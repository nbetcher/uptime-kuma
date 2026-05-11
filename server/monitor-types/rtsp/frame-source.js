/**
 * FrameSource: abstraction around node-av for opening a media URL,
 * pulling decoded frames, and tearing down. The single concrete
 * implementation is `NodeAvFrameSource`; the interface exists so a
 * subprocess fallback (or test stub) could substitute without
 * touching the check code.
 *
 * If `node-av` cannot be loaded on this platform (no prebuild, no
 * source build), the require throws and the parent `rtsp/index.js`
 * catches it — graceful degradation per UI-005.
 *
 * Implementation note: the `node-av` package's API (Demuxer /
 * Decoder / Encoder / Filter, with async iterators) is documented
 * at https://github.com/seydx/node-av. The adapter below targets
 * that high-level API but uses runtime feature detection so
 * minor-version differences don't break things outright.
 */

const av = require("node-av");
const sharp = require("sharp");
const { messages } = require("./messages");

/**
 * Promise.race against a timeout; rejects with TimeoutError. Avoids
 * the unhandled-rejection trap by using a `settled` flag in both
 * the inner promise's continuation and the timer body.
 * @param {Promise} p Inner promise
 * @param {number} ms Deadline in ms
 * @param {Function} onTimeout Cleanup hook called if the timer wins
 * @returns {Promise} resolved/rejected output
 */
function withDeadline(p, ms, onTimeout) {
    let settled = false;
    let timer;
    return new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            if (onTimeout) {
                try {
                    onTimeout();
                } catch {
                    /* ignored */
                }
            }
            reject(new Error(messages.TIMED_OUT(ms)));
        }, ms);

        p.then(
            (v) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                reject(e);
            }
        );
    });
}

/**
 * Build the AVDictionary-style options object passed to node-av at
 * session-open time. Per HLDS §6.2.
 * @param {object} ctx Preflight context
 * @returns {object} Options for node-av's open call
 */
function buildOpenOptions(ctx) {
    const opts = {};
    if (ctx.protocol === "rtsp" || ctx.protocol === "rtsps") {
        if (ctx.transport === "udp") {
            opts.rtsp_transport = "udp";
        } else {
            opts.rtsp_transport = "tcp";
        }
        if (ctx.username) {
            opts.rtsp_user = ctx.username;
        }
        if (ctx.password) {
            opts.rtsp_pass = ctx.password;
        }
    }
    if (!ctx.tlsVerify && (ctx.protocol === "rtsps" || ctx.protocol === "rtmps")) {
        opts.tls_verify = "0";
    }
    // libav `stimeout` is in microseconds — the receive-side socket
    // timeout. Keep it well below the wall-clock budget so the
    // demuxer doesn't hang past the deadline.
    opts.stimeout = String(Math.max(1000, ctx.timeoutMs) * 1000);
    return opts;
}

/**
 * NodeAvFrameSource wraps an open node-av session.
 *
 * The class uses runtime feature detection rather than committing
 * to a single API shape, because `node-av`'s public surface has
 * been in flux. The class is small enough that swapping for a
 * different shape is localised.
 */
class NodeAvFrameSource {
    /**
     * @param {object} demuxer node-av demuxer session
     * @param {object|null} decoder node-av decoder session
     * @param {object} ctx Preflight context
     */
    constructor(demuxer, decoder, ctx) {
        this.demuxer = demuxer;
        this.decoder = decoder;
        this.ctx = ctx;
        this._closed = false;
        this._frameIterator = null;
    }

