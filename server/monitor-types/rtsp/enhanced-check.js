const crypto = require("node:crypto");
const { UP, log } = require("../../../src/util");
const { messages } = require("./messages");
const { NodeAvFrameSource } = require("./frame-source");
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
 * @param {object} monitor Monitor row
 * @param {object} heartbeat Heartbeat to populate
 * @param {object} ctx Preflight context
 * @returns {Promise<void>}
 */
async function run(monitor, heartbeat, ctx) {
    const startMs = Date.now();
    const wantedRaw = parseInt(monitor.stream_frame_count, 10);
    const wanted = Number.isFinite(wantedRaw) ? Math.max(2, Math.min(15, wantedRaw)) : 5;
    const buffers = [];
    const hashes = [];
    let source = null;
    let keyframeIntervalSec = null;

    try {
        source = await NodeAvFrameSource.open(ctx);

        // UI-011: stash keyframe interval for the Test button warning.
        try {
            keyframeIntervalSec = await source.getKeyframeInterval();
        } catch (e) {
            log.debug("rtsp", `enhanced: keyframe-interval probe failed: ${e.message}`);
        }

        while (buffers.length < wanted) {
            // MR13 / OP-003: enforce the wall-clock budget as a hard
            // stop per frame, not just between frames.
            const remaining = ctx.budgetMs - (Date.now() - startMs);
            if (remaining <= 0) {
                break;
            }
            let frame;
            try {
                frame = await source.next(remaining);
            } catch (e) {
                if (buffers.length === 0) {
                    throw e;
                }
                log.debug("rtsp", `enhanced: read error after ${buffers.length} frames: ${e.message}`);
                break;
            }
            if (frame === null) {
                break;
            }

            let jpeg;
            try {
                jpeg = await source.toJpeg(frame);
            } catch (e) {
                log.debug("rtsp", `enhanced: toJpeg failed: ${e.message}`);
                continue;
            } finally {
                if (frame && typeof frame.free === "function") {
                    frame.free();
                }
            }

            try {
                await validateJpegStructure(jpeg);
            } catch (e) {
                log.debug("rtsp", `enhanced: ${e.message}`);
                continue;
            }

            buffers.push(jpeg);
            hashes.push(fastHash(jpeg));
        }
    } finally {
        if (source) {
            await source.close();
        }
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
    heartbeat.msg = messages.ENHANCED_OK(buffers.length, heartbeat.ping);
    // Surface for the Test button warning surface (UI-011) — the
    // socket handler reads this off the heartbeat object.
    if (keyframeIntervalSec != null) {
        heartbeat.keyframeIntervalSec = keyframeIntervalSec;
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
