const { describe, test } = require("node:test");
const assert = require("node:assert");
const { validateStreamMonitor } = require("../../../server/monitor-types/rtsp/validation");

describe("validateStreamMonitor", () => {
    test("ignores non-rtsp monitors", () => {
        // no throw expected
        validateStreamMonitor({ type: "http" }, null);
    });

    test("requires URL", () => {
        assert.throws(
            () => validateStreamMonitor({ type: "rtsp" }, null),
            /require a URL/
        );
    });

    test("accepts a minimal Basic-mode monitor", () => {
        validateStreamMonitor(
            { type: "rtsp", url: "rtsp://x/s", streamMode: "basic" },
            null
        );
    });

    test("rejects invalid streamMode", () => {
        assert.throws(
            () =>
                validateStreamMonitor(
                    { type: "rtsp", url: "rtsp://x/s", streamMode: "weird" },
                    null
                ),
            /Invalid streamMode/
        );
    });

    test("rejects invalid streamProtocol", () => {
        assert.throws(
            () =>
                validateStreamMonitor(
                    {
                        type: "rtsp",
                        url: "rtsp://x/s",
                        streamMode: "basic",
                        streamProtocol: "weird",
                    },
                    null
                ),
            /Invalid streamProtocol/
        );
    });

    test("FR-019b: Full mode rejected without Day reference", () => {
        assert.throws(
            () =>
                validateStreamMonitor(
                    {
                        type: "rtsp",
                        url: "rtsp://x/s",
                        streamMode: "full",
                        streamSeparateDayNight: true,
                    },
                    null
                ),
            /Day reference/
        );
    });

    test("FR-019b: Full mode rejected without Night reference when Separate is on", () => {
        assert.throws(
            () =>
                validateStreamMonitor(
                    {
                        type: "rtsp",
                        url: "rtsp://x/s",
                        streamMode: "full",
                        streamSeparateDayNight: true,
                        streamReferenceDayHasBlob: true,
                    },
                    { stream_reference_day_blob: Buffer.from([1]) }
                ),
            /Night reference/
        );
    });

    test("FR-019b: Full mode passes with both references", () => {
        validateStreamMonitor(
            {
                type: "rtsp",
                url: "rtsp://x/s",
                streamMode: "full",
                streamSeparateDayNight: true,
            },
            {
                stream_reference_day_blob: Buffer.from([1]),
                stream_reference_night_blob: Buffer.from([2]),
            }
        );
    });

    test("FR-019b: Full mode single-ref passes with Day reference only", () => {
        validateStreamMonitor(
            {
                type: "rtsp",
                url: "rtsp://x/s",
                streamMode: "full",
                streamSeparateDayNight: false,
            },
            { stream_reference_day_blob: Buffer.from([1]) }
        );
    });

    test("rejects streamFrameCount out of range", () => {
        assert.throws(
            () =>
                validateStreamMonitor(
                    {
                        type: "rtsp",
                        url: "rtsp://x/s",
                        streamMode: "enhanced",
                        streamFrameCount: 1,
                    },
                    null
                ),
            /streamFrameCount/
        );
        assert.throws(
            () =>
                validateStreamMonitor(
                    {
                        type: "rtsp",
                        url: "rtsp://x/s",
                        streamMode: "enhanced",
                        streamFrameCount: 100,
                    },
                    null
                ),
            /streamFrameCount/
        );
    });

    test("rejects streamMatchThreshold out of range", () => {
        assert.throws(
            () =>
                validateStreamMonitor(
                    {
                        type: "rtsp",
                        url: "rtsp://x/s",
                        streamMode: "full",
                        streamSeparateDayNight: false,
                        streamMatchThreshold: -1,
                    },
                    { stream_reference_day_blob: Buffer.from([1]) }
                ),
            /streamMatchThreshold/
        );
        assert.throws(
            () =>
                validateStreamMonitor(
                    {
                        type: "rtsp",
                        url: "rtsp://x/s",
                        streamMode: "full",
                        streamSeparateDayNight: false,
                        streamMatchThreshold: 200,
                    },
                    { stream_reference_day_blob: Buffer.from([1]) }
                ),
            /streamMatchThreshold/
        );
    });
});