    /**
     * Open a node-av session for the given URL. Tries the documented
     * `Demuxer.create(...)`/`Decoder.create(...)` pair first; falls
     * back to other shapes if present.
     * @param {object} ctx Preflight context
     * @returns {Promise<NodeAvFrameSource>} Opened source
     */
    static async open(ctx) {
        const opts = buildOpenOptions(ctx);
        let demuxer;
        let decoder = null;
        try {
            if (av.Demuxer && typeof av.Demuxer.create === "function") {
                demuxer = await withDeadline(av.Demuxer.create(ctx.url, opts), ctx.budgetMs);
                const videoStream = demuxer.streams?.find?.((s) => s.codecType === "video") || demuxer.videoStream;
                if (!videoStream) {
                    throw new Error("no video stream in input");
                }
                if (av.Decoder && typeof av.Decoder.create === "function") {
                    decoder = await withDeadline(av.Decoder.create(videoStream), ctx.budgetMs);
                }
            } else if (av.MediaInput && typeof av.MediaInput.open === "function") {
                demuxer = await withDeadline(av.MediaInput.open(ctx.url, opts), ctx.budgetMs);
            } else if (typeof av.open === "function") {
                demuxer = await withDeadline(av.open(ctx.url, opts), ctx.budgetMs);
            } else {
                throw new Error("node-av: no recognised open() API; install a current node-av release");
            }
        } catch (e) {
            throw new Error(messages.DECODE_FAILED(e.message || String(e)));
        }
        return new NodeAvFrameSource(demuxer, decoder, ctx);
    }

    /**
     * Pull the next decoded frame from the session. Returns null on
     * end of stream. Per HLDS §6.1, this MUST be wrapped in a
     * deadline at the caller so a hung session doesn't outlive the
     * wall-clock budget.
     * @param {number} remainingMs Max wait for this frame
     * @returns {Promise<object|null>} Frame or null
     */
    async next(remainingMs) {
        if (this._closed) {
            return null;
        }
        // On timeout, signal the underlying iterator/demuxer to
        // unwind so its pending I/O is released promptly rather than
        // dangling until the caller's `finally` close() — limits the
        // brief unbounded-hold window OP-003 calls out.
        const abort = () => {
            try {
                if (this._frameIterator && typeof this._frameIterator.return === "function") {
                    this._frameIterator.return();
                }
                if (this.decoder && typeof this.decoder.cancel === "function") {
                    this.decoder.cancel();
                }
                if (this.demuxer && typeof this.demuxer.cancel === "function") {
                    this.demuxer.cancel();
                }
            } catch {
                /* abort hooks are best-effort */
            }
        };
        try {
            // If we have a Decoder, use its async iterator (the
            // documented `node-av` pattern).
            if (this.decoder && typeof this.decoder.frames === "function") {
                if (!this._frameIterator) {
                    const iter = this.decoder.frames();
                    this._frameIterator = iter[Symbol.asyncIterator] ? iter[Symbol.asyncIterator]() : iter;
                }
                const p = this._frameIterator.next();
                const wrapped = remainingMs && remainingMs > 0 ? withDeadline(p, remainingMs, abort) : p;
                const result = await wrapped;
                if (!result || result.done) {
                    return null;
                }
                return result.value;
            }
            // Legacy / alternative API surfaces.
            const session = this.demuxer;
            const fn = session.readFrame || session.nextFrame || session.decode;
            if (typeof fn !== "function") {
                throw new Error("node-av: no recognised frame-iteration API");
            }
            const p = fn.call(session);
            const wrapped = remainingMs && remainingMs > 0 ? withDeadline(p, remainingMs, abort) : p;
            return await wrapped;
        } catch (e) {
            const msg = (e && e.message) || String(e);
            if (/end ?of ?(file|stream)|EOF|EOS/i.test(msg)) {
                return null;
            }
            throw new Error(messages.DECODE_FAILED(msg));
        }
    }

