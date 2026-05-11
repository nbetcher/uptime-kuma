const os = require("node:os");
const { log } = require("../../../src/util");

const DEFAULT_LIMIT = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));
const ENV_LIMIT = parseInt(process.env.RTSP_CONCURRENCY || "", 10);
const LIMIT = Number.isFinite(ENV_LIMIT) && ENV_LIMIT > 0 ? ENV_LIMIT : DEFAULT_LIMIT;

/**
 * SkipCheckError signals "skip this check, do not write a heartbeat"
 * — as opposed to a normal Error which the monitor framework converts
 * to a DOWN heartbeat. Currently thrown by `acquireConcurrencyToken`
 * when the global decode bucket is saturated.
 */
class SkipCheckError extends Error {
    /**
     * @param {string} msg Reason for skip
     */
    constructor(msg) {
        super(msg);
        this.name = "SkipCheckError";
    }
}

/**
 * Simple in-process bounded concurrency limiter. Used by Enhanced/Full
 * checks to cap concurrent decode sessions globally. Per NFR-004.
 */
class TokenBucket {
    /**
     * @param {number} limit Maximum concurrent token holders
     */
    constructor(limit) {
        this.limit = limit;
        this.active = 0;
        this.queue = [];
    }

    /**
     * Attempt to acquire a token. If the bucket is at capacity, wait
     * up to `timeoutMs` for a slot. On timeout, reject with
     * `SkipCheckError`.
     *
     * The `settled` flag prevents the timer and `release()` paths
     * from both firing — without it, a near-simultaneous timeout +
     * release would double-decrement `active`.
     * @param {number} timeoutMs Maximum wait
     * @returns {Promise<void>}
     */
    async acquire(timeoutMs) {
        if (this.active < this.limit) {
            this.active++;
            return;
        }
        return new Promise((resolve, reject) => {
            const entry = { settled: false };
            entry.timer = setTimeout(() => {
                if (entry.settled) {
                    return;
                }
                entry.settled = true;
                const idx = this.queue.indexOf(entry);
                if (idx >= 0) {
                    this.queue.splice(idx, 1);
                }
                reject(new SkipCheckError("concurrency limit timeout"));
            }, timeoutMs);
            entry.resolve = () => {
                if (entry.settled) {
                    return;
                }
                entry.settled = true;
                clearTimeout(entry.timer);
                this.active++;
                resolve();
            };
            this.queue.push(entry);
        });
    }

    /**
     * Release the token. If a waiter is queued, hand the slot to it
     * without an active-count dip.
     * @returns {void}
     */
    release() {
        this.active--;
        const next = this.queue.shift();
        if (next) {
            next.resolve();
        }
    }
}

const globalBucket = new TokenBucket(LIMIT);
const monitorMutexes = new Map(); // monitor.id → Promise chain tip

/**
 * Acquire a slot in the global decode bucket.
 * @param {object} monitor Monitor row (uses `timeout` + `id`)
 * @param {number} budgetMs Wall-clock budget for the check
 * @returns {Promise<{release: Function}>} Disposable token
 */
async function acquireConcurrencyToken(monitor, budgetMs) {
    const timeout = Math.min((monitor.timeout || 30) * 1000, budgetMs * 2);
    try {
        await globalBucket.acquire(timeout);
    } catch (err) {
        if (err instanceof SkipCheckError) {
            log.warn("rtsp", `RTSP check skipped: concurrency limit (monitor=${monitor.id})`);
        }
        throw err;
    }
    return {
        release: () => globalBucket.release(),
    };
}

/**
 * Acquire a per-monitor mutex so two checks for the same monitor
 * never run concurrently. NFR-014.
 * @param {number|string} monitorId Monitor id
 * @returns {Promise<{release: Function}>} Disposable token
 */
async function acquireMonitorMutex(monitorId) {
    const prev = monitorMutexes.get(monitorId) || Promise.resolve();
    let release;
    const next = new Promise((r) => {
        release = r;
    });
    const chain = prev.then(() => next);
    monitorMutexes.set(monitorId, chain);
    await prev;
    return {
        release: () => {
            release();
            // Only delete if no later waiter has chained onto us
            if (monitorMutexes.get(monitorId) === chain) {
                monitorMutexes.delete(monitorId);
            }
        },
    };
}

/**
 * Test hook: peek at the global token bucket's current state. Used
 * by concurrency tests to assert bounds without prying.
 * @returns {{active: number, queued: number, limit: number}}
 */
function _peekBucket() {
    return {
        active: globalBucket.active,
        queued: globalBucket.queue.length,
        limit: globalBucket.limit,
    };
}

module.exports = {
    LIMIT,
    DEFAULT_LIMIT,
    TokenBucket,
    SkipCheckError,
    acquireConcurrencyToken,
    acquireMonitorMutex,
    _peekBucket,
};
