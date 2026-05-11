const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");
const { UP, log } = require("../../../src/util");
const { messages } = require("./messages");

const RTSP_USER_AGENT = "UptimeKuma/2.x";
const MAX_RESPONSE_BYTES = 4096;
const RTMP_HANDSHAKE_BYTES = 1537;

/**
 * Open a socket (TCP or TLS). Resolves on `connect` / `secureConnect`,
 * rejects on error or timeout.
 * @param {object} ctx Preflight context
 * @returns {Promise<net.Socket>} Connected socket
 */
function openSocket(ctx) {
    return new Promise((resolve, reject) => {
        const useTls = ctx.protocol === "rtsps" || ctx.protocol === "rtmps";
        const options = {
            host: ctx.host,
            port: ctx.port,
        };

        let socket;
        let settled = false;

        const done = (err, sock) => {
            if (settled) {
                return;
            }
            settled = true;
            if (err) {
                if (socket && !socket.destroyed) {
                    socket.destroy();
                }
                reject(err);
            } else {
                resolve(sock);
            }
        };

        const timer = setTimeout(() => {
            done(new Error(messages.CONNECTION_TIMEOUT(ctx.timeoutMs)));
        }, ctx.timeoutMs);

        if (useTls) {
            socket = tls.connect(
                {
                    ...options,
                    servername: ctx.host,
                    rejectUnauthorized: ctx.tlsVerify,
                },
                () => {
                    clearTimeout(timer);
                    done(null, socket);
                }
            );
        } else {
            socket = net.connect(options, () => {
                clearTimeout(timer);
                done(null, socket);
            });
        }

        socket.on("error", (err) => {
            clearTimeout(timer);
            const code = err.code || "";
            if (code === "ECONNREFUSED") {
                done(new Error(messages.CONNECTION_REFUSED()));
            } else if (code === "ECONNRESET") {
                done(new Error(messages.CONNECTION_RESET()));
            } else if (err.message && err.message.includes("hostname")) {
                done(new Error(messages.TLS_HOSTNAME_MISMATCH(ctx.host)));
            } else if (
                code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
                code === "SELF_SIGNED_CERT_IN_CHAIN" ||
                code === "CERT_HAS_EXPIRED" ||
                (err.message && err.message.toLowerCase().includes("certificate"))
            ) {
                done(new Error(messages.TLS_CERT_INVALID(err.message)));
            } else {
                done(err);
            }
        });
    });
}

/**
 * Read up to `maxBytes` from a socket, optionally stopping early when
 * `\r\n\r\n` is seen (RTSP head terminator). Closes the socket when
 * done.
 * @param {net.Socket} socket Open socket
 * @param {number} maxBytes Maximum bytes to read
 * @param {number} timeoutMs Read timeout
 * @param {boolean} stopOnDoubleCrlf If true, return early at CRLF CRLF
 * @returns {Promise<Buffer>} Bytes read
 */
function readBytes(socket, maxBytes, timeoutMs, stopOnDoubleCrlf) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        let timer;
        let onData;
        let onEnd;
        let onError;

        const done = (err, buf) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.removeListener("data", onData);
            socket.removeListener("end", onEnd);
            socket.removeListener("error", onError);
            if (err) {
                reject(err);
            } else {
                resolve(buf);
            }
        };

        timer = setTimeout(() => {
            done(new Error(messages.CONNECTION_TIMEOUT(timeoutMs)));
        }, timeoutMs);

        onData = (chunk) => {
            chunks.push(chunk);
            total += chunk.length;
            if (total >= maxBytes) {
                done(null, Buffer.concat(chunks, Math.min(total, maxBytes)));
                return;
            }
            if (stopOnDoubleCrlf) {
                const joined = Buffer.concat(chunks);
                if (joined.indexOf("\r\n\r\n") >= 0) {
                    done(null, joined);
                }
            }
        };
        onEnd = () => {
            done(null, Buffer.concat(chunks));
        };
        onError = (err) => {
            done(err);
        };
        socket.on("data", onData);
        socket.on("end", onEnd);
        socket.on("error", onError);
    });
}

