/**
 * Parent-side frame capture. Forks `frame-worker.js` for every
 * Enhanced/Full check and enforces the wall-clock budget with SIGKILL.
 *
 * Why a process and not an in-process node-av session: libav calls run
 * on the libuv threadpool and do not reliably honour AbortSignal. A
 * camera that accepts TCP and then goes silent leaves the native call
 * blocked forever, and four of those exhaust the default threadpool —
 * at which point every fs / dns.lookup / crypto / sqlite3 call in
 * Uptime Kuma stalls. Killing a child process is the only cancellation
 * that is guaranteed to release the thread, the socket, and the libav
 * context. See `docs/rtsp-monitor/11-architecture-review.md` §2.1.
 */

const { fork } = require("node:child_process");
const path = require("node:path");
const { log } = require("../../../src/util");
const { messages } = require("./messages");
const { scrubUrlCredentialsForLog } = require("./url-parse");

const WORKER_PATH = path.join(__dirname, "frame-worker.js");
const PROBE_TIMEOUT_MS = 30000;
const STDERR_TAIL_CHARS = 2048;

// After the last frame the worker closes the session itself, which
// sends RTSP TEARDOWN. Cameras often allow only a handful of sessions,
// so a clean close matters; it is still bounded, because the close is
// libav code too.
const CLOSE_GRACE_MS = 2000;

// Live frames are downscaled in the worker. Fingerprints are computed
// on a 9×8 resample and references are canonicalised to 640 px, so
// shipping full-resolution frames over IPC buys nothing.
const LIVE_FRAME_MAX_DIM = 640;

/**
 * Build the libav input URL and AVDictionary options for a preflight
 * context.
 *
 * libav takes RTSP and RTMP credentials from the URL userinfo only;
 * there is no `rtsp_user` / `rtsp_pass` option, and `stimeout` was
 * removed in FFmpeg 5 (it is `timeout` now). The returned URL contains
 * credentials and must only ever be sent to the worker over IPC — never
 * logged, never put in argv or env.
 * @param {object} ctx Preflight context from url-parse.js
 * @returns {{input: string, format: string|null, options: object}} Worker job fields
 */
function buildLibavInput(ctx) {
    const url = new URL(ctx.url);
    if (ctx.username || ctx.password) {
        // The URL setters percent-encode reserved characters; libav
        // decodes RTSP userinfo before building the Authorization
        // header. The setters leave "%" alone, so escape it for RTSP or
        // a password like "a%41b" would reach the camera as "aAb".
        const isRtsp = ctx.protocol === "rtsp" || ctx.protocol === "rtsps";
        const esc = (s) => (isRtsp ? (s || "").replace(/%/g, "%25") : s || "");
        url.username = esc(ctx.username);
        url.password = esc(ctx.password);
    }

    const ioTimeoutUs = String(Math.max(1000, ctx.timeoutMs) * 1000);
    const options = {
        rw_timeout: ioTimeoutUs,
    };
    let format = null;

    if (ctx.protocol === "rtsp" || ctx.protocol === "rtsps") {
        format = "rtsp";
        options.rtsp_transport = ctx.transport === "udp" ? "udp" : "tcp";
        options.timeout = ioTimeoutUs;
        // Skip SETUP for audio/data tracks: fewer round-trips, and no
        // extra UDP port pairs when transport=udp.
        options.allowed_media_types = "video";
    }

    if (ctx.protocol === "rtmp" || ctx.protocol === "rtmps") {
        // FLV metadata carries the codec parameters, so libav's default
        // 5 s stream analysis only burns budget: measured against
        // MediaMTX it took the first frame from ~6 s to ~2 s.
        options.analyzeduration = "1000000";
    }

    return { input: url.toString(), format, options };
}

/**
 * Remove credentials from text produced by the worker (error messages,
 * libav log lines) before it reaches a heartbeat or the server log.
 * @param {string} text Text to scrub
 * @param {object} job Worker job (carries the credentialed input URL)
 * @param {object} ctx Preflight context (carries raw credentials)
 * @returns {string} Scrubbed text
 */
function redact(text, job, ctx) {
    let out = String(text ?? "");
    if (job?.input) {
        out = out.split(job.input).join(scrubUrlCredentialsForLog(job.input));
    }
    for (const secret of [ctx?.password, ctx?.password && encodeURIComponent(ctx.password)]) {
        if (secret && secret.length >= 3) {
            out = out.split(secret).join("***");
        }
    }
    return scrubUrlCredentialsForLog(out);
}

/**
 * Fork a worker process with an IPC channel that can carry Buffers.
 * @returns {import("node:child_process").ChildProcess} Worker
 */
