/**
 * Image-pipeline module: JPEG validation, fingerprint computation,
 * and Hamming-distance comparison. Depends on `sharp`. If sharp is
 * unavailable, this module's `require` throws — caught upstream in
 * the rtsp/index.js graceful-degradation block (UI-005).
 */

const sharp = require("sharp");
const { messages } = require("./messages");

const POPCOUNT_8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    let c = 0;
    let v = i;
    while (v) {
        c += v & 1;
        v >>= 1;
    }
    POPCOUNT_8[i] = c;
}

const FP_HASH_BYTES = 8;            // 64 bits each for lum + edge
const FP_TOTAL_BYTES = FP_HASH_BYTES * 2;
const FP_TOTAL_BITS = FP_TOTAL_BYTES * 8;

const MIN_JPEG_SIZE = 1024;
const MAX_JPEG_SIZE = 5 * 1024 * 1024;
const MIN_DIM = 64;
const MAX_DIM = 16384;

const SOBEL_X_KERNEL = {
    width: 3,
    height: 3,
    kernel: [-1, 0, 1, -2, 0, 2, -1, 0, 1],
};

/**
 * Validate the JPEG structural shape of a decoded frame.
 *
 * @param {Buffer} buf JPEG bytes
 * @returns {Promise<{width: number, height: number}>}
 */
async function validateJpegStructure(buf) {
    if (!Buffer.isBuffer(buf)) {
        throw new Error(messages.FRAME_INVALID("not a Buffer"));
    }
    if (buf.length < MIN_JPEG_SIZE || buf.length > MAX_JPEG_SIZE) {
        throw new Error(messages.FRAME_INVALID(`size ${buf.length} out of bounds`));
    }
    if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
        throw new Error(messages.FRAME_INVALID("missing JPEG SOI"));
    }
    if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
        throw new Error(messages.FRAME_INVALID("missing JPEG EOI"));
    }
    let meta;
    try {
        meta = await sharp(buf).metadata();
    } catch (e) {
        throw new Error(messages.FRAME_INVALID(`sharp metadata: ${e.message}`));
    }
    if (!meta.width || !meta.height) {
        throw new Error(messages.FRAME_INVALID("no dimensions"));
    }
    if (meta.width < MIN_DIM || meta.height < MIN_DIM) {
        throw new Error(messages.FRAME_INVALID(`dimensions ${meta.width}x${meta.height} below minimum`));
    }
    if (meta.width > MAX_DIM || meta.height > MAX_DIM) {
        throw new Error(messages.FRAME_INVALID(`dimensions ${meta.width}x${meta.height} above maximum`));
    }
    return { width: meta.width, height: meta.height };
}

/**
 * Compute the 64-bit difference hash of a small raw greyscale buffer.
 *
 * For each row, produces 8 bits comparing pixel[col] > pixel[col+1]
 * across cols 0..6 — 8 rows × 8 bits = 64 bits = 8 bytes.
 *
 * @param {Buffer} pixels Raw greyscale buffer, row-major
 * @param {number} w Width
 * @param {number} h Height
 * @returns {Buffer} 8-byte hash
 */
function dHash(pixels, w, h) {
    const out = Buffer.alloc(FP_HASH_BYTES);
    for (let row = 0; row < h && row < FP_HASH_BYTES; row++) {
        let bits = 0;
        for (let col = 0; col < w - 1 && col < 8; col++) {
            const left = pixels[row * w + col];
            const right = pixels[row * w + col + 1];
            if (left > right) bits |= 1 << (7 - col);
        }
        out[row] = bits;
    }
    return out;
}

/**
 * Compute the 128-bit fingerprint of a JPEG buffer: 64-bit luminance
 * dHash + 64-bit edge dHash. See `docs/rtsp-monitor/05-image-comparison-strategy.md` §2.
 *
 * @param {Buffer} jpegBuf JPEG bytes (already structurally valid)
 * @returns {Promise<{lumHash: Buffer, edgeHash: Buffer, meanLuma: number}>}
 */
async function fingerprint(jpegBuf) {
    const lumPixels = await sharp(jpegBuf)
        .greyscale()
        .normalise()
        .resize(9, 8, { fit: "fill", kernel: sharp.kernel.lanczos3 })
        .raw()
        .toBuffer();
    const lumHash = dHash(lumPixels, 9, 8);

    const edgePixels = await sharp(jpegBuf)
        .greyscale()
        .normalise()
        .resize(34, 33, { fit: "fill", kernel: sharp.kernel.lanczos3 })
        .convolve(SOBEL_X_KERNEL)
        .resize(9, 8, { fit: "fill", kernel: sharp.kernel.lanczos3 })
        .raw()
        .toBuffer();
    const edgeHash = dHash(edgePixels, 9, 8);

    const greyForStats = await sharp(jpegBuf)
        .greyscale()
        .resize(32, 32, { fit: "fill" })
        .raw()
        .toBuffer();
    let sum = 0;
    for (let i = 0; i < greyForStats.length; i++) sum += greyForStats[i];
    const meanLuma = greyForStats.length > 0 ? sum / greyForStats.length : 0;

    return { lumHash, edgeHash, meanLuma };
}

