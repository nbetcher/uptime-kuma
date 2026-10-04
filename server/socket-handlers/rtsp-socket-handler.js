const { R } = require("redbean-node");
const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");

const VALID_SLOTS = ["day", "night", "single"];

// The browser downscales references to ≤1280 px JPEG before sending
// (ReferenceImagePanel.vue), and the server canonicalises to 640 px
// anyway. Keeping uploads well under socket.io's default 1 MB message
// cap means the cap does not have to be raised for every client —
// including unauthenticated ones.
const MAX_UPLOAD_BYTES = 700 * 1024;

/**
 * Wrap a socket.io ack callback so handlers can call it freely
 * even when a malformed/forgotten client sent the event without an
 * ack. Without this, calling `callback(...)` raises TypeError
 * inside an async handler and surfaces as an unhandled rejection.
 * @param {unknown} cb Possible callback
 * @returns {Function} Always-callable ack
 */
function safeCallback(cb) {
    return typeof cb === "function" ? cb : () => {};
}

/**
 * Load the monitor row and assert (a) it exists, (b) it is an RTSP
 * monitor unless `requireRtsp` is false, (c) the calling socket's user
 * owns it.
 * @param {object} socket Socket.io socket (must have userID)
 * @param {number} monitorId Monitor id
 * @param {boolean} requireRtsp Reject non-RTSP monitors (default true)
 * @returns {Promise<object>} The bean
 */
async function loadMonitorOrThrow(socket, monitorId, requireRtsp = true) {
    const bean = await R.findOne("monitor", " id = ? ", [monitorId]);
    if (!bean) {
        throw new Error("Monitor not found");
    }
    // Defensive number-coerce: the redbean driver returns user_id as a
    // number for SQLite/MariaDB integer columns, but a future change
    // to how socket.userID is stored (e.g. session restoration) could
    // surface it as a string. `==` would have worked but eslint flags
    // it; explicit `Number(...)` is clearer.
    if (Number(bean.user_id) !== Number(socket.userID)) {
        throw new Error("Permission denied");
    }
    if (requireRtsp && bean.type !== "rtsp") {
        throw new Error("Not a stream monitor");
    }
    return bean;
}

/**
 * Derive the monitored hostname from the monitor row (URL hostname or
 * the legacy `hostname` column). Used by the SSRF carveout.
 * @param {object} bean Monitor bean
 * @returns {string|null} Resolved hostname for allow-list validation
 */
function monitorHostname(bean) {
    if (bean.hostname) {
        return bean.hostname;
    }
    if (!bean.url) {
        return null;
    }
    try {
        return new URL(bean.url).hostname;
    } catch {
        return null;
    }
}

/**
 * Decode an uploaded reference image sent either as binary (socket.io
 * delivers a Buffer) or as a base64 string (older clients).
 * @param {unknown} data Upload payload
 * @returns {Buffer} Image bytes
 */
