const { describe, test } = require("node:test");
const assert = require("node:assert");
const {
    TokenBucket,
    SkipCheckError,
    acquireMonitorMutex,
} = require("../../../server/monitor-types/rtsp/concurrency");

describe("TokenBucket", () => {
    test("immediate acquire when under limit", async () => {
        const b = new TokenBucket(2);
        await b.acquire(1000);
        await b.acquire(1000);
        b.release();
        b.release();
    });

    test("queues when at limit and resolves on release", async () => {
        const b = new TokenBucket(1);
        await b.acquire(1000);
        const second = b.acquire(2000);
        // Give event loop a tick to start waiting
        await new Promise((r) => setImmediate(r));
        b.release();
        await second;
        b.release();
    });

    test("rejects with SkipCheckError on timeout", async () => {
        const b = new TokenBucket(1);
        await b.acquire(1000);
        const start = Date.now();
        await assert.rejects(b.acquire(100), (err) => {
            assert.ok(err instanceof SkipCheckError);
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 80, `elapsed ${elapsed} ms`);
            return true;
        });
        b.release();
    });

    test("release hands slot directly to next waiter (no dip)", async () => {
        const b = new TokenBucket(1);
        await b.acquire(1000);
        // Two queued waiters
        const w1 = b.acquire(2000);
        const w2 = b.acquire(2000);
        await new Promise((r) => setImmediate(r));
        b.release();
        await w1;
        b.release();
        await w2;
        b.release();
    });
});

describe("per-monitor mutex", () => {
    test("serialises two parallel acquires for the same monitor", async () => {
        const order = [];
        const a = await acquireMonitorMutex("m1");
        const bP = acquireMonitorMutex("m1").then((b) => {
            order.push("b");
            return b;
        });
        order.push("a");
        // Give the awaiter a tick
        await new Promise((r) => setImmediate(r));
        a.release();
        const b = await bP;
        b.release();
        assert.deepStrictEqual(order, ["a", "b"]);
    });

    test("different monitors run in parallel", async () => {
        const a = await acquireMonitorMutex("m-A");
        const b = await acquireMonitorMutex("m-B");
        a.release();
        b.release();
    });

    test("mutex cleans up when chain drains", async () => {
        const a = await acquireMonitorMutex("m-cleanup");
        a.release();
        // Re-acquire shouldn't block
        const b = await acquireMonitorMutex("m-cleanup");
        b.release();
    });
});
