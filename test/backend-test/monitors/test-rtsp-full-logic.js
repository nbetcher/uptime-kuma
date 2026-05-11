const { describe, test } = require("node:test");
const assert = require("node:assert");
const { messages } = require("../../../server/monitor-types/rtsp/messages");

/**
 * Tests for the pure-logic pieces of Full mode that don't require
 * the node-av or sharp native dependencies. The end-to-end `run()`
 * function is exercised by the staged integration test (NFR-031b),
 * not in CI.
 */

describe("messages.MATCH_FAIL", () => {
    test("both scores present", () => {
        const m = messages.MATCH_FAIL(40, 50, 24);
        assert.match(m, /distance 40\/128/);
        assert.match(m, /Day=40/);
        assert.match(m, /Night=50/);
    });

    test("only day score present (single-ref mode)", () => {
        const m = messages.MATCH_FAIL(40, null, 24);
        assert.match(m, /distance 40\/128/);
        assert.doesNotMatch(m, /null/);
        assert.doesNotMatch(m, /NaN/);
    });

    test("only night score present", () => {
        const m = messages.MATCH_FAIL(null, 50, 24);
        assert.match(m, /distance 50\/128/);
        assert.doesNotMatch(m, /null/);
        assert.doesNotMatch(m, /NaN/);
    });

    test("neither score present", () => {
        const m = messages.MATCH_FAIL(null, null, 24);
        assert.match(m, /no scores computed/);
    });

    test("MATCH_OK format is parseable", () => {
        const m = messages.MATCH_OK("Day", 11);
        assert.match(m, /matched Day at distance 11\/128/);
    });
});

describe("messages.NODE_AV_UNAVAILABLE is a plain string", () => {
    test("static string for graceful-degradation surface", () => {
        // The catch-block in monitor.js reads error.message — when we
        // throw `new Error(messages.NODE_AV_UNAVAILABLE)`, the .message
        // is just the string; not a function call.
        assert.strictEqual(typeof messages.NODE_AV_UNAVAILABLE, "string");
        assert.match(messages.NODE_AV_UNAVAILABLE, /node-av failed to load/);
    });
});
