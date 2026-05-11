const { UP, log } = require("../../../src/util");
const { messages } = require("./messages");
const { NodeAvFrameSource } = require("./frame-source");
const { validateJpegStructure, fingerprint, distance, FP_TOTAL_BITS } = require("./image-pipeline");
const { persistFrameImage } = require("./reference-store");

const DEFAULT_THRESHOLD = 24;

/**
 * Full-mode entry point: capture one frame, fingerprint, compare
 * against the Day/Night references. See HLDS §5.7 and FR-015/FR-016.
 * @param {object} monitor Monitor row
 * @param {object} heartbeat Heartbeat to populate
 * @param {object} ctx Preflight context
 * @returns {Promise<void>}
 */
async function run(monitor, heartbeat, ctx) {
    const startMs = Date.now();
    let source = null;
    let jpeg;
    let keyframeIntervalSec = null;

    try {
        source = await NodeAvFrameSource.open(ctx);

        // UI-011: stash keyframe interval for the Test button warning.
        try {
            keyframeIntervalSec = await source.getKeyframeInterval();
        } catch (e) {
            log.debug("rtsp", `full: keyframe-interval probe failed: ${e.message}`);
        }
        let frame = null;
        // Pull a small number of attempts so a single bad frame
        // doesn't fail the whole check; bail on the first valid
        // JPEG. Each attempt is bounded by the remaining wall-clock
        // budget (MR13 / OP-003).
        for (let attempts = 0; attempts < 5; attempts++) {
            const remaining = ctx.budgetMs - (Date.now() - startMs);
            if (remaining <= 0) {
                break;
            }
            try {
                frame = await source.next(remaining);
            } catch (e) {
                throw new Error(messages.DECODE_FAILED(e.message || String(e)));
            }
            if (frame === null) {
                break;
            }
            try {
                jpeg = await source.toJpeg(frame);
                await validateJpegStructure(jpeg);
                break;
            } catch (e) {
                log.debug("rtsp", `full: discarding invalid frame: ${e.message}`);
                jpeg = null;
                continue;
            }
        }
        if (!jpeg) {
            throw new Error(messages.NO_FRAME());
        }
    } finally {
        if (source) {
            await source.close();
        }
    }

    const live = await fingerprint(jpeg);

    const thresholdRaw = parseInt(monitor.stream_match_threshold, 10);
    const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : DEFAULT_THRESHOLD;
    const dayHash = monitor.stream_reference_day_hash ? Buffer.from(monitor.stream_reference_day_hash) : null;
    const nightHash = monitor.stream_reference_night_hash ? Buffer.from(monitor.stream_reference_night_hash) : null;
    const separate = monitor.stream_separate_day_night !== false && monitor.stream_separate_day_night !== 0;

    if (separate && (!dayHash || !nightHash)) {
        throw new Error(messages.MISSING_REFERENCE());
    }
    if (!separate && !dayHash) {
        throw new Error(messages.MISSING_REFERENCE());
    }

    let scoreDay = null;
    let scoreNight = null;
    let matchedSlot = null;
    if (separate) {
        scoreDay = distance(live, dayHash, "day");
        scoreNight = distance(live, nightHash, "night");
        matchedSlot = scoreNight < scoreDay ? "Night" : "Day";
    } else {
        scoreDay = distance(live, dayHash, "single");
        matchedSlot = "single";
    }

    const best = scoreNight !== null && (scoreDay === null || scoreNight < scoreDay) ? scoreNight : scoreDay;

    heartbeat.ping = Date.now() - startMs;
    if (keyframeIntervalSec != null) {
        heartbeat.keyframeIntervalSec = keyframeIntervalSec;
    }

    if (best <= threshold) {
        heartbeat.status = UP;
        heartbeat.msg = messages.MATCH_OK(matchedSlot, best);
        if (monitor.stream_status_thumbnail || monitor.stream_keep_down_images) {
            try {
                await persistFrameImage({
                    monitorId: monitor.id,
                    kind: "match",
                    jpeg,
                });
            } catch (e) {
                log.warn("rtsp", `persist match thumbnail failed: ${e.message}`);
            }
        }
    } else {
        if (monitor.stream_keep_down_images) {
            try {
                await persistFrameImage({
                    monitorId: monitor.id,
                    kind: "down",
                    jpeg,
                });
            } catch (e) {
                log.warn("rtsp", `persist down image failed: ${e.message}`);
            }
        }
        const failMsg = messages.MATCH_FAIL(scoreDay, scoreNight, threshold);
        // Stash debug response before throwing
        await maybeSaveResponse(monitor, heartbeat, live, scoreDay, scoreNight, threshold, jpeg);
        throw new Error(failMsg);
    }

    await maybeSaveResponse(monitor, heartbeat, live, scoreDay, scoreNight, threshold, jpeg);
}

/**
 * Build and persist the structured debug response payload for the
 * `response` heartbeat column when save_response is enabled.
 * @param {object} monitor Monitor row
 * @param {object} heartbeat Heartbeat to populate
 * @param {object} live Live fingerprint
 * @param {number|null} scoreDay Day distance
 * @param {number|null} scoreNight Night distance
 * @param {number} threshold Match threshold
 * @param {Buffer} jpeg Captured frame bytes
 * @returns {Promise<void>}
 */
async function maybeSaveResponse(monitor, heartbeat, live, scoreDay, scoreNight, threshold, jpeg) {
    if (!monitor.getSaveResponse || !monitor.getSaveResponse() || !monitor.saveResponseData) {
        return;
    }
    try {
        const summary = {
            frame: { size: jpeg.length },
            live_fingerprint: Buffer.concat([live.lumHash, live.edgeHash]).toString("hex"),
            scores: { day: scoreDay, night: scoreNight },
            threshold,
            total_bits: FP_TOTAL_BITS,
            mean_luma: Math.round(live.meanLuma * 10) / 10,
        };
        await monitor.saveResponseData(heartbeat, JSON.stringify(summary));
    } catch (e) {
        log.debug("rtsp", `full: saveResponseData failed: ${e.message}`);
    }
}

module.exports = {
    run,
    DEFAULT_THRESHOLD,
};
