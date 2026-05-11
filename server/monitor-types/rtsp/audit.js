const { R } = require("redbean-node");
const dayjs = require("dayjs");
const { log } = require("../../../src/util");

/**
 * Write an audit record for a reference-image action. Per OP-007 /
 * HLDS §3.4 / §5.11.
 *
 * @param {object} args Audit fields
 * @param {number} args.monitorId Monitor ID
 * @param {string} args.slot 'day' | 'night' | 'single'
 * @param {string} args.source 'upload' | 'url-fetch' | 'url-refresh' | 'delete'
 * @param {number} args.byteSize Canonical bytes length (0 for delete)
 * @param {Buffer|null} args.sha256 SHA-256 of canonical bytes (null for delete)
 * @param {number|null} args.userId Authenticated user id (null if disableAuth)
 * @returns {Promise<void>}
 */
async function recordAudit(args) {
    try {
        await R.exec(
            "INSERT INTO monitor_reference_audit (monitor_id, slot, source, byte_size, sha256, user_id, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                args.monitorId,
                args.slot,
                args.source,
                args.byteSize | 0,
                args.sha256 || null,
                args.userId === undefined ? null : args.userId,
                dayjs().toISOString(),
            ]
        );
    } catch (e) {
        // An audit failure should not block the user's action.
        log.warn("rtsp", `recordAudit failed: ${e.message}`);
    }
}

module.exports = {
    recordAudit,
};
