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
 * @param {object} monitor Incoming monitor JSON
 * @param {object} bean DB bean (used to read existing reference state
 *     for edit-time validation — references are uploaded separately
 *     and may already be present on the bean)
 * @returns {void}
 */
function validateStreamMonitor(monitor, bean) {
    if (monitor.type !== "rtsp") return;

    if (!monitor.url) {
        throw new Error("RTSP/RTMP monitors require a URL");
    }

    if (monitor.streamProtocol && !VALID_PROTOCOLS.includes(monitor.streamProtocol)) {
        throw new Error(`Invalid streamProtocol: ${monitor.streamProtocol}`);
    }

    if (monitor.streamTransport && !VALID_TRANSPORTS.includes(monitor.streamTransport)) {
        throw new Error(`Invalid streamTransport: ${monitor.streamTransport}`);
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
        if (!Number.isFinite(b) || b < 5 || b > 300) {
            throw new Error("streamWallClockBudgetSec must be between 5 and 300");
        }
    }

    // FR-019b: Full mode requires at least one reference image.
    if (mode === "full") {
        const dayBlob =
            (bean && bean.stream_reference_day_blob) ||
            monitor.streamReferenceDayHasBlob;
        const nightBlob =
            (bean && bean.stream_reference_night_blob) ||
            monitor.streamReferenceNightHasBlob;
        const separate = monitor.streamSeparateDayNight !== false;

        if (separate) {
            if (!dayBlob) {
                throw new Error("Full mode with Separate Day/Night requires a Day reference image");
            }
            if (!nightBlob) {
                throw new Error("Full mode with Separate Day/Night requires a Night reference image");
            }
        } else {
            // Single-reference mode: Day slot reused.
            if (!dayBlob) {
                throw new Error("Full mode requires a reference image");
            }
        }
    }
}

module.exports = {
    VALID_PROTOCOLS,
    VALID_TRANSPORTS,
    VALID_MODES,
    validateStreamMonitor,
};
