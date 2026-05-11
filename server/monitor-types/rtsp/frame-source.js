/**
 * FrameSource: abstraction around node-av for opening a media URL,
 * pulling raw decoded frames, encoding them to JPEG, and tearing
 * down. The single concrete implementation is `NodeAvFrameSource`;
 * the interface exists so a subprocess fallback (or test stub)
 * could substitute without touching the check code.
 *
 * If `node-av` cannot be loaded on this platform (no prebuild, no
 * source build), the require throws and the parent `rtsp/index.js`
 * catches it — graceful degradation per UI-005.
 */

const av = require("node-av");
const sharp = require("sharp");
const { messages } = require("./messages");

/**
 * Promise.race against a timeout; rejects with TimeoutError. Also
 * supports an `onTimeout` cleanup callback.
 *
 * @param {Promise} p Inner promise
 * @param {number} ms Deadline in ms
 * @param {Function} [onTimeout] Cleanup hook called if the timer wins
 * @returns {Promise} resolved/rejected output
 */
function withDeadline(p, ms, onTimeout) {
    let timer;
    return Promise.race([
        p.then(
            (v) => {
                clearTimeout(timer);
                return v;
            },
            (e) => {
                clearTimeout(timer);
                throw e;
            }
        ),
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                if (onTimeout) {
                    try {
                        onTimeout();
                    } catch {
                        /* ignored */
                    }
                }
                reject(new Error(messages.TIMED_OUT(ms)));
            }, ms);
        }),
    ]);
}

/**
 * NodeAvFrameSource wraps an open node-av session.
 *
 * The exact node-av API surface is library-version-specific; the
 * adapter here defaults to its documented `MediaInput` /
 * `decodeVideo` flow but degrades gracefully when an alternative API
 * shape is detected.
 */
class NodeAvFrameSource {
    /**
     * @param {object} session node-av session
     * @param {object} ctx Preflight context
     */
    constructor(session, ctx) {
        this.session = session;
        this.ctx = ctx;
        this._closed = false;
    }

    /**
     * Open a node-av input for the given URL.
     *
     * @param {object} ctx Preflight context
     * @returns {Promise<NodeAvFrameSource>} Opened source
     */
    static async open(ctx) {
        const options = {};
        if (ctx.transport === "udp") options.rtsp_transport = "udp";
        else options.rtsp_transport = "tcp";
        if (ctx.username) options.rtsp_user = ctx.username;
        if (ctx.password) options.rtsp_pass = ctx.password;
        if (!ctx.tlsVerify && (ctx.protocol === "rtsps" || ctx.protocol === "rtmps")) {
            options.tls_verify = "0";
        }
        // Sane socket-level timeouts to avoid hangs at libav layer
        options.stimeout = String(Math.max(1000, ctx.timeoutMs) * 1000); // microseconds

        let session;
        try {
            // node-av API: prefer the explicit MediaInput.open if it
            // exists, fall back to a top-level open() function.
            if (av.MediaInput && typeof av.MediaInput.open === "function") {
                session = await withDeadline(
                    av.MediaInput.open(ctx.url, options),
                    ctx.budgetMs
                );
            } else if (typeof av.open === "function") {
                session = await withDeadline(av.open(ctx.url, options), ctx.budgetMs);
            } else {
                throw new Error("node-av: no recognised open() API");
            }
        } catch (e) {
            throw new Error(messages.DECODE_FAILED(e.message || String(e)));
        }
        return new NodeAvFrameSource(session, ctx);
    }

    /**
     * Pull the next decoded frame. Returns null on stream end.
     *
     * @returns {Promise<object|null>} Raw frame metadata + bytes
     */
    async next() {
        if (this._closed) return null;
        if (!this.session) return null;

        const session = this.session;
        try {
            // node-av frame iteration — try a few API shapes
            if (typeof session.readFrame === "function") {
                return await session.readFrame();
            }
            if (typeof session.nextFrame === "function") {
                return await session.nextFrame();
            }
            if (typeof session.decode === "function") {
                return await session.decode();
            }
            throw new Error("node-av: no recognised frame-iteration API");
        } catch (e) {
            if (e && /end ?of ?(file|stream)|EOF|EOS/i.test(e.message || "")) {
                return null;
            }
            throw new Error(messages.DECODE_FAILED(e.message || String(e)));
        }
    }

    /**
     * Encode a raw frame to JPEG. Tries node-av's encoder first;
     * falls back to sharp on raw pixel data.
     *
     * @param {object} frame Raw frame from `next()`
     * @returns {Promise<Buffer>} JPEG bytes
     */
    async toJpeg(frame) {
        if (!frame) throw new Error(messages.FRAME_INVALID("null frame"));

        // Case 1: node-av frame exposes an encoder method directly
        if (typeof frame.toJpeg === "function") {
            return await frame.toJpeg({ quality: 75 });
        }
        if (typeof frame.encode === "function") {
            return await frame.encode("mjpeg");
        }

        // Case 2: frame already carries a JPEG buffer
        if (Buffer.isBuffer(frame)) return frame;
        if (frame.data && Buffer.isBuffer(frame.data) && frame.data[0] === 0xff && frame.data[1] === 0xd8) {
            return frame.data;
        }

        // Case 3: frame carries raw RGB/RGBA pixels — encode via sharp
        const data = frame.data || frame.buffer || frame.pixels;
        const width = frame.width || frame.w;
        const height = frame.height || frame.h;
        if (!Buffer.isBuffer(data) || !width || !height) {
            throw new Error(messages.FRAME_INVALID("unknown frame layout"));
        }
        const channels = data.length / (width * height);
        if (![1, 3, 4].includes(channels)) {
            throw new Error(messages.FRAME_INVALID(`unexpected channels=${channels}`));
        }
        return sharp(data, {
            raw: { width, height, channels },
        })
            .jpeg({ quality: 75, mozjpeg: true })
            .toBuffer();
    }

    /**
     * Close the session, freeing libav handles.
     *
     * @returns {Promise<void>}
     */
    async close() {
        if (this._closed) return;
        this._closed = true;
        if (!this.session) return;
        try {
            if (typeof this.session.close === "function") {
                await this.session.close();
            } else if (typeof this.session.destroy === "function") {
                this.session.destroy();
            } else if (typeof this.session.end === "function") {
                this.session.end();
            }
        } catch {
            /* swallow close errors */
        }
        this.session = null;
    }

    /**
     * Best-effort lookup of the input stream's keyframe interval, in
     * seconds. Used by the Test button to warn users when the
     * keyframe cadence is too sparse for their monitor interval
     * (UI-011).
     *
     * @returns {Promise<number|null>} Keyframe interval in seconds, or null if unknown
     */
    async getKeyframeInterval() {
        if (!this.session) return null;
        // node-av may expose stream metadata
        try {
            const streams = this.session.streams || (typeof this.session.getStreams === "function" ? await this.session.getStreams() : null);
            if (!streams) return null;
            const video = Array.isArray(streams)
                ? streams.find((s) => s.codecType === "video" || s.type === "video")
                : null;
            if (!video) return null;
            // Look for explicit GOP / keyframe interval fields
            if (video.gop_size && video.frame_rate) {
                const fps = typeof video.frame_rate === "number" ? video.frame_rate : Number(video.frame_rate);
                if (fps > 0) return video.gop_size / fps;
            }
            if (typeof video.keyframe_interval === "number") return video.keyframe_interval;
        } catch {
            /* ignored */
        }
        return null;
    }
}

module.exports = {
    NodeAvFrameSource,
    withDeadline,
};
