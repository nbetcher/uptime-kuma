const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { UP } = require("../../../src/util");

const MIGRATIONS = path.join(__dirname, "../../../db/knex_migrations");
const REFERENCE_TABLE_MIGRATION = "2026-10-04-0000-stream-reference-table.js";
const FIXTURES = path.join(__dirname, "fixtures", "rtsp");

/**
 * Preflight-shaped context that decodes a local fixture file.
 * @param {string} name Fixture file name
 * @returns {object} ctx
 */
function fileCtx(name) {
    return {
        url: pathToFileURL(path.join(FIXTURES, name)).href,
        protocol: "file",
        timeoutMs: 5000,
        budgetMs: 15000,
        tlsVerify: false,
    };
}

/**
 * Monitor-shaped stub for the check modules.
 * @param {object} overrides Fields to set
 * @returns {object} Monitor stub
 */
function stubMonitor(overrides) {
    return {
        stream_frame_count: 5,
        stream_match_threshold: 24,
        getSaveResponse: () => false,
        ...overrides,
    };
}

describe("RTSP reference storage against a real SQLite database", async () => {
    const { probeNativeSupport } = require("../../../server/monitor-types/rtsp/frame-capture");
    const native = await probeNativeSupport();
    const skip = native.nodeAv || native.sharp ? `native support unavailable: ${native.nodeAv || native.sharp}` : false;

    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kuma-rtsp-")), "kuma.db");
    let R;
    let monitorId;
    let heartbeatCount;
    let legacyBlob;

    before(async () => {
        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");
        const knex = require("knex")({
            client: Dialect,
            connection: { filename: dbPath },
            useNullAsDefault: true,
        });
        R = require("redbean-node").R;
        R.setup(knex);

        const { createTables } = require("../../../db/knex_init_db.js");
        await createTables();

        // Bring the schema to the state shipped before the reference
        // table existed.
        const [, pending] = await knex.migrate.list({ directory: MIGRATIONS });
        for (const m of pending) {
            if (m.file === REFERENCE_TABLE_MIGRATION) {
                break;
            }
            await knex.migrate.up({ directory: MIGRATIONS, name: m.file });
        }

        // Seed a user, an RTSP monitor with a legacy in-row reference,
        // and some heartbeats that must survive the migration.
        const [userId] = await knex("user").insert({ username: "admin", password: "x", active: 1 });
        legacyBlob = Buffer.alloc(1024, 7);
        [monitorId] = await knex("monitor").insert({
            name: "cam",
            type: "rtsp",
            url: "rtsp://cam.local/s",
            user_id: userId,
            stream_mode: "full",
            stream_reference_day_blob: legacyBlob,
            stream_reference_day_hash: Buffer.alloc(16, 1),
            stream_reference_day_url: "http://nas.local/day.jpg",
        });
        for (let i = 0; i < 3; i++) {
            await knex("heartbeat").insert({
                monitor_id: monitorId,
                status: 1,
                msg: "ok",
                time: `2026-10-0${i + 1} 00:00:00`,
            });
        }
        heartbeatCount = 3;

        await knex.migrate.latest({ directory: MIGRATIONS });
        // Match production (database.js): transactions are no-ops in
        // redbean's fluid mode.
        R.freeze(true);
    });

    after(async () => {
        await R?.knex.destroy();
        fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    });

    test("migration moves references out of the monitor row", async () => {
        const rows = await R.getAll("SELECT * FROM monitor_stream_reference WHERE monitor_id = ?", [monitorId]);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].slot, "day");
        assert.ok(Buffer.from(rows[0].image_blob).equals(legacyBlob));
        assert.strictEqual(rows[0].source_url, "http://nas.local/day.jpg");

        const monitor = await R.getRow(
            "SELECT stream_reference_day_blob, stream_reference_day_hash FROM monitor WHERE id = ?",
            [monitorId]
        );
        assert.strictEqual(monitor.stream_reference_day_blob, null);
        assert.strictEqual(monitor.stream_reference_day_hash, null);
    });

    test("migration keeps heartbeats", async () => {
        const row = await R.getRow("SELECT COUNT(*) AS n FROM heartbeat WHERE monitor_id = ?", [monitorId]);
        assert.strictEqual(Number(row.n), heartbeatCount);
    });

    test("upload, read back, fingerprint, and delete a reference", { skip }, async () => {
        const store = require("../../../server/monitor-types/rtsp/reference-store");
        const sharp = require("sharp");
        const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#336699" } })
            .png()
            .toBuffer();

        const result = await store.uploadBlob({ monitorId, slot: "night", bytes: png, userId: null });
        assert.strictEqual(result.width, 640);

        const info = await store.getReferenceInfo(monitorId);
        assert.ok(info.day, "migrated day reference is visible");
        assert.strictEqual(info.night.byteSize, result.byteSize);

        const fps = await store.getFingerprints(monitorId);
        assert.strictEqual(fps.night.toString("hex"), result.fingerprint);

        // Re-upload replaces rather than duplicates.
        await store.uploadBlob({ monitorId, slot: "night", bytes: png, userId: null });
        const count = await R.getRow(
            "SELECT COUNT(*) AS n FROM monitor_stream_reference WHERE monitor_id = ? AND slot = 'night'",
            [monitorId]
        );
        assert.strictEqual(Number(count.n), 1);

        await store.deleteSlot({ monitorId, slot: "night", userId: null });
        assert.strictEqual((await store.getFingerprints(monitorId)).night, null);

        const audits = await R.getAll("SELECT source FROM monitor_reference_audit WHERE monitor_id = ? ORDER BY id", [
            monitorId,
        ]);
        assert.deepStrictEqual(
            audits.map((a) => a.source),
            ["upload", "upload", "delete"]
        );
    });

    test("frame-image history stays bounded per kind", { skip }, async () => {
        const store = require("../../../server/monitor-types/rtsp/reference-store");
        const sharp = require("sharp");
        const jpeg = await sharp({ create: { width: 160, height: 120, channels: 3, background: "#808080" } })
            .jpeg()
            .toBuffer();
        for (let i = 0; i < 7; i++) {
            await store.persistFrameImage({ monitorId, kind: "down", jpeg });
            await store.persistFrameImage({ monitorId, kind: "match", jpeg });
        }
        const rows = await R.getAll(
            "SELECT kind, COUNT(*) AS n FROM monitor_stream_down_image WHERE monitor_id = ? GROUP BY kind ORDER BY kind",
            [monitorId]
        );
        assert.deepStrictEqual(
            rows.map((r) => [r.kind, Number(r.n)]),
            [
                ["down", 5],
                ["match", 1],
            ]
        );
    });

    test("Full mode matches a frame against its stored reference end to end", { skip }, async () => {
        const store = require("../../../server/monitor-types/rtsp/reference-store");
        const { captureFrames } = require("../../../server/monitor-types/rtsp/frame-capture");
        const fullCheck = require("../../../server/monitor-types/rtsp/full-check");

        const { frames } = await captureFrames(fileCtx("moving.mp4"), { count: 1, budgetMs: 15000 });
        await store.uploadBlob({ monitorId, slot: "day", bytes: frames[0], userId: null });

        const monitor = stubMonitor({ id: monitorId, stream_separate_day_night: false });
        const heartbeat = {};
        await fullCheck.run(monitor, heartbeat, fileCtx("moving.mp4"));
        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /matched single at distance \d+\/128/);

        await assert.rejects(fullCheck.run(monitor, {}, fileCtx("frozen.mp4")), /scene mismatch/);
    });

    test("Full mode without references fails before opening the stream", async () => {
        const fullCheck = require("../../../server/monitor-types/rtsp/full-check");
        const monitor = stubMonitor({ id: 999999, stream_separate_day_night: true });
        const ctx = { ...fileCtx("moving.mp4"), url: "rtsp://192.0.2.1/never-contacted" };
        await assert.rejects(fullCheck.run(monitor, {}, ctx), /requires at least one reference/);
    });
});

describe("Enhanced mode end to end on fixture streams", async () => {
    const { probeNativeSupport } = require("../../../server/monitor-types/rtsp/frame-capture");
    const native = await probeNativeSupport();
    const skip = native.nodeAv || native.sharp ? `native support unavailable: ${native.nodeAv || native.sharp}` : false;

    test("moving stream is UP", { skip }, async () => {
        const enhanced = require("../../../server/monitor-types/rtsp/enhanced-check");
        const heartbeat = {};
        await enhanced.run(stubMonitor({ id: "t1" }), heartbeat, fileCtx("moving.mp4"));
        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /captured 5 frames/);
    });

    test("frozen stream is DOWN", { skip }, async () => {
        const enhanced = require("../../../server/monitor-types/rtsp/enhanced-check");
        await assert.rejects(enhanced.run(stubMonitor({ id: "t2" }), {}, fileCtx("frozen.mp4")), /frozen/);
    });

    test("black stream is DOWN", { skip }, async () => {
        const enhanced = require("../../../server/monitor-types/rtsp/enhanced-check");
        await assert.rejects(enhanced.run(stubMonitor({ id: "t3" }), {}, fileCtx("dark.mp4")), /black or uniform/);
    });
});