function spawnWorker() {
    return fork(WORKER_PATH, [], {
        serialization: "advanced",
        // Never inherit --inspect / --max-old-space-size etc. from the
        // server process.
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
}

/**
 * Run one capture job in a fresh worker process.
 *
 * Resolves with whatever frames arrived when the job ends (frame count
 * reached, end of stream, or budget exhausted — partial results are the
 * caller's decision). Rejects only when the worker failed before
 * producing any frame.
 * @param {object} job Worker job: {input, format, options, count, maxDim}
 * @param {number} budgetMs Hard wall-clock limit; the worker is SIGKILLed at this point
 *     (after a successful capture it gets CLOSE_GRACE_MS to tear down cleanly)
 * @param {object} ctx Preflight context, used only for redaction
 * @returns {Promise<{frames: Buffer[], firstFrameMs: number|null, stopReason: string, detail: string|null}>} Capture result
 */
function runWorker(job, budgetMs, ctx = null) {
    return new Promise((resolve, reject) => {
        const frames = [];
        const startMs = Date.now();
        // Measured here, not in the worker: what matters is how much of
        // the budget is gone before the first frame, process start-up
        // included.
        let firstFrameMs = null;
        let stderrTail = "";
        let settled = false;
        let child;

        try {
            child = spawnWorker();
        } catch (e) {
            reject(new Error(messages.WORKER_FAILED(e.message)));
            return;
        }

        const finish = (stopReason, detail = null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null && child.signalCode === null) {
                if (stopReason === "count" || stopReason === "eof") {
                    const killer = setTimeout(() => child.kill("SIGKILL"), CLOSE_GRACE_MS);
                    killer.unref();
                    child.once("close", () => clearTimeout(killer));
                } else {
                    child.kill("SIGKILL");
                }
            }
            if (stderrTail && stopReason !== "count" && stopReason !== "eof") {
                log.debug("rtsp", `frame worker stderr (tail): ${redact(stderrTail, job, ctx)}`);
            }
            if (frames.length === 0 && (stopReason === "error" || stopReason === "crash")) {
                reject(new Error(detail));
                return;
            }
            resolve({ frames, firstFrameMs, stopReason, detail });
        };

        const timer = setTimeout(() => finish("timeout", messages.TIMED_OUT(budgetMs)), budgetMs);

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
        });

        child.on("message", (msg) => {
            if (!msg || settled) {
                return;
            }
            if (msg.type === "frame") {
                if (firstFrameMs === null) {
                    firstFrameMs = Date.now() - startMs;
                }
                const u8 = msg.jpeg;
                frames.push(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));
                if (frames.length >= job.count) {
                    finish("count");
                }
            } else if (msg.type === "done") {
                finish("eof");
            } else if (msg.type === "error") {
                finish("error", messages.DECODE_FAILED(redact(msg.message, job, ctx)));
            }
        });

        child.on("error", (e) => finish("crash", messages.WORKER_FAILED(e.message)));
        // "close" rather than "exit": it fires only after the IPC
        // channel has drained, so a worker that sent "done" and exited
        // is never mistaken for a crash.
        child.on("close", (code, signal) => finish("crash", messages.WORKER_CRASHED(signal || `exit code ${code}`)));

        child.send({ type: "capture", ...job });
    });
}

/**
 * Capture up to `count` decoded video frames from the stream described
 * by `ctx`, as JPEGs.
 * @param {object} ctx Preflight context
 * @param {object} opts Options
 * @param {number} opts.count Frames wanted
 * @param {number} opts.budgetMs Hard wall-clock limit
 * @returns {Promise<{frames: Buffer[], firstFrameMs: number|null, stopReason: string, detail: string|null}>} Capture result
 */
function captureFrames(ctx, { count, budgetMs }) {
    const job = {
        ...buildLibavInput(ctx),
        count,
        maxDim: LIVE_FRAME_MAX_DIM,
    };
    return runWorker(job, budgetMs, ctx);
}

let probePromise = null;

/**
 * Check, in a throwaway worker, whether node-av and sharp load on this
 * platform. The server process itself never loads node-av. The result
 * is cached for the life of the process; infrastructure failures (fork
 * failed, probe timed out) are not cached so a later call can retry.
 * @returns {Promise<{nodeAv: string|null, sharp: string|null}>} Load error per dependency, null when it loaded
 */
function probeNativeSupport() {
    if (probePromise) {
        return probePromise;
    }
    probePromise = new Promise((resolve) => {
        let settled = false;
        let child;
        const finish = (result, cache) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (child && child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
            }
            if (!cache) {
                probePromise = null;
            }
            resolve(result);
        };
        const timer = setTimeout(() => {
            finish({ nodeAv: "native support probe timed out", sharp: null }, false);
        }, PROBE_TIMEOUT_MS);

        try {
            child = spawnWorker();
        } catch (e) {
            finish({ nodeAv: `could not start frame worker: ${e.message}`, sharp: null }, false);
            return;
        }
        child.stderr.resume();
        child.on("message", (msg) => {
            if (msg?.type === "probe") {
                finish({ nodeAv: msg.nodeAv ?? null, sharp: msg.sharp ?? null }, true);
            }
        });
        child.on("error", (e) => finish({ nodeAv: `frame worker failed: ${e.message}`, sharp: null }, false));
        child.on("close", (code, signal) => {
            // A crash while loading the native module is a definitive
            // answer for this platform, so it is cached.
            finish({ nodeAv: `node-av crashed while loading (${signal || `exit code ${code}`})`, sharp: null }, true);
        });
        child.send({ type: "probe" });
    });
    return probePromise;
}

module.exports = {
    LIVE_FRAME_MAX_DIM,
    buildLibavInput,
    redact,
    runWorker,
    captureFrames,
    probeNativeSupport,
};
