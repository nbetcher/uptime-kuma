const { describe, test } = require("node:test");
const assert = require("node:assert");
const { validateStreamMonitor } = require("../../../server/monitor-types/rtsp/validation");

describe("validateStreamMonitor", () => {
    test("ignores non-rtsp monitors", () => {
        // no throw expected
        validateStreamMonitor({ type: "http" }, null);
    });

    test("requires URL", () => {
        assert.throws(() => validateStreamMonitor({ type: "rtsp" }, null), /require a URL/);
    });

    test("accepts a minimal Basic-mode monitor", () => {
        validateStreamMonitor({ type: "rtsp", url: "rtsp://x/s", streamMode: "basic" }, null);
    });

    test("rejects invalid streamMode", () => {
        assert.throws(
            () => validateStreamMonitor({ type: "rtsp", url: "rtsp://x/s", streamMode: "weird" }, null),
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

    test("FR-019b: Full mode rejected without Day reference at edit time", () => {
        assert.throws(
            () =>
                validateStreamMonitor(
                    {
                        type: "rtsp",
                        url: "rtsp://x/s",
                        streamMode: "full",
                        streamSeparateDayNight: true,
                    },
                    {} // bean exists, but no reference blobs
                ),
            /Day reference/
        );
    });

    test("FR-019b: Full mode permitted on add (bean=null) so user can upload refs after save", () => {
        // No throw expected — references can only be uploaded after
        // the monitor row exists. Runtime emits MISSING_REFERENCE.
        validateStreamMonitor(
            {
                type: "rtsp",
                url: "rtsp://x/s",
                streamMode: "full",
                streamSeparateDayNight: true,
            },
            null
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

    test("FR-026: rejects RTMP+UDP combination", () => {
        assert.throws(
            () =>
                validateStreamMonitor(
                    {
                        type: "rtsp",
                        url: "rtmp://x/s",
                        streamMode: "basic",
                        streamProtocol: "rtmp",
                        streamTransport: "udp",
                    },
                    null
                ),
            /RTMP is TCP-only/
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

    test("rejects streamWallClockBudgetSec above 30 (NFR-002 envelope)", () => {
        assert.throws(
            () =>
                validateStreamMonitor(
                    {
                        type: "rtsp",
                        url: "rtsp://x/s",
                        streamMode: "enhanced",
                        streamWallClockBudgetSec: 60,
                    },
                    null
                ),
            /streamWallClockBudgetSec/
        );
    });
});
