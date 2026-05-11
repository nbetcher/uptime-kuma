const { describe, test } = require("node:test");
const assert = require("node:assert");
const {
    preflight,
    computeBudget,
    scrubUrlCredentialsForLog,
    urlContainsRtspTransport,
} = require("../../../server/monitor-types/rtsp/url-parse");

/**
 * Build a stub monitor for preflight.
 * @param {object} overrides Property overrides
 * @returns {object} Stub monitor
 */
function stub(overrides) {
    return {
        id: 1,
        timeout: 10,
        interval: 60,
        getIgnoreTls: () => false,
        ...overrides,
    };
}

describe("url-parse preflight", () => {
    test("parses an RTSP URL with default port", async () => {
        const ctx = await preflight(stub({ url: "rtsp://example.com/stream" }));
        assert.strictEqual(ctx.protocol, "rtsp");
        assert.strictEqual(ctx.host, "example.com");
        assert.strictEqual(ctx.port, 554);
    });

    test("parses an RTSPS URL with default port 322", async () => {
        const ctx = await preflight(stub({ url: "rtsps://example.com/stream" }));
        assert.strictEqual(ctx.protocol, "rtsps");
        assert.strictEqual(ctx.port, 322);
        assert.strictEqual(ctx.tlsVerify, true);
    });

    test("respects per-monitor port override", async () => {
        const ctx = await preflight(stub({ url: "rtsp://example.com:8554/stream" }));
        assert.strictEqual(ctx.port, 8554);
    });

    test("rejects unknown schemes", async () => {
        await assert.rejects(preflight(stub({ url: "http://example.com" })), /unknown protocol/);
    });

    test("strips URL-embedded credentials and uses form credentials", async () => {
        const ctx = await preflight(
            stub({
                url: "rtsp://urluser:urlpass@example.com/s",
                basic_auth_user: "formuser",
                basic_auth_pass: "formpass",
            })
        );
        assert.strictEqual(ctx.username, "formuser");
        assert.strictEqual(ctx.password, "formpass");
        assert.doesNotMatch(ctx.url, /urluser/);
        assert.doesNotMatch(ctx.url, /urlpass/);
    });

    test("falls back to URL credentials when form credentials are empty", async () => {
        const ctx = await preflight(
            stub({
                url: "rtsp://urluser:urlpass@example.com/s",
            })
        );
        assert.strictEqual(ctx.username, "urluser");
        assert.strictEqual(ctx.password, "urlpass");
    });

    test("preserves RTMP credentials on URL for decode auth", async () => {
        const ctx = await preflight(
            stub({
                url: "rtmp://urluser:urlpass@example.com/live/stream",
            })
        );
        assert.strictEqual(ctx.username, "urluser");
        assert.strictEqual(ctx.password, "urlpass");
        assert.match(ctx.url, /^rtmp:\/\/urluser:urlpass@example\.com\//);
    });

    test("RTMP form credentials override URL credentials", async () => {
        const ctx = await preflight(
            stub({
                url: "rtmp://urluser:urlpass@example.com/live/stream",
                basic_auth_user: "formuser",
                basic_auth_pass: "formpass",
            })
        );
        assert.strictEqual(ctx.username, "formuser");
        assert.strictEqual(ctx.password, "formpass");
        assert.match(ctx.url, /^rtmp:\/\/formuser:formpass@example\.com\//);
        assert.doesNotMatch(ctx.url, /urluser/);
    });

    test("strips ?rtsp_transport= URL parameter", async () => {
        const ctx = await preflight(
            stub({
                url: "rtsp://example.com/s?rtsp_transport=udp",
                stream_transport: "tcp",
            })
        );
        assert.doesNotMatch(ctx.url, /rtsp_transport/);
        assert.strictEqual(ctx.transport, "tcp");
    });
});

describe("computeBudget", () => {
    test("clamps to 5 seconds minimum", () => {
        assert.strictEqual(computeBudget({ interval: 5 }), 5000);
    });

    test("clamps to 30 seconds maximum", () => {
        assert.strictEqual(computeBudget({ interval: 300 }), 30000);
    });

    test("interval/3 in the middle range", () => {
        assert.strictEqual(computeBudget({ interval: 60 }), 20000);
    });

    test("respects per-monitor override", () => {
        assert.strictEqual(computeBudget({ interval: 60, stream_wall_clock_budget_sec: 15 }), 15000);
    });
});

describe("scrubUrlCredentialsForLog", () => {
    test("scrubs credentials before log/error echo", () => {
        assert.strictEqual(
            scrubUrlCredentialsForLog("rtsp://user:pass@example.com/stream"),
            "rtsp://***@example.com/stream"
        );
        assert.strictEqual(
            scrubUrlCredentialsForLog("rtsp+ssh://foo@bar@example.com/stream"),
            "rtsp+ssh://***@example.com/stream"
        );
    });
});

describe("urlContainsRtspTransport", () => {
    test("true when ?rtsp_transport= is present", () => {
        assert.strictEqual(urlContainsRtspTransport("rtsp://h/p?rtsp_transport=udp"), true);
    });

    test("false otherwise", () => {
        assert.strictEqual(urlContainsRtspTransport("rtsp://h/p"), false);
    });

    test("safe on invalid URLs", () => {
        assert.strictEqual(urlContainsRtspTransport("not a url"), false);
        assert.strictEqual(urlContainsRtspTransport(null), false);
    });
});
