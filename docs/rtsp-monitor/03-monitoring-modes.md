# 03 — Monitoring Modes

Three modes, ordered by verification depth and resource cost. The user
selects exactly one per monitor.

| Mode | What it proves | Typical cost per check | Requires media decode? |
|---|---|---|---|
| **Basic** | Server is reachable and speaks RTSP/RTMP. | < 100 ms; ~2 kB net | No |
| **Enhanced** | Server is producing real video frames that decode to valid pictures and are not frozen. | 3–10 s; 1–5 MB net | Yes |
| **Full** | Server is producing real frames *and* the scene visually matches a known reference. | 3–10 s; 1–5 MB net + ~10 ms CPU on local fingerprint compare | Yes |

Each mode supersedes the previous in coverage; selecting Full does **not**
also run Enhanced or Basic — Full is more thorough than either, so the
weaker checks are redundant.

## 1. Mode-selection UX

A single radio-group / segmented-control on the monitor edit form,
populated only after the user has selected the RTSP/RTMP monitor type.
Reveals a help block per mode summarising the verification depth and
resource cost. The default is **Basic** because it is the cheapest, the
least likely to fail spuriously, and aligns with `@CommanderStorm`'s
"start small" guidance for upstream-merge scenarios. **PROPOSED**.

## 2. Common preflight (all modes)

Before mode-specific work, every check performs the following in order;
any failure short-circuits to DOWN with a precise message:

1. Resolve hostname (DNS). On NXDOMAIN/SERVFAIL: DOWN with
   `"DNS resolution failed: <reason>"`.
2. URL parse and validate. If the URL contains embedded credentials
   (`rtsp://user:pass@host/path`) **and** the user has also supplied
   separate username/password form fields, a non-blocking warning is
   shown in the UI; the form fields (generic `username`/`password`
   columns) are canonical and take precedence. The embedded URL
   credentials are stripped before passing the URL to the decode stack.
   Reject URLs whose scheme does not match the configured protocol.
3. If TLS is in use and the user has *not* disabled cert validation,
   apply Node.js TLS defaults (RFC 5280 chain validation, hostname check).
4. Acquire a per-monitor concurrency token (see
   **[04-requirements.md](./04-requirements.md)** NFR-014) so two checks
   for the same monitor cannot overlap.
5. Start a wall-clock timer; on success the elapsed time is the heartbeat
   `ping`.

## 3. Basic mode

### Goal

Confirm that the host:port answers and speaks the configured protocol.
Equivalent in spirit to an HTTP HEAD that demands a real HTTP response.
Strictly stronger than a TCP-port check.

### Mechanism

Basic mode does *not* spawn FFmpeg. It uses Node.js sockets directly:

- **RTSP / RTSPS:** `net.connect()` (or `tls.connect()` for `rtsps://`,
  port 322). Send the literal `OPTIONS` request shown in
  **[02-protocol-coverage.md](./02-protocol-coverage.md)** §5. Read up to
  4 KB of response. Pass if the first 5 bytes are `RTSP/` and a matching
  `CSeq:` is echoed; status codes 2xx, 401, 403, 404, 405 all count as UP
  (server is alive). Status codes 3xx (redirects) count as UP with a warning.
  Status codes 5xx pass with a warning message in the heartbeat.
- **RTMP / RTMPS:** open the socket, send 1+1536 bytes (C0 then C1), read
  1537 bytes (S0 then S1), assert `S0 == C0`. Close. No C2 sent.

A pure-Node implementation is small (~30 lines per protocol) and avoids
the maintenance risk of `rtsp-client@1.4.5` (last published 2020,
classified Inactive — see
**[06-prior-art-review.md](./06-prior-art-review.md)** §4).

### Pass / fail

| Outcome | Status |
|---|---|
| Connection refused / RST | DOWN |
| TCP timeout (configured per-monitor, default 10 s) | DOWN |
| TLS error and `verify cert` is enabled | DOWN with cert message |
| Response does not begin with protocol marker | DOWN with `"server did not speak RTSP"` / `"server did not speak RTMP"` |
| RTSP 2xx/401/403/404/405, or RTMP S0/S1 valid | UP |
| RTSP 3xx | UP with warning (redirect from an RTSP server still proves liveness) |
| RTSP 5xx | UP with warning |

