const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { UP, PENDING } = require("../../../src/util");
const { RtspMonitorType } = require("../../../server/monitor-types/rtsp");
const { parseRtspResponse, classifyRtspStatus } = require("../../../server/monitor-types/rtsp/basic-probe");

/**
 * Spin up an in-process TCP server that handles a single connection
 * with a canned RTSP response. Returns the server and its assigned
 * port number.
 * @param {(socket: net.Socket) => void} handler Connection handler
 * @returns {Promise<{server: net.Server, port: number}>}
 */
async function makeRtspServer(handler) {
    return new Promise((resolve, reject) => {
        const server = net.createServer(handler);
        server.unref();
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            resolve({ server, port: addr.port });
        });
        server.on("error", reject);
    });
}

/**
 * Build a minimal monitor object that satisfies what
 * `RtspMonitorType.check()` needs to read.
 * @param {object} overrides Property overrides
 * @returns {object} Stub monitor
 */
function stubMonitor(overrides) {
    return {
        id: 1,
        stream_mode: "basic",
        timeout: 5,
        interval: 60,
        getIgnoreTls: () => true,
        getSaveResponse: () => false,
        saveResponseData: async () => {},
        ...overrides,
    };
}

describe("RTSP basic-probe — RTSP responses", () => {
    test("UP on RTSP/1.0 200 OK", async () => {
        const { server, port } = await makeRtspServer((socket) => {
            socket.once("data", () => {
                socket.write("RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n");
                socket.end();
            });
        });
        try {
            const monitor = stubMonitor({ url: `rtsp://127.0.0.1:${port}/stream` });
            const hb = { status: PENDING, msg: "" };
            const type = new RtspMonitorType();
            await type.check(monitor, hb, {});
            assert.strictEqual(hb.status, UP);
            assert.match(hb.msg, /200/);
        } finally {
            server.close();
        }
    });

    test("UP on RTSP/1.0 401 (Hikvision pattern)", async () => {
        const { server, port } = await makeRtspServer((socket) => {
            socket.once("data", () => {
                socket.write('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="Login"\r\n\r\n');
                socket.end();
            });
        });
        try {
            const monitor = stubMonitor({ url: `rtsp://127.0.0.1:${port}/stream` });
            const hb = { status: PENDING, msg: "" };
            const type = new RtspMonitorType();
            await type.check(monitor, hb, {});
            assert.strictEqual(hb.status, UP);
            assert.match(hb.msg, /401/);
        } finally {
            server.close();
        }
    });

    test("UP with redirect warning on 3xx", async () => {
        const { server, port } = await makeRtspServer((socket) => {
            socket.once("data", () => {
                socket.write("RTSP/1.0 302 Moved\r\nCSeq: 1\r\nLocation: rtsp://other/\r\n\r\n");
                socket.end();
            });
        });
        try {
            const monitor = stubMonitor({ url: `rtsp://127.0.0.1:${port}/stream` });
            const hb = { status: PENDING, msg: "" };
            const type = new RtspMonitorType();
            await type.check(monitor, hb, {});
            assert.strictEqual(hb.status, UP);
            assert.match(hb.msg, /redirect/i);
        } finally {
            server.close();
        }
    });

    test("DOWN when server speaks HTTP not RTSP", async () => {
        const { server, port } = await makeRtspServer((socket) => {
            socket.once("data", () => {
                socket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
                socket.end();
            });
        });
        try {
            const monitor = stubMonitor({ url: `rtsp://127.0.0.1:${port}/stream` });
            const hb = { status: PENDING, msg: "" };
            const type = new RtspMonitorType();
            await assert.rejects(type.check(monitor, hb, {}), /did not speak RTSP/);
        } finally {
            server.close();
        }
    });

    test("DOWN when CSeq is not echoed", async () => {
        const { server, port } = await makeRtspServer((socket) => {
            socket.once("data", () => {
                socket.write("RTSP/1.0 200 OK\r\nCSeq: 99\r\n\r\n");
                socket.end();
            });
        });
        try {
            const monitor = stubMonitor({ url: `rtsp://127.0.0.1:${port}/stream` });
            const hb = { status: PENDING, msg: "" };
            const type = new RtspMonitorType();
            await assert.rejects(type.check(monitor, hb, {}), /did not speak RTSP/);
        } finally {
            server.close();
        }
    });

    test("DOWN on connection refused", async () => {
        // Use a port that is almost certainly not bound on a CI runner
        const monitor = stubMonitor({ url: "rtsp://127.0.0.1:1/stream" });
        const hb = { status: PENDING, msg: "" };
        const type = new RtspMonitorType();
        await assert.rejects(type.check(monitor, hb, {}), /refused|timeout|reset/i);
    });
});