function decodeUpload(data) {
    let bytes;
    if (Buffer.isBuffer(data)) {
        bytes = data;
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        bytes = Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
    } else if (typeof data === "string") {
        bytes = Buffer.from(data, "base64");
    } else {
        throw new Error("upload data must be binary or base64");
    }
    if (bytes.length === 0) {
        throw new Error("empty upload");
    }
    if (bytes.length > MAX_UPLOAD_BYTES) {
        throw new Error(`upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
    }
    return bytes;
}

/**
 * Build an ephemeral monitor-shaped object from a form payload for
 * the test-stream probe. No DB writes occur.
 *
 * If the form belongs to a saved monitor, the test uses its id for the
 * per-monitor mutex (so a Test can't race a scheduled check against
 * the same camera) and Full mode compares against that monitor's
 * stored references. The persistence-side write paths are gated to
 * `false` here, so reusing the real id is safe — no rows are inserted
 * or updated.
 * @param {object} formMonitor Form state from the frontend
 * @param {number|null} savedId Id of the caller's saved monitor, if any
 * @returns {object} Stub that satisfies `RtspMonitorType.check()`
 */
function buildEphemeralMonitor(formMonitor, savedId) {
    const id = savedId || `test-${Date.now()}`;
    return {
        id,
        // Marker read by enhanced/full check so they may attach
        // non-DB-column diagnostics (firstFrameMs) to the heartbeat
        // object, and by RtspMonitorType so a Test does not count
        // toward the monitor's skip allowance. Never set on a real
        // Monitor bean — keeps R.store off the path for those
        // properties.
        _isTestStream: true,
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
        // Hard-disable any persistence side-effect for the test path
        // — full-check.js and reference-store.persistFrameImage gate
        // on these flags, so test invocations cannot write rows even
        // when a real monitor.id is reused for the mutex.
        stream_status_thumbnail: false,
        stream_keep_down_images: false,
        timeout: formMonitor.timeout || 10,
        interval: formMonitor.interval || 60,
        getIgnoreTls: () => Boolean(formMonitor.ignoreTls),
        getSaveResponse: () => false,
        saveResponseData: async () => {},
    };
}

/**
 * Register the stream-monitor socket handlers on a socket.
 *
 * Events:
 * - rtsp:uploadReference(monitorId, slot, { data?, url? }, cb) — data is binary
 * - rtsp:getReferenceInfo(monitorId, cb) — slot metadata, no image bytes
 * - rtsp:getReference(monitorId, slot, cb) — returns base64
 * - rtsp:refreshReference(monitorId, slot, cb)
 * - rtsp:deleteReference(monitorId, slot, cb)
 * - rtsp:listDownImages(monitorId, cb)
 * - rtsp:testStream(formMonitor, cb)
 * - rtsp:getModuleStatus(cb)
 * @param {object} socket socket.io socket
 * @returns {void}
 */
module.exports.rtspSocketHandler = function (socket) {
    socket.on("rtsp:getModuleStatus", async (callback) => {
        const cb = safeCallback(callback);
        try {
            checkLogin(socket);
            const { RtspMonitorType } = require("../monitor-types/rtsp");
            const { messages } = require("../monitor-types/rtsp/messages");
            const status = await RtspMonitorType.moduleStatus();
            let msg = null;
            let detail = null;

            if (!status.enhancedAvailable) {
                msg = messages.NODE_AV_UNAVAILABLE;
                detail = status.enhancedLoadError;
            } else if (!status.fullAvailable) {
                msg = messages.FULL_MODE_UNAVAILABLE;
                detail = status.fullLoadError;
            }

            cb({
                ok: true,
                enhancedAvailable: status.enhancedAvailable,
                fullAvailable: status.fullAvailable,
                msg,
                detail,
            });
        } catch (e) {
            log.error("rtsp", `getModuleStatus: ${e.message}`);
            cb({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:uploadReference", async (monitorId, slot, payload, callback) => {
        const cb = safeCallback(callback);
        try {
            checkLogin(socket);
            if (!VALID_SLOTS.includes(slot)) {
                throw new Error(`invalid slot: ${slot}`);
            }
            const bean = await loadMonitorOrThrow(socket, parseInt(monitorId, 10));
            const refStore = require("../monitor-types/rtsp/reference-store");

            const body = payload || {};
            let result;
            if (body.url) {
                result = await refStore.uploadUrl({
                    monitorId: bean.id,
                    slot,
                    url: body.url,
                    monitorHostname: monitorHostname(bean),
                    userId: socket.userID || null,
                });
            } else if (body.data) {
                result = await refStore.uploadBlob({
                    monitorId: bean.id,
                    slot,
                    bytes: decodeUpload(body.data),
                    userId: socket.userID || null,
                });
            } else {
                throw new Error("either `data` (binary or base64) or `url` is required");
            }
            cb({ ok: true, ...result });
        } catch (e) {
            log.error("rtsp", `uploadReference: ${e.message}`);
            cb({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:getReferenceInfo", async (monitorId, callback) => {
        const cb = safeCallback(callback);
        try {
            checkLogin(socket);
            const bean = await loadMonitorOrThrow(socket, parseInt(monitorId, 10));
            const refStore = require("../monitor-types/rtsp/reference-store");
            cb({ ok: true, references: await refStore.getReferenceInfo(bean.id) });
        } catch (e) {
            log.error("rtsp", `getReferenceInfo: ${e.message}`);
            cb({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:getReference", async (monitorId, slot, callback) => {
        const cb = safeCallback(callback);
        try {
            checkLogin(socket);
            if (!VALID_SLOTS.includes(slot)) {
                throw new Error(`invalid slot: ${slot}`);
            }
            const bean = await loadMonitorOrThrow(socket, parseInt(monitorId, 10));
            const refStore = require("../monitor-types/rtsp/reference-store");
            const buf = await refStore.getBlob({ monitorId: bean.id, slot });
            if (!buf) {
                cb({ ok: false, msg: "no reference for this slot" });
                return;
            }
            cb({
                ok: true,
                slot,
                byteSize: buf.length,
                dataBase64: buf.toString("base64"),
                contentType: "image/jpeg",
            });
        } catch (e) {
            log.error("rtsp", `getReference: ${e.message}`);
            cb({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:refreshReference", async (monitorId, slot, callback) => {
        const cb = safeCallback(callback);
        try {
            checkLogin(socket);
            if (!VALID_SLOTS.includes(slot)) {
                throw new Error(`invalid slot: ${slot}`);
            }
            const bean = await loadMonitorOrThrow(socket, parseInt(monitorId, 10));
            const refStore = require("../monitor-types/rtsp/reference-store");
            const result = await refStore.refreshUrl({
                monitorId: bean.id,
                slot,
                monitorHostname: monitorHostname(bean),
                userId: socket.userID || null,
            });
            cb({ ok: true, ...result });
        } catch (e) {
            log.error("rtsp", `refreshReference: ${e.message}`);
            cb({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:listDownImages", async (monitorId, callback) => {
        const cb = safeCallback(callback);
        try {
            checkLogin(socket);
            const bean = await loadMonitorOrThrow(socket, parseInt(monitorId, 10));
            // UI-014: return the most recent (up to 5) DOWN-frame
            // thumbnails for the incident-detail page. The list is
            // empty if streamKeepDownImages is off — the row never
            // gets inserted in the first place.
            const rows = await R.getAll(
                "SELECT id, captured_at, image_blob FROM monitor_stream_down_image " +
                    "WHERE monitor_id = ? AND kind = 'down' ORDER BY captured_at DESC LIMIT 5",
                [bean.id]
            );
            const images = rows.map((r) => ({
                id: r.id,
                capturedAt: r.captured_at,
                dataBase64: Buffer.isBuffer(r.image_blob)
                    ? r.image_blob.toString("base64")
                    : Buffer.from(r.image_blob).toString("base64"),
            }));
            cb({ ok: true, images });
        } catch (e) {
            log.error("rtsp", `listDownImages: ${e.message}`);
            cb({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:deleteReference", async (monitorId, slot, callback) => {
        const cb = safeCallback(callback);
        try {
            checkLogin(socket);
            if (!VALID_SLOTS.includes(slot)) {
                throw new Error(`invalid slot: ${slot}`);
            }
            const bean = await loadMonitorOrThrow(socket, parseInt(monitorId, 10));
            const refStore = require("../monitor-types/rtsp/reference-store");
            await refStore.deleteSlot({
                monitorId: bean.id,
                slot,
                userId: socket.userID || null,
            });
            cb({ ok: true });
        } catch (e) {
            log.error("rtsp", `deleteReference: ${e.message}`);
            cb({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:testStream", async (formMonitor, callback) => {
        const cb = safeCallback(callback);
        try {
            checkLogin(socket);
            if (!formMonitor || formMonitor.type !== "rtsp") {
                throw new Error("test-stream is for type=rtsp only");
            }
            // A saved monitor's id is only reused after an ownership
            // check: it selects which stored references Full mode
            // compares against. The type is not checked, so a monitor
            // being converted to RTSP can be tested before saving.
            const formId = parseInt(formMonitor.id, 10);
            let savedId = null;
            if (Number.isFinite(formId) && formId > 0) {
                savedId = (await loadMonitorOrThrow(socket, formId, false)).id;
            }
            const stub = buildEphemeralMonitor(formMonitor, savedId);
            const heartbeat = { msg: "", status: 0 };
            const { RtspMonitorType } = require("../monitor-types/rtsp");
            const { computeBudget } = require("../monitor-types/rtsp/url-parse");
            const type = new RtspMonitorType();
            let warningSlowFirstFrame = null;

            try {
                await type.check(stub, heartbeat, null);
            } catch (err) {
                cb({
                    ok: false,
                    mode: stub.stream_mode,
                    msg: err.message,
                });
                return;
            }

            // UI-011: warn when the first decoded frame took more than
            // half the time budget. That is almost always a long
            // keyframe (GOP) interval — the decoder has to wait for the
            // next I-frame — and means scheduled checks will sometimes
            // run out of budget.
            if (heartbeat.firstFrameMs != null) {
                const budgetMs = computeBudget(stub);
                if (heartbeat.firstFrameMs > budgetMs / 2) {
                    warningSlowFirstFrame = {
                        key: "RTSP Slow First Frame Warning",
                        args: [(heartbeat.firstFrameMs / 1000).toFixed(1), Math.round(budgetMs / 1000)],
                    };
                }
            }

            cb({
                ok: true,
                mode: stub.stream_mode,
                msg: heartbeat.msg,
                ping: heartbeat.ping,
                warningSlowFirstFrame,
            });
        } catch (e) {
            log.error("rtsp", `testStream: ${e.message}`);
            cb({ ok: false, msg: e.message });
        }
    });
};
