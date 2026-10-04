const crypto = require("node:crypto");
const dayjs = require("dayjs");
// Registered here as well as in server.js so the module works on its
// own (tests, scripts); extend() is idempotent.
dayjs.extend(require("dayjs/plugin/utc"));
const { R } = require("redbean-node");
const { log } = require("../../../src/util");
const { canonicalize, fingerprint, packFingerprint, thumbnailize } = require("./image-pipeline");
const { fetchUrl } = require("./ssrf-guard");
const { recordAudit } = require("./audit");

const VALID_SLOTS = ["day", "night", "single"];

/**
 * Map the public `slot` discriminator to the stored slot. 'single'
 * (one reference, no day/night split) is stored in the 'day' row.
 * @param {string} slot 'day' | 'night' | 'single'
 * @returns {'day'|'night'} Stored slot
 */
function storedSlot(slot) {
    if (!VALID_SLOTS.includes(slot)) {
        throw new Error(`invalid slot: ${slot}`);
    }
    return slot === "night" ? "night" : "day";
}

/**
 * Current time in the format the rest of Uptime Kuma stores, valid for
 * both SQLite and MariaDB DATETIME columns.
 * @returns {string} Timestamp
 */
function nowForDb() {
    return R.isoDateTimeMillis(dayjs.utc());
}

/**
 * Internal: process raw image bytes into the canonical (blob,
 * fingerprint, sha256) tuple.
 * @param {Buffer} rawBytes Source image bytes
 * @returns {Promise<{blob: Buffer, hash: Buffer, sha256: Buffer, width: number, height: number}>}
 */
async function processRaw(rawBytes) {
    const blob = await canonicalize(rawBytes);
    // HLDS §3.3: canonicalised BLOBs are capped at 256 KB. mozjpeg
    // re-encode at quality 85 at 640px should land well under, but
    // a pathological input (e.g. dense noise) could exceed — reject
    // rather than store an oversize row.
    if (blob.length > 256 * 1024) {
        throw new Error(`reference exceeds 256 KB after canonicalize (got ${blob.length})`);
    }
    const sharpModule = require("sharp");
    const meta = await sharpModule(blob).metadata();
    const fp = await fingerprint(blob);
    const hash = packFingerprint(fp);
    const sha256 = crypto.createHash("sha256").update(blob).digest();
    return {
        blob,
        hash,
        sha256,
        width: meta.width || 0,
        height: meta.height || 0,
    };
}

/**
 * Replace the reference row for (monitor, slot) inside a transaction.
 * @param {object} trx RedBean transaction
 * @param {number} monitorId Monitor ID
 * @param {string} slot 'day' | 'night' | 'single'
 * @param {Buffer} blob Canonical JPEG
 * @param {Buffer} hash Packed fingerprint
 * @param {string|null} sourceUrl Source URL if any
 * @returns {Promise<void>}
 */
async function persist(trx, monitorId, slot, blob, hash, sourceUrl) {
    const stored = storedSlot(slot);
    await trx.exec("DELETE FROM monitor_stream_reference WHERE monitor_id = ? AND slot = ?", [monitorId, stored]);
    await trx.exec(
        "INSERT INTO monitor_stream_reference (monitor_id, slot, image_blob, fingerprint, source_url, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        [monitorId, stored, blob, hash, sourceUrl, nowForDb()]
    );
}

/**
 * Run `persist` + `recordAudit` atomically. Either both succeed or
 * neither: addresses the race where an observer sees the new blob but
 * the audit reports the old SHA (M6 from the audit). Used by all
 * non-delete upload paths.
 * @param {object} args Persist + audit arguments
 * @param {number} args.monitorId Monitor ID
 * @param {string} args.slot 'day' | 'night' | 'single'
 * @param {Buffer} args.blob Canonical JPEG
 * @param {Buffer} args.hash Packed fingerprint
 * @param {string|null} args.sourceUrl Source URL if any
 * @param {string} args.source Audit source label
 * @param {Buffer} args.sha256 SHA-256 of canonical bytes
 * @param {number|null} args.userId Authenticated user id
 * @returns {Promise<void>}
 */
async function persistWithAudit(args) {
    const { monitorId, slot, blob, hash, sourceUrl, source, sha256, userId } = args;
    let trx;
    try {
        trx = await R.begin();
        await persist(trx, monitorId, slot, blob, hash, sourceUrl);
        await recordAudit({
            monitorId,
            slot,
            source,
            byteSize: blob.length,
            sha256,
            userId,
            trx,
        });
        await trx.commit();
    } catch (e) {
        if (trx) {
            try {
                await trx.rollback();
            } catch {
                /* ignored — original error is the meaningful one */
            }
        }
        throw e;
    }
}

