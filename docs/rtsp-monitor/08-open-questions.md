# 08 — Open Questions, Pushbacks, and Decisions Still to Make

This is the document I most want you to attack. Every item here is either
something I am pushing back on from your original brief, an alternative I
am proposing that you should weigh, or a decision that genuinely cannot be
locked without your call.

Numbering is durable so you can reference items by ID in critique.

---

## Q1. PUSHBACK: drop "RTSP over DTLS"

### Your brief

> "RTSP over DTLS for RTSP UDP should be planned for (if this is even
> something some vendors use: RTSP over DTLS), but not implemented yet,
> with optional certificate validation."

You hedged ("if this is even something") — and you were right to hedge.

### My finding

`[HIGH]` confidence: RTSP over DTLS is not a thing.

- No RFC describes it. RFC 2326 and RFC 7826 (the two RTSP RFCs) define
  RTSP over reliable transports — TCP unreliable transport implementation
  is left as an exercise but never standardised.
- DTLS (RFC 6347) is intended for datagram (UDP) protocols. Pairing it
  with RTSP-control would require RTSP to handle datagram boundaries,
  loss, and reordering, none of which the protocol's text-line framing
  supports.
- DTLS-SRTP (RFC 5764) — the most likely source of confusion — is a
  WebRTC-only construction. WebRTC uses ICE / SDP for signalling and
  DTLS-SRTP for media keying. RTSP is not in the WebRTC stack.
- No FFmpeg flag, no GStreamer element, no maintained client library, no
  IP-camera vendor documentation references "RTSP-DTLS" or "RTSPS-UDP."
- The closest real thing is **RTSPS over TCP with SRTP keyed by SDES**
  (RFC 4568) on the media channel. SRTP-SDES is also rare in IP cameras
  but at least exists in the standards.

### What I propose

**FR-025: Won't.** Drop RTSP-over-DTLS from this work entirely. If a
specific vendor surface emerges, address it in a focused follow-up
based on that vendor's actual protocol.

If the underlying intent was "encrypt the camera traffic," the answer
that already exists is RTSPS (FR-022) — RTSP over TCP-TLS. Camera
deployments that need encrypted *media* (rare) generally use SRTP under
RTSPS, which is transparent to FFmpeg / `node-av`; we do not need to
configure it.

### What you could choose instead

- **Accept the pushback.** Recommended.
- **Reserve UI space for it anyway** with a "coming soon" toggle.
  Cheap; zero implementation; introduces UI debt.
- **Reject the pushback** and ask me to find or build *something* — but
  that something would be vendor-specific and probably wouldn't be
  RTSP at all.

---

## Q2. PUSHBACK: drop "RTMP over UDP"

### Your brief

> "RTSP and RTMP over TCP and UDP should be supported."

For RTSP this resolves cleanly to "RTSP-control over TCP, RTP-media over
TCP-interleaved or UDP" (FR-020 / FR-021).

For RTMP the "over UDP" half is impossible.

### My finding

`[HIGH]` confidence: RTMP is TCP-only.

- RTMP framing (C0/C1 handshake, chunk streams, AMF) assumes ordered,
  reliable byte delivery.
- The UDP cousin from the same era is **RTMFP** (RFC 7016), which is a
  separate protocol — peer-to-peer, NAT-traversing, used almost
  exclusively by Adobe Flash applications. No IP camera ships with it.
- No FFmpeg flag, no NGINX-RTMP option, no MediaMTX option.

### What I propose

**FR-026: Won't.** RTMP-over-UDP is dropped. RTMP and RTMPS over TCP are
fully supported (FR-023 / FR-024). If you eventually want RTMFP, that's
a different monitor type — and there's no surveyed demand.

### What you could choose instead

- **Accept the pushback.** Recommended.
- **Reject and ask me to add RTMFP** — possible, but a separate monitor
  type with a separate audience (effectively no one in the IP-camera
  market).

---

## Q3. DECISION: FFmpeg subprocess vs. `node-av`

This is the highest-stakes design decision in the project. Your prior
answer on the clarifying question selected:

> "Both: bundle in Docker AND prefer system ffmpeg if present"

That implies the **subprocess approach**: spawn `ffmpeg` as a child
process, pipe MJPEG to stdout, read frames as `Buffer`.

`@louislam` (the Uptime Kuma project owner) recommended a different
direction in PR #5822's comments:

> "Just saw node-av recently, which is ffmpeg bindings for Node.js."

