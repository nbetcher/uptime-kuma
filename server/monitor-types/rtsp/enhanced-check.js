const crypto = require("node:crypto");
const { UP, log } = require("../../../src/util");
const { messages } = require("./messages");
const { captureFrames } = require("./frame-capture");
const { verifyTlsEndpoint } = require("./basic-probe");
const { validateJpegStructure, luminanceStats } = require("./image-pipeline");

const BLACK_FRAME_MEAN_THRESHOLD = 5;
const BLACK_FRAME_STDDEV_THRESHOLD = 2;
const MIN_VALID_FRAMES = 2;

/**
 * Compute a fast hash of a JPEG buffer for frozen-frame detection.
 *
 * Uses SHA-256 truncated to 16 bytes. xxhash64 would be marginally
 * faster but adds a dependency (NFR-034). SHA-256 of a 200 KB JPEG
 * is ~1 ms on a modern CPU — well below the per-frame budget.
 * @param {Buffer} buf JPEG bytes
 * @returns {string} Hex hash
 */
function fastHash(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32);
}

/**
 * Enhanced-mode entry point: capture N frames, validate structure,
 * detect frozen / black streams. See HLDS §5.6 and FR-013 / FR-014.
 * Decoding happens in a worker process (frame-capture.js); this
 * function only sees finished JPEGs.
 * @param {object} monitor Monitor row
 * @param {object} heartbeat Heartbeat to populate
 * @param {object} ctx Preflight context
 * @returns {Promise<void>}
 */
async function run(monitor, heartbeat, ctx) {
    const startMs = Date.now();
    const wantedRaw = parseInt(monitor.stream_frame_count, 10);
    const wanted = Number.isFinite(wantedRaw) ? Math.max(2, Math.min(15, wantedRaw)) : 5;

    await verifyTlsEndpoint({ ...ctx, timeoutMs: Math.min(ctx.timeoutMs, ctx.budgetMs) });

    const capture = await captureFrames(ctx, {
        count: wanted,
        budgetMs: Math.max(1000, ctx.budgetMs - (Date.now() - startMs)),
    });
    if (capture.frames.length < wanted && capture.detail) {
        // Surfaces as the "(partial)" suffix of ENHANCED_OK, or as
        // INSUFFICIENT_FRAMES below; warn so the cause is in the log.
        log.warn(
            "rtsp",
            `enhanced: capture stopped after ${capture.frames.length}/${wanted} frames: ${capture.detail}`
        );
    }

    const buffers = [];
    const hashes = [];
    for (const jpeg of capture.frames) {
        try {
            await validateJpegStructure(jpeg);
        } catch (e) {
            log.debug("rtsp", `enhanced: ${e.message}`);
            continue;
        }
        buffers.push(jpeg);
        hashes.push(fastHash(jpeg));
    }

    if (buffers.length < MIN_VALID_FRAMES) {
        throw new Error(messages.INSUFFICIENT_FRAMES(buffers.length, wanted));
    }

    // Frozen-frame detection: all hashes byte-identical?
    const firstHash = hashes[0];
    const allFrozen = hashes.every((h) => h === firstHash);
    if (allFrozen) {
        throw new Error(messages.FROZEN_FRAME(buffers.length));
    }

    // Black/uniform check on the last frame
    const stats = await luminanceStats(buffers[buffers.length - 1]);
    const meanRounded = Math.round(stats.mean * 10) / 10;
    const stddevRounded = Math.round(stats.stddev * 10) / 10;
    if (stats.mean < BLACK_FRAME_MEAN_THRESHOLD && stats.stddev < BLACK_FRAME_STDDEV_THRESHOLD) {
        throw new Error(messages.BLACK_FRAME({ mean: meanRounded, stddev: stddevRounded }));
    }

    heartbeat.status = UP;
    heartbeat.ping = Date.now() - startMs;
    heartbeat.msg = messages.ENHANCED_OK(buffers.length, wanted, heartbeat.ping);
    // UI-011: only the Test button consumes this. On the scheduled
    // check path `heartbeat` is a RedBean bean and R.freeze(true) is
    // global, so attaching unmodelled properties would make R.store
    // write a non-existent column. The socket handler sets
    // `_isTestStream` on its ephemeral monitor stub.
    if (monitor._isTestStream && capture.firstFrameMs != null) {
        heartbeat.firstFrameMs = capture.firstFrameMs;
    }

    if (monitor.getSaveResponse && monitor.getSaveResponse() && monitor.saveResponseData) {
        try {
            const summary = {
                frames: buffers.map((b, i) => ({
                    size: b.length,
                    xxhash: hashes[i],
                })),
                luminance_stats: { mean: meanRounded, stddev: stddevRounded },
                elapsed_ms: heartbeat.ping,
            };
            await monitor.saveResponseData(heartbeat, JSON.stringify(summary));
        } catch (e) {
            log.debug("rtsp", `enhanced: saveResponseData failed: ${e.message}`);
        }
    }
}

module.exports = {
    run,
    fastHash,
    BLACK_FRAME_MEAN_THRESHOLD,
    BLACK_FRAME_STDDEV_THRESHOLD,
};