describe("RTSP basic-probe — RTMP handshake", () => {
    test("UP on valid S0/S1 handshake", async () => {
        const { server, port } = await makeRtspServer((socket) => {
            const collected = [];
            const onData = (chunk) => {
                collected.push(chunk);
                const buf = Buffer.concat(collected);
                if (buf.length >= 1537) {
                    socket.removeListener("data", onData);
                    const reply = Buffer.alloc(1537);
                    reply[0] = 0x03;
                    socket.write(reply);
                    socket.end();
                }
            };
            socket.on("data", onData);
        });
        try {
            const monitor = stubMonitor({ url: `rtmp://127.0.0.1:${port}/live/stream` });
            const hb = { status: PENDING, msg: "" };
            const type = new RtspMonitorType();
            await type.check(monitor, hb, {});
            assert.strictEqual(hb.status, UP);
            assert.match(hb.msg, /RTMP/);
        } finally {
            server.close();
        }
    });

    test("DOWN when version byte is wrong", async () => {
        const { server, port } = await makeRtspServer((socket) => {
            const collected = [];
            const onData = (chunk) => {
                collected.push(chunk);
                const buf = Buffer.concat(collected);
                if (buf.length >= 1537) {
                    socket.removeListener("data", onData);
                    const reply = Buffer.alloc(1537);
                    reply[0] = 0x06; // wrong
                    socket.write(reply);
                    socket.end();
                }
            };
            socket.on("data", onData);
        });
        try {
            const monitor = stubMonitor({ url: `rtmp://127.0.0.1:${port}/live` });
            const hb = { status: PENDING, msg: "" };
            const type = new RtspMonitorType();
            await assert.rejects(type.check(monitor, hb, {}), /not speak RTMP/);
        } finally {
            server.close();
        }
    });
});

describe("RTSP basic-probe — parseRtspResponse", () => {
    test("parses status code from first line", () => {
        const buf = Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n");
        const r = parseRtspResponse(buf, 1);
        assert.strictEqual(r.statusCode, 200);
    });

    test("rejects non-RTSP prefix", () => {
        const buf = Buffer.from("HTTP/1.1 200 OK\r\n\r\n");
        assert.throws(() => parseRtspResponse(buf, 1), /not speak RTSP/);
    });

    test("rejects mismatched CSeq", () => {
        const buf = Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 5\r\n\r\n");
        assert.throws(() => parseRtspResponse(buf, 1), /not speak RTSP/);
    });
});

describe("RTSP basic-probe — classifyRtspStatus", () => {
    test("200 → UP no warning", () => {
        const r = classifyRtspStatus(200);
        assert.match(r.msg, /200/);
        assert.doesNotMatch(r.msg, /warning|alive but reports error|redirect/i);
    });

    test("401 → UP no warning", () => {
        const r = classifyRtspStatus(401);
        assert.match(r.msg, /401/);
    });

    test("301 → UP with redirect warning", () => {
        const r = classifyRtspStatus(301);
        assert.match(r.msg, /redirect/i);
    });

    test("500 → UP with server-error warning", () => {
        const r = classifyRtspStatus(500);
        assert.match(r.msg, /500/);
        assert.match(r.msg, /server alive but reports error/);
    });

    test("400 → UP with server-error warning (still RTSP-speaking)", () => {
        const r = classifyRtspStatus(400);
        assert.match(r.msg, /400/);
    });
});
