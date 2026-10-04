<template>
    <div class="my-3 reference-image-panel">
        <h2 class="mt-4 mb-2">{{ $t("RTSP Reference Images") }}</h2>

        <div v-for="slot in slotsToShow" :key="slot.key" class="ref-slot mb-3">
            <div>
                <h5>{{ slot.label }}</h5>

                <div v-if="slot.hasBlob" class="mb-2">
                    <img
                        v-if="thumbFor(slot.key)"
                        :src="thumbFor(slot.key)"
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
// Source files larger than this are refused before decoding; anything
// smaller is downscaled in the browser before upload.
const READ_LIMIT_BYTES = 25 * 1024 * 1024;
// The server canonicalises references to 640 px, so 1280 px leaves
// headroom without shipping megapixels. Keeping the encoded upload
// under ~600 KB keeps it inside socket.io's default 1 MB message cap.
const UPLOAD_MAX_DIM = 1280;
const UPLOAD_MAX_BYTES = 600 * 1024;

/**
 * ReferenceImagePanel
 *
 * Per HLDS §7.2: surfaces the Day / Night (or single) reference
 * slots and lets the user upload bytes or supply a URL. All wire
 * traffic flows over the authenticated socket.io connection — see
 * `server/socket-handlers/rtsp-socket-handler.js`. The panel owns its
 * state: it reads slot metadata from the server rather than from the
 * monitor form.
 */
export default {
    name: "ReferenceImagePanel",

    props: {
        monitorId: { type: [Number, String], required: true },
        separateDayNight: { type: Boolean, default: true },
    },

    data() {
        return {
            // Keyed by stored slot ("day" also backs "single").
            stored: {
                day: { hasBlob: false, url: null },
                night: { hasBlob: false, url: null },
            },
            status: { day: "", night: "", single: "" },
            thumbCache: {},
        };
    },

    computed: {
        slotsToShow() {
            const keys = this.separateDayNight ? ["day", "night"] : ["single"];
            const labels = {
                day: this.$t("RTSP Reference Day"),
                night: this.$t("RTSP Reference Night"),
                single: this.$t("RTSP Reference Single"),
            };
            return keys.map((key) => {
                const stored = this.stored[storedSlot(key)];
                return {
                    key,
                    label: labels[key],
                    hasBlob: stored.hasBlob,
                    url: stored.url,
                    status: this.status[key],
                };
            });
        },
    },

    watch: {
        monitorId() {
            this.thumbCache = {};
            this.loadInfo();
        },
    },

    mounted() {
        this.loadInfo();
    },

    beforeUnmount() {
        this.thumbCache = {};
    },

    methods: {
        socket() {
            return this.$root.getSocket && this.$root.getSocket();
        },

        loadInfo() {
            const socket = this.socket();
            if (!socket || !socket.connected) {
                return;
            }
            socket.emit("rtsp:getReferenceInfo", this.monitorId, (res) => {
                if (!res || !res.ok) {
                    return;
                }
                for (const slot of ["day", "night"]) {
                    const info = res.references[slot];
                    this.stored[slot] = { hasBlob: !!info, url: info ? info.url : null };
                    if (info) {
                        this.loadThumb(slot);
                    } else {
                        delete this.thumbCache[slot];
                    }
                }
            });
        },

        loadThumb(slot) {
            const socket = this.socket();
            if (!socket || !socket.connected) {
                return;
            }
            socket.emit("rtsp:getReference", this.monitorId, slot, (res) => {
                if (!res || !res.ok) {
                    return;
                }
                this.thumbCache[slot] = `data:${res.contentType};base64,${res.dataBase64}`;
            });
        },

        thumbFor(key) {
            return this.thumbCache[storedSlot(key)];
        },

        async onFileSelected(evt, slot) {
            const file = evt.target.files && evt.target.files[0];
            evt.target.value = "";
            if (!file) {
                return;
            }
            if (file.size > READ_LIMIT_BYTES) {
                this.status[slot] = this.$t("RTSP Reference Too Large");
                return;
            }
            this.status[slot] = this.$t("RTSP Reference Uploading");
            try {
                const data = await downscaleToJpeg(file, UPLOAD_MAX_DIM, UPLOAD_MAX_BYTES);
                this.callSocket("rtsp:uploadReference", [this.monitorId, storedSlot(slot), { data }], slot);
            } catch (err) {
                this.status[slot] = err.message || String(err);
            }
        },

        onSetUrl(slot) {
            const current = this.stored[storedSlot(slot)].url;
            // eslint-disable-next-line no-alert
            const url = window.prompt(this.$t("RTSP Reference URL Prompt"), current || "https://");
            if (!url) {
                return;
            }
            this.status[slot] = this.$t("RTSP Reference Fetching URL");
            this.callSocket("rtsp:uploadReference", [this.monitorId, storedSlot(slot), { url }], slot);
        },

        onRefresh(slot) {
            this.status[slot] = this.$t("RTSP Reference Refreshing");
            this.callSocket("rtsp:refreshReference", [this.monitorId, storedSlot(slot)], slot);
        },

        onDelete(slot) {
            // eslint-disable-next-line no-alert
            if (!window.confirm(this.$t("Confirm"))) {
                return;
            }
            this.status[slot] = "";
            const realSlot = storedSlot(slot);
            const socket = this.socket();
            if (!socket) {
                return;
            }
            socket.emit("rtsp:deleteReference", this.monitorId, realSlot, (res) => {
                if (!res || !res.ok) {
                    this.status[slot] = (res && res.msg) || this.$t("RTSP Reference Failed");
                    return;
                }
                this.stored[realSlot] = { hasBlob: false, url: null };
                delete this.thumbCache[realSlot];
            });
        },

        callSocket(event, args, slot) {
            const socket = this.socket();
            if (!socket) {
                this.status[slot] = this.$t("RTSP Reference Failed");
                return;
            }
            socket.emit(event, ...args, (res) => {
                if (!res || !res.ok) {
                    this.status[slot] = (res && res.msg) || this.$t("RTSP Reference Failed");
                    return;
                }
                const realSlot = storedSlot(slot);
                this.stored[realSlot] = {
                    hasBlob: true,
                    url: "url" in res ? res.url : this.stored[realSlot].url,
                };
                this.status[slot] =
                    `${res.width || "?"}×${res.height || "?"} — ${Math.round((res.byteSize || 0) / 1024)} KB`;
                this.loadThumb(realSlot);
            });
        },
    },
};

