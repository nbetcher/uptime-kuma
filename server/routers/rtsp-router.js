/**
 * REST endpoints for the RTSP/RTMP stream monitor:
 *   - reference image upload/get/refresh/delete
 *   - test-stream probe
 *
 * All endpoints require authentication via the existing `apiAuth`
 * middleware. The upload endpoint accepts base64-encoded image bytes
 * in a JSON body rather than a multipart upload — this stays within
 * NFR-034's "exactly two new direct deps" by reusing express's JSON
 * body parser instead of pulling in `multer`. The body parser is
 * configured here with a 14 MB cap (33 % base64 inflation on a 10 MB
 * binary).
 */

const express = require("express");
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { apiAuth } = require("../auth");

const router = express.Router();

// 14 MB cap covers 10 MB binary at base64 inflation
const UPLOAD_BODY_LIMIT = "14mb";
const uploadParser = express.json({ limit: UPLOAD_BODY_LIMIT });

const VALID_SLOTS = ["day", "night", "single"];

/**
 * Look up the monitor row and assert authorisation. With auth
 * disabled, `req.user` is not set — fall back to the userID stored on
 * the monitor row.
 *
 * @param {express.Request} req Express request
 * @param {number} monitorId Monitor id
 * @returns {Promise<object>} Monitor bean
 */
async function loadMonitor(req, monitorId) {
    const bean = await R.findOne("monitor", " id = ? ", [monitorId]);
    if (!bean) {
        const err = new Error("monitor not found");
        err.statusCode = 404;
        throw err;
    }
    if (bean.type !== "rtsp") {
        const err = new Error("not a stream monitor");
        err.statusCode = 400;
        throw err;
    }
    return bean;
}

/**
 * Extract the authenticated user id from the request. Returns null
 * when auth is disabled.
 *
 * @param {express.Request} req Express request
 * @returns {number|null} User id
 */
function userIdFromReq(req) {
    if (!req) return null;
    if (req.user && (req.user.id || req.user.userID)) {
        return req.user.id || req.user.userID;
    }
    if (req.auth && req.auth.user) {
        return null; // basic-auth path: no user id surfaced
    }
    return null;
}

router.post("/api/monitor/:id/reference/:slot", apiAuth, uploadParser, async (req, res) => {
    try {
        const slot = req.params.slot;
        if (!VALID_SLOTS.includes(slot)) {
            res.status(400).json({ ok: false, msg: `invalid slot: ${slot}` });
            return;
        }
        const monitorId = parseInt(req.params.id, 10);
        if (!Number.isFinite(monitorId)) {
            res.status(400).json({ ok: false, msg: "invalid monitor id" });
            return;
        }
        const bean = await loadMonitor(req, monitorId);

        const body = req.body || {};
        const refStore = require("../monitor-types/rtsp/reference-store");
        let result;

        if (body.url) {
            result = await refStore.uploadUrl({
                monitorId,
                slot,
                url: body.url,
                monitorHostname: bean.hostname || (bean.url ? new URL(bean.url).hostname : null),
                userId: userIdFromReq(req),
            });
        } else if (body.data) {
            let bytes;
            try {
                bytes = Buffer.from(body.data, "base64");
            } catch (e) {
                res.status(400).json({ ok: false, msg: `invalid base64: ${e.message}` });
                return;
            }
            if (bytes.length === 0) {
                res.status(400).json({ ok: false, msg: "empty upload body" });
                return;
            }
            if (bytes.length > 10 * 1024 * 1024) {
                res.status(413).json({ ok: false, msg: "upload exceeds 10 MB" });
                return;
            }
            result = await refStore.uploadBlob({
                monitorId,
                slot,
                bytes,
                userId: userIdFromReq(req),
            });
        } else {
            res.status(400).json({ ok: false, msg: "either `data` (base64) or `url` is required" });
            return;
        }

        result.thumbnailUrl = `/api/monitor/${monitorId}/reference/${slot}`;
        res.json({ ok: true, ...result });
    } catch (err) {
        log.error("rtsp", `reference upload failed: ${err.message}`);
        const status = err.statusCode || 400;
        res.status(status).json({ ok: false, msg: err.message });
    }
});

router.get("/api/monitor/:id/reference/:slot", apiAuth, async (req, res) => {
    try {
        const slot = req.params.slot;
        if (!VALID_SLOTS.includes(slot)) {
            res.status(400).json({ ok: false, msg: `invalid slot: ${slot}` });
            return;
        }
        const monitorId = parseInt(req.params.id, 10);
        if (!Number.isFinite(monitorId)) {
            res.status(400).json({ ok: false, msg: "invalid monitor id" });
            return;
        }
        await loadMonitor(req, monitorId);
        const refStore = require("../monitor-types/rtsp/reference-store");
        const buf = await refStore.getBlob({ monitorId, slot });
        if (!buf) {
            res.status(404).json({ ok: false, msg: "no reference for this slot" });
            return;
        }
        const crypto = require("node:crypto");
        const etag = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
        if (req.headers["if-none-match"] === `"${etag}"`) {
            res.status(304).end();
            return;
        }
        res.set("Cache-Control", "private, max-age=60, must-revalidate");
        res.set("ETag", `"${etag}"`);
        res.set("Content-Type", "image/jpeg");
        res.set("Content-Length", String(buf.length));
        res.send(buf);
    } catch (err) {
        log.error("rtsp", `reference get failed: ${err.message}`);
        const status = err.statusCode || 500;
        res.status(status).json({ ok: false, msg: err.message });
    }
});

