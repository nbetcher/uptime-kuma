exports.up = async function (knex) {
    // Older MariaDB installations can have the monitor columns committed
    // even though the original signed foreign-key migration then failed.
    // Resume that partial migration without duplicating existing columns.
    const columns = {
        stream_protocol: (table) => table.string("stream_protocol", 8).defaultTo(null),
        stream_transport: (table) => table.string("stream_transport", 8).defaultTo(null),
        stream_mode: (table) => table.string("stream_mode", 16).defaultTo(null),
        stream_frame_count: (table) => table.integer("stream_frame_count").defaultTo(null),
        stream_wall_clock_budget_sec: (table) => table.integer("stream_wall_clock_budget_sec").defaultTo(null),
        stream_match_threshold: (table) => table.integer("stream_match_threshold").defaultTo(null),
        stream_separate_day_night: (table) => table.boolean("stream_separate_day_night").defaultTo(null),
        stream_reference_day_blob: (table) => table.specificType("stream_reference_day_blob", "mediumblob").nullable(),
        stream_reference_day_url: (table) => table.text("stream_reference_day_url").defaultTo(null),
        stream_reference_day_hash: (table) => table.binary("stream_reference_day_hash").defaultTo(null),
        stream_reference_night_blob: (table) => table.specificType("stream_reference_night_blob", "mediumblob").nullable(),
        stream_reference_night_url: (table) => table.text("stream_reference_night_url").defaultTo(null),
        stream_reference_night_hash: (table) => table.binary("stream_reference_night_hash").defaultTo(null),
        stream_status_thumbnail: (table) => table.boolean("stream_status_thumbnail").defaultTo(null),
        stream_keep_down_images: (table) => table.boolean("stream_keep_down_images").defaultTo(null),
    };
    const missing = [];
    for (const [name, create] of Object.entries(columns)) {
        if (!(await knex.schema.hasColumn("monitor", name))) {
            missing.push(create);
        }
    }
    if (missing.length) {
        await knex.schema.alterTable("monitor", (table) => {
            for (const create of missing) {
                create(table);
            }
        });
    }
    if (!(await knex.schema.hasTable("monitor_reference_audit"))) {
        await knex.schema.createTable("monitor_reference_audit", function (table) {
            table.increments("id");
            table.integer("monitor_id").unsigned().notNullable()
                .references("id").inTable("monitor").onDelete("CASCADE");
            table.string("slot", 8).notNullable();
            table.string("source", 16).notNullable();
            table.integer("byte_size").notNullable().defaultTo(0);
            table.binary("sha256").nullable();
            table.integer("user_id").unsigned().nullable()
                .references("id").inTable("user").onDelete("SET NULL");
            table.timestamp("created_at").defaultTo(knex.fn.now());
            table.index("monitor_id");
        });
    }
    if (!(await knex.schema.hasTable("monitor_stream_down_image"))) {
        await knex.schema.createTable("monitor_stream_down_image", function (table) {
            table.increments("id");
            table.integer("monitor_id").unsigned().notNullable()
                .references("id").inTable("monitor").onDelete("CASCADE");
            table.string("kind", 8).notNullable().defaultTo("down");
            table.timestamp("captured_at").defaultTo(knex.fn.now());
            table.specificType("image_blob", "mediumblob").notNullable();
            table.index(["monitor_id", "kind", "captured_at"]);
        });
    }
};

exports.down = function (knex) {
    return knex.schema
        .dropTableIfExists("monitor_stream_down_image")
        .dropTableIfExists("monitor_reference_audit")
        .alterTable("monitor", function (table) {
            table.dropColumn("stream_keep_down_images");
            table.dropColumn("stream_status_thumbnail");
            table.dropColumn("stream_reference_night_hash");
            table.dropColumn("stream_reference_night_url");
            table.dropColumn("stream_reference_night_blob");
            table.dropColumn("stream_reference_day_hash");
            table.dropColumn("stream_reference_day_url");
            table.dropColumn("stream_reference_day_blob");
            table.dropColumn("stream_separate_day_night");
            table.dropColumn("stream_match_threshold");
            table.dropColumn("stream_wall_clock_budget_sec");
            table.dropColumn("stream_frame_count");
            table.dropColumn("stream_mode");
            table.dropColumn("stream_transport");
            table.dropColumn("stream_protocol");
        });
};
