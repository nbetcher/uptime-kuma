const { UP, log } = require("../../../src/util");
const { messages } = require("./messages");
const { captureFrames } = require("./frame-capture");
const { verifyTlsEndpoint } = require("./basic-probe");
const { validateJpegStructure, fingerprint, distance, FP_TOTAL_BITS } = require("./image-pipeline");
const { getFingerprints, persistFrameImage } = require("./reference-store");

const DEFAULT_THRESHOLD = 24;

/**
 * Full-mode entry point: capture one frame, fingerprint, compare
 * against the Day/Night references. See HLDS §5.7 and FR-015/FR-016.
 * Decoding happens in a worker process (frame-capture.js).
 * @param {object} monitor Monitor row
 * @param {object} heartbeat Heartbeat to populate
 * @param {object} ctx Preflight context
 * @returns {Promise<void>}
 */
async function run(monitor, heartbeat, ctx) {
    const startMs = Date.now();

    // References first: a misconfigured monitor fails without opening
    // a camera session.
    const refs = monitor.id ? await getFingerprints(monitor.id) : { day: null, night: null };
    const separate = monitor.stream_separate_day_night !== false && monitor.stream_separate_day_night !== 0;
    if (!refs.day || (separate && !refs.night)) {
        throw new Error(messages.MISSING_REFERENCE());
    }

    await verifyTlsEndpoint({ ...ctx, timeoutMs: Math.min(ctx.timeoutMs, ctx.budgetMs) });

    const capture = await captureFrames(ctx, {
        count: 1,
        budgetMs: Math.max(1000, ctx.budgetMs - (Date.now() - startMs)),
    });
    const jpeg = capture.frames[0];
    if (!jpeg) {
        throw new Error(messages.NO_FRAME());
    }
    await validateJpegStructure(jpeg);

    const live = await fingerprint(jpeg);

    const thresholdRaw = parseInt(monitor.stream_match_threshold, 10);
    const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : DEFAULT_THRESHOLD;

    let scoreDay = null;
    let scoreNight = null;
    let matchedSlot = null;
    if (separate) {
        scoreDay = distance(live, refs.day, "day");
        scoreNight = distance(live, refs.night, "night");
        matchedSlot = scoreNight < scoreDay ? "Night" : "Day";
    } else {
        scoreDay = distance(live, refs.day, "single");
        matchedSlot = "single";
    }

    const best = scoreNight !== null && (scoreDay === null || scoreNight < scoreDay) ? scoreNight : scoreDay;

    heartbeat.ping = Date.now() - startMs;
    // UI-011: only the Test button consumes this. The scheduled-check
    // path's `heartbeat` is a frozen RedBean bean; adding unmodelled
    // properties would make R.store write a non-existent column.
    // The socket handler sets `_isTestStream` on its ephemeral monitor.
    if (monitor._isTestStream && capture.firstFrameMs != null) {
        heartbeat.firstFrameMs = capture.firstFrameMs;
    }

    if (best <= threshold) {
        heartbeat.status = UP;
        heartbeat.msg = messages.MATCH_OK(matchedSlot, best);
        // The "match" image is only ever shown on the public status
        // page, so only that opt-in pays for the write.
        if (monitor.stream_status_thumbnail) {
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
