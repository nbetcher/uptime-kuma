const crypto = require("node:crypto");
const { R } = require("redbean-node");
const { log } = require("../../../src/util");
const { canonicalize, fingerprint, packFingerprint, thumbnailize } = require("./image-pipeline");
const { fetchUrl } = require("./ssrf-guard");
const { recordAudit } = require("./audit");

const VALID_SLOTS = ["day", "night", "single"];

/**
 * Map the public `slot` discriminator to internal column names. The
 * 'single' slot reuses the Day column because the storage layout is
 * keyed by (day|night) only.
 *
 * @param {string} slot 'day' | 'night' | 'single'
 * @returns {{blobCol: string, urlCol: string, hashCol: string}}
 */
function columnsForSlot(slot) {
    if (slot === "night") {
        return {
            blobCol: "stream_reference_night_blob",
            urlCol: "stream_reference_night_url",
            hashCol: "stream_reference_night_hash",
        };
    }
    // day OR single both target the Day column set
    return {
        blobCol: "stream_reference_day_blob",
        urlCol: "stream_reference_day_url",
        hashCol: "stream_reference_day_hash",
    };
}

/**
 * Internal: process raw image bytes into the canonical (blob,
 * fingerprint, sha256) tuple.
 *
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
 * Persist a processed reference onto the monitor row.
 *
 * @param {number} monitorId Monitor ID
 * @param {string} slot 'day' | 'night' | 'single'
 * @param {Buffer} blob Canonical JPEG
 * @param {Buffer} hash Packed fingerprint
 * @param {string|null} sourceUrl Source URL if any
 * @returns {Promise<void>}
 */
async function persist(monitorId, slot, blob, hash, sourceUrl) {
    const cols = columnsForSlot(slot);
    await R.exec(
        `UPDATE monitor SET ${cols.blobCol} = ?, ${cols.urlCol} = ?, ${cols.hashCol} = ? WHERE id = ?`,
        [blob, sourceUrl, hash, monitorId]
    );
}

/**
 * Upload a reference from raw bytes (multipart upload). Per HLDS
 * §5.10.
 *
 * @param {object} args Arguments
 * @param {number} args.monitorId Monitor ID
 * @param {string} args.slot 'day' | 'night' | 'single'
 * @param {Buffer} args.bytes Raw uploaded bytes
 * @param {number|null} args.userId Authenticated user id
 * @returns {Promise<object>} Result metadata
 */
async function uploadBlob(args) {
    const { monitorId, slot, bytes, userId } = args;
    if (!VALID_SLOTS.includes(slot)) throw new Error(`invalid slot: ${slot}`);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new Error("empty upload");
    }
    const processed = await processRaw(bytes);
    await persist(monitorId, slot, processed.blob, processed.hash, null);
    await recordAudit({
        monitorId,
        slot,
        source: "upload",
        byteSize: processed.blob.length,
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
 *
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
    if (!VALID_SLOTS.includes(slot)) throw new Error(`invalid slot: ${slot}`);
    if (!url) throw new Error("URL is required");

    const bytes = await fetchUrl(url, { monitorHostname });
    const processed = await processRaw(bytes);
    await persist(monitorId, slot, processed.blob, processed.hash, url);
    await recordAudit({
        monitorId,
        slot,
        source: "url-fetch",
        byteSize: processed.blob.length,
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
 *
 * @param {object} args Arguments
 * @returns {Promise<object>}
 */
async function refreshUrl(args) {
    const { monitorId, slot, monitorHostname, userId } = args;
    if (!VALID_SLOTS.includes(slot)) throw new Error(`invalid slot: ${slot}`);
    const cols = columnsForSlot(slot);
    const row = await R.getRow(
        `SELECT ${cols.urlCol} as url FROM monitor WHERE id = ?`,
        [monitorId]
    );
    if (!row || !row.url) {
        throw new Error("no URL stored for this slot");
    }
    const bytes = await fetchUrl(row.url, { monitorHostname });
    const processed = await processRaw(bytes);
    await persist(monitorId, slot, processed.blob, processed.hash, row.url);
    await recordAudit({
        monitorId,
        slot,
        source: "url-refresh",
        byteSize: processed.blob.length,
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
 *
 * @param {object} args Arguments
 * @returns {Promise<void>}
 */
async function deleteSlot(args) {
    const { monitorId, slot, userId } = args;
    if (!VALID_SLOTS.includes(slot)) throw new Error(`invalid slot: ${slot}`);
    const cols = columnsForSlot(slot);
    await R.exec(
        `UPDATE monitor SET ${cols.blobCol} = NULL, ${cols.urlCol} = NULL, ${cols.hashCol} = NULL WHERE id = ?`,
        [monitorId]
    );
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
 * Fetch the cached BLOB for an HTTP GET response.
 *
 * @param {object} args Arguments
 * @returns {Promise<Buffer|null>}
 */
async function getBlob(args) {
    const { monitorId, slot } = args;
    if (!VALID_SLOTS.includes(slot)) throw new Error(`invalid slot: ${slot}`);
    const cols = columnsForSlot(slot);
    const row = await R.getRow(
        `SELECT ${cols.blobCol} as blob FROM monitor WHERE id = ?`,
        [monitorId]
    );
    if (!row || !row.blob) return null;
    return Buffer.isBuffer(row.blob) ? row.blob : Buffer.from(row.blob);
}

/**
 * Persist a last-match thumbnail or DOWN-frame image, bounded to 5
 * rows per (monitor_id, kind). Inline DELETE in the same transaction
 * keeps the table size capped. Per OP-008.
 *
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
            [monitorId, kind, thumb, new Date().toISOString()]
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
    columnsForSlot,
    uploadBlob,
    uploadUrl,
    refreshUrl,
    deleteSlot,
    getBlob,
    persistFrameImage,
};