/**
 * Combine luminance + edge halves into a single 16-byte fingerprint
 * for storage in the `stream_reference_*_hash` column.
 *
 * @param {{lumHash: Buffer, edgeHash: Buffer}} fp Fingerprint
 * @returns {Buffer} 16-byte concatenation
 */
function packFingerprint(fp) {
    return Buffer.concat([fp.lumHash, fp.edgeHash], FP_TOTAL_BYTES);
}

/**
 * Compute Hamming distance between two equal-length byte buffers.
 *
 * @param {Buffer} a First buffer
 * @param {Buffer} b Second buffer
 * @returns {number} Number of differing bits
 */
function hammingDistance(a, b) {
    if (a.length !== b.length) {
        throw new Error("hammingDistance: length mismatch");
    }
    let d = 0;
    for (let i = 0; i < a.length; i++) {
        d += POPCOUNT_8[a[i] ^ b[i]];
    }
    return d;
}

/**
 * Compute the 128-bit Hamming distance between a live fingerprint and
 * a stored reference hash. Applies the extreme-luminance adjustment
 * for Day/Night-classified references — for the single-reference
 * case (`classification === 'single'`), no adjustment is applied
 * (HLDS §6.6).
 *
 * @param {{lumHash: Buffer, edgeHash: Buffer, meanLuma: number}} live Live fingerprint
 * @param {Buffer} refHash Packed reference hash (16 bytes)
 * @param {'day'|'night'|'single'} classification Reference classification
 * @returns {number} Distance in [0, 128]
 */
function distance(live, refHash, classification) {
    if (!refHash || refHash.length !== FP_TOTAL_BYTES) {
        throw new Error("distance: bad reference hash");
    }
    const lumRef = refHash.subarray(0, FP_HASH_BYTES);
    const edgeRef = refHash.subarray(FP_HASH_BYTES, FP_TOTAL_BYTES);
    let d = hammingDistance(live.lumHash, lumRef) + hammingDistance(live.edgeHash, edgeRef);

    if (classification === "day" && live.meanLuma < 5) d = FP_TOTAL_BITS;
    if (classification === "night" && live.meanLuma > 240) d = FP_TOTAL_BITS;
    // For 'single', no classification adjustment applies.

    return d;
}

/**
 * Compute simple greyscale luminance statistics on a 32×32 downsample
 * of a JPEG. Used by Enhanced mode's black/uniform-frame detection.
 *
 * @param {Buffer} jpegBuf JPEG bytes
 * @returns {Promise<{mean: number, stddev: number}>}
 */
async function luminanceStats(jpegBuf) {
    const grey = await sharp(jpegBuf)
        .greyscale()
        .resize(32, 32, { fit: "fill" })
        .raw()
        .toBuffer();
    if (grey.length === 0) return { mean: 0, stddev: 0 };
    let sum = 0;
    for (let i = 0; i < grey.length; i++) sum += grey[i];
    const mean = sum / grey.length;
    let varSum = 0;
    for (let i = 0; i < grey.length; i++) {
        const d = grey[i] - mean;
        varSum += d * d;
    }
    const stddev = Math.sqrt(varSum / grey.length);
    return { mean, stddev };
}

/**
 * Canonicalize an uploaded reference image: re-encode to a bounded
 * JPEG with all metadata stripped. Per UI-004 / NFR-023.
 *
 * @param {Buffer} inputBuf Source image bytes
 * @param {object} [opts] Override options
 * @param {number} [opts.maxDim=640] Max long-edge px
 * @param {number} [opts.quality=85] JPEG quality
 * @returns {Promise<Buffer>} Canonicalised JPEG
 */
async function canonicalize(inputBuf, opts = {}) {
    const maxDim = parseInt(process.env.RTSP_REFERENCE_MAX_DIM, 10) || opts.maxDim || 640;
    const quality = parseInt(process.env.RTSP_REFERENCE_QUALITY, 10) || opts.quality || 85;

    return sharp(inputBuf)
        .rotate() // honour EXIF orientation before stripping
        .resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .withMetadata(false)
        .toBuffer();
}

/**
 * Resample a frame for storage as a small thumbnail in the status-page
 * / DOWN-image table.
 * @param {Buffer} jpegBuf JPEG bytes
 * @returns {Promise<Buffer>} Thumbnail JPEG
 */
async function thumbnailize(jpegBuf) {
    const maxDim = parseInt(process.env.RTSP_DOWN_IMAGE_MAX_DIM, 10) || 320;
    return sharp(jpegBuf)
        .resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .withMetadata(false)
        .toBuffer();
}

module.exports = {
    FP_HASH_BYTES,
    FP_TOTAL_BYTES,
    FP_TOTAL_BITS,
    SOBEL_X_KERNEL,
    POPCOUNT_8,
    dHash,
    fingerprint,
    packFingerprint,
    hammingDistance,
    distance,
    luminanceStats,
    validateJpegStructure,
    canonicalize,
    thumbnailize,
};