/**
 * Map a displayed slot to the slot it is stored under: the single
 * (no day/night split) reference is stored as "day".
 * @param {string} slot "day" | "night" | "single"
 * @returns {string} Stored slot
 */
function storedSlot(slot) {
    return slot === "single" ? "day" : slot;
}

/**
 * Decode an image file in the browser, downscale it so its long edge
 * is at most `maxDim`, and re-encode it as JPEG no larger than
 * `maxBytes` (stepping quality down if needed). EXIF orientation is
 * applied by the decoder, so the result needs no metadata.
 * @param {File} file Image file chosen by the user
 * @param {number} maxDim Maximum long-edge size in pixels
 * @param {number} maxBytes Maximum encoded size
 * @returns {Promise<ArrayBuffer>} JPEG bytes
 */
async function downscaleToJpeg(file, maxDim, maxBytes) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) {
        bitmap.close();
    }
    for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (blob && blob.size <= maxBytes) {
            return blob.arrayBuffer();
        }
    }
    throw new Error(`image is still larger than ${Math.round(maxBytes / 1024)} KB after downscaling`);
}
</script>

<style scoped>
/* Not Bootstrap's .card: the app's global border radius turns it into
   an ellipse. */
.ref-slot {
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 10px;
    padding: 1rem;
}

.ref-thumb {
    max-width: 240px;
    max-height: 180px;
    border-radius: 4px;
}
</style>
