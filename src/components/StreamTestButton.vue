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
                <span v-if="result.ping !== undefined && result.ping !== null">({{ result.ping }} ms)</span>
            </div>

            <div
                v-if="result.warningKeyframeInterval"
                class="alert alert-warning py-1 px-2 mb-1"
                role="alert"
            >
                {{ keyframeWarning(result.warningKeyframeInterval) }}
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
/**
 * Test button for stream monitors. Runs the same check function the
 * scheduler would, but against the current edit-form state and
 * without writing a heartbeat row (Q19 / HLDS §7.3). Communicates
 * over socket.io using the authenticated session.
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
        keyframeWarning(w) {
            // The server returns a structured warning (key + args)
            // so the operator-facing text can be localised here.
            if (!w || !w.key) return "";
            return this.$t(w.key, w.args || []);
        },

        runTest() {
            const socket = this.$root.socket;
            if (!socket) {
                this.result = { ok: false, msg: "no socket" };
                return;
            }
            this.running = true;
            this.result = null;
            socket.emit("rtsp:testStream", this.monitor, (res) => {
                this.running = false;
                this.result = res || { ok: false, msg: "no response" };
            });
        },
    },
};
</script>