### Resource cost

- One TCP (or TLS) socket, opened and closed.
- ~150 bytes sent (RTSP) or 1537 bytes (RTMP); ~1 KB received.
- 0 subprocesses, 0 disk writes, 0 image decoding.

## 4. Enhanced mode

### Goal

Confirm that real video bits are flowing — not just protocol speech. Catch
the failure modes Basic cannot: encoder hung after handshake, audio-only
stream, lens cap on, sensor stuck on the same frame
(`@PoleTransformer`'s "black screen" concern, see
**[06-prior-art-review.md](./06-prior-art-review.md)** §3).

### Mechanism

Pull a small number of decoded frames in-memory, validate each, and
detect frozen-frame stalls.

- **Frames captured:** 5 by default (configurable 2–15).
- **Capture path:** `node-av` opens the input, decodes the first
  available video stream, returns frames as raw image buffers in
  memory. No temp files, no subprocess, no stdout pipe. See
  **[06-prior-art-review.md](./06-prior-art-review.md)** §6 for why
  `node-av` was chosen over a FFmpeg subprocess.
- **Wall-clock budget:** scales with the monitor `interval`. Default is
  `min(max(interval / 3, 5), 30)` seconds — i.e. one third of the
  interval, clamped to [5 s, 30 s]. So a 60 s interval gives a 20 s
  budget; a 5 s interval clamps to 5 s; a 5-min interval clamps to 30 s.
  User-overridable per monitor.
- **Hard backstop:** the `node-av` decode session is wrapped in a
  Promise that rejects at budget; on rejection, the session is closed
  and resources released. No subprocess to kill — `node-av` cleanup is
  in-process.
- **Decoder validation per frame:** JPEG magic bytes (`FF D8 FF` start,
  `FF D9` end), non-zero size, sane dimensions (≥ 64×64, ≤ 16384×16384).
  Reject frames that fail any of these.
- **Frozen-frame detection:** compute a fast hash (xxHash64 of the JPEG
  bytes) for each frame; require at least one byte-different pair among
  the captured frames. If all frames are byte-identical → DOWN with
  `"stream appears frozen — N identical frames"`.
- **Black/uniform detection:** decode the last frame to greyscale 32×32
  via `sharp`, compute mean and standard deviation. If `mean < 5` **and**
  `stddev < 2` (on a 0–255 raw scale) → DOWN with
  `"stream appears black or uniform"`. The thresholds are chosen so a
  real night-vision IR scene with even a single illuminated object passes.

### Pass / fail

| Outcome | Status |
|---|---|
| Subprocess timeout / non-zero exit before any frame | DOWN with `"no frames received within Ns"` |
| Fewer than 2 valid JPEGs captured | DOWN with `"only N/M valid frames"` |
| All captured frames byte-identical | DOWN — frozen |
| Last frame mean luminance < 5 and stddev < 2 (0–255 scale) | DOWN — black/uniform |
| Otherwise | UP, with frame count in heartbeat message |

### Resource cost

- One `node-av` decode session per check (in-process, no subprocess).
- 1–5 MB network depending on resolution and bitrate; bound by the
  wall-clock budget.
- ~20 MB peak heap during decode (typical 1080p H.264 decode), released
  on session close.
- 5 small JPEG buffers held in Node memory (~50–500 KB total) for the
  duration of the check, then freed.
- 0 disk writes.

## 5. Full mode

### Goal

Confirm that the camera is looking at the *correct scene*. Catches lens
bumps, redirected cameras, and cases where the encoder is delivering
valid-but-wrong video (e.g., colour bars, default test pattern).

### Mechanism

A single frame is captured, fingerprinted, and compared against the user's
reference image(s).

- **Capture:** one frame via the same `node-av` path as Enhanced, exiting
  as soon as the first decoded video frame is available.
