const compareVersions = require("compare-versions");

const RTSP_MONITOR_VERSION_PATTERN = /^v?(\d+\.\d+\.\d+)-rtsp(?:-monitor\.(\d+))?$/;

/**
 * Parse a downstream RTSP release version. The source branch's legacy
 * `-rtsp` version is treated as counter zero so the first packaged release
 * is recognized as an upgrade.
 * @param {string} version Version or release tag
 * @returns {{ baseVersion: string, counter: number, version: string } | null} Parsed version
 */
function parseRtspMonitorVersion(version) {
    if (typeof version !== "string") {
        return null;
    }

    const match = version.match(RTSP_MONITOR_VERSION_PATTERN);
    if (!match) {
        return null;
    }

    return {
        baseVersion: match[1],
        counter: match[2] === undefined ? 0 : Number(match[2]),
        version: match[2] === undefined ? `${match[1]}-rtsp` : `${match[1]}-rtsp-monitor.${Number(match[2])}`,
    };
}

/**
 * Compare downstream versions by their upstream base and then their numeric
 * downstream release counter.
 * @param {string} left First version
 * @param {string} right Second version
 * @returns {number} Negative, zero, or positive comparison result
 * @throws {TypeError} If either value is not an RTSP monitor version
 */
function compareRtspMonitorVersions(left, right) {
    const parsedLeft = parseRtspMonitorVersion(left);
    const parsedRight = parseRtspMonitorVersion(right);
    if (!parsedLeft || !parsedRight) {
        throw new TypeError("Both values must be RTSP monitor versions");
    }

    const baseComparison = compareVersions(parsedLeft.baseVersion, parsedRight.baseVersion);
    if (baseComparison !== 0) {
        return baseComparison;
    }

    return parsedLeft.counter - parsedRight.counter;
}

/**
 * Find the newest published RTSP monitor release returned by GitHub.
 * @param {object[]} releases GitHub release API results
 * @returns {{ version: string, url: string } | null} Latest release metadata
 */
function findLatestRtspMonitorRelease(releases) {
    let latest = null;

    for (const release of Array.isArray(releases) ? releases : []) {
        if (!release || release.draft) {
            continue;
        }

        const parsed = parseRtspMonitorVersion(release.tag_name);
        if (!parsed) {
            continue;
        }

        if (!latest || compareRtspMonitorVersions(parsed.version, latest.version) > 0) {
            latest = {
                version: parsed.version,
                url: release.html_url || `https://github.com/nbetcher/uptime-kuma/releases/tag/${parsed.version}`,
            };
        }
    }

    return latest;
}

module.exports = {
    compareRtspMonitorVersions,
    findLatestRtspMonitorRelease,
    parseRtspMonitorVersion,
};
