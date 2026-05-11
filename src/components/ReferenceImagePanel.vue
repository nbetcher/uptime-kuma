<template>
    <div class="my-3 reference-image-panel">
        <h2 class="mt-4 mb-2">{{ $t("RTSP Reference Images") }}</h2>

        <div v-for="slot in slotsToShow" :key="slot.key" class="card mb-3">
            <div class="card-body">
                <h5 class="card-title">{{ slot.label }}</h5>

                <div v-if="slot.hasBlob" class="mb-2">
                    <img :src="thumbUrl(slot.key)" alt="reference thumbnail" class="ref-thumb" />
                </div>
                <div v-else class="text-muted mb-2">{{ $t("RTSP Reference Empty") }}</div>

                <div v-if="slot.url" class="form-text mb-2">
                    {{ $t("RTSP Reference URL Label") }}: <code>{{ slot.url }}</code>
                </div>

                <div class="d-flex gap-2 align-items-center">
                    <label :for="`upload-${slot.key}`" class="btn btn-outline-primary mb-0">
                        {{ $t("RTSP Upload File") }}
                        <input
                            :id="`upload-${slot.key}`"
                            type="file"
                            accept="image/*"
                            class="d-none"
                            @change="onFileSelected($event, slot.key)"
                        />
                    </label>
                    <button
                        type="button"
                        class="btn btn-outline-primary"
                        @click="onSetUrl(slot.key)"
                    >
                        {{ $t("RTSP Upload URL") }}
                    </button>
                    <button
                        v-if="slot.url"
                        type="button"
                        class="btn btn-outline-secondary"
                        @click="onRefresh(slot.key)"
                    >
                        {{ $t("RTSP Refresh URL") }}
                    </button>
                    <button
                        v-if="slot.hasBlob"
                        type="button"
                        class="btn btn-outline-danger"
                        @click="onDelete(slot.key)"
                    >
                        {{ $t("Delete") }}
                    </button>
                </div>

                <div v-if="slot.status" class="form-text mt-2">{{ slot.status }}</div>
            </div>
        </div>
    </div>
</template>

<script>
import axios from "axios";

const READ_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * ReferenceImagePanel
 *
 * Per HLDS §7.2: surfaces the Day / Night (or single) reference
 * slots, lets the user upload bytes or supply a URL, and lazily
 * fetches the canonical thumbnail via GET. BLOBs are never embedded
 * in the WebSocket-serialised monitor payload (UI-012).
 *
 * Emits `uploaded(info)` after a successful upload / URL fetch /
 * refresh so the parent form can update its hasBlob flags.
 */