- **Fingerprint:** `sharp` pipeline to greyscale → normalise → resize 9×8
  → compute combined fingerprint (64-bit luminance dHash + 64-bit
  edge-aware dHash = 128 bits). Full algorithm and rationale in
  **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)**.
- **Reference selection:** if "Separate Day/Night" is enabled (default),
  the live frame is compared against both Day and Night fingerprints; the
  *minimum* Hamming distance is taken. This is the "try both, lowest
  wins" strategy you selected.
- **Pass criterion:** minimum Hamming distance ≤ user-configured
  threshold (default 24 of 128 bits — the value comes from the Zauner
  thesis on perceptual-hash robustness for "same scene, lighting variant"
  — see **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** §4).

### Pass / fail

| Outcome | Status |
|---|---|
| Frame capture fails (connection refused, TCP timeout, TLS error, or decode error producing zero frames) | DOWN with the capture-failure reason |
| Live frame fingerprint successfully computed | Continue to compare |
| `min(distance(live, Day), distance(live, Night)) ≤ threshold` | UP with `"matched <Day|Night> at distance N/128"` |
| Both distances > threshold | DOWN with `"scene mismatch: distance N > threshold T"` |

### Resource cost

Same as Enhanced for capture, plus:

- ~10 ms for `sharp` to greyscale + resize + raw-pixel-extract a 1080p JPEG.
- ~5 ms for fingerprint computation in pure JS.
- A few KB of memory for the fingerprints; references are held in cache
  (see NFR-005 in **[04-requirements.md](./04-requirements.md)**).

## 6. Frame capture: `node-av`

Decoded frames are produced by `node-av`, the N-API bindings to FFmpeg
that `@louislam` recommended in the comments of PR #5822. The library
ships prebuilt binaries via npm optional-deps for Linux/macOS/Windows ×
x64/arm64; FFmpeg itself is bundled. No system FFmpeg is required, no
PATH detection runs, and no subprocess is spawned.

Operationally:

- The `node-av` session opens the input URL, demuxes, decodes the first
  video stream, and emits decoded frames as `Buffer`s.
- Frames are converted to JPEG in memory via either `node-av`'s
  encoder or `sharp`, depending on which is faster on the target
  platform — to be benchmarked at HLD time.
- Session close is awaited in a `finally`, releasing all libav state.
- Authentication credentials, when supplied, are passed via the
  `node-av` input options (matching FFmpeg's `-rtsp_transport`,
  username/password URL components, or the dedicated AVDictionary
  options for Digest auth).

Both Enhanced and Full use this same path. The interface is small enough
that swapping implementations later (e.g., to a subprocess fallback for
edge platforms `node-av` doesn't prebuild for) would be localised.

## 7. Behaviour shared across modes

### 7.1 Heartbeat fields

| Field | Basic | Enhanced | Full |
|---|---|---|---|
| `status` | UP/DOWN | UP/DOWN | UP/DOWN |
| `ping` | TCP/TLS handshake + first-byte round-trip | Wall-clock from preflight start to last decoded frame | Wall-clock from preflight start to fingerprint comparison |
| `msg` | Protocol-level reason (codes, errors) | Frame stats and any failure reason | Match result, distance, which reference matched |
| `response` (debug) | First 256 bytes of raw response | Per-frame summary (size, dimensions, hash) | Per-frame summary + fingerprint hex + threshold/distance |

### 7.2 Retry policy

Inherits Uptime Kuma's existing per-monitor `maxretries` / `retryInterval`
setting. No mode-specific override. **PROPOSED.**

### 7.3 Notification semantics

Standard Uptime Kuma notifications fire on UP/DOWN transitions, no
mode-specific differences. The heartbeat `msg` is the only differentiator
in notification text. **PROPOSED.**

### 7.4 Conditions / `supportsConditions`

Set to `false` for the new monitor type (consistent with `tcp.js`,
`mqtt.js`, `mongodb.js`). Future work could add condition variables like
`frame_count` or `match_distance`, but that's a follow-up. **PROPOSED.**
