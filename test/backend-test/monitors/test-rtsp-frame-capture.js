const { describe, test, before } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
    buildLibavInput,
    captureFrames,
    probeNativeSupport,
    redact,
    runWorker,
} = require("../../../server/monitor-types/rtsp/frame-capture");
const { preflight } = require("../../../server/monitor-types/rtsp/url-parse");

const FIXTURES = path.join(__dirname, "fixtures", "rtsp");

/**
 * Build a worker job that decodes a local fixture file.
 * @param {string} name Fixture file name
 * @param {number} count Frames wanted
 * @returns {object} Worker job
 */
function fileJob(name, count) {
    return { input: path.join(FIXTURES, name), format: null, options: {}, count, maxDim: 640 };
}

/**
 * Minimal RTSP server: answers OPTIONS, then 401s every DESCRIBE that
 * lacks an Authorization header and 404s the rest. Records requests.
 * @returns {Promise<{port: number, requests: Array<{method: string, auth: string|null}>, close: Function}>} Server handle
 */
async function authRtspServer() {
    const requests = [];
    const server = net.createServer((sock) => {
        let buf = "";
        sock.on("error", () => {});
        sock.on("data", (d) => {
            buf += d.toString("latin1");
            let idx;
            while ((idx = buf.indexOf("\r\n\r\n")) >= 0) {
                const req = buf.slice(0, idx);
                buf = buf.slice(idx + 4);
                const method = req.split(" ")[0];
                const cseq = (req.match(/CSeq:\s*(\d+)/i) || [])[1];
                const header = (req.match(/Authorization:\s*(.*)/i) || [])[1] || null;
                const auth =
                    header && header.startsWith("Basic ")
                        ? Buffer.from(header.slice(6), "base64").toString("utf8")
                        : header;
                requests.push({ method, auth });
                if (method === "OPTIONS") {
                    sock.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n\r\n`);
                } else if (!header) {
                    sock.write(
                        `RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\nWWW-Authenticate: Basic realm="cam"\r\n\r\n`
                    );
                } else {
                    sock.write(`RTSP/1.0 404 Not Found\r\nCSeq: ${cseq}\r\n\r\n`);
                }
            }
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: server.address().port, requests, close: () => server.close() };
}

/**
 * Time a trivial libuv-threadpool task.
 * @returns {Promise<number>} Milliseconds, or Infinity if it did not finish within 3 s
 */
function threadpoolLatency() {
    const start = Date.now();
    return Promise.race([
        new Promise((resolve) => crypto.pbkdf2("x", "y", 1, 32, "sha256", () => resolve(Date.now() - start))),
        new Promise((resolve) => setTimeout(() => resolve(Infinity), 3000)),
    ]);
}

describe("buildLibavInput", () => {
    test("puts credentials in the URL userinfo, percent-encoded", () => {
        const job = buildLibavInput({
            url: "rtsp://cam.local:554/s",
            protocol: "rtsp",
            transport: "tcp",
            timeoutMs: 5000,
            username: "ad@min",
            password: "p@ss:w/rd",
        });
        const url = new URL(job.input);
        assert.strictEqual(decodeURIComponent(url.username), "ad@min");
        assert.strictEqual(decodeURIComponent(url.password), "p@ss:w/rd");
    });

    test("uses option names libav actually has", () => {
        const job = buildLibavInput({
            url: "rtsp://cam.local/s",
            protocol: "rtsp",
            transport: "udp",
            timeoutMs: 7000,
            username: "u",
            password: "p",
        });
        assert.strictEqual(job.format, "rtsp");
        assert.strictEqual(job.options.rtsp_transport, "udp");
        assert.strictEqual(job.options.timeout, "7000000");
        assert.strictEqual(job.options.rw_timeout, "7000000");
        for (const bogus of ["rtsp_user", "rtsp_pass", "stimeout"]) {
            assert.ok(!(bogus in job.options), `${bogus} is not a libav option`);
        }
    });

    test("RTMP gets no RTSP-only options", () => {
        const job = buildLibavInput({ url: "rtmp://host/app/key", protocol: "rtmp", timeoutMs: 5000 });
        assert.strictEqual(job.format, null);
        assert.ok(!("rtsp_transport" in job.options));
        assert.ok(!("timeout" in job.options));
        assert.strictEqual(job.options.analyzeduration, "1000000");
    });
});

describe("redact", () => {
    test("removes the credentialed input URL and raw password", () => {
        const job = { input: "rtsp://admin:hunter22@cam/s" };
        const out = redact("open rtsp://admin:hunter22@cam/s failed; pw hunter22", job, { password: "hunter22" });
        assert.doesNotMatch(out, /hunter22/);
    });
});

describe("frame worker (node-av in a child process)", async () => {
    const native = await probeNativeSupport();
    const skip = native.nodeAv || native.sharp ? `native support unavailable: ${native.nodeAv || native.sharp}` : false;

    before(() => {
        if (skip) {
            // node:test skips the tests below; make the reason visible.
            console.log(`skipping frame worker tests: ${skip}`);
        }
    });

    test("decodes the requested number of frames as JPEGs", { skip }, async () => {
        const result = await runWorker(fileJob("moving.mp4", 3), 15000);
        assert.strictEqual(result.stopReason, "count");
        assert.strictEqual(result.frames.length, 3);
        for (const jpeg of result.frames) {
            assert.strictEqual(jpeg[0], 0xff);
            assert.strictEqual(jpeg[1], 0xd8);
        }
        assert.ok(result.firstFrameMs >= 0);
    });

    test("end of stream before the count resolves with what was decoded", { skip }, async () => {
        const result = await runWorker(fileJob("moving.mp4", 1000), 15000);
        assert.strictEqual(result.stopReason, "eof");
        assert.strictEqual(result.frames.length, 20);
    });

    test("open failure rejects with a decode error", { skip }, async () => {
        await assert.rejects(runWorker(fileJob("does-not-exist.mp4", 1), 15000), /decode failed/);
    });

    test("RTSP credentials reach the camera (form fields and URL userinfo)", { skip }, async () => {
        const server = await authRtspServer();
        try {
            for (const monitor of [
                { url: `rtsp://127.0.0.1:${server.port}/s`, basic_auth_user: "admin", basic_auth_pass: "p@ss:w/rd" },
                { url: `rtsp://admin:p%40ss%3Aw%2Frd@127.0.0.1:${server.port}/s` },
            ]) {
                server.requests.length = 0;
                const ctx = await preflight({ id: 1, timeout: 5, interval: 60, getIgnoreTls: () => true, ...monitor });
                await assert.rejects(captureFrames(ctx, { count: 1, budgetMs: 10000 }), (err) => {
                    assert.match(err.message, /404/, "auth was accepted, so the server moved on to 404");
                    assert.doesNotMatch(err.message, /p@ss/);
                    return true;
                });
                const authed = server.requests.filter((r) => r.auth);
                assert.ok(authed.length > 0, `no Authorization header sent: ${JSON.stringify(server.requests)}`);
                assert.strictEqual(authed[0].auth, "admin:p@ss:w/rd");
            }
        } finally {
            server.close();
        }
    });

    test("silent cameras are killed at the budget and do not wedge the threadpool", { skip }, async () => {
        // A camera that accepts TCP and never answers used to leave a
        // native libav call blocked on a libuv threadpool thread
        // forever; four of them stalled every fs/dns/crypto/sqlite call
        // in the server.
        const server = net.createServer((sock) => sock.on("error", () => {}));
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const ctx = await preflight({
                id: 1,
                url: `rtsp://127.0.0.1:${server.address().port}/s`,
                timeout: 30,
                interval: 60,
                getIgnoreTls: () => true,
            });
            const start = Date.now();
            const results = await Promise.all(
                Array.from({ length: 6 }, () => captureFrames(ctx, { count: 1, budgetMs: 1500 }))
            );
            assert.ok(Date.now() - start < 6000, "budget was not enforced");
            for (const r of results) {
                assert.strictEqual(r.stopReason, "timeout");
                assert.strictEqual(r.frames.length, 0);
            }
            assert.ok((await threadpoolLatency()) < 1000, "libuv threadpool is blocked");
        } finally {
            server.close();
        }
    });

    test("file URLs work through captureFrames (used by the end-to-end tests)", { skip }, async () => {
        const ctx = {
            url: pathToFileURL(path.join(FIXTURES, "moving.mp4")).href,
            protocol: "file",
            timeoutMs: 5000,
        };
        const result = await captureFrames(ctx, { count: 2, budgetMs: 15000 });
        assert.strictEqual(result.frames.length, 2);
    });
});
