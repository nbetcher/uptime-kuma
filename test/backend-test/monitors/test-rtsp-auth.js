const { afterEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const net = require("node:net");
const { verifyRtspCredentials } = require("../../../server/monitor-types/rtsp/basic-probe");

const servers = [];

afterEach(() => {
    for (const server of servers.splice(0)) {
        server.close();
    }
});

/**
 * Start a small RTSP server which handles one request per connection.
 * @param {(request: string) => number} authorize Returns the response status
 * @param {string} challenge WWW-Authenticate value
 * @returns {Promise<{port: number, requests: string[]}>} Server details
 */
async function startServer(authorize, challenge = 'Basic realm="camera"') {
    const requests = [];
    const server = net.createServer((socket) => {
        let request = "";
        socket.on("data", (chunk) => {
            request += chunk.toString("utf8");
            if (!request.includes("\r\n\r\n")) {
                return;
            }
            requests.push(request);
            const cseq = (request.match(/\r\nCSeq:\s*(\d+)/i) || [])[1] || "1";
            const status = authorize(request);
            const reason = status === 200 ? "OK" : status === 403 ? "Forbidden" : "Unauthorized";
            const authHeader = status === 401 ? `WWW-Authenticate: ${challenge}\r\n` : "";
            socket.end(`RTSP/1.0 ${status} ${reason}\r\nCSeq: ${cseq}\r\n${authHeader}\r\n`);
        });
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return { port: server.address().port, requests };
}

/**
 * Build a preflight-style context for the fixture camera.
 * @param {number} port Fixture server port
 * @param {string} password Password to verify
 * @returns {object} Credential verification context
 */
function context(port, password) {
    return {
        url: `rtsp://127.0.0.1:${port}/stream`,
        protocol: "rtsp",
        host: "127.0.0.1",
        port,
        username: "admin",
        password,
        tlsVerify: false,
        timeoutMs: 3000,
    };
}

describe("RTSP credential verification", () => {
    test("accepts valid Basic credentials and rejects an incorrect password", async () => {
        const expected = `Basic ${Buffer.from("admin:correct").toString("base64")}`;
        const camera = await startServer((request) => (request.includes(`Authorization: ${expected}\r\n`) ? 200 : 401));

        await verifyRtspCredentials(context(camera.port, "correct"));
        await assert.rejects(
            verifyRtspCredentials(context(camera.port, "incorrect")),
            /incorrect username or password/
        );
        assert.equal(camera.requests.length, 4);
    });

    test("fails closed when supplied credentials are not challenged", async () => {
        const camera = await startServer(() => 200);
        await assert.rejects(verifyRtspCredentials(context(camera.port, "anything")), /did not require authentication/);
        assert.equal(camera.requests.length, 1);
        assert.doesNotMatch(camera.requests[0], /Authorization:/i);
    });

    test("answers an MD5 Digest challenge", async () => {
        const realm = "Login to camera, please";
        const nonce = "0123456789abcdef";
        const challenge = `Digest realm="${realm}", nonce="${nonce}", qop="auth", algorithm=MD5`;
        const camera = await startServer((request) => {
            const authorization = (request.match(/\r\nAuthorization:\s*Digest\s+([^\r\n]+)/i) || [])[1];
            if (!authorization) {
                return 401;
            }
            const values = {};
            for (const match of authorization.matchAll(/([a-z]+)=\s*(?:"([^"]*)"|([^,\s]+))/gi)) {
                values[match[1].toLowerCase()] = match[2] ?? match[3];
            }
            const hash = (value) => crypto.createHash("md5").update(value).digest("hex");
            const ha1 = hash(`admin:${realm}:correct`);
            const ha2 = hash(`DESCRIBE:rtsp://127.0.0.1:${camera.port}/stream`);
            const expected = hash(`${ha1}:${nonce}:${values.nc}:${values.cnonce}:auth:${ha2}`);
            return values.response === expected ? 200 : 401;
        }, challenge);

        await verifyRtspCredentials(context(camera.port, "correct"));
        await assert.rejects(verifyRtspCredentials(context(camera.port, "wrong")), /incorrect username or password/);
    });

    test("does nothing when no credentials are configured", async () => {
        await verifyRtspCredentials({ protocol: "rtsp", username: "", password: "" });
        await verifyRtspCredentials({ protocol: "rtmp", username: "admin", password: "password" });
    });
});
