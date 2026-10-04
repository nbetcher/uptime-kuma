# 05 — Image Comparison Strategy

The Full-mode verification depends on robust same-scene matching across
day/night, IR, JPEG-noise, and sharpening artefacts. This document picks
the library, the fingerprint algorithm, the threshold, and the storage
strategy.

## 1. Library selection

### Recommended primary: `sharp`

`sharp` is the Node.js wrapper around libvips. It is the dominant Node
image library (~57M weekly downloads), Apache-2.0 licensed, and ships
prebuilt binaries via npm optional-deps for every platform Uptime Kuma
already targets:

- **Linux:** glibc and musl, on x64, arm, arm64, riscv64, ppc64, s390x.
- **macOS:** x64, arm64.
- **Windows:** x64, ia32, arm64.
- **Wasm32:** as a final fallback.

Alpine (musl) and Debian (glibc) are both fully covered, so neither the
official `Dockerfile` nor the Alpine variant has to install build tools
or compile anything.

Why sharp over alternatives:

- **Speed:** consistently 10–25× faster than `jimp` for the resize +
  greyscale + raw-extract pipeline we need.
- **Memory:** decodes JPEG straight from a `Buffer`; no intermediate
  files; libvips streams pixels rather than holding the full bitmap.
- **Toolkit:** `.greyscale()`, `.normalise()`, `.resize()`,
  `.convolve()` (for Sobel/Laplacian-style edge enhancement),
  `.stats()` (for mean/stddev/dominant-colour), and `.raw()` (raw
  RGBA/grey bytes). Everything we need, no plugins.

### Fallback if a no-native-dep policy applies: `jimp`

