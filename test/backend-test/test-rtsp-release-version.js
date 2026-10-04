const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const compareVersions = require("compare-versions");
const {
    compareRtspMonitorVersions,
    findLatestRtspMonitorRelease,
    parseRtspMonitorVersion,
} = require("../../server/rtsp-release-version");

describe("RTSP monitor release versions", () => {
    test("parses packaged counters and treats the source suffix as counter zero", () => {
        assert.deepEqual(parseRtspMonitorVersion("2.5.5-rtsp"), {
            baseVersion: "2.5.5",
            counter: 0,
            version: "2.5.5-rtsp",
        });
        assert.deepEqual(parseRtspMonitorVersion("v2.5.5-rtsp-monitor.12"), {
            baseVersion: "2.5.5",
            counter: 12,
            version: "2.5.5-rtsp-monitor.12",
        });
        assert.equal(parseRtspMonitorVersion("2.5.5"), null);
        assert.equal(parseRtspMonitorVersion("2.5.5-rtsp-monitor.bad"), null);
    });

    test("compares the upstream version before the downstream counter", () => {
        assert.ok(compareRtspMonitorVersions("2.5.5-rtsp-monitor.2", "2.5.5-rtsp-monitor.1") > 0);
        assert.ok(compareRtspMonitorVersions("2.5.6-rtsp-monitor.1", "2.5.5-rtsp-monitor.99") > 0);
        assert.ok(compareRtspMonitorVersions("2.5.5-rtsp-monitor.1", "2.5.5-rtsp") > 0);
        assert.equal(compareRtspMonitorVersions("2.5.5-rtsp-monitor.4", "2.5.5-rtsp-monitor.4"), 0);
    });

    test("dashboard semver comparison recognizes a newer downstream counter", () => {
        assert.ok(compareVersions("2.5.5-rtsp-monitor.2", "2.5.5-rtsp-monitor.1") > 0);
        assert.ok(compareVersions("2.5.5-rtsp-monitor.1", "2.5.5-rtsp") > 0);
        assert.ok(compareVersions("2.5.5-rtsp-monitor.1", "2.5.5-rtsp-monitor.2") < 0);
    });

    test("selects the newest published downstream release", () => {
        const release = findLatestRtspMonitorRelease([
            { tag_name: "2.5.6-rtsp-monitor.1", draft: true, html_url: "https://example.test/draft" },
            { tag_name: "2.5.5-rtsp-monitor.11", draft: false, html_url: "https://example.test/11" },
            { tag_name: "v2.5.6-rtsp-monitor.2", draft: false, html_url: "https://example.test/latest" },
            { tag_name: "2.5.6-rtsp-monitor.1", draft: false, html_url: "https://example.test/1" },
            { tag_name: "2.5.7", draft: false, html_url: "https://example.test/upstream" },
        ]);

        assert.deepEqual(release, {
            version: "2.5.6-rtsp-monitor.2",
            url: "https://example.test/latest",
        });
    });
});
