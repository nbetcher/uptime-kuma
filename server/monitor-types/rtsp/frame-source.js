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
 * that high-level API and fails fast if the required entry points
 * are unavailable.
 */

const av = require("node-av/api");
const { AV_PIX_FMT_RGB24 } = require("node-av/constants");
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
 * The class targets the documented `node-av/api` Demuxer, Decoder,
 * FilterAPI, and ImageUtils surface. The class is small enough that
 * swapping for a different shape is localised if node-av changes.
 */
class NodeAvFrameSource {
    /**
     * @param {object} demuxer node-av demuxer session
     * @param {object|null} decoder node-av decoder session
     * @param {object} ctx Preflight context
     * @param {object|null} videoStream node-av video stream
     * @param {AbortController|null} abortController Shared node-av cancellation controller
     */
    constructor(demuxer, decoder, ctx, videoStream = null, abortController = null) {
        this.demuxer = demuxer;
        this.decoder = decoder;
        this.ctx = ctx;
        this.videoStream = videoStream;
        this._abortController = abortController;
        this._closed = false;
        this._frameIterator = null;
        this._rgbFilter = null;
    }

    /**
     * Open a node-av session for the given URL using the documented
     * `Demuxer.open` / `Decoder.create` pair from `node-av/api`.
     * @param {object} ctx Preflight context
     * @returns {Promise<NodeAvFrameSource>} Opened source
     */
    static async open(ctx) {
        if (!av.Demuxer || typeof av.Demuxer.open !== "function" || !av.Decoder || typeof av.Decoder.create !== "function") {
            throw new Error("node-av: required Demuxer.open / Decoder.create are unavailable; install a current node-av release");
        }
        const opts = buildOpenOptions(ctx);
        const openOptions = { options: opts };
        const abortController = typeof AbortController === "function" ? new AbortController() : null;
        if (ctx.protocol === "rtsp" || ctx.protocol === "rtsps") {
            openOptions.format = "rtsp";
        }
        if (abortController) {
            openOptions.signal = abortController.signal;
        }
        let demuxer;
        let decoder = null;
        let videoStream = null;
        try {
            demuxer = await withDeadline(
                av.Demuxer.open(ctx.url, openOptions),
                ctx.budgetMs,
                () => abortController?.abort()
            );
            videoStream = typeof demuxer.video === "function" ? demuxer.video() : null;
            if (!videoStream) {
                throw new Error("no video stream in input");
            }
            const decoderOptions = abortController ? { signal: abortController.signal } : undefined;
            decoder = await withDeadline(
                av.Decoder.create(videoStream, decoderOptions),
                ctx.budgetMs,
                () => abortController?.abort()
            );
        } catch (error) {
            for (const session of [decoder, demuxer]) {
                try {
                    if (session && typeof session.close === "function") {
                        await session.close();
                    }
                } catch {
                    /* ignored */
                }
            }
            throw new Error(messages.DECODE_FAILED(error.message || String(error)));
        }
        return new NodeAvFrameSource(demuxer, decoder, ctx, videoStream, abortController);
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
                if (this._abortController) {
                    this._abortController.abort();
                }
            } catch {
                /* abort hooks are best-effort */
            }
        };
        try {
            if (!this.decoder || typeof this.decoder.frames !== "function") {
                throw new Error("node-av: decoder.frames() is unavailable");
            }
            if (!this._frameIterator) {
                if (!this.demuxer || !this.videoStream || typeof this.demuxer.packets !== "function") {
                    throw new Error("node-av: demuxer.packets() is unavailable");
                }
                const packetSource = this.demuxer.packets(this.videoStream.index);
                this._frameIterator = this.decoder.frames(packetSource);
            }
            const p = this._frameIterator.next();
            const wrapped = remainingMs && remainingMs > 0 ? withDeadline(p, remainingMs, abort) : p;
            const result = await wrapped;
            if (!result || result.done) {
                return null;
            }
            return result.value;
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

        if (Array.isArray(frame.data) && frame.width && frame.height && av.FilterAPI && av.ImageUtils) {
            return await this.nodeAvFrameToJpeg(frame);
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
     * Convert a node-av Frame to JPEG via an RGB filter and sharp.
     * @param {object} frame node-av Frame
     * @returns {Promise<Buffer>} JPEG bytes
     */
    async nodeAvFrameToJpeg(frame) {
        if (!this._rgbFilter) {
            this._rgbFilter = av.FilterAPI.create("format=rgb24");
        }

        const filteredFrames = await this._rgbFilter.processAll(frame);
        const rgbFrame = filteredFrames.find((candidate) => candidate && candidate.width && candidate.height);
        try {
            if (!rgbFrame) {
                throw new Error(messages.FRAME_INVALID("RGB filter produced no output"));
            }
            const width = rgbFrame.width;
            const height = rgbFrame.height;
            const rawSize = av.ImageUtils.getBufferSize(AV_PIX_FMT_RGB24, width, height, 1);
            const raw = Buffer.alloc(rawSize);
            const written = av.ImageUtils.copyToBuffer(
                raw,
                rawSize,
                rgbFrame.data,
                rgbFrame.linesize,
                AV_PIX_FMT_RGB24,
                width,
                height,
                1
            );
            if (written < 0) {
                throw new Error(messages.FRAME_INVALID(`RGB frame copy failed (${written})`));
            }
            const pixels = written === raw.length ? raw : raw.subarray(0, written);
            return await sharp(pixels, {
                raw: { width, height, channels: 3 },
            })
                .jpeg({ quality: 75, mozjpeg: true })
                .toBuffer();
        } finally {
            for (const filteredFrame of filteredFrames) {
                if (filteredFrame && filteredFrame !== frame && typeof filteredFrame.free === "function") {
                    filteredFrame.free();
                }
            }
        }
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
        if (this._abortController && !this._abortController.signal.aborted) {
            this._abortController.abort();
        }
        await safeClose(this._rgbFilter, "RGB filter");
        await safeClose(this.decoder, "decoder");
        await safeClose(this.demuxer, "demuxer");
        this.demuxer = null;
        this.decoder = null;
        this.videoStream = null;
        this._abortController = null;
        this._frameIterator = null;
        this._rgbFilter = null;
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