If, during implementation, a constraint emerges that forbids native
modules (e.g., a deployment target where libvips can't be loaded),
`jimp` 1.x is the pure-JavaScript alternative. It is:

- 10–25× slower than sharp,
- Has its own pHash (`image.hash()`) and convolution
  (`image.convolute()`) primitives,
- Pulls in ~25 transitive `@jimp/*` packages.

For the typical "a handful of cameras at 1-minute intervals" deployment,
`jimp`'s speed deficit is acceptable. For dozens of streams or sub-30 s
intervals, `sharp` is materially better. **PROPOSED:** ship with `sharp`,
keep the design clean enough that a `jimp` fallback can be substituted by
implementing the same internal interface.

### Rejected libraries and why

- **`pixelmatch`** — does per-pixel anti-aliased diff, designed for
  visual-regression of *exact* renderings. Hopelessly intolerant of JPEG
  noise, camera shake, or any lighting variation. Issue #6325 proposes
  it for screenshot-diff monitoring (a different use case where the
  inputs *are* exact renderings); inappropriate here.
- **`opencv4nodejs` / `@u4/opencv4nodejs`** — the canonical answer for
  "robust visual matching", but the install pulls 150+ MB of OpenCV (or
  forces basing on a special Docker image), takes 30+ minutes to compile
  from source on first install when prebuilds aren't available, and the
  upstream package is abandoned (5 years stale). Disproportionate for
  this use case. Suggested by some community comments on issue #2851
  but rejected here.
- **`ssim.js` / `image-ssim`** — both stale (2020 and 2015 respectively).
  SSIM doesn't help with day/night cross-matching anyway; it's a
  per-pixel structural-similarity score that requires identical
  dimensions and is sensitive to global brightness shift.
- **`image-hash`, `imghash`, `blockhash-core`** — small user bases,
  abandoned or near-abandoned, weaker hash algorithms (block-mean
  rather than DCT or gradient).

`[HIGH]` confidence on the recommendation. Source data: npm registry
download numbers, sharp docs, jimp release history, the published
benchmarks aggregated in the research log.

## 2. Fingerprint algorithm

The fingerprint is a small bit-string (proposed: 128 bits) computed
from each image, designed to be tolerant of the artefacts we expect.

### Pipeline

```
JPEG buffer
  ↓ sharp().greyscale()              # collapse colour, also bridges IR/visible
  ↓ .normalise()                     # equalise dynamic range; reduces day/night gap
  ↓ .resize(9, 8)                    # 9×8 because dHash needs N+1 cols for diffs: (9-1)×8 = 64 bits
  ↓ .raw().toBuffer()                # 72 bytes of luminance
fingerprint = dHash(buffer, 9, 8)
```

This gives a 64-bit dHash (64 comparisons of horizontal-neighbour
luminance differences; each row of 9 pixels yields 8 left-right
gradient bits, across 8 rows = 8 × 8 = 64 bits). To improve day/night
robustness, we *also* compute a 64-bit hash on a Sobel-edge variant:

```
JPEG buffer
  ↓ sharp().greyscale().normalise().resize(34, 33)   # larger for Sobel input quality
  ↓ apply 3×3 Sobel kernel via .convolve({width:3,height:3,kernel:[…]})
  ↓ .resize(9, 8)                    # reduce to hash-input size: (9-1)×8 = 64 bits
  ↓ .raw().toBuffer()                # 72 bytes of edge luminance
edge-hash = dHash(buffer, 9, 8)
```

The combined fingerprint is the concatenation: 64 luminance dHash bits +
64 edge dHash bits = 128 bits.

### Why dHash over pHash

Both work; dHash is preferred here because:

- Faster to compute (no DCT).
- Empirically more robust to JPEG quantisation noise (per Zauner's
  thesis on perceptual-hash robustness).
- Robust to small linear transforms that are common in IP-cam feeds
  (slight zoom, slight jitter from optical image stabilisation).

Why include the edge variant:

- Edges (a doorframe, the silhouette of a fence) survive the
  day-night brightness change far better than absolute luminance.
- A pure-luminance hash on a Day reference compared to a Night live
  frame typically gives Hamming distance 30–45 of 64 bits — too much.
- An edge hash on the same pair typically gives 8–18 of 64 bits — well
  inside the threshold.

### Why not SSIM

SSIM is a great metric when both images are at the same lighting and
the question is "did pixels move?" — that's not our question. Our
question is "is this the same scene under different conditions?" — a
question SSIM is poor at by design.

### Distance metric

Hamming distance: count of differing bits between two equal-length
fingerprints. We compute distance on the luminance and edge halves
separately:

```
distance(live, ref) = hamming(live.lumHash, ref.lumHash)   // 0..64
                    + hamming(live.edgeHash, ref.edgeHash)  // 0..64
                    // total range: 0..128
```

A pre-flight luminance check catches the easy "covered lens / black
frame" cases and reflects them as maximum Hamming distance rather than
a separate abort. These are part of the comparison algorithm — Full
mode does not short-circuit to DOWN independently of the fingerprint
comparison:

```
if (mean(liveGrey) < 5  &&  ref is Day)   → score = 128 (max distance)
if (mean(liveGrey) > 240 && ref is Night) → score = 128
```

Setting the score to the maximum (128) means the threshold test will
then produce DOWN naturally. This avoids a hidden separate detection
path while still ensuring extreme-luminance edge cases don't
spuriously pass.

## 3. Day/Night logic

Per the user-confirmed strategy ("try both, lowest distance wins"):

```
if separateDayNight:
    distDay   = distance(liveFingerprint, dayFingerprint)
    distNight = distance(liveFingerprint, nightFingerprint)
    minDist   = min(distDay, distNight)
    matched   = (distDay <= distNight) ? "Day" : "Night"
    pass      = (minDist <= threshold)
else:
    dist      = distance(liveFingerprint, singleReferenceFingerprint)
    pass      = (dist <= threshold)
```

This delivers:

- **Zero configuration burden:** no time-of-day window, no lat/lon, no
  sunrise calc.
- **Robustness to seasonal drift:** sunrise at 04:30 in summer vs 08:00
  in winter is automatically handled.
- **Robustness to abnormal lighting:** stormy afternoon, IR illuminator
  burst at noon, indoor camera with manual switch — all just work.

The cost is one extra fingerprint comparison per check (microseconds).
Negligible.

## 4. Threshold selection

Default: **24 of 128**, user-adjustable per monitor on a slider.

### What the number actually means

Hamming distance counts differing bits between two 128-bit fingerprints.
Calibration table for an adversarial reviewer (or a UI tooltip):

| Distance | Interpretation |
|---|---|
| 0 / 128 | Identical fingerprints (same image, no JPEG re-encoding noise) |
| 1–8 / 128 | Essentially identical (negligible noise) |
| 9–16 / 128 | Same scene, minor variation (slight camera shift, small JPEG-quality change) |
| **17–24 / 128** | **Same scene, notable variation — different time of day, mild weather change, slight zoom drift** |
| 25–40 / 128 | Same scene with substantial change, OR closely related but materially different scenes |
| 41–60 / 128 | Different scenes that share some structure |
| 61–127 / 128 | Unrelated scenes (random pairs average ~64 = 50% bit flip) |

Default 24 lands in the "same scene, notable variation" band — the
camera-monitoring sweet spot. It tolerates day-to-night swing on the
edge half of the fingerprint, accepts moderate lighting changes, and
still rejects "camera bumped onto a different wall."

User-overridable per monitor (slider 8–48 with the table above as
inline help). Stored on the monitor row, not as a global setting,
because different scenes have different inherent variability (a busy
street has more frame-to-frame variation than a hallway).

`[MEDIUM]` confidence on default 24 — based on Zauner's empirical bounds
on dHash; should be tuned during implementation with real footage.

## 5. Reference storage and acquisition

Per your clarifying-question answer ("BLOB *and* URL"), the schema
supports either source per slot:

```
monitor.rtsp_reference_day_blob    BLOB     -- nullable
monitor.rtsp_reference_day_url     TEXT     -- nullable
monitor.rtsp_reference_day_hash    BLOB     -- 16 bytes, fingerprint cache
monitor.rtsp_reference_night_blob  BLOB     -- nullable, only if separateDayNight
monitor.rtsp_reference_night_url   TEXT     -- nullable, ditto
monitor.rtsp_reference_night_hash  BLOB     -- 16 bytes, fingerprint cache
monitor.rtsp_reference_threshold   INTEGER  -- default 24
monitor.rtsp_reference_separate    INTEGER  -- 0/1, default 1
```

Constraints (enforced at the **reference-upload endpoint**, not at SQL
level or in `Monitor.toJSON()` — serialisation is the wrong layer for
upload validation; `toJSON()` merely excludes BLOB columns for payload
hygiene):

- For each slot, exactly one of `_blob` and `_url` is non-null.
- BLOB column capped at 256 KB (well above the 80 KB target after
  re-encoding; provides headroom).
- Fingerprint hash column is always populated when `_blob` or `_url`
  has a value; computed at upload time / first URL fetch.

### Upload UX (BLOB path)

1. User clicks "Upload Day reference" and picks a file.
2. On submit, the file is sent to a dedicated endpoint
   (`POST /api/monitor/:id/reference`) — separate from the main
   monitor save, to keep the WebSocket-serialised monitor object lean.
3. Server-side: re-encode via `sharp` to canonical form (max 640 px on
   the long edge, JPEG quality 85, EXIF stripped). Compute fingerprint.
   Store BLOB and fingerprint atomically.
4. UI confirms with the canonical thumbnail and resolution/size summary.

### URL path

1. User pastes URL.
2. On submit, the URL is fetched (with the SSRF protections in
   NFR-022). Same re-encoding and fingerprinting pipeline.
3. The URL is stored alongside the cached BLOB, so an explicit
   "Refresh" button (UI-affordance next to the URL field) can re-fetch
   on demand. The fetched bytes are *not* re-fetched on every monitor
   check — only the cached BLOB is used at check time.

### Lazy-load on the edit form

Because monitor objects are serialised over WebSockets to the frontend,
embedding multi-KB reference BLOBs in the default serialisation would
be wasteful (every monitor list refresh, every status push). Instead:

- The default `Monitor.toJSON()` MUST exclude the BLOB columns (and
  include `referenceDayHasBlob: true`/`false` flags so the UI knows
  whether one exists).
- A dedicated GET endpoint (`GET /api/monitor/:id/reference/:slot`)
  serves the BLOB on demand.
- The edit form fetches the BLOB(s) only when the user opens the
  "Reference Images" section (the existing
  `<details>`/accordion pattern that other Uptime Kuma monitor types
  use for advanced configuration).

`[HIGH]` confidence the BLOB-on-row pattern is right and matches the
fork owner's instruction. `[HIGH]` on the lazy-load approach for
WebSocket payload hygiene.

## 6. End-to-end Full-mode flow

```
1. Preflight (DNS, URL parse, TLS setup, concurrency token).
2. Capture one frame: node-av → JPEG buffer (in memory).
3. Validate JPEG magic bytes; reject if malformed.
4. Decode → greyscale → normalise → resize 9×8 raw → compute
   luminance dHash (64 bits).
5. Sobel-convolve (at larger intermediate size) → resize 9×8 raw →
   compute edge dHash (64 bits).
6. Concatenate → 128-bit live fingerprint.
7. Extreme-luminance adjustment: if live frame mean < 5 and ref is Day,
   or mean > 240 and ref is Night, set distance to 128 (max) rather
   than computing fingerprint distance.
8. Hamming-compare against cached Day fingerprint and (if present)
   Night fingerprint. Take min.
9. UP if min distance ≤ threshold; DOWN otherwise. Heartbeat message
   includes which reference matched and the actual distance.
10. Free buffers; release concurrency token.
```

Total CPU after FFmpeg returns the JPEG: ~10–15 ms on a Raspberry Pi 4
(`[MEDIUM]`, extrapolated from sharp benchmarks). Total memory peak in
Node: ~5 MB above baseline for a 1080p source.

## 7. Edge cases and how the design handles them

| Case | Handling |
|---|---|
| Camera bumped 5 degrees | Combined dHash distance typically 10–20 → still passes default threshold; if the bump is severe enough to fail, the alert is correct. |
| Lens fogged | Edge hash distance balloons; luminance hash mostly unchanged → combined distance 30–60 → DOWN. Correct. |
| IR illuminator died at night | Live frame is uniformly black → luminance adjustment sets distance to 128 → exceeds threshold → DOWN. The result flows through the normal fingerprint-comparison path; there is no separate abort. Correct. |
| Day reference uploaded while it's night-time and "Separate" toggle is off | Only one reference; live frame compared to it; distance high → DOWN. **This is the user-error case the day/night feature exists to prevent.** UI nudges: when the user uploads a single reference, the form should suggest enabling Separate Day/Night with a note. **PROPOSED.** |
| Camera stream resolution differs across day/night (some cameras downshift) | Both fingerprints are taken at 9×8 — resolution-invariant. No issue. |
| Camera adds a timestamp overlay | Localised to ~5% of the image; dHash is dominated by the bulk of the scene; distance contribution typically < 5 bits. No issue. |
| Camera adds a moving timestamp / weather overlay that changes every check | Distance contribution can be up to ~10 bits; default threshold 24 absorbs this. If borderline, user can raise threshold. |
| Reference upload is a corrupt JPEG | `sharp` re-decode fails → upload rejected with explicit error. No bad reference reaches storage. |
| URL reference 404s on upload | Upload rejected; no monitor created/saved with broken reference. |
| URL reference becomes 404 later | The cached BLOB and fingerprint remain valid; checks continue to work. The URL is a convenience for re-acquisition, not a runtime dependency. |
| Hash cache schema migration | Fingerprints cached in DB are recomputable; if the algorithm is ever changed, a one-shot re-fingerprint job runs at server start (lazy: only on first check after server start). **PROPOSED.** |

## 8. What gets logged

For every Full-mode UP heartbeat (in the `msg` field, NFR-040 patterns):

- `matched Day at distance 11/128` — clear, scannable.

For every DOWN:

- `scene mismatch: distance 47/128 > threshold 24/128 (Day=47, Night=53)` —
  shows both distances so the operator can diagnose.

For verbose mode (NFR-041):

- The full 128-bit fingerprint hex, the live luminance mean and stddev,
  and the per-half distance breakdown.