/**
 * Upload a reference from raw bytes (multipart upload). Per HLDS
 * §5.10.
 * @param {object} args Arguments
 * @param {number} args.monitorId Monitor ID
 * @param {string} args.slot 'day' | 'night' | 'single'
 * @param {Buffer} args.bytes Raw uploaded bytes
 * @param {number|null} args.userId Authenticated user id
 * @returns {Promise<object>} Result metadata
 */
async function uploadBlob(args) {
    const { monitorId, slot, bytes, userId } = args;
    storedSlot(slot);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new Error("empty upload");
    }
    const processed = await processRaw(bytes);
    await persistWithAudit({
        monitorId,
        slot,
        blob: processed.blob,
        hash: processed.hash,
        sourceUrl: null,
        source: "upload",
        sha256: processed.sha256,
        userId,
    });
    return {
        slot,
        source: "upload",
        byteSize: processed.blob.length,
        width: processed.width,
        height: processed.height,
        sha256: processed.sha256.toString("hex"),
        fingerprint: processed.hash.toString("hex"),
    };
}

/**
 * Upload a reference by URL (server fetches it).
 * @param {object} args Arguments
 * @param {number} args.monitorId Monitor ID
 * @param {string} args.slot 'day' | 'night' | 'single'
 * @param {string} args.url Source URL
 * @param {string|null} args.monitorHostname Monitored hostname (for SSRF carveout)
 * @param {number|null} args.userId Authenticated user id
 * @returns {Promise<object>} Result metadata
 */
async function uploadUrl(args) {
    const { monitorId, slot, url, monitorHostname, userId } = args;
    storedSlot(slot);
    if (!url) {
        throw new Error("URL is required");
    }

    const bytes = await fetchUrl(url, { monitorHostname });
    const processed = await processRaw(bytes);
    await persistWithAudit({
        monitorId,
        slot,
        blob: processed.blob,
        hash: processed.hash,
        sourceUrl: url,
        source: "url-fetch",
        sha256: processed.sha256,
        userId,
    });
    return {
        slot,
        source: "url",
        byteSize: processed.blob.length,
        width: processed.width,
        height: processed.height,
        sha256: processed.sha256.toString("hex"),
        fingerprint: processed.hash.toString("hex"),
        url,
    };
}

/**
 * Re-fetch the stored URL and refresh the cached BLOB. Returns the
 * same metadata shape as uploadUrl.
 * @param {object} args Arguments
 * @returns {Promise<object>}
 */
async function refreshUrl(args) {
    const { monitorId, slot, monitorHostname, userId } = args;
    const row = await R.getRow(
        "SELECT source_url AS url FROM monitor_stream_reference WHERE monitor_id = ? AND slot = ?",
        [monitorId, storedSlot(slot)]
    );
    if (!row || !row.url) {
        throw new Error("no URL stored for this slot");
    }
    const bytes = await fetchUrl(row.url, { monitorHostname });
    const processed = await processRaw(bytes);
    await persistWithAudit({
        monitorId,
        slot,
        blob: processed.blob,
        hash: processed.hash,
        sourceUrl: row.url,
        source: "url-refresh",
        sha256: processed.sha256,
        userId,
    });
    return {
        slot,
        source: "url",
        byteSize: processed.blob.length,
        width: processed.width,
        height: processed.height,
        sha256: processed.sha256.toString("hex"),
        fingerprint: processed.hash.toString("hex"),
        url: row.url,
    };
}

/**
 * Clear a reference slot.
 * @param {object} args Arguments
 * @returns {Promise<void>}
 */
async function deleteSlot(args) {
    const { monitorId, slot, userId } = args;
    await R.exec("DELETE FROM monitor_stream_reference WHERE monitor_id = ? AND slot = ?", [
        monitorId,
        storedSlot(slot),
    ]);
    await recordAudit({
        monitorId,
        slot,
        source: "delete",
        byteSize: 0,
        sha256: null,
        userId,
    });
}

/**
 * Fetch the cached BLOB for display.
 * @param {object} args Arguments
 * @returns {Promise<Buffer|null>}
 */
