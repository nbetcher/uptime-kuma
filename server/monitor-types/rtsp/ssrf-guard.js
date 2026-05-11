const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const { log } = require("../../../src/util");

const DEFAULT_MAX_BYTES = parseInt(process.env.RTSP_FETCH_MAX_BYTES, 10) || 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
// SVG is XML and can carry scripts / external entity references; we
// re-decode through sharp before storing, but defence-in-depth says
// reject SVG outright. Allow common binary raster formats only.
const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];

/**
 * Convert a dotted-quad IPv4 string to a uint32 in network byte order.
 * @param {string} ip Dotted IPv4
 * @returns {number} 32-bit integer
 */
function ipv4ToInt(ip) {
    const parts = ip.split(".");
    if (parts.length !== 4) {
        return NaN;
    }
    let n = 0;
    for (let i = 0; i < 4; i++) {
        const p = parseInt(parts[i], 10);
        if (!Number.isFinite(p) || p < 0 || p > 255) {
            return NaN;
        }
        // Use multiplication to avoid 32-bit signed shift on the high byte
        n = n * 256 + p;
    }
    return n;
}

/**
 * Determine which "private range bucket" an IPv4 falls into. Used by
 * the SSRF carveout — references hosted on the same private network
 * as the monitored camera are permitted (HLDS §12.4 / §20.4).
 * @param {string} ip IPv4 dotted-quad
 * @returns {string|null} Bucket name or null if not private/blocked
 */
function ipv4Bucket(ip) {
    const n = ipv4ToInt(ip);
    if (!Number.isFinite(n)) {
        return null;
    }
    // 127.0.0.0/8 — loopback
    if (n >= 0x7f000000 && n <= 0x7fffffff) {
        return "loopback";
    }
    // 10.0.0.0/8
    if (n >= 0x0a000000 && n <= 0x0affffff) {
        return "rfc1918-10";
    }
    // 172.16.0.0/12  → 172.16.0.0 - 172.31.255.255
    if (n >= 0xac100000 && n <= 0xac1fffff) {
        return "rfc1918-172";
    }
    // 192.168.0.0/16
    if (n >= 0xc0a80000 && n <= 0xc0a8ffff) {
        return "rfc1918-192";
    }
    // 169.254.0.0/16 — link-local
    if (n >= 0xa9fe0000 && n <= 0xa9feffff) {
        return "link-local";
    }
    // 224.0.0.0/4 — multicast
    if (n >= 0xe0000000 && n <= 0xefffffff) {
        return "multicast";
    }
    // 0.0.0.0/8 — "this network"
    if (n >= 0x00000000 && n <= 0x00ffffff) {
        return "this-network";
    }
    return null;
}

/**
 * Expand a compressed IPv6 address into eight 16-bit segments.
 * @param {string} ip IPv6 address
 * @returns {number[]|null} Parsed segments, or null for invalid input
 */
function parseIpv6Segments(ip) {
    const withoutZone = ip.toLowerCase().split("%")[0];
    if (withoutZone.includes(".")) {
        return null;
    }

    const compressedParts = withoutZone.split("::");
    if (compressedParts.length > 2) {
        return null;
    }

    const head = compressedParts[0] ? compressedParts[0].split(":").filter(Boolean) : [];
    const tail =
        compressedParts.length === 2 && compressedParts[1] ? compressedParts[1].split(":").filter(Boolean) : [];
    const fillLength = compressedParts.length === 2 ? 8 - head.length - tail.length : 0;
    if (fillLength < 0) {
        return null;
    }

    const rawSegments = compressedParts.length === 2 ? [...head, ...Array(fillLength).fill("0"), ...tail] : head;
    if (rawSegments.length !== 8) {
        return null;
    }

    const segments = rawSegments.map((segment) => {
        if (!/^[0-9a-f]{1,4}$/.test(segment)) {
            return NaN;
        }
        return parseInt(segment, 16);
    });
    if (segments.some((segment) => !Number.isFinite(segment))) {
        return null;
    }
    return segments;
}