`node-av` (https://github.com/seydx/node-av) is N-API bindings to FFmpeg
with prebuilt binaries for Linux/macOS/Windows × x64/arm64.

### Tradeoffs

| Aspect | FFmpeg subprocess | `node-av` |
|---|---|---|
| Maintainer signal | None / neutral | Endorsed by `@louislam` |
| Install footprint | 0 (system) or ~50 MB (Docker bundle) | ~30–50 MB (npm prebuilds) |
| Architectures | Whatever the system / Docker has | Linux/macOS/Win × x64/arm64 prebuilt; others compile (or fail) |
| First-frame latency | ~50 ms subprocess startup overhead | ~5 ms (in-process) |
| Memory model | Frames cross stdout pipe (one extra copy) | Frames are `Buffer` directly from libav |
| PATH detection | Required (OP-001/002) | None |
| Zombie risk | High; needs OP-003 hard-kill | None |
| Failure mode on missing FFmpeg | Detected at startup; UI warning | Install fails at `npm install` time — can't run at all |
| Failure mode on subprocess hang | Wall-clock backstop kills it | Can't hang the way a subprocess can; but a stuck `await` is still possible |
| Maturity | Decades of FFmpeg + standard Node child_process | Newer; smaller user base; less battle-tested |
| Upstream-PR optics | "Adds a binary" or "spawns subprocess" — reviewer may flag | Clean N-API dep; but also a heavier `package.json` change |
| Fork-only optics | Either is fine | Either is fine |

### My honest read

- For the **fork**, either works. Pick the one with less ops burden for
  *you*: subprocess if you'd rather see what's happening on the wire and
  use the same `ffmpeg` binary you already operate, `node-av` if you'd
  rather avoid PATH and zombie-process concerns entirely.
- For an **upstream PR**, `node-av` carries the maintainer's own hint,
  which is a non-trivial signal. But CommanderStorm has not commented on
  `node-av` specifically; he might still argue for subprocess on
  Docker-image-size grounds.
- The **brief's "no temp storage, max efficiency"** weighs slightly
  toward `node-av` (no subprocess overhead, no IPC).
- The **brief's "minimal new dependencies"** weighs slightly toward
  subprocess (`node-av` is one fairly chunky new dep; subprocess
  requires no new deps if FFmpeg is already on the system).

### What I propose

**Default to the subprocess approach** (matching your stated answer),
with the implementation cleanly factored behind a `FrameSource` interface
so substituting `node-av` later is a localised change.

But I'd like you to confirm or override before HLD. **DECISION REQUEST.**

---

## Q4. DECISION: HEVC / H.265 / AV1 support

Many newer IP cameras ship HEVC by default. FFmpeg builds usually include
HEVC decode (LGPL); the bundled `@ffmpeg-installer/ffmpeg` does. `node-av`
also includes it. Three things to decide:

1. Is HEVC support in scope from day one? *(I'd say yes — the cost is
   zero for our pipeline; the cost is in not supporting common
   cameras.)*
2. AV1 streams are still rare in cameras (mostly seen in cloud
   transcodes). I'd say yes too, for the same reason — comes for free.
3. We should *not* claim support for proprietary codecs (e.g., legacy
   Hikvision-only H.264+ extensions). FFmpeg handles them via standard
   H.264 paths; if a vendor emits genuinely non-standard frames, the
   monitor will report DOWN — accurately.

**PROPOSED:** HEVC and AV1 supported via the chosen decode stack; no
explicit codec filter applied.

---

## Q5. DECISION: behaviour when reference image is missing in Full mode

If a user picks Full mode but hasn't yet uploaded a reference (or the URL
fetch failed), what does the monitor do?

Options:
- **(a) Refuse to save.** UI validation fails until at least one
  reference is provided.
- **(b) Save but show monitor as DOWN** with `"Full mode: no reference
  image configured"` until references are added.
- **(c) Auto-capture a reference** from the live stream on first save.

Each has trade-offs. (a) is strictest; (b) makes the failure visible
without preventing setup; (c) is slick but bakes "current scene" as the
correct one even if the camera was misaimed at setup time.

**PROPOSED:** (a) for required references, with a separate "Capture from
current stream" button (per **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** §5)
that lets the user explicitly opt in to (c). **DECISION REQUEST.**

---

## Q6. PROPOSED: scope-split readiness for upstream

The brief is silent on whether you eventually want the work upstream.
The repo is your fork. Two postures matter:

