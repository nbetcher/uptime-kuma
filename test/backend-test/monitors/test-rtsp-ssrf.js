const { describe, test } = require("node:test");
const assert = require("node:assert");
const { ipv4Bucket, ipv6Bucket, classifyIp } = require("../../../server/monitor-types/rtsp/ssrf-guard");

describe("ipv4Bucket", () => {
    test("classifies RFC 1918 ranges", () => {
        assert.strictEqual(ipv4Bucket("10.0.0.1"), "rfc1918-10");
        assert.strictEqual(ipv4Bucket("10.255.255.254"), "rfc1918-10");
        assert.strictEqual(ipv4Bucket("172.16.0.1"), "rfc1918-172");
        assert.strictEqual(ipv4Bucket("172.31.255.254"), "rfc1918-172");
        assert.strictEqual(ipv4Bucket("192.168.0.1"), "rfc1918-192");
        assert.strictEqual(ipv4Bucket("192.168.255.254"), "rfc1918-192");
    });

    test("classifies loopback", () => {
        assert.strictEqual(ipv4Bucket("127.0.0.1"), "loopback");
        assert.strictEqual(ipv4Bucket("127.255.255.254"), "loopback");
    });

    test("classifies link-local", () => {
        assert.strictEqual(ipv4Bucket("169.254.169.254"), "link-local");
    });

    test("classifies multicast", () => {
        assert.strictEqual(ipv4Bucket("224.0.0.1"), "multicast");
    });

    test("returns null for public IPs", () => {
        assert.strictEqual(ipv4Bucket("8.8.8.8"), null);
        assert.strictEqual(ipv4Bucket("1.1.1.1"), null);
        // 172.32 is just outside 172.16/12
        assert.strictEqual(ipv4Bucket("172.32.0.1"), null);
        // 192.169 is just outside 192.168/16
        assert.strictEqual(ipv4Bucket("192.169.0.1"), null);
    });

    test("returns null for malformed input", () => {
        assert.strictEqual(ipv4Bucket("not.an.ip"), null);
        assert.strictEqual(ipv4Bucket("10.0.0"), null);
        assert.strictEqual(ipv4Bucket(""), null);
    });
});

describe("ipv6Bucket", () => {
    test("classifies loopback", () => {
        assert.strictEqual(ipv6Bucket("::1"), "loopback");
    });

    test("classifies link-local (fe80::/10)", () => {
        assert.strictEqual(ipv6Bucket("fe80::1"), "link-local");
        assert.strictEqual(ipv6Bucket("febf::1"), "link-local");
    });

    test("classifies ULA (fc00::/7)", () => {
        assert.strictEqual(ipv6Bucket("fc00::1"), "ula");
        assert.strictEqual(ipv6Bucket("fd00::1"), "ula");
    });

    test("classifies multicast (ff00::/8)", () => {
        assert.strictEqual(ipv6Bucket("ff02::1"), "multicast");
    });

    test("returns null for public IPv6", () => {
        assert.strictEqual(ipv6Bucket("2001:4860:4860::8888"), null);
    });
});

describe("classifyIp dispatcher", () => {
    test("dispatches IPv4", () => {
        assert.strictEqual(classifyIp("10.0.0.1"), "rfc1918-10");
        assert.strictEqual(classifyIp("8.8.8.8"), null);
    });

    test("dispatches IPv6", () => {
        assert.strictEqual(classifyIp("::1"), "loopback");
        assert.strictEqual(classifyIp("fc00::1"), "ula");
    });

    test("handles null/empty", () => {
        assert.strictEqual(classifyIp(null), null);
        assert.strictEqual(classifyIp(""), null);
    });

    test("reclassifies IPv4-mapped IPv6 as the underlying IPv4 bucket", () => {
        // ::ffff:127.0.0.1 → loopback, NOT public
        assert.strictEqual(classifyIp("::ffff:127.0.0.1"), "loopback");
        assert.strictEqual(classifyIp("::ffff:10.0.0.1"), "rfc1918-10");
        assert.strictEqual(classifyIp("::ffff:192.168.1.1"), "rfc1918-192");
        // Public IPv4-mapped is still null (public)
        assert.strictEqual(classifyIp("::ffff:8.8.8.8"), null);
    });
});
