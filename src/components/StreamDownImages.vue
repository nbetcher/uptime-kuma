<template>
    <div v-if="visible" class="shadow-box big-padding mt-3 stream-down-images">
        <h2 class="mb-3">{{ $t("RTSP Recent DOWN Frames") }}</h2>

        <div v-if="loading" class="text-muted">{{ $t("Loading") }}…</div>
        <div v-else-if="error" class="alert alert-warning py-1 px-2">{{ error }}</div>
        <div v-else-if="images.length === 0" class="text-muted">{{ $t("RTSP No DOWN Frames") }}</div>

        <div v-else class="row g-3">
            <div v-for="img in images" :key="img.id" class="col-6 col-md-4 col-lg-3">
                <figure class="m-0">
                    <img :src="`data:image/jpeg;base64,${img.dataBase64}`" alt="" class="img-fluid rounded" />
                    <figcaption class="form-text">{{ formatTimestamp(img.capturedAt) }}</figcaption>
                </figure>
            </div>
        </div>
    </div>
</template>

<script>
/**
 * StreamDownImages
 *
 * UI-014: render up to the 5 most recent DOWN-frame thumbnails for
 * an RTSP monitor on the authenticated Details page. Images are
 * served as base64 over the socket — they're private (Details is
 * gated by login) and the socket session already authenticates.
 */
export default {
    name: "StreamDownImages",

    props: {
        monitor: { type: Object, required: true },
    },

    data() {
        return {
            loading: false,
            error: "",
            images: [],
        };
    },

    computed: {
        visible() {
            return this.monitor && this.monitor.type === "rtsp" && this.monitor.streamKeepDownImages;
        },
    },

    watch: {
        // Reload when the monitor changes or the user toggles the
        // opt-in (saves the form).
        "monitor.id"() {
            if (this.visible) this.reload();
        },
        "monitor.streamKeepDownImages"(v) {
            if (v) this.reload();
            else this.images = [];
        },
    },

    mounted() {
        if (this.visible) this.reload();
    },

    methods: {
        reload() {
            const socket = this.$root.socket;
            if (!socket) return;
            this.loading = true;
            this.error = "";
            socket.emit("rtsp:listDownImages", this.monitor.id, (res) => {
                this.loading = false;
                if (!res || !res.ok) {
                    this.error = (res && res.msg) || this.$t("RTSP DOWN Images Failed");
                    return;
                }
                this.images = res.images || [];
            });
        },
        formatTimestamp(iso) {
            if (!iso) return "";
            try {
                return new Date(iso).toLocaleString();
            } catch {
                return iso;
            }
        },
    },
};
</script>

<style scoped>
.stream-down-images img {
    max-height: 180px;
    object-fit: cover;
    width: 100%;
}
</style>
