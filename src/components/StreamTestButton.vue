<template>
    <div class="my-3">
        <button type="button" class="btn btn-outline-primary" :disabled="running" @click="runTest">
            <span v-if="running">{{ $t("Loading") }}…</span>
            <span v-else>{{ $t("Test") }}</span>
        </button>

        <div v-if="result" class="mt-2">
            <div :class="result.ok ? 'alert alert-success' : 'alert alert-danger'" role="alert">
                <strong>{{ result.ok ? "✓" : "✗" }}</strong>
                {{ result.msg }}
                <span v-if="result.ping !== undefined">({{ result.ping }} ms)</span>
            </div>
            <ul v-if="result.warnings && result.warnings.length" class="list-unstyled">
                <li v-for="(w, i) in result.warnings" :key="i" class="alert alert-warning py-1 px-2 mb-1">
                    {{ w }}
                </li>
            </ul>
        </div>
    </div>
</template>

<script>
import axios from "axios";

/**
 * Test button for stream monitors. Runs the same check function the
 * scheduler would, but against the current edit-form state and
 * without writing a heartbeat row (Q19 / HLDS §7.3).
 */
export default {
    name: "StreamTestButton",

    props: {
        monitor: { type: Object, required: true },
    },

    data() {
        return {
            running: false,
            result: null,
        };
    },

    methods: {
        async runTest() {
            this.running = true;
            this.result = null;
            try {
                const r = await axios.post("/api/monitor/test-stream", this.monitor);
                this.result = r.data;
            } catch (err) {
                this.result = {
                    ok: false,
                    msg: (err && err.response && err.response.data && err.response.data.msg) || err.message || String(err),
                };
            } finally {
                this.running = false;
            }
        },
    },
};
</script>