export default {
    name: "ReferenceImagePanel",

    props: {
        monitorId: { type: [Number, String], required: true },
        separateDayNight: { type: Boolean, default: true },
        dayHasBlob: { type: Boolean, default: false },
        nightHasBlob: { type: Boolean, default: false },
        dayUrl: { type: String, default: null },
        nightUrl: { type: String, default: null },
    },

    emits: ["uploaded"],

    data() {
        return {
            slotState: {
                day: { hasBlob: this.dayHasBlob, url: this.dayUrl, status: "" },
                night: { hasBlob: this.nightHasBlob, url: this.nightUrl, status: "" },
                single: { hasBlob: this.dayHasBlob, url: this.dayUrl, status: "" },
            },
            thumbBust: Date.now(),
        };
    },

    computed: {
        slotsToShow() {
            if (this.separateDayNight) {
                return [
                    {
                        key: "day",
                        label: this.$t("RTSP Reference Day"),
                        hasBlob: this.slotState.day.hasBlob,
                        url: this.slotState.day.url,
                        status: this.slotState.day.status,
                    },
                    {
                        key: "night",
                        label: this.$t("RTSP Reference Night"),
                        hasBlob: this.slotState.night.hasBlob,
                        url: this.slotState.night.url,
                        status: this.slotState.night.status,
                    },
                ];
            }
            return [
                {
                    key: "single",
                    label: this.$t("RTSP Reference Single"),
                    hasBlob: this.slotState.single.hasBlob,
                    url: this.slotState.single.url,
                    status: this.slotState.single.status,
                },
            ];
        },
    },

    watch: {
        dayHasBlob(v) {
            this.slotState.day.hasBlob = v;
            this.slotState.single.hasBlob = v;
        },
        nightHasBlob(v) {
            this.slotState.night.hasBlob = v;
        },
        dayUrl(v) {
            this.slotState.day.url = v;
            this.slotState.single.url = v;
        },
        nightUrl(v) {
            this.slotState.night.url = v;
        },
    },

    methods: {
        thumbUrl(slot) {
            return `/api/monitor/${this.monitorId}/reference/${slot}?b=${this.thumbBust}`;
        },

        async onFileSelected(evt, slot) {
            const file = evt.target.files && evt.target.files[0];
            evt.target.value = "";
            if (!file) return;
            if (file.size > READ_LIMIT_BYTES) {
                this.slotState[slot].status = this.$t("RTSP Reference Too Large");
                return;
            }
            this.slotState[slot].status = this.$t("RTSP Reference Uploading");
            try {
                const buf = await file.arrayBuffer();
                const b64 = arrayBufferToBase64(buf);
                const result = await axios.post(
                    `/api/monitor/${this.monitorId}/reference/${slot}`,
                    { data: b64 }
                );
                this.applyResult(slot, result.data);
            } catch (err) {
                this.slotState[slot].status = errorMsg(err);
            }
        },

        async onSetUrl(slot) {
            // eslint-disable-next-line no-alert
            const url = window.prompt(this.$t("RTSP Reference URL Prompt"), this.slotState[slot].url || "https://");
            if (!url) return;
            this.slotState[slot].status = this.$t("RTSP Reference Fetching URL");
            try {
                const result = await axios.post(
                    `/api/monitor/${this.monitorId}/reference/${slot}`,
                    { url }
                );
                this.applyResult(slot, result.data);
            } catch (err) {
                this.slotState[slot].status = errorMsg(err);
            }
        },

        async onRefresh(slot) {
            this.slotState[slot].status = this.$t("RTSP Reference Refreshing");
            try {
                const result = await axios.post(
                    `/api/monitor/${this.monitorId}/reference/${slot}/refresh`,
                    {}
                );
                this.applyResult(slot, result.data);
            } catch (err) {
                this.slotState[slot].status = errorMsg(err);
            }
        },

        async onDelete(slot) {
            // eslint-disable-next-line no-alert
            if (!window.confirm(this.$t("Confirm"))) return;
            this.slotState[slot].status = "";
            try {
                await axios.delete(`/api/monitor/${this.monitorId}/reference/${slot}`);
                this.slotState[slot].hasBlob = false;
                this.slotState[slot].url = null;
                this.thumbBust = Date.now();
                this.$emit("uploaded", { slot, hasBlob: false, url: null });
            } catch (err) {
                this.slotState[slot].status = errorMsg(err);
            }
        },

        applyResult(slot, data) {
            if (!data || data.ok === false) {
                this.slotState[slot].status = data && data.msg ? data.msg : this.$t("RTSP Reference Failed");
                return;
            }
            this.slotState[slot].hasBlob = true;
            if ("url" in data) this.slotState[slot].url = data.url;
            this.slotState[slot].status = `${data.width || "?"}×${data.height || "?"} — ${Math.round((data.byteSize || 0) / 1024)} KB`;
            this.thumbBust = Date.now();
            this.$emit("uploaded", { slot, hasBlob: true, url: data.url || null });
        },
    },
};

/**
 * Encode an ArrayBuffer to base64 without blowing the stack for
 * multi-MB inputs (chunk through a fixed window).
 * @param {ArrayBuffer} buf Source bytes
 * @returns {string} base64-encoded string
 */
function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let str = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
        str += String.fromCharCode.apply(null, slice);
    }
    return btoa(str);
}

/**
 * Pull a human-readable error message from an axios error.
 * @param {Error|object} err Error
 * @returns {string} Message
 */
function errorMsg(err) {
    if (err && err.response && err.response.data && err.response.data.msg) {
        return err.response.data.msg;
    }
    return (err && err.message) || String(err);
}
</script>

<style scoped>
.ref-thumb {
    max-width: 240px;
    max-height: 180px;
    border-radius: 4px;
}
</style>