    /**
     * Encode a raw frame to JPEG. The exact frame layout depends on
     * the decoder — H.264/H.265 typically produce YUV420P. node-av's
     * filter graph converts to RGB before we hand off to sharp.
     * @param {object} frame Raw frame from `next()`
     * @returns {Promise<Buffer>} JPEG bytes
     */
    async toJpeg(frame) {
        if (!frame) {
            throw new Error(messages.FRAME_INVALID("null frame"));
        }

        // Case 1: frame exposes a direct JPEG encoder
        if (typeof frame.toJpeg === "function") {
            return await frame.toJpeg({ quality: 75 });
        }
        if (typeof frame.encode === "function") {
            const out = await frame.encode("mjpeg");
            return Buffer.isBuffer(out) ? out : Buffer.from(out);
        }

        // Case 2: frame already carries JPEG bytes
        if (Buffer.isBuffer(frame) && frame[0] === 0xff && frame[1] === 0xd8) {
            return frame;
        }
        if (frame.data && Buffer.isBuffer(frame.data) && frame.data[0] === 0xff && frame.data[1] === 0xd8) {
            return frame.data;
        }

        // Case 3: frame carries raw pixels. The decoder MAY have
        // already converted to RGB/RGBA via a filter; if it's still
        // in a planar YUV format we fail loudly so the user knows
        // the build needs adjustment rather than silently producing
        // a corrupted image.
        const fmt = (frame.format || frame.pixelFormat || "").toString().toLowerCase();
        const data = frame.data || frame.buffer || frame.pixels;
        const width = frame.width || frame.w;
        const height = frame.height || frame.h;
        if (!Buffer.isBuffer(data) || !width || !height) {
            throw new Error(messages.FRAME_INVALID("unknown frame layout"));
        }
        if (fmt && /yuv|nv12|nv21/.test(fmt)) {
            throw new Error(
                messages.FRAME_INVALID(
                    `frame is in ${fmt}; configure the decoder to output RGB via node-av's filter graph`
                )
            );
        }
        const channels = data.length / (width * height);
        if (![1, 3, 4].includes(channels)) {
            throw new Error(
                messages.FRAME_INVALID(`unexpected channels=${channels} (raw bytes=${data.length}, ${width}x${height})`)
            );
        }
        return sharp(data, {
            raw: { width, height, channels },
        })
            .jpeg({ quality: 75, mozjpeg: true })
            .toBuffer();
    }

    /**
     * Close the session, freeing libav handles. Logs (not throws)
     * cleanup errors so a leaked-handle bug is visible without
     * masking the original failure that led us here.
     * @returns {Promise<void>}
     */
    async close() {
        if (this._closed) {
            return;
        }
        this._closed = true;
        const { log } = require("../../../src/util");
        const safeClose = async (obj, label) => {
            if (!obj) {
                return;
            }
            try {
                if (typeof obj.close === "function") {
                    await obj.close();
                } else if (typeof obj.destroy === "function") {
                    obj.destroy();
                } else if (typeof obj.end === "function") {
                    obj.end();
                }
            } catch (e) {
                log.warn("rtsp", `${label} close failed: ${e.message}`);
            }
        };
        await safeClose(this.decoder, "decoder");
        await safeClose(this.demuxer, "demuxer");
        this.demuxer = null;
        this.decoder = null;
        this._frameIterator = null;
    }

    /**
     * Best-effort lookup of the input stream's keyframe interval, in
     * seconds. Used by the Test button to warn users when the
     * keyframe cadence is too sparse for their monitor interval
     * (UI-011).
     * @returns {Promise<number|null>} Keyframe interval in seconds
     */
    async getKeyframeInterval() {
        if (!this.demuxer) {
            return null;
        }
        try {
            const streams =
                this.demuxer.streams ||
                (typeof this.demuxer.getStreams === "function" ? await this.demuxer.getStreams() : null);
            if (!streams) {
                return null;
            }
            const video = Array.isArray(streams)
                ? streams.find((s) => s.codecType === "video" || s.type === "video")
                : null;
            if (!video) {
                return null;
            }
            if (video.gop_size && video.frame_rate) {
                const fps = typeof video.frame_rate === "number" ? video.frame_rate : Number(video.frame_rate);
                if (fps > 0) {
                    return video.gop_size / fps;
                }
            }
            if (typeof video.keyframe_interval === "number") {
                return video.keyframe_interval;
            }
        } catch {
            /* ignored */
        }
        return null;
    }
}

module.exports = {
    NodeAvFrameSource,
    withDeadline,
    buildOpenOptions,
};