- **Fork-only.** All three modes ship together. Done. No CommanderStorm
  to satisfy except indirectly (good code is good code).
- **Upstream-bound.** CommanderStorm's "split keeps it maintainable"
  guidance pushes Basic into a standalone first PR; Enhanced and Full
  are follow-ups.

NFR-051 (scope-split readiness) keeps the option open: Basic is in its
own file, with no compile-time or runtime dependency on Enhanced/Full.
A Basic-only upstream PR is then a `git rm` of three Enhanced/Full files
plus the migration columns they introduced.

Cost of NFR-051: a tiny amount of architectural discipline; a slightly
larger boundary between Basic and Enhanced/Full code paths than would
otherwise exist.

**DECISION REQUEST:** confirm whether you want NFR-051 enforced. If
fork-only is the only goal, we can relax it.

---

## Q7. PROPOSED: where do BLOB references actually live for SQLite?

Uptime Kuma supports SQLite (default) and MariaDB. SQLite stores BLOBs
inline (no extra cost; though large BLOBs can cause page bloat). MariaDB
stores them in `LONGBLOB` columns (efficient).

The 80 KB target after re-resampling is well within both engines'
comfort zones. The schema change is identical for both: a `blob` column
type via Knex.

What might bite us:
- SQLite's `dump`/`restore` and Uptime Kuma's existing backup script
  must round-trip BLOBs correctly. I have not verified this.
- Frontend serialisation: Uptime Kuma serialises monitor objects over
  WebSockets. We'd want to *omit* BLOB columns from default
  serialisation to avoid blasting kilobytes of base64 on every push;
  serve them on demand via a dedicated endpoint instead.

**PROPOSED:** add `excludedFromMonitorJSON: true` semantics for BLOB
columns; the existing `Monitor.toJSON()` filter list is the place. A
dedicated GET endpoint serves the BLOB on demand for the edit form.

**DECISION REQUEST:** confirm this is acceptable; raise concerns about
SQLite/MariaDB backup compatibility if you have visibility I lack.

---

## Q8. PROPOSED: minimum supported FFmpeg version

If we go the subprocess route, the `-stimeout` / `-timeout` flag rename
in FFmpeg 5.0 (April 2021) means we either:

- (a) Detect version and pick the right flag.
- (b) Set both flags (older versions fail on unknown new flags; newer
  versions fail on removed old flags — so this *doesn't* actually work).
- (c) Require FFmpeg ≥ 5.0 and document it.

`@ffmpeg-installer/ffmpeg` ships FFmpeg 6.0+ in its current versions.
The Debian-base Dockerfile would `apt-get install ffmpeg` from Debian
stable (currently FFmpeg 5.1+).

**PROPOSED:** require FFmpeg ≥ 5.0. Detected at startup; UI warning if
older. Documented in the README section we'll add at HLD time.

**DECISION REQUEST:** confirm or lower the floor. (Lowering is
genuinely complicated; I'd argue we don't.)

---

## Q9. PROPOSED: per-monitor concurrency cap default

NFR-004 caps concurrently-active Enhanced/Full checks at 4 by default.
The number is somewhat arbitrary. The reasoning:

- Each FFmpeg subprocess is ~20 MB RSS plus ~10–30% of one CPU core
  during decode.
- A small VPS (1 CPU, 1–2 GB RAM) can comfortably handle 4 concurrent
  decodes; 8 starts to thrash.
- A big server can override via env var (e.g., `RTSP_CONCURRENCY=16`).

**DECISION REQUEST:** confirm 4 as a reasonable default, or propose a
different number. Maybe 2 if you target small NAS deployments;
`Math.max(2, Math.min(4, os.cpus().length / 2))` if you want it scaled.

---

## Q10. CLARIFICATION: meaning of "RTSP and RTMP over TCP and UDP" — once more, in writing

Just to make sure my interpretation in FR-020 / FR-021 / FR-023 is what
you meant. My read:

- **RTSP over TCP** → RTSP control on TCP/554; media on TCP-interleaved
  (in the same RTSP socket) — supported in all three modes.
- **RTSP over UDP** → I am rendering this as "RTSP control on TCP/554
  with media on UDP-RTP" — supported in all three modes. Pure
  RTSP-control-over-UDP is excluded (FR-020 doesn't include the row;
  see **[02-protocol-coverage.md](./02-protocol-coverage.md)** §3.1
  for why).
- **RTMP over TCP** → standard RTMP on TCP/1935 — supported.
- **RTMP over UDP** → not a real thing; rejected as FR-026 / Q2 above.

**DECISION REQUEST:** confirm this interpretation, or push back if you
genuinely meant something else by "RTSP over UDP." If a specific vendor
requires raw RTSP-control-over-UDP, share the vendor and I'll
investigate.

---

## Q11. SMALL ASKS (please confirm or override)

- **Q11.a** — "Path" field placeholder text. Default proposal:
  `"/Streaming/Channels/101"` for RTSP, `"/live/stream"` for RTMP, with
  a tooltip noting "consult your camera's documentation."
  **CONFIRM/OVERRIDE.**
- **Q11.b** — Default thresholds: 10-second wall-clock budget, 5
  frames for Enhanced, 24/128 distance threshold for Full.
  **CONFIRM/OVERRIDE.**
- **Q11.c** — Whether to support `?rtsp_transport=` URL parameter (some
  camera apps emit this). Probably not; we expose a UI toggle instead.
  **CONFIRM/OVERRIDE.**
- **Q11.d** — Whether the "Capture from current stream" button (used to
  populate references) should require Enhanced or Full mode capability,
  or be a one-shot regardless of selected mode. **DECISION REQUEST.**

---

## Q12. THINGS YOU DIDN'T ASK ABOUT BUT I THINK ARE WORTH RAISING

In your spirit of "don't be shy to suggest things I've failed to
consider" — these aren't requirements, but they are things you might
want to weigh.

- **Q12.a — Pre-roll / first-frame patience.** Some cameras take 2–4
  seconds to send their first decoded keyframe (they have to wait for
  the next IDR). If wall-clock budget is too tight, healthy cameras
  fail. The 10 s default is comfortable but worth flagging. *Mitigation
  in current design:* configurable timeout in NFR-002.

- **Q12.b — H.264 keyframe-only vs all frames.** Enhanced mode could
  speed up massively by only decoding keyframes (`-skip_frame nokey`),
  at the cost of confused statistics. Full mode definitely wants
  keyframe-only (one frame is enough). **PROPOSED:** Full uses
  `-skip_frame nokey`, Enhanced uses default. **CONFIRM/OVERRIDE.**

- **Q12.c — Multi-camera per-monitor.** Your bash script runs *two*
  cameras per cron tick, each producing its own push update. The new
  monitor maps **one camera per monitor row**, matching every existing
  Uptime Kuma monitor type. This is more verbose to set up (one
  monitor per camera) but composes correctly with status pages,
  notifications, and tags. I'd not change it. *Confirming this is the
  right call.*

- **Q12.d — Push fallback.** Keep your existing push monitors as
  fallbacks for the period before the new monitor is implemented;
  remove them after the active monitor proves out. The new monitor
  doesn't replace push monitors; it makes the script obsolete. Worth
  noting in your migration notes when you eventually implement.

- **Q12.e — Audit log of reference uploads.** Should we keep an audit
  trail of when references were updated and from where (BLOB upload,
  URL refresh, captured-from-stream)? It is one extra column and a
  log line; cheap. **PROPOSED yes.**

- **Q12.f — A "test now" button on the edit form.** Let the user run a
  one-shot probe against the entered URL before saving. UI-affordance
  precedent in HTTP monitors. Particularly useful here because the
  failure modes are nuanced (vendor quirks, transport choice, codec
  support). **PROPOSED yes.**

- **Q12.g — Heartbeat enrichment for status pages.** The status-page
  view of a Full-mode monitor could optionally show a tiny thumbnail
  of the most recent matching frame, captioned with the distance.
  Privacy-questionable for some users (camera footage on a status
  page). **PROPOSED:** off by default; per-monitor opt-in only;
  thumbnail re-resampled from BLOB-stored last-match frame.

- **Q12.h — Webhook outputs for image-match changes.** When a Full-mode
  monitor's distance climbs *toward* the threshold without crossing
  it, that's a useful early warning ("camera is drifting"). **PROPOSED
  defer:** capture data in heartbeats, but don't add new notification
  channels in v1.

---

## How to use this document for adversarial review

For each numbered item, the expected outcome of your review is one of:

- **ACK** — proposed direction stands; lock into requirements.
- **OVERRIDE: <new direction>** — replace the proposal.
- **DEFER** — keep on this list; don't commit yet.
- **REJECT** — drop entirely; remove from scope.

I'll fold the outcomes into a revised
**[04-requirements.md](./04-requirements.md)** before HLD work begins.
