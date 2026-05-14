const { MonitorType } = require("../monitor-type");
const { log } = require("../../../src/util");
const { basicProbe } = require("./basic-probe");
const { acquireConcurrencyToken, acquireMonitorMutex, SkipCheckError } = require("./concurrency");
const { messages } = require("./messages");
const { preflight } = require("./url-parse");

// Optional submodules — guarded so a broken native dep (node-av or sharp
// failing to load on an unsupported platform) doesn't kill the whole
// monitor type. UI-005 graceful degradation.
let enhancedCheck = null;
let fullCheck = null;
let enhancedLoadError = null;
let fullLoadError = null;

try {
    enhancedCheck = require("./enhanced-check");
} catch (e) {
    enhancedLoadError = e;
    log.warn("rtsp", `Enhanced-mode submodule unavailable: ${e.message}`);
}

try {
    fullCheck = require("./full-check");
} catch (e) {
    fullLoadError = e;
    log.warn("rtsp", `Full-mode submodule unavailable: ${e.message}`);
}

/**
 * Uptime Kuma monitor type for RTSP and RTMP video streams.
 *
 * Three modes:
 *   - basic: hand-rolled OPTIONS/handshake probe
 *   - enhanced: capture and inspect frames (node-av + sharp)
 *   - full: capture one frame, fingerprint-match against reference
 *
 * See `docs/rtsp-monitor/10-high-level-design.md` for the full design.
 */
class RtspMonitorType extends MonitorType {
    name = "rtsp";
    supportsConditions = false;
    allowCustomStatus = false;

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, server) {
        const mutex = await acquireMonitorMutex(monitor.id);
        try {
            const ctx = await preflight(monitor);
            const mode = monitor.stream_mode || "basic";

            if (mode === "basic") {
                return await basicProbe(monitor, heartbeat, ctx);
            }

            if (mode === "enhanced") {
                if (!enhancedCheck) {
                    throw new Error(messages.NODE_AV_UNAVAILABLE);
                }
                const token = await acquireConcurrencyToken(monitor, ctx.budgetMs);
                try {
                    return await enhancedCheck.run(monitor, heartbeat, ctx);
                } finally {
                    token.release();
                }
            }

            if (mode === "full") {
                if (!fullCheck) {
                    throw new Error(enhancedCheck ? messages.FULL_MODE_UNAVAILABLE : messages.NODE_AV_UNAVAILABLE);
                }
                const token = await acquireConcurrencyToken(monitor, ctx.budgetMs);
                try {
                    return await fullCheck.run(monitor, heartbeat, ctx);
                } finally {
                    token.release();
                }
            }

            throw new Error(messages.UNKNOWN_MODE(mode));
        } finally {
            mutex.release();
        }
    }

     /**
      * Module-level test hook: report whether the optional submodules
      * loaded. Used by UI-005 graceful-degradation tests.
      * @returns {{enhancedAvailable: boolean, fullAvailable: boolean, loadError: Error|null, enhancedLoadError: Error|null, fullLoadError: Error|null}} Availability flags plus per-mode load errors
      */
    static moduleStatus() {
        return {
            enhancedAvailable: enhancedCheck !== null,
            fullAvailable: fullCheck !== null,
            loadError: enhancedLoadError || fullLoadError,
            enhancedLoadError,
            fullLoadError,
        };
    }
}

module.exports = {
    RtspMonitorType,
    SkipCheckError,
};
