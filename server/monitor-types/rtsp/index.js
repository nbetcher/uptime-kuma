const { MonitorType } = require("../monitor-type");
const { log } = require("../../../src/util");
const { basicProbe } = require("./basic-probe");
const { acquireConcurrencyToken, acquireMonitorMutex, clearSkips, SkipCheckError } = require("./concurrency");
const { probeNativeSupport } = require("./frame-capture");
const { messages } = require("./messages");
const { computeBudget, preflight } = require("./url-parse");

// Enhanced/Full need sharp in this process (fingerprints, luminance,
// thumbnails). node-av is never loaded here — decoding runs in a
// worker process (frame-capture.js), whose availability is probed
// separately. Guarded so a sharp that fails to load on this platform
// degrades those modes instead of killing the monitor type (UI-005).
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
 *   - enhanced: capture and inspect frames (node-av worker + sharp)
 *   - full: capture one frame, fingerprint-match against reference
 *
 * See `docs/rtsp-monitor/10-high-level-design.md` for the original
 * design and `11-architecture-review.md` for what changed and why.
 */
class RtspMonitorType extends MonitorType {
    name = "rtsp";
    supportsConditions = false;
    allowCustomStatus = false;

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, server) {
        // Test-button runs share the per-monitor lock with scheduled
        // checks but must not consume the monitor's skip allowance.
        const countSkips = !monitor._isTestStream;
        const budgetMs = computeBudget(monitor);
        const mutex = await acquireMonitorMutex(monitor.id, budgetMs * 2, { countSkips });
        try {
            const ctx = await preflight(monitor);
            const mode = monitor.stream_mode || "basic";

            if (mode === "basic") {
                if (countSkips) {
                    clearSkips(monitor.id);
                }
                return await basicProbe(monitor, heartbeat, ctx);
            }

            if (mode !== "enhanced" && mode !== "full") {
                throw new Error(messages.UNKNOWN_MODE(mode));
            }

            if (ctx.tlsVerify && (ctx.protocol === "rtsps" || ctx.protocol === "rtmps")) {
                throw new Error(messages.VERIFIED_TLS_CAPTURE_UNAVAILABLE);
            }

            const status = await RtspMonitorType.moduleStatus();
            const available = mode === "enhanced" ? status.enhancedAvailable : status.fullAvailable;
            if (!available) {
                throw new Error(
                    mode === "full" && status.enhancedAvailable
                        ? messages.FULL_MODE_UNAVAILABLE
                        : messages.NODE_AV_UNAVAILABLE
                );
            }

            const token = await acquireConcurrencyToken(monitor, ctx.budgetMs, { countSkips });
            try {
                if (countSkips) {
                    clearSkips(monitor.id);
                }
                const impl = mode === "enhanced" ? enhancedCheck : fullCheck;
                return await impl.run(monitor, heartbeat, ctx);
            } finally {
                token.release();
            }
        } finally {
            mutex.release();
        }
    }

    /**
     * Report whether Enhanced/Full mode can run on this server. The
     * native-dependency probe runs in a throwaway worker process once
     * and is cached.
     * @returns {Promise<{enhancedAvailable: boolean, fullAvailable: boolean, enhancedLoadError: string|null, fullLoadError: string|null}>} Availability plus the reason when unavailable
     */
    static async moduleStatus() {
        const native = await probeNativeSupport();
        const workerError = native.nodeAv || native.sharp;
        const enhancedError = workerError || enhancedLoadError?.message || null;
        const fullError = enhancedError || fullLoadError?.message || null;
        return {
            enhancedAvailable: !enhancedError,
            fullAvailable: !fullError,
            enhancedLoadError: enhancedError,
            fullLoadError: fullError,
        };
    }
}

module.exports = {
    RtspMonitorType,
    SkipCheckError,
};
