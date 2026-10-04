const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const dns = require("node:dns").promises;
const { fetchUrl } = require("../../../server/monitor-types/rtsp/ssrf-guard");

/**
 * Start a local snapshot server and close every connection after the test.
 * @param {Function} handler HTTP handler
 * @param {Function} run Test body
 * @param {string} host Bind address
 * @returns {Promise<void>} Test completion
 */
async function withServer(handler, run, host = "127.0.0.1") {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, host, resolve));
    const authority = `${host.includes(":") ? `[${host}]` : host}:${server.address().port}`;
    try {
        await run(`http://${authority}/snapshot`, host, server);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

describe("reference HTTP fetch", () => {
    test("sends decoded Basic credentials and the correct Host port", async () => {
        await withServer(
            (req, res) => {
                assert.equal(req.headers.authorization, `Basic ${Buffer.from("user:p@ss:w/rd").toString("base64")}`);
                assert.match(req.headers.host, /127\.0\.0\.1:\d+/);
                res.writeHead(200, { "Content-Type": "image/jpeg" });
                res.end("image fixture");
            },
            async (url, host) => {
                const credentialed = url.replace("http://", "http://user:p%40ss%3Aw%2Frd@");
                const body = await fetchUrl(credentialed, { monitorHostname: host });
                assert.equal(body.toString(), "image fixture");
            }
        );
    });

    test("supports IPv6 literal snapshot URLs and camera hostnames", async () => {
        await withServer(
            (req, res) => {
                assert.match(req.headers.host, /^\[::1\]:\d+$/);
                res.writeHead(200, { "Content-Type": "image/png" });
                res.end("fixture");
            },
            async (url) => {
                assert.equal((await fetchUrl(url, { monitorHostname: "[::1]" })).toString(), "fixture");
            },
            "::1"
        );
    });

    test("a continuously dripping response hits the wall-clock deadline", async () => {
        let closed;
        const peerClosed = new Promise((resolve) => {
            closed = resolve;
        });
        await withServer(
            (req, res) => {
                res.writeHead(200, { "Content-Type": "image/jpeg" });
                const interval = setInterval(() => res.write("x"), 15);
                res.on("close", () => {
                    clearInterval(interval);
                    closed();
                });
            },
            async (url, host) => {
                const start = Date.now();
                await assert.rejects(fetchUrl(url, { monitorHostname: host, timeoutMs: 120 }), /timed out/);
                assert.ok(Date.now() - start < 1000);
                await peerClosed;
            }
        );
    });

    test("a stalled DNS lookup is included in the deadline and never starts a late request", async (t) => {
        let resolveDns;
        let requests = 0;
        await withServer(
            (req, res) => {
                requests++;
                res.end();
            },
            async (url) => {
                t.mock.method(
                    dns,
                    "lookup",
                    () =>
                        new Promise((resolve) => {
                            resolveDns = resolve;
                        })
                );
                await assert.rejects(fetchUrl(url, { timeoutMs: 50 }), /timed out/);
                resolveDns({ address: "127.0.0.1", family: 4 });
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(requests, 0);
            }
        );
    });

    test("invalid responses are closed immediately instead of drained", async () => {
        let closed;
        const peerClosed = new Promise((resolve) => {
            closed = resolve;
        });
        await withServer(
            (req, res) => {
                res.writeHead(302, { Location: "/another" });
                res.write("unbounded redirect body");
                res.on("close", closed);
            },
            async (url, host) => {
                await assert.rejects(fetchUrl(url, { monitorHostname: host }), /redirect/);
                await peerClosed;
            }
        );
    });

    test("rejects oversized bodies and premature response closure", async () => {
        await withServer(
            (req, res) => {
                res.writeHead(200, { "Content-Type": "image/jpeg" });
                res.end(Buffer.alloc(1024));
            },
            async (url, host) => {
                await assert.rejects(fetchUrl(url, { monitorHostname: host, maxBytes: 32 }), /exceeds 32/);
            }
        );
        await withServer(
            (req, res) => {
                res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": "1024" });
                res.write("partial");
                setImmediate(() => res.destroy());
            },
            async (url, host) => {
                await assert.rejects(fetchUrl(url, { monitorHostname: host }));
            }
        );
    });
});
