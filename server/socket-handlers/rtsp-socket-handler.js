const { R } = require("redbean-node");
const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");

const VALID_SLOTS = ["day", "night", "single"];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Load the monitor row and assert (a) it exists, (b) it is an RTSP
 * monitor, (c) the calling socket's user owns it.
 *
 * @param {object} socket Socket.io socket (must have userID)
 * @param {number} monitorId Monitor id
 * @returns {Promise<object>} The bean
 */
async function loadMonitorOrThrow(socket, monitorId) {
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
    if (bean.type !== "rtsp") {
        throw new Error("Not a stream monitor");
    }
    return bean;
}

/**
 * Derive the monitored hostname from the monitor row (URL hostname or
 * the legacy `hostname` column). Used by the SSRF carveout.
 * @param {object} bean Monitor bean
 * @returns {string|null}
 */
function monitorHostname(bean) {
    if (bean.hostname) return bean.hostname;
    if (!bean.url) return null;
    try {
        return new URL(bean.url).hostname;
    } catch {
        return null;
    }
}

/**
 * Build an ephemeral monitor-shaped object from a form payload for
 * the test-stream probe. No DB writes occur.
 * @param {object} formMonitor Form state from the frontend
 * @returns {object} Stub that satisfies `RtspMonitorType.check()`
 */
function buildEphemeralMonitor(formMonitor) {
    return {
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
        stream_status_thumbnail: false,
        stream_keep_down_images: false,
        stream_reference_day_hash: null,
        stream_reference_night_hash: null,
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
 *   - rtsp:uploadReference(monitorId, slot, { data?, url? }, cb)
 *   - rtsp:getReference(monitorId, slot, cb) — returns base64
 *   - rtsp:refreshReference(monitorId, slot, cb)
 *   - rtsp:deleteReference(monitorId, slot, cb)
 *   - rtsp:testStream(formMonitor, cb)
 *
 * @param {object} socket socket.io socket
 * @returns {void}
 */
module.exports.rtspSocketHandler = function (socket) {
    socket.on("rtsp:uploadReference", async (monitorId, slot, payload, callback) => {
        try {
            checkLogin(socket);
            if (!VALID_SLOTS.includes(slot)) throw new Error(`invalid slot: ${slot}`);
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
                let bytes;
                try {
                    bytes = Buffer.from(body.data, "base64");
                } catch (e) {
                    throw new Error(`invalid base64: ${e.message}`);
                }
                if (bytes.length === 0) throw new Error("empty upload");
                if (bytes.length > MAX_UPLOAD_BYTES) {
                    throw new Error(`upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
                }
                result = await refStore.uploadBlob({
                    monitorId: bean.id,
                    slot,
                    bytes,
                    userId: socket.userID || null,
                });
            } else {
                throw new Error("either `data` (base64) or `url` is required");
            }
            callback({ ok: true, ...result });
        } catch (e) {
            log.error("rtsp", `uploadReference: ${e.message}`);
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:getReference", async (monitorId, slot, callback) => {
        try {
            checkLogin(socket);
            if (!VALID_SLOTS.includes(slot)) throw new Error(`invalid slot: ${slot}`);
            const bean = await loadMonitorOrThrow(socket, parseInt(monitorId, 10));
            const refStore = require("../monitor-types/rtsp/reference-store");
            const buf = await refStore.getBlob({ monitorId: bean.id, slot });
            if (!buf) {
                callback({ ok: false, msg: "no reference for this slot" });
                return;
            }
            callback({
                ok: true,
                slot,
                byteSize: buf.length,
                dataBase64: buf.toString("base64"),
                contentType: "image/jpeg",
            });
        } catch (e) {
            log.error("rtsp", `getReference: ${e.message}`);
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:refreshReference", async (monitorId, slot, callback) => {
        try {
            checkLogin(socket);
            if (!VALID_SLOTS.includes(slot)) throw new Error(`invalid slot: ${slot}`);
            const bean = await loadMonitorOrThrow(socket, parseInt(monitorId, 10));
            const refStore = require("../monitor-types/rtsp/reference-store");
            const result = await refStore.refreshUrl({
                monitorId: bean.id,
                slot,
                monitorHostname: monitorHostname(bean),
                userId: socket.userID || null,
            });
            callback({ ok: true, ...result });
        } catch (e) {
            log.error("rtsp", `refreshReference: ${e.message}`);
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:listDownImages", async (monitorId, callback) => {
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
            callback({ ok: true, images });
        } catch (e) {
            log.error("rtsp", `listDownImages: ${e.message}`);
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:deleteReference", async (monitorId, slot, callback) => {
        try {
            checkLogin(socket);
            if (!VALID_SLOTS.includes(slot)) throw new Error(`invalid slot: ${slot}`);
            const bean = await loadMonitorOrThrow(socket, parseInt(monitorId, 10));
            const refStore = require("../monitor-types/rtsp/reference-store");
            await refStore.deleteSlot({
                monitorId: bean.id,
                slot,
                userId: socket.userID || null,
            });
            callback({ ok: true });
        } catch (e) {
            log.error("rtsp", `deleteReference: ${e.message}`);
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("rtsp:testStream", async (formMonitor, callback) => {
        try {
            checkLogin(socket);
            if (!formMonitor || formMonitor.type !== "rtsp") {
                throw new Error("test-stream is for type=rtsp only");
            }
            const stub = buildEphemeralMonitor(formMonitor);
            const heartbeat = { msg: "", status: 0 };
            const { RtspMonitorType } = require("../monitor-types/rtsp");
            const type = new RtspMonitorType();
            let warningKeyframeInterval = null;

            try {
                await type.check(stub, heartbeat, null);
            } catch (err) {
                callback({
                    ok: false,
                    mode: stub.stream_mode,
                    msg: err.message,
                });
                return;
            }

            // UI-011: surface a localised warning when the keyframe
            // cadence is too sparse for the configured interval. The
            // check function (enhanced-check.js / full-check.js)
            // populates heartbeat.keyframeIntervalSec on the same
            // session it already opened — no second round-trip.
            if (stub.stream_mode === "enhanced" || stub.stream_mode === "full") {
                if (heartbeat.keyframeIntervalSec != null) {
                    const halfInterval = (stub.interval || 60) / 2;
                    if (heartbeat.keyframeIntervalSec > halfInterval) {
                        warningKeyframeInterval = {
                            key: "RTSP Keyframe Interval Warning",
                            args: [Math.round(heartbeat.keyframeIntervalSec), stub.interval || 60],
                        };
                    }
                }
            }

            callback({
                ok: true,
                mode: stub.stream_mode,
                msg: heartbeat.msg,
                ping: heartbeat.ping,
                warningKeyframeInterval,
            });
        } catch (e) {
            log.error("rtsp", `testStream: ${e.message}`);
            callback({ ok: false, msg: e.message });
        }
    });
};