/**
 * Write all bytes to a socket and destroy it immediately on write
 * failure, including synchronous write errors.
 * @param {net.Socket} socket Open socket
 * @param {string|Buffer} data Request bytes
 * @param {BufferEncoding|null} encoding Optional string encoding
 * @returns {Promise<void>}
 */
function writeSocket(socket, data, encoding = null) {
    return new Promise((resolve, reject) => {
        const onWrite = (err) => {
            if (err) {
                if (!socket.destroyed) {
                    socket.destroy();
                }
                reject(err);
                return;
            }
            resolve();
        };

        try {
            if (encoding) {
                socket.write(data, encoding, onWrite);
            } else {
                socket.write(data, onWrite);
            }
        } catch (err) {
            if (!socket.destroyed) {
                socket.destroy();
            }
            reject(err);
        }
    });
}

/**
 * Parse an RTSP response into status code + CSeq, and assert the
 * response shape per HLDS §5.5 step 4.
 * @param {Buffer} buf Raw response bytes
 * @param {number} requestCSeq The CSeq value sent in the request
 * @returns {{ statusCode: number }} Parsed status code
 */
function parseRtspResponse(buf, requestCSeq) {
    if (!buf || buf.length < 5) {
        throw new Error(messages.RTSP_NOT_SPOKEN());
    }
    const head = buf.toString("utf8", 0, Math.min(buf.length, MAX_RESPONSE_BYTES));
    if (!head.startsWith("RTSP/")) {
        throw new Error(messages.RTSP_NOT_SPOKEN());
    }
    const firstLineEnd = head.indexOf("\r\n");
    if (firstLineEnd < 0) {
        throw new Error(messages.RTSP_NOT_SPOKEN());
    }
    const firstLine = head.slice(0, firstLineEnd);
    // Form: "RTSP/1.0 200 OK"
    const match = firstLine.match(/^RTSP\/\d+\.\d+\s+(\d{3})(?:\s+|$)/);
    if (!match) {
        throw new Error(messages.RTSP_NOT_SPOKEN());
    }
    const statusCode = parseInt(match[1], 10);

    // CSeq must echo the request CSeq value
    const cseqMatch = head.match(/[\r\n]CSeq:\s*(\d+)/i);
    if (!cseqMatch || parseInt(cseqMatch[1], 10) !== requestCSeq) {
        throw new Error(messages.RTSP_NOT_SPOKEN());
    }

    return { statusCode };
}

/**
 * Map an RTSP status code to a (status, msg) tuple. Per
 * 02-protocol-coverage.md §5: any response with `RTSP/` prefix + echoed
 * CSeq proves liveness, so all status codes from an RTSP-speaking
 * server are UP — most cleanly, some with a warning surface.
 * @param {number} code RTSP status code
 * @returns {{ msg: string }} Heartbeat msg
 */
function classifyRtspStatus(code) {
    if (code >= 200 && code < 300) {
        return { msg: messages.RTSP_OK(code) };
    }
    if ([401, 403, 404, 405].includes(code)) {
        return { msg: messages.RTSP_OK(code) };
    }
    if (code >= 300 && code < 400) {
        return { msg: messages.RTSP_REDIRECT(code) };
    }
    if (code >= 500 && code < 600) {
        return { msg: messages.RTSP_SERVER_ERROR(code) };
    }
    // Other 4xx — still RTSP-speaking, surface as server-error warning
    return { msg: messages.RTSP_SERVER_ERROR(code) };
}

/**
 * Basic-mode probe for RTSP/RTSPS: open socket, send OPTIONS, parse.
 * @param {object} monitor Monitor row
 * @param {object} heartbeat Heartbeat to populate
 * @param {object} ctx Preflight context
 * @returns {Promise<void>}
 */
