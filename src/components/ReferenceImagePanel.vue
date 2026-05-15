<template>
    <div class="my-3 reference-image-panel">
        <h2 class="mt-4 mb-2">{{ $t("RTSP Reference Images") }}</h2>

        <div v-for="slot in slotsToShow" :key="slot.key" class="card mb-3">
            <div class="card-body">
                <h5 class="card-title">{{ slot.label }}</h5>

                <div v-if="slot.hasBlob" class="mb-2">
                    <img
                        v-if="thumbCache[slot.key]"
                        :src="thumbCache[slot.key]"
                        alt="reference thumbnail"
                        class="ref-thumb"
                    />
                    <span v-else>{{ $t("Loading") }}…</span>
                </div>
                <div v-else class="text-muted mb-2">{{ $t("RTSP Reference Empty") }}</div>

                <div v-if="slot.url" class="form-text mb-2">
                    {{ $t("RTSP Reference URL Label") }}:
                    <code>{{ slot.url }}</code>
                </div>

                <div class="d-flex gap-2 align-items-center flex-wrap">
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
                    <button type="button" class="btn btn-outline-primary" @click="onSetUrl(slot.key)">
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
const READ_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * ReferenceImagePanel
 *
 * Per HLDS §7.2: surfaces the Day / Night (or single) reference
 * slots and lets the user upload bytes or supply a URL. All wire
 * traffic flows over the authenticated socket.io connection — see
 * `server/socket-handlers/rtsp-socket-handler.js`.
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
            thumbCache: {},
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
            if (v) {
                this.loadThumb(this.separateDayNight ? "day" : "single");
            } else {
                delete this.thumbCache.day;
                delete this.thumbCache.single;
            }
        },
        nightHasBlob(v) {
            this.slotState.night.hasBlob = v;
            if (v) {
                this.loadThumb("night");
            } else {
                delete this.thumbCache.night;
            }
        },
        dayUrl(v) {
            this.slotState.day.url = v;
            this.slotState.single.url = v;
        },
        nightUrl(v) {
            this.slotState.night.url = v;
        },
        separateDayNight(v) {
            if (v) {
                if (this.slotState.day.hasBlob) {
                    this.loadThumb("day");
                }
                if (this.slotState.night.hasBlob) {
                    this.loadThumb("night");
                }
            } else if (this.slotState.single.hasBlob) {
                this.loadThumb("single");
            }
        },
    },

    mounted() {
        if (this.dayHasBlob) {
            this.loadThumb(this.separateDayNight ? "day" : "single");
        }
        if (this.nightHasBlob && this.separateDayNight) {
            this.loadThumb("night");
        }
    },

    beforeUnmount() {
        this.thumbCache = {};
    },

    methods: {
        socket() {
            return this.$root.getSocket && this.$root.getSocket();
        },

        async loadThumb(slot) {
            const socket = this.socket();
            if (!socket || !socket.connected) {
                return;
            }
            const realSlot = slot === "single" ? "day" : slot;
            socket.emit("rtsp:getReference", this.monitorId, realSlot, (res) => {
                if (!res || !res.ok) {
                    return;
                }
                this.thumbCache[slot] = `data:${res.contentType};base64,${res.dataBase64}`;
            });
        },

        async onFileSelected(evt, slot) {
            const file = evt.target.files && evt.target.files[0];
            evt.target.value = "";
            if (!file) {
                return;
            }
            if (file.size > READ_LIMIT_BYTES) {
                this.slotState[slot].status = this.$t("RTSP Reference Too Large");
                return;
            }
            this.slotState[slot].status = this.$t("RTSP Reference Uploading");
            try {
                const buf = await file.arrayBuffer();
                const b64 = arrayBufferToBase64(buf);
                this.callSocket(
                    "rtsp:uploadReference",
                    [this.monitorId, slot === "single" ? "day" : slot, { data: b64 }],
                    slot
                );
            } catch (err) {
                this.slotState[slot].status = err.message || String(err);
            }
        },

        onSetUrl(slot) {
            // eslint-disable-next-line no-alert
            const url = window.prompt(this.$t("RTSP Reference URL Prompt"), this.slotState[slot].url || "https://");
            if (!url) {
                return;
            }
            this.slotState[slot].status = this.$t("RTSP Reference Fetching URL");
            this.callSocket("rtsp:uploadReference", [this.monitorId, slot === "single" ? "day" : slot, { url }], slot);
        },

        onRefresh(slot) {
            this.slotState[slot].status = this.$t("RTSP Reference Refreshing");
            this.callSocket("rtsp:refreshReference", [this.monitorId, slot === "single" ? "day" : slot], slot);
        },

        onDelete(slot) {
            // eslint-disable-next-line no-alert
            if (!window.confirm(this.$t("Confirm"))) {
                return;
            }
            this.slotState[slot].status = "";
            const realSlot = slot === "single" ? "day" : slot;
            const socket = this.socket();
            if (!socket) {
                return;
            }
            socket.emit("rtsp:deleteReference", this.monitorId, realSlot, (res) => {
                if (!res || !res.ok) {
                    this.slotState[slot].status = (res && res.msg) || this.$t("RTSP Reference Failed");
                    return;
                }
                this.slotState[slot].hasBlob = false;
                this.slotState[slot].url = null;
                delete this.thumbCache[slot];
                delete this.thumbCache[realSlot];
                this.$emit("uploaded", { slot, hasBlob: false, url: null, fingerprint: null });
            });
        },

        callSocket(event, args, slot) {
            const socket = this.socket();
            if (!socket) {
                this.slotState[slot].status = this.$t("RTSP Reference Failed");
                return;
            }
            socket.emit(event, ...args, (res) => {
                if (!res || !res.ok) {
                    this.slotState[slot].status = (res && res.msg) || this.$t("RTSP Reference Failed");
                    return;
                }
                this.slotState[slot].hasBlob = true;
                if ("url" in res) {
                    this.slotState[slot].url = res.url;
                }
                this.slotState[slot].status =
                    `${res.width || "?"}×${res.height || "?"} — ${Math.round((res.byteSize || 0) / 1024)} KB`;
                this.loadThumb(slot);
                this.$emit("uploaded", {
                    slot,
                    hasBlob: true,
                    url: res.url || null,
                    fingerprint: res.fingerprint || null,
                });
            });
        },
    },
};

/**
 * Encode an ArrayBuffer to base64 without blowing the stack on
 * multi-MB inputs (chunks through a fixed window).
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
</script>

<style scoped>
.ref-thumb {
    max-width: 240px;
    max-height: 180px;
    border-radius: 4px;
}
</style>
