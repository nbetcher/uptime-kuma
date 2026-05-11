const { describe, test } = require("node:test");
const assert = require("node:assert");
const { TokenBucket, SkipCheckError, _peekBucket } = require("../../../server/monitor-types/rtsp/concurrency");

/**
 * NFR-004 acceptance criterion (c): when a check cannot acquire a
 * concurrency token within timeout, the check is *skipped* (no
 * heartbeat). The TokenBucket throws SkipCheckError; the
 * RtspMonitorType wraps acquire() and the Monitor model's
 * SkipCheckError catch block short-circuits the heartbeat write.
 */

describe("RTSP SkipCheckError plumbing", () => {
    test("TokenBucket.acquire times out with SkipCheckError when saturated", async () => {
        const b = new TokenBucket(1);
        await b.acquire(1000); // hold the only slot
        await assert.rejects(b.acquire(50), SkipCheckError);
        b.release();
    });

    test("SkipCheckError name is stable for the catch-block discriminator in monitor.js", () => {
        const e = new SkipCheckError("test");
        assert.strictEqual(e.name, "SkipCheckError");
        assert.ok(e instanceof Error);
    });

    test("_peekBucket reports limit/active/queued for diagnostics", () => {
        const peek = _peekBucket();
        assert.ok(typeof peek.limit === "number");
        assert.ok(typeof peek.active === "number");
        assert.ok(typeof peek.queued === "number");
    });
});
