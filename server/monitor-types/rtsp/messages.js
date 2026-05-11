/**
 * Heartbeat-message catalog for the RTSP/RTMP monitor.
 *
 * All user-facing strings produced by the monitor flow through this
 * module. The patterns are stable across releases so users can build
 * alert rules with substring or regex matches against the heartbeat
 * `msg` field — see HLDS §10.2 and NFR-040.
 */

exports.messages = {
    // === Preflight ===
    DNS_FAILURE: (reason) => `DNS resolution failed: ${reason}`,
    URL_SCHEME_MISMATCH: (proto) => `URL scheme ${proto} does not match selected protocol`,
    UNKNOWN_PROTOCOL: (proto) => `unknown protocol: ${proto}`,
    UNKNOWN_MODE: (mode) => `unknown mode: ${mode}`,
    INVALID_URL: (reason) => `invalid URL: ${reason}`,

    // === Basic ===
    RTSP_OK: (code) => `RTSP OPTIONS reply: ${code}`,
    RTSP_REDIRECT: (code) => `RTSP OPTIONS reply: ${code} (redirect; treating as alive)`,
    RTSP_SERVER_ERROR: (code) => `RTSP OPTIONS reply: ${code} (server alive but reports error)`,
    RTSP_NOT_SPOKEN: () => "server did not speak RTSP",
    RTMP_OK: () => "RTMP S0/S1 handshake completed",
    RTMP_NOT_SPOKEN: () => "server did not speak RTMP",

    // === Connect ===
    CONNECTION_REFUSED: () => "connection refused",
    CONNECTION_TIMEOUT: (ms) => `connection timeout after ${ms}ms`,
    CONNECTION_RESET: () => "connection reset by peer",
    TLS_HOSTNAME_MISMATCH: (got) => `TLS hostname does not match certificate (got ${got})`,
    TLS_CERT_INVALID: (reason) => `TLS certificate invalid: ${reason}`,

    // === Enhanced ===
    INSUFFICIENT_FRAMES: (got, wanted) => `only ${got}/${wanted} valid frames captured`,
    FROZEN_FRAME: (n) => `stream appears frozen — ${n} identical frames`,
    BLACK_FRAME: (s) => `stream appears black or uniform (mean=${s.mean}, stddev=${s.stddev})`,
    ENHANCED_OK: (n, ms) => `captured ${n} frames in ${ms}ms`,
    FRAME_INVALID: (reason) => `frame validation failed: ${reason}`,

    // === Full ===
    MATCH_OK: (which, dist) => `matched ${which} at distance ${dist}/128`,
    MATCH_FAIL: (day, night, thr) => {
        // Symmetric handling: either score may be null when the
        // corresponding reference slot is unset (single-ref mode or
        // partial config).
        const dayPresent = day !== null && day !== undefined;
        const nightPresent = night !== null && night !== undefined;
        if (dayPresent && nightPresent) {
            return `scene mismatch: distance ${Math.min(day, night)}/128 > threshold ${thr}/128 (Day=${day}, Night=${night})`;
        }
        if (dayPresent) return `scene mismatch: distance ${day}/128 > threshold ${thr}/128`;
        if (nightPresent) return `scene mismatch: distance ${night}/128 > threshold ${thr}/128`;
        return `scene mismatch: no scores computed`;
    },
    NO_FRAME: () => "no frames received within wall-clock budget",
    MISSING_REFERENCE: () => "Full mode requires at least one reference image",

    // === Infra ===
    NODE_AV_UNAVAILABLE: "node-av failed to load — Enhanced/Full mode unavailable on this platform",
    TIMED_OUT: (ms) => `timed out after ${ms}ms`,
    DECODE_FAILED: (reason) => `decode failed: ${reason}`,
};
