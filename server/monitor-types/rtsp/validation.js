/**
 * Server-side validation for stream-monitor save events. Mirrors the
 * UI-side validation but is the authoritative gate — the socket
 * handler must call this before `R.store()`.
 *
 * Throws a descriptive Error on validation failure; caller wraps
 * into the existing socket-error envelope.
 */

const VALID_PROTOCOLS = ["rtsp", "rtsps", "rtmp", "rtmps"];
const VALID_TRANSPORTS = ["tcp", "udp"];
const VALID_MODES = ["basic", "enhanced", "full"];

/**
 * Validate the stream-monitor-specific fields of a monitor payload
 * coming from the frontend.
 *
 * For a freshly-added monitor (`references === null`) we cannot enforce
 * FR-019b's "Full mode requires references at save time" — references
 * can only be uploaded *after* the monitor row exists (they're keyed
 * by `monitor_id`). Instead, the runtime check throws
 * `MISSING_REFERENCE` until the user uploads references, which surfaces
 * as a DOWN heartbeat (matches NFR-010's "every plausible failure mode
 * is reported as a DOWN heartbeat"). FR-019b is enforced on
 * `editMonitor`, which passes the saved monitor's reference presence.
 * @param {object} monitor Incoming monitor JSON
 * @param {{day: boolean, night: boolean}|null} references Which reference slots exist (null on add)
 * @returns {void}
 */
function validateStreamMonitor(monitor, references) {
    if (monitor.type !== "rtsp") {
        return;
    }

    if (!monitor.url) {
        throw new Error("RTSP/RTMP monitors require a URL");
    }

    if (monitor.streamProtocol && !VALID_PROTOCOLS.includes(monitor.streamProtocol)) {
        throw new Error(`Invalid streamProtocol: ${monitor.streamProtocol}`);
    }

    if (monitor.streamTransport && !VALID_TRANSPORTS.includes(monitor.streamTransport)) {
        throw new Error(`Invalid streamTransport: ${monitor.streamTransport}`);
    }

    // FR-026: RTMP is TCP-only by specification. Reject a
    // (protocol=rtmp/rtmps + transport=udp) combination explicitly
    // rather than silently ignore the transport at runtime.
    if (
        monitor.streamTransport === "udp" &&
        (monitor.streamProtocol === "rtmp" || monitor.streamProtocol === "rtmps")
    ) {
        throw new Error("RTMP is TCP-only; UDP transport is not supported (FR-026)");
    }

    const mode = monitor.streamMode || "basic";
    if (!VALID_MODES.includes(mode)) {
        throw new Error(`Invalid streamMode: ${mode}`);
    }

    if (monitor.streamFrameCount !== undefined && monitor.streamFrameCount !== null) {
        const n = parseInt(monitor.streamFrameCount, 10);
        if (!Number.isFinite(n) || n < 2 || n > 15) {
            throw new Error("streamFrameCount must be between 2 and 15");
        }
    }

    if (monitor.streamMatchThreshold !== undefined && monitor.streamMatchThreshold !== null) {
        const t = parseInt(monitor.streamMatchThreshold, 10);
        if (!Number.isFinite(t) || t < 0 || t > 128) {
            throw new Error("streamMatchThreshold must be between 0 and 128");
        }
    }

    if (monitor.streamWallClockBudgetSec !== undefined && monitor.streamWallClockBudgetSec !== null) {
        const b = parseInt(monitor.streamWallClockBudgetSec, 10);
        if (!Number.isFinite(b) || b < 5 || b > 30) {
            throw new Error("streamWallClockBudgetSec must be between 5 and 30");
        }
    }

    // FR-019b: Full mode requires at least one reference image.
    // Enforced only when we have a saved monitor row to inspect.
    // For new monitors (references=null), Full mode is permitted; the
    // runtime check throws MISSING_REFERENCE until references are
    // uploaded, which surfaces as a clear DOWN heartbeat.
    if (mode === "full" && references) {
        const separate = monitor.streamSeparateDayNight !== false;

        if (separate) {
            if (!references.day) {
                throw new Error("Full mode with Separate Day/Night requires a Day reference image");
            }
            if (!references.night) {
                throw new Error("Full mode with Separate Day/Night requires a Night reference image");
            }
        } else {
            // Single-reference mode: Day slot reused.
            if (!references.day) {
                throw new Error("Full mode requires a reference image");
            }
        }
    }
}

/**
 * Which reference slots a saved monitor has, for validateStreamMonitor.
 * @param {number} monitorId Monitor ID
 * @returns {Promise<{day: boolean, night: boolean}>} Presence per stored slot
 */
async function loadReferencePresence(monitorId) {
    const { R } = require("redbean-node");
    const rows = await R.getAll("SELECT slot FROM monitor_stream_reference WHERE monitor_id = ?", [monitorId]);
    const slots = new Set(rows.map((row) => row.slot));
    return { day: slots.has("day"), night: slots.has("night") };
}

/**
 * Persist the stream-monitor configuration fields onto a DB bean.
 * Used by both the `add` and `editMonitor` socket handlers so the
 * mapping rules (boolean coercion, ?? null) stay in one place.
 *
 * Reference images live in monitor_stream_reference and are managed
 * by the reference-upload socket handlers, never by the form save.
 * @param {object} bean Monitor bean to mutate
 * @param {object} monitor Form payload
 * @returns {void}
 */
function applyStreamFieldsToBean(bean, monitor) {
    bean.stream_protocol = monitor.streamProtocol || null;
    bean.stream_transport = monitor.streamTransport || null;
    bean.stream_mode = monitor.streamMode || null;
    bean.stream_frame_count = monitor.streamFrameCount ?? null;
    bean.stream_wall_clock_budget_sec = monitor.streamWallClockBudgetSec ?? null;
    bean.stream_match_threshold = monitor.streamMatchThreshold ?? null;
    bean.stream_separate_day_night =
        monitor.streamSeparateDayNight === null || monitor.streamSeparateDayNight === undefined
            ? null
            : Boolean(monitor.streamSeparateDayNight);
    bean.stream_status_thumbnail =
        monitor.streamStatusThumbnail === null || monitor.streamStatusThumbnail === undefined
            ? null
            : Boolean(monitor.streamStatusThumbnail);
    bean.stream_keep_down_images =
        monitor.streamKeepDownImages === null || monitor.streamKeepDownImages === undefined
            ? null
            : Boolean(monitor.streamKeepDownImages);
}

module.exports = {
    VALID_PROTOCOLS,
    VALID_TRANSPORTS,
    VALID_MODES,
    validateStreamMonitor,
    loadReferencePresence,
    applyStreamFieldsToBean,
};