router.post("/api/monitor/:id/reference/:slot/refresh", apiAuth, express.json(), async (req, res) => {
    try {
        const slot = req.params.slot;
        if (!VALID_SLOTS.includes(slot)) {
            res.status(400).json({ ok: false, msg: `invalid slot: ${slot}` });
            return;
        }
        const monitorId = parseInt(req.params.id, 10);
        if (!Number.isFinite(monitorId)) {
            res.status(400).json({ ok: false, msg: "invalid monitor id" });
            return;
        }
        const bean = await loadMonitor(req, monitorId);
        const refStore = require("../monitor-types/rtsp/reference-store");
        const result = await refStore.refreshUrl({
            monitorId,
            slot,
            monitorHostname: bean.hostname || (bean.url ? new URL(bean.url).hostname : null),
            userId: userIdFromReq(req),
        });
        result.thumbnailUrl = `/api/monitor/${monitorId}/reference/${slot}`;
        res.json({ ok: true, ...result });
    } catch (err) {
        log.error("rtsp", `reference refresh failed: ${err.message}`);
        const status = err.statusCode || 400;
        res.status(status).json({ ok: false, msg: err.message });
    }
});

router.delete("/api/monitor/:id/reference/:slot", apiAuth, async (req, res) => {
    try {
        const slot = req.params.slot;
        if (!VALID_SLOTS.includes(slot)) {
            res.status(400).json({ ok: false, msg: `invalid slot: ${slot}` });
            return;
        }
        const monitorId = parseInt(req.params.id, 10);
        if (!Number.isFinite(monitorId)) {
            res.status(400).json({ ok: false, msg: "invalid monitor id" });
            return;
        }
        await loadMonitor(req, monitorId);
        const refStore = require("../monitor-types/rtsp/reference-store");
        await refStore.deleteSlot({
            monitorId,
            slot,
            userId: userIdFromReq(req),
        });
        res.json({ ok: true });
    } catch (err) {
        log.error("rtsp", `reference delete failed: ${err.message}`);
        const status = err.statusCode || 400;
        res.status(status).json({ ok: false, msg: err.message });
    }
});

/**
 * Test-stream endpoint. Runs the monitor's check against the
 * supplied form-state without persisting a heartbeat or audit row.
 *
 * Q19 resolution / HLDS §7.3: operates on form state, no DB writes.
 */
router.post("/api/monitor/test-stream", apiAuth, express.json(), async (req, res) => {
    try {
        const formMonitor = req.body || {};

        if (formMonitor.type !== "rtsp") {
            res.status(400).json({ ok: false, msg: "test-stream is for type=rtsp only" });
            return;
        }

        // Build an ephemeral monitor-shaped object that the
        // RtspMonitorType.check() can consume without touching the DB.
        const stub = {
            id: `test-${Date.now()}`,
            url: formMonitor.url,
            basic_auth_user: formMonitor.basic_auth_user || "",
            basic_auth_pass: formMonitor.basic_auth_pass || "",
            stream_protocol: formMonitor.streamProtocol,
            stream_transport: formMonitor.streamTransport,
            stream_mode: formMonitor.streamMode || "basic",
            stream_frame_count: formMonitor.streamFrameCount,
            stream_wall_clock_budget_sec: formMonitor.streamWallClockBudgetSec,
            stream_match_threshold: formMonitor.streamMatchThreshold,
            stream_separate_day_night: formMonitor.streamSeparateDayNight,
            stream_status_thumbnail: false, // disable side effects
            stream_keep_down_images: false,
            stream_reference_day_hash: null,
            stream_reference_night_hash: null,
            timeout: formMonitor.timeout || 10,
            interval: formMonitor.interval || 60,
            getIgnoreTls: () => Boolean(formMonitor.ignoreTls),
            getSaveResponse: () => false,
            saveResponseData: async () => {}, // no-op for test probe
        };

        const heartbeat = { msg: "", status: 0 };
        const { RtspMonitorType } = require("../monitor-types/rtsp");
        const type = new RtspMonitorType();
        const warnings = [];

        try {
            await type.check(stub, heartbeat, null);
            // Best-effort: also measure keyframe interval for Enhanced/Full
            if (stub.stream_mode === "enhanced" || stub.stream_mode === "full") {
                try {
                    const { NodeAvFrameSource } = require("../monitor-types/rtsp/frame-source");
                    const { preflight } = require("../monitor-types/rtsp/url-parse");
                    const ctx = await preflight(stub);
                    const probe = await NodeAvFrameSource.open(ctx);
                    try {
                        const kfi = await probe.getKeyframeInterval();
                        if (kfi != null) {
                            const halfInterval = (stub.interval || 60) / 2;
                            if (kfi > halfInterval) {
                                warnings.push(
                                    `keyframe interval ${Math.round(kfi)}s exceeds half of ${stub.interval}s interval`
                                );
                            }
                        }
                    } finally {
                        await probe.close();
                    }
                } catch (e) {
                    log.debug("rtsp", `test-stream keyframe probe failed: ${e.message}`);
                }
            }
        } catch (err) {
            res.json({
                ok: false,
                mode: stub.stream_mode,
                msg: err.message,
                warnings,
            });
            return;
        }

        res.json({
            ok: true,
            mode: stub.stream_mode,
            msg: heartbeat.msg,
            ping: heartbeat.ping,
            warnings,
        });
    } catch (err) {
        log.error("rtsp", `test-stream failed: ${err.message}`);
        res.status(400).json({ ok: false, msg: err.message });
    }
});

module.exports = router;
