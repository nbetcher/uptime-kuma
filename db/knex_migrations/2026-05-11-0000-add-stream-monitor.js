exports.up = function (knex) {
    return knex.schema
        .alterTable("monitor", function (table) {
            // Stream-monitor configuration
            table.string("stream_protocol", 8).defaultTo(null);
            table.string("stream_transport", 8).defaultTo(null);
            table.string("stream_mode", 16).defaultTo(null);
            table.integer("stream_frame_count").defaultTo(null);
            table.integer("stream_wall_clock_budget_sec").defaultTo(null);

            // Full-mode references
            table.integer("stream_match_threshold").defaultTo(null);
            table.boolean("stream_separate_day_night").defaultTo(null);
            table.binary("stream_reference_day_blob").defaultTo(null);
            table.text("stream_reference_day_url").defaultTo(null);
            table.binary("stream_reference_day_hash").defaultTo(null);
            table.binary("stream_reference_night_blob").defaultTo(null);
            table.text("stream_reference_night_url").defaultTo(null);
            table.binary("stream_reference_night_hash").defaultTo(null);

            // Display opt-ins
            table.boolean("stream_status_thumbnail").defaultTo(null);
            table.boolean("stream_keep_down_images").defaultTo(null);
        })
        .createTable("monitor_reference_audit", function (table) {
            table.increments("id");
            table.integer("monitor_id").notNullable()
                .references("id").inTable("monitor").onDelete("CASCADE");
            table.string("slot", 8).notNullable();
            table.string("source", 16).notNullable();
            table.integer("byte_size").notNullable().defaultTo(0);
            table.binary("sha256").nullable();
            table.integer("user_id").nullable()
                .references("id").inTable("user").onDelete("SET NULL");
            table.timestamp("created_at").defaultTo(knex.fn.now());
            table.index("monitor_id");
        })
        .createTable("monitor_stream_down_image", function (table) {
            table.increments("id");
            table.integer("monitor_id").notNullable()
                .references("id").inTable("monitor").onDelete("CASCADE");
            table.string("kind", 8).notNullable().defaultTo("down");
            table.timestamp("captured_at").defaultTo(knex.fn.now());
            table.binary("image_blob").notNullable();
            table.index(["monitor_id", "kind", "captured_at"]);
        });
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
