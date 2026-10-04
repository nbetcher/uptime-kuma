const { describe, test, before } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const tls = require("node:tls");
const { execFileSync } = require("node:child_process");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
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
    test("RTMP passes literal credentials to its non-decoding auth parser", () => {
        const job = buildLibavInput({ url: "rtmp://host/live", protocol: "rtmp", timeoutMs: 5000, username: "u@ser", password: "p%41@ss:word" });
        assert.strictEqual(job.input, "rtmp://u@ser:p%41@ss:word@host/live");
        assert.throws(() => buildLibavInput({ url: "rtmp://host/live", protocol: "rtmp", timeoutMs: 5000, username: "u", password: "p/ss" }), /cannot be represented/);
        for (const credentials of [
            { username: "percent%user", password: "password" },
            { username: "user", password: "a".repeat(50) },
            { username: "user", password: "é".repeat(25) },
        ]) {
            assert.throws(() => buildLibavInput({ url: "rtmp://host/live", protocol: "rtmp", timeoutMs: 5000, ...credentials }), /cannot be represented/);
        }
        const boundary = buildLibavInput({ url: "rtmp://host/live", protocol: "rtmp", timeoutMs: 5000, username: "u", password: "a".repeat(49) });
        assert.strictEqual(boundary.input, `rtmp://u:${"a".repeat(49)}@host/live`);
    });
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
    test("redacts short passwords and multiple URLs embedded in native logs", () => {
        const out = redact("password xy; open rtsp://u:xy@camera/a and rtsp://u:xy@camera/b", null, { password: "xy" });
        assert.doesNotMatch(out, /xy|u:xy/);
    });
    test("removes the credentialed input URL and raw password", () => {
        const job = { input: "rtsp://admin:hunter22@cam/s" };
        const out = redact("open rtsp://admin:hunter22@cam/s failed; pw hunter22", job, { password: "hunter22" });
        assert.doesNotMatch(out, /hunter22/);
    });
});

test("worker cleanup retains the caller's decode slot until child close", async (t) => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    child.send = () => {
        setImmediate(() => child.emit("message", { type: "frame", jpeg: Buffer.from("frame") }));
    };
    t.mock.method(childProcess, "fork", () => child);
    let returned = false;
    const capture = runWorker({ count: 1 }, 1000).then((result) => {
        returned = true;
        return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.strictEqual(returned, false, "native teardown still holds the slot");
    child.exitCode = 0;
    child.emit("close", 0, null);
    assert.strictEqual((await capture).stopReason, "count");
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

    test("verified TLS capture fails closed, while Basic verifies chain and hostname", { skip }, async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-tls-test-"));
        const certPath = path.join(dir, "cert.pem");
        try {
            try {
                execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-keyout", path.join(dir, "key.pem"), "-out", certPath, "-subj", "/CN=localhost",
                    "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
            } catch (error) {
                if (error.code === "ENOENT") {
                    t.skip("openssl unavailable for generating a test certificate");
                    return;
                }
                throw error;
            }
            let requests = 0;
            const server = tls.createServer({ key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(certPath) }, (socket) => {
                socket.on("error", () => {});
                socket.on("data", (data) => {
                    requests++;
                    const seq = data.toString().match(/CSeq:\s*(\d+)/i)?.[1] || "1";
                    socket.end(`RTSP/1.0 404 Not Found\r\nCSeq: ${seq}\r\n\r\n`);
                });
            });
            await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
            try {
                const ctx = await preflight({ url: `rtsps://127.0.0.1:${server.address().port}/s`, timeout: 2 });
                await assert.rejects(captureFrames(ctx, { count: 1, budgetMs: 5000 }), /Verified TLS frame capture is unavailable/);
                assert.strictEqual(requests, 0);
                const { basicProbe } = require("../../../server/monitor-types/rtsp/basic-probe");
                await assert.rejects(basicProbe({}, {}, ctx), /TLS.*certificate|self-signed/i);
                const connect = tls.connect.bind(tls);
                t.mock.method(tls, "connect", (options, callback) => connect({ ...options, ca: fs.readFileSync(certPath) }, callback));
                await assert.rejects(basicProbe({}, {}, ctx), /hostname.*match/i);
                assert.strictEqual(requests, 0, "Basic rejects a trusted certificate for the wrong host");
                const hostnameCtx = { ...ctx, host: "localhost" };
                const heartbeat = {};
                await basicProbe({}, heartbeat, hostnameCtx);
                assert.strictEqual(heartbeat.status, 1);
                requests = 0;
                await assert.rejects(captureFrames({ ...ctx, tlsVerify: false }, { count: 1, budgetMs: 5000 }), /404/);
                assert.ok(requests > 0, "explicit ignore-TLS remains available");
            } finally {
                await new Promise((resolve) => server.close(resolve));
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("oversized coded frames fail before allocating full RGB planes", { skip }, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-frame-limit-"));
        const file = path.join(dir, "oversized.jpg");
        try {
            const sharp = require("sharp");
            await sharp({ create: { width: 8192, height: 2049, channels: 3, background: "black" } }).jpeg().toFile(file);
            await assert.rejects(runWorker({ input: file, format: null, options: {}, count: 1, maxDim: 640 }, 5000), /decode failed/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

});