/**
 * Check whether a contiguous segment range is all zeroes.
 * @param {number[]} segments IPv6 segments
 * @param {number} start Inclusive start index
 * @param {number} end Exclusive end index
 * @returns {boolean} True if all segments in range are zero
 */
function segmentsAreZero(segments, start, end) {
    return segments.slice(start, end).every((segment) => segment === 0);
}

/**
 * Classify an IPv6 address.
 * @param {string} ip IPv6 address
 * @returns {string|null} Bucket name or null
 */
function ipv6Bucket(ip) {
    if (!ip || typeof ip !== "string") {
        return null;
    }
    const segments = parseIpv6Segments(ip);
    if (!segments) {
        return null;
    }

    if (segmentsAreZero(segments, 0, 8)) {
        return "this-network";
    }
    if (segmentsAreZero(segments, 0, 7) && segments[7] === 1) {
        return "loopback";
    }

    if (segmentsAreZero(segments, 0, 5) && segments[5] === 0xffff) {
        return ipv4Bucket(`${segments[6] >> 8}.${segments[6] & 0xff}.${segments[7] >> 8}.${segments[7] & 0xff}`);
    }

    // Deprecated IPv4-compatible ::/96 and NAT64 well-known 64:ff9b::/96 can route to IPv4 space.
    if (segmentsAreZero(segments, 0, 6)) {
        return "ipv4-compatible";
    }
    if (segments[0] === 0x0064 && segments[1] === 0xff9b && segmentsAreZero(segments, 2, 6)) {
        return "ipv4-translation";
    }

    const firstNum = segments[0];
    // fe80::/10 — link-local
    if ((firstNum & 0xffc0) === 0xfe80) {
        return "link-local";
    }
    // fec0::/10 — deprecated site-local
    if ((firstNum & 0xffc0) === 0xfec0) {
        return "site-local";
    }
    // fc00::/7 — unique-local (ULA)
    if ((firstNum & 0xfe00) === 0xfc00) {
        return "ula";
    }
    // ff00::/8 — multicast
    if ((firstNum & 0xff00) === 0xff00) {
        return "multicast";
    }
    // 100::/64 — discard-only prefix
    if (firstNum === 0x0100 && segmentsAreZero(segments, 1, 4)) {
        return "discard";
    }
    // 2001:db8::/32 — documentation prefix
    if (firstNum === 0x2001 && segments[1] === 0x0db8) {
        return "documentation";
    }
    // 2001::/32 — Teredo tunneling; 2002::/16 — deprecated 6to4.
    if (firstNum === 0x2001 && segments[1] === 0x0000) {
        return "teredo";
    }
    if (firstNum === 0x2002) {
        return "6to4";
    }
    return null;
}

/**
 * Classify any resolved IP address (v4 or v6) into a private-range
 * bucket name. Returns null for public IPs.
 * @param {string} ip Resolved IP
 * @returns {string|null} Bucket name (or null = public/unknown)
 */
function classifyIp(ip) {
    if (!ip) {
        return null;
    }
    if (ip.includes(":")) {
        // IPv4-mapped IPv6 (::ffff:1.2.3.4) must be reclassified as
        // IPv4 — otherwise an attacker could route a request to e.g.
        // ::ffff:127.0.0.1 and bypass the loopback check.
        const lower = ip.toLowerCase();
        const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) {
            return ipv4Bucket(mapped[1]);
        }
        return ipv6Bucket(ip);
    }
    return ipv4Bucket(ip);
}

/**
 * Resolve a hostname's first IP via DNS lookup. We pin to the first
 * result to prevent DNS-rebinding between the SSRF check and the
 * connect. Returns both the IP and its family.
 * @param {string} hostname Hostname to resolve
 * @returns {Promise<{address: string, family: number}>}
 */
async function resolveOnce(hostname) {
    return dns.lookup(hostname, { family: 0, verbatim: true });
}

