const { log } = require("../../../src/util");
const { messages } = require("./messages");

const DEFAULT_PORTS = {
    rtsp: 554,
    rtsps: 322,
    rtmp: 1935,
    rtmps: 443, // user can override; commercial RTMPS commonly 443 or 4935
};

/**
 * Compute the wall-clock budget for an Enhanced/Full check.
 *
 * Per NFR-002: `budget = clamp(interval / 3, 5, 30)` seconds. The
 * monitor may carry an explicit override via
 * `stream_wall_clock_budget_sec`.
 * @param {object} monitor Monitor row from the DB
 * @returns {number} Budget in milliseconds
 */
function computeBudget(monitor) {
    const overrideSec = parseInt(monitor.stream_wall_clock_budget_sec, 10);
    if (Number.isFinite(overrideSec) && overrideSec > 0) {
        // Clamp overrides to the same 5..30s envelope NFR-002
        // defines — without this, a user-supplied override defeats
        // the budget and can starve the global decode bucket.
        const clamped = Math.max(5, Math.min(30, overrideSec));
        return clamped * 1000;
    }
    const intervalSec = parseInt(monitor.interval, 10) || 60;
    const clamped = Math.max(5, Math.min(30, Math.floor(intervalSec / 3)));
    return clamped * 1000;
}

/**
 * Preflight: parse the URL, validate scheme, normalise transport, fold
 * URL-embedded credentials into the form-supplied credentials, compute
 * the wall-clock budget. Returns a `ctx` object consumed by the
 * mode-specific check functions.
 * @param {object} monitor Monitor row
 * @returns {Promise<object>} preflight context
 */
async function preflight(monitor) {
    if (!monitor.url) {
        throw new Error(messages.INVALID_URL("URL is required"));
    }

    let url;
    try {
        url = new URL(monitor.url);
    } catch (e) {
        // NFR-020: scrub any user:pass@ portion from the input before
        // echoing it back in the error message — even though URL
        // parse failed, the input bytes are still readable.
        const scrubbed = String(monitor.url).replace(/(\b\w+):\/\/[^:/@\s]+:[^@/\s]+@/, "$1://***:***@");
        throw new Error(messages.INVALID_URL(`${e.message} (input: ${scrubbed.substring(0, 80)})`));
    }

    const proto = url.protocol.replace(":", "").toLowerCase();
    if (!["rtsp", "rtsps", "rtmp", "rtmps"].includes(proto)) {
        throw new Error(messages.UNKNOWN_PROTOCOL(proto));
    }

    if (monitor.stream_protocol && proto !== monitor.stream_protocol) {
        log.warn(
            "rtsp",
            `URL scheme ${proto} disagrees with selected protocol ${monitor.stream_protocol} on monitor ${monitor.id}; using URL scheme`
        );
    }

    const port = parseInt(url.port, 10) || DEFAULT_PORTS[proto];

    // Credentials precedence (FR-030 / HLDS §5.4 step 4):
    //   form-supplied basic_auth_user/basic_auth_pass win;
    //   URL-embedded credentials are stripped and only used as
    //   fallback when the form fields are empty.
    let username = monitor.basic_auth_user || "";
    let password = monitor.basic_auth_pass || "";
    if (url.username || url.password) {
        if (username || password) {
            log.warn(
                "rtsp",
                `URL credentials shadowed by form fields on monitor ${monitor.id}`
            );
        } else {
            // URL class returns percent-encoded values
            try {
                username = decodeURIComponent(url.username);
                password = decodeURIComponent(url.password);
            } catch {
                username = url.username;
                password = url.password;
            }
        }
        url.username = "";
        url.password = "";
    }

    // UI-007: ?rtsp_transport= URL parameter is ignored; the dedicated
    // transport selector is canonical. The UI shows a warning; we
    // strip the parameter on the server too as defence-in-depth.
    if (url.searchParams.has("rtsp_transport")) {
        log.warn(
            "rtsp",
            `?rtsp_transport= in URL ignored on monitor ${monitor.id}`
        );
        url.searchParams.delete("rtsp_transport");
    }

    const tlsVerify = !monitor.getIgnoreTls?.() && (proto === "rtsps" || proto === "rtmps");
    const transport = (monitor.stream_transport || "tcp").toLowerCase();
    const budgetMs = computeBudget(monitor);
    const timeoutMs = (parseInt(monitor.timeout, 10) || 10) * 1000;

    return {
        url: url.toString(),
        protocol: proto,
        host: url.hostname,
        port,
        path: url.pathname + (url.search || ""),
        username,
        password,
        tlsVerify,
        transport,
        budgetMs,
        timeoutMs,
    };
}

/**
 * UI helper: returns true if the URL string contains a
 * `?rtsp_transport=` query parameter. Used by the EditMonitor.vue
 * warning chip (UI-007).
 * @param {string} urlStr URL to inspect
 * @returns {boolean} True if rtsp_transport parameter present
 */
function urlContainsRtspTransport(urlStr) {
    if (!urlStr || typeof urlStr !== "string") return false;
    try {
        const u = new URL(urlStr);
        return u.searchParams.has("rtsp_transport");
    } catch {
        return false;
    }
}

module.exports = {
    DEFAULT_PORTS,
    computeBudget,
    preflight,
    urlContainsRtspTransport,
};
