/**
 * Frame-capture worker. Runs in a child process forked by
 * `frame-capture.js` and is never `require()`d by the server process.
 *
 * Everything that touches libav (node-av) lives here so that a hung
 * native call, a leaked libuv threadpool thread, or a crash inside
 * FFmpeg can only take down this process — the parent enforces the
 * wall-clock budget with SIGKILL. See
 * `docs/rtsp-monitor/11-architecture-review.md` §2.1.
 *
 * Protocol (parent → child, one message per process):
 *   { type: "probe" }
 *   { type: "capture", input, format, options, count, maxDim }
 *
 * Protocol (child → parent):
 *   { type: "probe", nodeAv: string|null, sharp: string|null }
 *   { type: "frame", jpeg: Uint8Array, width, height }   (0..count times)
 *   { type: "done" }
 *   { type: "error", message: string }
 */

const JPEG_QUALITY = 75;

/**
 * Send a message to the parent and resolve once it has been handed to
 * the IPC channel, so `process.exit()` cannot drop it.
 * @param {object} msg Message
 * @returns {Promise<void>}
 */
function send(msg) {
    return new Promise((resolve) => {
        if (!process.send) {
            resolve();
            return;
        }
        process.send(msg, undefined, undefined, () => resolve());
    });
}

/**
 * Try to load the native dependencies and report what failed.
 * @returns {Promise<void>}
 */
async function probe() {
    let nodeAv = null;
    let sharpErr = null;
    try {
        const av = require("node-av/api");
        if (typeof av.Demuxer?.open !== "function" || typeof av.Decoder?.create !== "function") {
            nodeAv = "node-av/api does not expose Demuxer.open / Decoder.create";
        }
    } catch (e) {
        nodeAv = e.message;
    }
    try {
        require("sharp");
    } catch (e) {
        sharpErr = e.message;
    }
    await send({ type: "probe", nodeAv, sharp: sharpErr });
}

/**
 * Open the input, decode up to `job.count` video frames, and stream
 * each one back to the parent as a JPEG no larger than `job.maxDim`
 * on its long edge.
 * @param {object} job Capture job from the parent
 * @returns {Promise<void>}
 */
async function capture(job) {
    const av = require("node-av/api");
    const sharp = require("sharp");

    let sent = 0;
    let demuxer = null;
    let decoder = null;
    let filter = null;

    try {
        const openOptions = { options: job.options };
        if (job.format) {
            openOptions.format = job.format;
        }
        demuxer = await av.Demuxer.open(job.input, openOptions);

        const videoStream = demuxer.video();
        if (!videoStream) {
            throw new Error("no video stream in input");
        }
        decoder = await av.Decoder.create(videoStream);
        filter = av.FilterAPI.create("format=rgb24");

        for await (const frame of decoder.frames(demuxer.packets(videoStream.index))) {
            if (!frame) {
                continue;
            }
            let rgbFrames = [];
            try {
                rgbFrames = await filter.processAll(frame);
                for (const rgb of rgbFrames) {
                    if (sent >= job.count) {
                        break;
                    }
                    const jpeg = await sharp(rgb.toBuffer(), {
                        raw: { width: rgb.width, height: rgb.height, channels: 3 },
                    })
                        .resize(job.maxDim, job.maxDim, { fit: "inside", withoutEnlargement: true })
                        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
                        .toBuffer();
                    await send({ type: "frame", jpeg, width: rgb.width, height: rgb.height });
                    sent++;
                }
            } finally {
                for (const rgb of rgbFrames) {
                    rgb.free();
                }
                frame.free();
            }
            if (sent >= job.count) {
                break;
            }
        }
    } finally {
        // Best effort only: the parent kills this process right after
        // "done", so a slow close cannot hold anything up.
        for (const res of [filter, decoder, demuxer]) {
            try {
                await res?.close?.();
            } catch {
                /* ignored */
            }
        }
    }

    await send({ type: "done" });
}

process.once("message", async (msg) => {
    try {
        if (msg?.type === "probe") {
            await probe();
        } else if (msg?.type === "capture") {
            await capture(msg);
        } else {
            await send({ type: "error", message: `unknown worker message: ${msg?.type}` });
        }
    } catch (e) {
        await send({ type: "error", message: (e && e.message) || String(e) });
    }
    process.exit(0);
});

// The parent going away (crash, restart) must never leave an orphaned
// decoder holding a camera session open.
process.on("disconnect", () => process.exit(0));