/**
 * Fetch a URL with SSRF protections. Per OP-006 / HLDS §5.9.
 * @param {string} urlStr URL to fetch
 * @param {object} opts Options
 * @param {string} opts.monitorHostname Hostname of the monitored
 *     camera — used for the "same private range" carveout.
 * @param {number} opts.maxBytes Body cap
 * @returns {Promise<Buffer>} Response body
 */
async function fetchUrl(urlStr, opts = {}) {
    const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    let url;
    try {
        url = new URL(urlStr);
    } catch (e) {
        throw new Error(`invalid URL: ${e.message}`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`unsupported scheme: ${url.protocol}`);
    }

    const { address: ip } = await resolveOnce(url.hostname);
    const bucket = classifyIp(ip);

    if (bucket) {
        // The carveout: if the monitor's own target hostname is in the
        // same bucket, allow the reference fetch.
        let allowed = false;
        if (opts.monitorHostname) {
            try {
                const targetResolved = await resolveOnce(opts.monitorHostname);
                const targetBucket = classifyIp(targetResolved.address);
                if (targetBucket && targetBucket === bucket) {
                    allowed = true;
                    log.debug(
                        "rtsp",
                        `SSRF carveout: both ref (${ip}) and target (${targetResolved.address}) in ${bucket}`
                    );
                }
            } catch (e) {
                log.debug("rtsp", `SSRF carveout DNS lookup failed: ${e.message}`);
            }
        }
        if (!allowed) {
            throw new Error(`reference URL resolves to private/blocked IP (${ip}, bucket=${bucket})`);
        }
    }

    return new Promise((resolve, reject) => {
        const lib = url.protocol === "https:" ? https : http;
        const port = url.port || (url.protocol === "https:" ? 443 : 80);
        // IPv6 literals must be bracketed in the `host` field;
        // `servername` stays as the bare hostname for SNI/cert
        // validation.
        const hostForConnect = ip.includes(":") ? `[${ip}]` : ip;

        const req = lib.request(
            {
                host: hostForConnect,
                port,
                path: url.pathname + url.search,
                headers: {
                    Host: url.hostname,
                    "User-Agent": "UptimeKuma-RTSP-Ref/1.0",
                    // Constrain the Accept header to the same shapes
                    // the response-side allowlist enforces; this
                    // signals intent and reduces wasted round-trips
                    // for SVG-only origins.
                    Accept: ALLOWED_CONTENT_TYPES.join(", "),
                },
                servername: url.hostname,
                timeout: FETCH_TIMEOUT_MS,
                method: "GET",
            },
            (res) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
                    res.resume();
                    reject(new Error(`reference URL returned redirect ${res.statusCode}; redirects are not followed`));
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`reference URL returned HTTP ${res.statusCode}`));
                    return;
                }
                const ctype = (res.headers["content-type"] || "").toLowerCase().split(";")[0].trim();
                if (!ALLOWED_CONTENT_TYPES.includes(ctype)) {
                    res.resume();
                    reject(
                        new Error(
                            `reference URL content-type is ${ctype || "(absent)"}, must be one of ${ALLOWED_CONTENT_TYPES.join(", ")}`
                        )
                    );
                    return;
                }

                const chunks = [];
                let total = 0;
                let aborted = false;
                res.on("data", (chunk) => {
                    if (aborted) {
                        return;
                    }
                    total += chunk.length;
                    if (total > maxBytes) {
                        aborted = true;
                        req.destroy(new Error(`reference URL body exceeds ${maxBytes} bytes`));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => {
                    if (aborted) {
                        return;
                    }
                    resolve(Buffer.concat(chunks, total));
                });
                res.on("error", (err) => {
                    if (!aborted) {
                        reject(err);
                    }
                });
            }
        );
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy(new Error(`reference URL fetch timed out after ${FETCH_TIMEOUT_MS}ms`));
        });
        req.end();
    });
}

module.exports = {
    DEFAULT_MAX_BYTES,
    FETCH_TIMEOUT_MS,
    ALLOWED_CONTENT_TYPES,
    ipv4ToInt,
    ipv4Bucket,
    parseIpv6Segments,
    ipv6Bucket,
    classifyIp,
    resolveOnce,
    fetchUrl,
};
