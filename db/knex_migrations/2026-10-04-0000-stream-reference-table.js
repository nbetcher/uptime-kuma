// Move stream-monitor reference images out of the `monitor` row.
//
// Every monitor row is loaded with SELECT * (server start, monitor list,
// every edit) and kept in memory for the life of the process, so two
// up-to-256 KB BLOBs per RTSP monitor rode along everywhere and were
// rewritten by every R.store() on edit. References now live in their
// own table and are only read when they are needed.
//
// The old monitor.stream_reference_* columns are emptied, not dropped:
// dropping a column on SQLite makes knex rebuild the whole `monitor`
// table, which with foreign keys enabled on another pooled connection
// would cascade-delete heartbeats. Empty nullable columns cost nothing.

const SLOTS = ["day", "night"];

exports.up = async function (knex) {
    await knex.schema.createTable("monitor_stream_reference", function (table) {
        table.increments("id");
        table
            .integer("monitor_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("monitor")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table.string("slot", 8).notNullable();
        table.specificType("image_blob", "mediumblob").notNullable();
        table.binary("fingerprint", 16).notNullable();
        table.text("source_url").nullable();
        table.datetime("updated_at").notNullable();
        table.unique(["monitor_id", "slot"]);
    });

    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    for (const slot of SLOTS) {
        const rows = await knex("monitor")
            .select(
                "id",
                `stream_reference_${slot}_blob as blob`,
                `stream_reference_${slot}_hash as hash`,
                `stream_reference_${slot}_url as url`
            )
            .whereNotNull(`stream_reference_${slot}_blob`)
            .whereNotNull(`stream_reference_${slot}_hash`);
        for (const row of rows) {
            await knex("monitor_stream_reference").insert({
                monitor_id: row.id,
                slot,
                image_blob: row.blob,
                fingerprint: row.hash,
                source_url: row.url,
                updated_at: now,
            });
        }
    }

    await knex("monitor").update({
        stream_reference_day_blob: null,
        stream_reference_day_hash: null,
        stream_reference_day_url: null,
        stream_reference_night_blob: null,
        stream_reference_night_hash: null,
        stream_reference_night_url: null,
    });
};

exports.down = async function (knex) {
    const rows = await knex("monitor_stream_reference").select(
        "monitor_id",
        "slot",
        "image_blob",
        "fingerprint",
        "source_url"
    );
    for (const row of rows) {
        if (!SLOTS.includes(row.slot)) {
            continue;
        }
        await knex("monitor")
            .where("id", row.monitor_id)
            .update({
                [`stream_reference_${row.slot}_blob`]: row.image_blob,
                [`stream_reference_${row.slot}_hash`]: row.fingerprint,
                [`stream_reference_${row.slot}_url`]: row.source_url,
            });
    }
    await knex.schema.dropTableIfExists("monitor_stream_reference");
};
