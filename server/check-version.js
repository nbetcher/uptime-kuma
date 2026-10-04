const { setSetting, setting } = require("./util-server");
const axios = require("axios");
const compareVersions = require("compare-versions");
const { log } = require("../src/util");
const { findLatestRtspMonitorRelease, parseRtspMonitorVersion } = require("./rtsp-release-version");

const UPSTREAM_RELEASES_URL = "https://github.com/louislam/uptime-kuma/releases";
const RTSP_MONITOR_RELEASES_PAGE = "https://github.com/nbetcher/uptime-kuma/releases";

exports.version = require("../package.json").version;
exports.latestVersion = null;
exports.latestVersionUrl = parseRtspMonitorVersion(exports.version)
    ? RTSP_MONITOR_RELEASES_PAGE
    : UPSTREAM_RELEASES_URL;

// How much time in ms to wait between update checks
const UPDATE_CHECKER_INTERVAL_MS = 1000 * 60 * 60 * 48;
const UPDATE_CHECKER_LATEST_VERSION_URL = "https://uptime.kuma.pet/version";
const RTSP_MONITOR_RELEASES_URL = "https://api.github.com/repos/nbetcher/uptime-kuma/releases?per_page=100";

let interval;

exports.startInterval = () => {
    let check = async () => {
        if ((await setting("checkUpdate")) === false) {
            return;
        }

        log.debug("update-checker", "Retrieving latest versions");

        try {
            if (parseRtspMonitorVersion(exports.version)) {
                const res = await axios.get(RTSP_MONITOR_RELEASES_URL, {
                    headers: {
                        Accept: "application/vnd.github+json",
                        "User-Agent": "nbetcher-uptime-kuma-update-checker",
                    },
                });
                const latestRelease = findLatestRtspMonitorRelease(res.data);
                exports.latestVersion = latestRelease?.version || null;
                exports.latestVersionUrl = latestRelease?.url || RTSP_MONITOR_RELEASES_PAGE;
                return;
            }

            const res = await axios.get(UPDATE_CHECKER_LATEST_VERSION_URL);

            // For debug
            if (process.env.TEST_CHECK_VERSION === "1") {
                res.data.slow = "1000.0.0";
            }

            let checkBeta = await setting("checkBeta");

            if (checkBeta && res.data.beta) {
                if (compareVersions.compare(res.data.beta, res.data.slow, ">")) {
                    exports.latestVersion = res.data.beta;
                    exports.latestVersionUrl = UPSTREAM_RELEASES_URL;
                    return;
                }
            }

            if (res.data.slow) {
                exports.latestVersion = res.data.slow;
                exports.latestVersionUrl = UPSTREAM_RELEASES_URL;
            }
        } catch (_) {
            log.info("update-checker", "Failed to check for new versions");
        }
    };

    check();
    interval = setInterval(check, UPDATE_CHECKER_INTERVAL_MS);
};

/**
 * Enable the check update feature
 * @param {boolean} value Should the check update feature be enabled?
 * @returns {Promise<void>}
 */
exports.enableCheckUpdate = async (value) => {
    await setSetting("checkUpdate", value);

    clearInterval(interval);

    if (value) {
        exports.startInterval();
    }
};

exports.socket = null;
