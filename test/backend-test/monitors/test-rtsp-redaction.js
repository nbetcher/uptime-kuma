const { describe, test } = require("node:test");
const assert = require("node:assert");
const { preflight } = require("../../../server/monitor-types/rtsp/url-parse");

/**
 * NFR-020: passwords MUST NOT appear in heartbeat messages, log
 * lines, or anywhere user-facing.
 */

describe("RTSP credential redaction (NFR-020)", () => {
    test("malformed URLs never echo passwords, including whitespace and truncated userinfo", async () => {
        for (const url of [
            " rtsp://alice:secretpass@bad host/path",
            "rtsp://alice:secret pass@bad host/path",
            "rtsp://alice:secretpass@",
        ]) {
            await assert.rejects(preflight({ url }), (error) => {
                assert.doesNotMatch(error.message, /alice|secret/);
                return true;
            });
        }
    });
    test("preflight strips URL-embedded credentials from the canonical URL", async () => {
        const ctx = await preflight({
            url: "rtsp://alice:secretpass@cam.local/path",
            timeout: 10,
            interval: 60,
            getIgnoreTls: () => true,
        });
        assert.doesNotMatch(ctx.url, /alice/);
        assert.doesNotMatch(ctx.url, /secretpass/);
    });

    test("INVALID_URL error scrubs credentials from echoed input (user:pass)", async () => {
        try {
            await preflight({
                url: "rtsp://alice:secretpass@bad url with spaces",
                timeout: 10,
                interval: 60,
                getIgnoreTls: () => true,
            });
            assert.fail("should have thrown");
        } catch (err) {
            assert.doesNotMatch(err.message, /alice/);
            assert.doesNotMatch(err.message, /secretpass/);
        }
    });

    test("INVALID_URL error scrubs user-only URLs (no password)", async () => {
        try {
            await preflight({
                url: "rtsp://alice@bad url with spaces",
                timeout: 10,
                interval: 60,
                getIgnoreTls: () => true,
            });
            assert.fail("should have thrown");
        } catch (err) {
            assert.doesNotMatch(err.message, /alice/);
        }
    });
});
