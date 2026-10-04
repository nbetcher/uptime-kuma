const os = require("node:os");
const { log } = require("../../../src/util");
const { messages } = require("./messages");

const DEFAULT_LIMIT = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));
const ENV_LIMIT = parseInt(process.env.RTSP_CONCURRENCY || "", 10);
const LIMIT = Number.isFinite(ENV_LIMIT) && ENV_LIMIT > 0 ? ENV_LIMIT : DEFAULT_LIMIT;

/**
 * SkipCheckError signals "skip this check, do not write a heartbeat"
 * — as opposed to a normal Error which the monitor framework converts
 * to a DOWN heartbeat. Thrown when a check cannot get its per-monitor
 * lock or a global decode slot in time, at most
 * MAX_CONSECUTIVE_SKIPS times in a row per monitor.
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
const monitorLocks = new Map(); // monitor.id → TokenBucket(1)
const consecutiveSkips = new Map(); // monitor.id → number of skips in a row

// Used when a caller passes no usable wait time.
const DEFAULT_WAIT_MS = 60000;

/**
 * @param {unknown} waitMs Requested wait
 * @returns {number} A positive finite wait in milliseconds
 */
function sanitizeWait(waitMs) {
    return Number.isFinite(waitMs) && waitMs > 0 ? waitMs : DEFAULT_WAIT_MS;
}

// A skipped check writes no heartbeat, so the monitor keeps showing
// whatever it showed last — possibly UP. That is only acceptable as a
// transient. After this many skips in a row the next one is reported
// as a real failure so a starved monitor cannot stay green forever.
const MAX_CONSECUTIVE_SKIPS = 2;

/**
 * Turn a lock-acquisition timeout into the error the check should
 * throw: a SkipCheckError while the monitor is within its skip
 * allowance, a plain Error (→ DOWN/PENDING) once it is exhausted.
 * @param {number|string} monitorId Monitor id
 * @param {string} reason Why the check could not run
 * @param {boolean} countSkips False for Test-button runs, which must not
 *     eat into the scheduled monitor's allowance
 * @returns {Error} Error to throw
 */
function skipOrFail(monitorId, reason, countSkips) {
    if (!countSkips) {
        return new SkipCheckError(reason);
    }
    const n = (consecutiveSkips.get(monitorId) || 0) + 1;
    consecutiveSkips.set(monitorId, n);
    if (n > MAX_CONSECUTIVE_SKIPS) {
        return new Error(messages.CHECK_STARVED(n, reason));
    }
    log.warn("rtsp", `RTSP check skipped (${n}/${MAX_CONSECUTIVE_SKIPS}): ${reason} (monitor=${monitorId})`);
    return new SkipCheckError(reason);
}

/**
 * Record that a check got all the locks it needs and will run, which
 * resets the monitor's consecutive-skip count.
 * @param {number|string} monitorId Monitor id
 * @returns {void}
 */
function clearSkips(monitorId) {
    consecutiveSkips.delete(monitorId);
}

/**
 * Acquire a slot in the global decode bucket.
 * @param {object} monitor Monitor row (uses `id`)
 * @param {number} waitMs How long to wait for a slot
 * @param {object} opts Options
 * @param {boolean} opts.countSkips Count a timeout toward the skip allowance (default true)
 * @returns {Promise<{release: Function}>} Disposable token
 */
async function acquireConcurrencyToken(monitor, waitMs, opts = {}) {
    try {
        await globalBucket.acquire(sanitizeWait(waitMs));
    } catch (err) {
        if (err instanceof SkipCheckError) {
            throw skipOrFail(monitor.id, `all ${globalBucket.limit} decode slots busy`, opts.countSkips !== false);
        }
        throw err;
    }
    let released = false;
    return {
        release: () => {
            if (!released) {
                released = true;
                globalBucket.release();
            }
        },
    };
}

/**
 * Acquire a per-monitor mutex so two checks for the same monitor
 * never run concurrently (a scheduled check and a Test-button run, or
 * a check from a monitor instance that was restarted mid-check).
 * NFR-014. The wait is bounded: a holder that never lets go must not
 * queue every later check behind it indefinitely.
 * @param {number|string} monitorId Monitor id
 * @param {number} waitMs How long to wait for the lock
 * @param {object} opts Options
 * @param {boolean} opts.countSkips Count a timeout toward the skip allowance (default true)
 * @returns {Promise<{release: Function}>} Disposable token
 */
async function acquireMonitorMutex(monitorId, waitMs, opts = {}) {
    let lock = monitorLocks.get(monitorId);
    if (!lock) {
        lock = new TokenBucket(1);
        monitorLocks.set(monitorId, lock);
    }
    const dropIfIdle = () => {
        if (lock.active === 0 && lock.queue.length === 0 && monitorLocks.get(monitorId) === lock) {
            monitorLocks.delete(monitorId);
        }
    };
    try {
        await lock.acquire(sanitizeWait(waitMs));
    } catch (err) {
        dropIfIdle();
        if (err instanceof SkipCheckError) {
            throw skipOrFail(monitorId, "previous check for this monitor is still running", opts.countSkips !== false);
        }
        throw err;
    }
    let released = false;
    return {
        release: () => {
            if (released) {
                return;
            }
            released = true;
            lock.release();
            dropIfIdle();
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
    MAX_CONSECUTIVE_SKIPS,
    acquireConcurrencyToken,
    acquireMonitorMutex,
    clearSkips,
    _peekBucket,
};