async function getBlob(args) {
    const { monitorId, slot } = args;
    const row = await R.getRow("SELECT image_blob FROM monitor_stream_reference WHERE monitor_id = ? AND slot = ?", [
        monitorId,
        storedSlot(slot),
    ]);
    if (!row || !row.image_blob) {
        return null;
    }
    return Buffer.isBuffer(row.image_blob) ? row.image_blob : Buffer.from(row.image_blob);
}

/**
 * Load the packed fingerprints a Full-mode check compares against.
 * @param {number} monitorId Monitor ID
 * @returns {Promise<{day: Buffer|null, night: Buffer|null}>} Fingerprint per stored slot
 */
async function getFingerprints(monitorId) {
    const rows = await R.getAll("SELECT slot, fingerprint FROM monitor_stream_reference WHERE monitor_id = ?", [
        monitorId,
    ]);
    const out = { day: null, night: null };
    for (const row of rows) {
        if ((row.slot === "day" || row.slot === "night") && row.fingerprint) {
            out[row.slot] = Buffer.isBuffer(row.fingerprint) ? row.fingerprint : Buffer.from(row.fingerprint);
        }
    }
    return out;
}

/**
 * Metadata about a monitor's references for the edit form — no image
 * bytes.
 * @param {number} monitorId Monitor ID
 * @returns {Promise<{day: object|null, night: object|null}>} Per stored slot: {byteSize, url, updatedAt} or null
 */
async function getReferenceInfo(monitorId) {
    const rows = await R.getAll(
        "SELECT slot, LENGTH(image_blob) AS byte_size, source_url, updated_at FROM monitor_stream_reference WHERE monitor_id = ?",
        [monitorId]
    );
    const out = { day: null, night: null };
    for (const row of rows) {
        if (row.slot === "day" || row.slot === "night") {
            out[row.slot] = {
                byteSize: Number(row.byte_size) || 0,
                url: row.source_url || null,
                updatedAt: row.updated_at,
            };
        }
    }
    return out;
}

/**
 * Persist a last-match thumbnail or DOWN-frame image, bounded to 5
 * rows per (monitor_id, kind). Inline DELETE in the same transaction
 * keeps the table size capped. Per OP-008.
 * @param {object} args Arguments
 * @param {number} args.monitorId Monitor ID
 * @param {'down'|'match'} args.kind Image kind
 * @param {Buffer} args.jpeg JPEG bytes
 * @returns {Promise<void>}
 */
async function persistFrameImage(args) {
    const { monitorId, kind, jpeg } = args;
    if (!["down", "match"].includes(kind)) {
        throw new Error(`invalid frame-image kind: ${kind}`);
    }
    let thumb;
    try {
        thumb = await thumbnailize(jpeg);
    } catch (e) {
        log.warn("rtsp", `thumbnailize failed: ${e.message}`);
        return;
    }
    const limit = kind === "match" ? 1 : 5;
    // Wrap INSERT + bounded-cleanup DELETE in a single
    // transaction so the table never transiently exceeds `limit`
    // rows for a given (monitor, kind) — OP-008. The cleanup
    // subquery uses a portable "id NOT IN (most-recent-N)" form
    // that works on both SQLite and MariaDB (LIMIT/OFFSET inside
    // IN subqueries needs the wrapping table on MySQL/MariaDB).
    let trx;
    try {
        trx = await R.begin();
        await trx.exec(
            "INSERT INTO monitor_stream_down_image (monitor_id, kind, image_blob, captured_at) VALUES (?, ?, ?, ?)",
            [monitorId, kind, thumb, nowForDb()]
        );
        await trx.exec(
            `DELETE FROM monitor_stream_down_image
             WHERE monitor_id = ? AND kind = ?
               AND id NOT IN (
                 SELECT id FROM (
                   SELECT id FROM monitor_stream_down_image
                   WHERE monitor_id = ? AND kind = ?
                   ORDER BY captured_at DESC
                   LIMIT ?
                 ) AS keep
               )`,
            [monitorId, kind, monitorId, kind, limit]
        );
        await trx.commit();
    } catch (e) {
        if (trx) {
            try {
                await trx.rollback();
            } catch {
                /* ignored */
            }
        }
        log.warn("rtsp", `persistFrameImage failed: ${e.message}`);
    }
}

module.exports = {
    VALID_SLOTS,
    storedSlot,
    uploadBlob,
    uploadUrl,
    refreshUrl,
    deleteSlot,
    getBlob,
    getFingerprints,
    getReferenceInfo,
    persistFrameImage,
};