async function probeRtsp(monitor, heartbeat, ctx) {
    const startTime = Date.now();
    const cseq = 1;
    const requestLine = `OPTIONS ${ctx.url} RTSP/1.0\r\nCSeq: ${cseq}\r\nUser-Agent: ${RTSP_USER_AGENT}\r\n\r\n`;

    const socket = await openSocket(ctx);
    let rawResponse;
    try {
        await writeSocket(socket, requestLine, "utf8");
        rawResponse = await readBytes(socket, MAX_RESPONSE_BYTES, ctx.timeoutMs, true);
    } finally {
        if (!socket.destroyed) {
            socket.destroy();
        }
    }

    const { statusCode } = parseRtspResponse(rawResponse, cseq);
    const { msg } = classifyRtspStatus(statusCode);

    heartbeat.status = UP;
    heartbeat.msg = msg;
    heartbeat.ping = Date.now() - startTime;

    if (monitor.getSaveResponse && monitor.getSaveResponse() && monitor.saveResponseData) {
        const head = rawResponse.subarray(0, 256).toString("utf8");
        try {
            await monitor.saveResponseData(heartbeat, JSON.stringify({ raw_first_256_bytes: head }));
        } catch (err) {
            log.debug("rtsp", `saveResponseData failed: ${err.message}`);
        }
    }
}

/**
 * Basic-mode probe for RTMP/RTMPS: open socket, send C0+C1 handshake,
 * read S0+S1, verify the version byte. C2 is intentionally not sent —
 * S0+S1 prove the server is RTMP-speaking, and Basic doesn't need to
 * proceed further. Per HLDS §5.5 / 02-protocol-coverage.md §5.
 * @param {object} monitor Monitor row
 * @param {object} heartbeat Heartbeat to populate
 * @param {object} ctx Preflight context
 * @returns {Promise<void>}
 */
async function probeRtmp(monitor, heartbeat, ctx) {
    const startTime = Date.now();
    const c0c1 = Buffer.alloc(RTMP_HANDSHAKE_BYTES);
    c0c1[0] = 0x03; // C0 — version byte
    const now = Math.floor(Date.now() / 1000) & 0xffffffff;
    c0c1.writeUInt32BE(now, 1); // C1 time
    c0c1.writeUInt32BE(0, 5); // C1 zeros
    crypto.randomFillSync(c0c1, 9, 1528); // C1 random payload

    const socket = await openSocket(ctx);
    let s0s1;
    try {
        await writeSocket(socket, c0c1);
        s0s1 = await readBytes(socket, RTMP_HANDSHAKE_BYTES, ctx.timeoutMs, false);
    } finally {
        if (!socket.destroyed) {
            socket.destroy();
        }
    }

    if (!s0s1 || s0s1.length < 1 || s0s1[0] !== 0x03) {
        throw new Error(messages.RTMP_NOT_SPOKEN());
    }

    heartbeat.status = UP;
    heartbeat.msg = messages.RTMP_OK();
    heartbeat.ping = Date.now() - startTime;

    if (monitor.getSaveResponse && monitor.getSaveResponse() && monitor.saveResponseData) {
        try {
            await monitor.saveResponseData(
                heartbeat,
                JSON.stringify({
                    s0_version: s0s1[0],
                    bytes_received: s0s1.length,
                })
            );
        } catch (err) {
            log.debug("rtsp", `saveResponseData failed: ${err.message}`);
        }
    }
}

/**
 * Basic-mode entry point. Dispatches by protocol.
 * @param {object} monitor Monitor row
 * @param {object} heartbeat Heartbeat to populate
 * @param {object} ctx Preflight context
 * @returns {Promise<void>}
 */
async function basicProbe(monitor, heartbeat, ctx) {
    const { protocol } = ctx;
    if (protocol === "rtsp" || protocol === "rtsps") {
        return probeRtsp(monitor, heartbeat, ctx);
    }
    if (protocol === "rtmp" || protocol === "rtmps") {
        return probeRtmp(monitor, heartbeat, ctx);
    }
    throw new Error(messages.UNKNOWN_PROTOCOL(protocol));
}

module.exports = {
    basicProbe,
    probeRtsp,
    probeRtmp,
    parseRtspResponse,
    classifyRtspStatus,
    writeSocket,
};
