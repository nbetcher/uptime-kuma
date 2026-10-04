const { R } = require("redbean-node");
const dayjs = require("dayjs");
// Registered here as well as in server.js so the module works on its
// own (tests, scripts); extend() is idempotent.
dayjs.extend(require("dayjs/plugin/utc"));
const { log } = require("../../../src/util");
const { dbErrorMessage } = require("./db-error");

/**
 * Write an audit record for a reference-image action. Per OP-007 /
 * HLDS §3.4 / §5.11.
 *
 * When `args.trx` is provided, the INSERT runs on that transaction and
 * propagates errors so the caller can roll back atomically with its
 * blob write. When omitted, runs standalone and swallows errors with a
 * warn. Reference uploads and deletes supply a transaction so their
 * data changes and audit record either both succeed or both roll back.
 * @param {object} args Audit fields
 * @param {number} args.monitorId Monitor ID
 * @param {string} args.slot 'day' | 'night' | 'single'
 * @param {string} args.source 'upload' | 'url-fetch' | 'url-refresh' | 'delete'
 * @param {number} args.byteSize Canonical bytes length (0 for delete)
 * @param {Buffer|null} args.sha256 SHA-256 of canonical bytes (null for delete)
 * @param {number|null} args.userId Authenticated user id (null if disableAuth)
 * @param {object} args.trx Optional RedBean transaction
 * @returns {Promise<void>}
 */
async function recordAudit(args) {
    const sql =
        "INSERT INTO monitor_reference_audit (monitor_id, slot, source, byte_size, sha256, user_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)";
    const bindings = [
        args.monitorId,
        args.slot,
        args.source,
        args.byteSize | 0,
        args.sha256 || null,
        args.userId === undefined ? null : args.userId,
        R.isoDateTimeMillis(dayjs.utc()),
    ];
    if (args.trx) {
        await args.trx.exec(sql, bindings);
        return;
    }
    try {
        await R.exec(sql, bindings);
    } catch (e) {
        // An audit failure should not block the user's action.
        log.warn("rtsp", dbErrorMessage(e));
    }
}

module.exports = {
    recordAudit,
};
