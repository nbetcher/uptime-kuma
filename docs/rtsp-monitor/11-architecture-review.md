# 11 — Architecture Review

**Date:** 2026-10-04. **Reviewed:** branch `rtsp-monitor` at `9380df7`, plus
the `sync-upstream-rtsp-docker.yml` release workflow on `master`.
**Fixes:** branch `rtsp-monitor-architecture`.

**Follow-up:** [12-security-and-correctness-audit.md](./12-security-and-correctness-audit.md)
audits that architecture branch at `d13e960`. Its fixes supersede the TLS
precheck approach in §2.3: verified TLS frame capture now fails closed because
the decoder cannot reliably verify hostnames. Basic verification and explicit
Ignore TLS remain available. The text below records the earlier implementation.

This review supersedes parts of [10-high-level-design.md](./10-high-level-design.md):
§3.1/§4.2 (reference storage), §5.6–§5.8 and §6.1–§6.2 (frame capture,
libav options, concurrency), and §12.3 (TLS posture in Enhanced/Full).

Every defect marked **proven** below was reproduced against the original
code before it was changed — either with a purpose-built fake RTSP server
or against a real [MediaMTX](https://github.com/bluenviron/mediamtx)
server publishing an H.264 test pattern over RTSP, RTSPS, and RTMP.

---

## 1. Findings at a glance

| #   | Finding                                                                                       | Severity   | Evidence      | Status          |
| --- | --------------------------------------------------------------------------------------------- | ---------- | ------------- | --------------- |
| 2.1 | libav runs inside the server process; a silent camera permanently wedges the libuv threadpool | Critical   | proven        | fixed           |
| 2.2 | Enhanced/Full never send RTSP credentials                                                     | Critical   | proven        | fixed           |
| 2.3 | Enhanced/Full never verify RTSPS/RTMPS certificates                                           | High       | proven        | fixed           |
| 2.4 | No libav I/O timeout; a fixed open deadline makes RTMP always DOWN                            | High       | proven        | fixed           |
| 2.5 | Saturation skips are unbounded, so a starved monitor stays green forever                      | High       | by inspection | fixed           |
| 2.6 | Reference BLOBs live on the `monitor` row                                                     | Medium     | by inspection | fixed           |
| 2.7 | socket.io message cap raised to 16 MB for every client, including unauthenticated ones        | Medium     | by inspection | fixed           |
| 2.8 | Smaller defects (8 items)                                                                     | Low–Medium | mixed         | fixed           |
| 3.x | Structural / process issues                                                                   | —          | —             | recommendations |

---

## 2. Defects fixed on `rtsp-monitor-architecture`

### 2.1 Native decoding shared the server's fate — **Critical, proven**

`NodeAvFrameSource` called node-av in the Uptime Kuma process. node-av's
async calls run on the libuv threadpool (4 threads by default), and its
`AbortSignal` support does not interrupt a blocked `avformat_open_input`.
`withDeadline()` only stopped _waiting_; the native call kept running.

Reproduction: four RTSP endpoints that accept TCP and never answer (a
common half-dead camera/NVR state). Each check "timed out" at 4 s on the
JS side — and the threadpool never recovered:

```
4.0s all 4 check paths returned to the caller
9.0s threadpool latency after: BLOCKED >5000ms     (and every 5 s after)
```

With the threadpool gone, every `fs`, `dns.lookup`, `crypto` and — via
the sqlite3 driver — every SQLite query in Uptime Kuma stalls. One hung
camera gets there on its own within ~4 check intervals, because each
check leaks another thread. A segfault anywhere in FFmpeg would have
killed the whole server outright.

**Fix.** Decoding moved to `frame-worker.js`, a child process forked per
Enhanced/Full check by `frame-capture.js`. The parent enforces the
wall-clock budget with `SIGKILL`, which is the only cancellation
guaranteed to release the thread, the socket and the libav context. The
server process never loads node-av; availability is probed once in a
throwaway worker. Credentials go to the worker over IPC only — never argv
or env. After a successful capture the worker gets 2 s to close cleanly so
the camera receives `TEARDOWN` (verified on TCP and UDP transports);
cameras often allow only a handful of sessions.

Same reproduction, after: six silent cameras, each killed at its 1.5 s
budget; threadpool latency afterwards 1 ms.

Cost: ~0.3 s process start-up and ~50 MB transient RSS per concurrent
decode, bounded by `RTSP_CONCURRENCY` (default 2–4).

### 2.2 Credentials never reached the camera — **Critical, proven**

HLDS §6.2 specified `rtsp_user` / `rtsp_pass` AVDictionary options. libav
has no such options (`ffmpeg -h demuxer=rtsp`); it takes credentials only
from the URL userinfo. Preflight also _stripped_ userinfo from the URL.
Result: every Enhanced/Full check of a password-protected camera was
DOWN with `401 Unauthorized`, whether credentials were in the form or in
the URL. A fake RTSP server confirmed the client never sent an
`Authorization` header.

**Fix.** `buildLibavInput()` puts the credentials into the URL handed to
the worker (percent-encoded; libav decodes them before building the
header). Verified with `@`, `:`, `/`, `#`, `&` and `%` in passwords against
the fake server and MediaMTX. Regression test:
`test-rtsp-frame-capture.js`.

### 2.3 TLS was never verified in Enhanced/Full — **High, proven**

libav's `tls_verify` defaults to `0`, and the code only ever set it to
`0` explicitly. Against MediaMTX with a self-signed certificate and
"Ignore TLS" **off**, the original code reported UP.

**Fix.** Before opening the decode session, `verifyTlsEndpoint()` performs
a Node TLS handshake (chain + hostname) against the same host:port, using
the same error classification as Basic mode. libav itself is still not
asked to verify: options given to the RTSP demuxer are not guaranteed to
reach the TLS connection it opens internally, and a build without a usable
CA path would fail every connection. The residual gap is a DNS change
between the two connections; documented, accepted.

**Behaviour change:** RTSPS/RTMPS monitors in Enhanced/Full that use
self-signed certificates and were UP will now be DOWN until "Ignore TLS
errors" is enabled — which is what that setting has always claimed to do.

### 2.4 Timeouts — **High, proven**

- `stimeout` was removed in FFmpeg 5; the option is `timeout` (µs). libav
  therefore had **no** socket I/O timeout at all.
- The open was capped at 40 % of the budget (max 8 s). RTMP's default 5 s
  stream analysis did not fit: against MediaMTX every Enhanced RTMP check
  was DOWN (`timed out after 4000ms`).
- `monitor.timeout` was used raw; the monitor loop rewrites a zero timeout
  to `interval * 1000 * 0.8` (a millisecond value), which RTSP then
  multiplied by 1000 again (~13 h).
- Basic mode applied the timeout to connect and read separately (up to
  2× the configured value).

**Fix.** `timeout` + `rw_timeout` in µs; one hard budget enforced by the
parent; `computeTimeout()` clamps to [1 s, 80 % of interval]; Basic mode
uses one deadline. RTMP gets `analyzeduration=1s` (first frame ~6 s →
~2 s, measured); RTSP keeps libav's default because SDP coverage varies
by camera and a shorter window was not validated against real devices.

### 2.5 Fail-open skip semantics — **High**

`SkipCheckError` drops a beat without writing a heartbeat, so the monitor
keeps whatever status it last had. A permanently saturated decode bucket
therefore meant a camera could die while its monitor stayed UP
indefinitely — the one outcome a monitoring tool must not have. The
per-monitor mutex also had no timeout.

**Fix.** At most `MAX_CONSECUTIVE_SKIPS` (2) skips in a row per monitor;
the next one is a normal error (DOWN/PENDING through the usual retry
logic) reading `check could not run 3 times in a row: …`. The per-monitor
lock is now a bounded `TokenBucket(1)`. Test-button runs share the lock
but do not consume the monitor's skip allowance.

### 2.6 Reference images on the `monitor` row — **Medium**

Two up-to-256 KB BLOBs per RTSP monitor were loaded by every
`SELECT * FROM monitor` (server start, monitor list, every edit), held in
memory by each running `Monitor` for the life of the process, and
rewritten by every `R.store()` on edit.

**Fix.** New table `monitor_stream_reference (monitor_id, slot,
image_blob, fingerprint, source_url, updated_at)`, unique on
`(monitor_id, slot)`. Migration
`2026-10-04-0000-stream-reference-table.js` copies existing references
and then **empties** the old columns rather than dropping them: on SQLite
a `dropColumn` makes knex rebuild the whole `monitor` table, which with
foreign keys enabled on a second pooled connection would cascade-delete
heartbeats. Tested against a real SQLite database built by the full
migration chain, with heartbeats present before and after.

The edit form no longer receives reference metadata through
`Monitor.toJSON()`; `ReferenceImagePanel` reads it with
`rtsp:getReferenceInfo`. The Test button no longer trusts fingerprints
sent by the browser; it looks them up server-side after an ownership
check.

### 2.7 Global 16 MB socket.io message cap — **Medium**

`maxHttpBufferSize` was raised from 1 MB to 16 MB for **every** socket,
including unauthenticated ones, to carry one base64 upload — a 16× larger
pre-auth memory-amplification surface. Uploading a 10 MB original was
also pointless: the server canonicalises to 640 px.

**Fix.** Reverted to the default. The browser decodes the file (EXIF
orientation applied), downscales to ≤1280 px, re-encodes JPEG under
600 KB and sends it as binary. Measured in Chromium with an 11 MB PNG:
largest websocket frame 51 KB (the old path would have sent ~15 MB).
Source-file limit raised from 10 MB to 25 MB since the bytes never leave
the browser.

### 2.8 Smaller defects

- Full mode wrote a "match" thumbnail (INSERT + DELETE of a BLOB) on every
  successful check when only _Keep DOWN images_ was enabled; the image is
  only ever shown on the status page.
- `captured_at` / `created_at` were written as ISO strings with a `Z`
  suffix; now `R.isoDateTimeMillis()` like the rest of Uptime Kuma, which
  both SQLite and MariaDB `DATETIME` accept.
- `reference-store.js` / `audit.js` relied on `server.js` having registered
  the dayjs `utc` plugin (found by the new integration test).
- The keyframe-interval warning (UI-011) could never fire: node-av streams
  have no `gop_size` / `keyframe_interval`. Replaced by the measured time
  to first frame — the quantity that actually decides whether a check fits
  its budget.
- `toJpeg()` carried five speculative branches for frame shapes node-av
  does not produce; the worker now targets the real API
  (`FilterAPI("format=rgb24")` → `frame.toBuffer()`).
- `allowed_media_types=video` skips SETUP for audio tracks (fewer
  round-trips, fewer UDP ports).
- Live frames are downscaled to ≤640 px in the worker, matching the
  reference canonicalisation and keeping IPC small.
- node-av 5.x calls `Promise.withResolvers` (Node.js 22+), while Uptime
  Kuma supports Node.js ≥ 20.4. On Node 20 the packet iterator throws and
  decoding silently yields no frames (`only 0/5 valid frames`). The Docker
  images run Node 22 and are unaffected; on Node 20 the native-support
  probe now reports Enhanced/Full as unavailable with that reason.
- `ReferenceImagePanel` used Bootstrap `.card`, which the app's global
  border radius renders as an ellipse.

---

## 3. Not fixed here — recommendations

### 3.1 Fork branding is mixed into the feature branch

`rtsp-monitor` rewrites `louislam` → `nbetcher` across 30+ files
(workflows, `extra/`, Dockerfiles, `package.json`) alongside the feature.
Every upstream release therefore conflicts in files the feature never
needed to touch, which is why the sync workflow needs automated conflict
resolution at all. Keep `rtsp-monitor` as the pure feature delta and apply
branding at build time — the workflow already does exactly that for the
Docker base images.

### 3.2 `latest-rtsp` is published without running a test

A clean textual merge of an upstream release is built and pushed weekly
with zero tests run, and the RTSP suite runs nowhere in CI. A clean merge
can still break the feature (e.g. a change to the monitor loop or the
`MonitorType` contract). The RTSP suite now decodes real H.264 fixtures
and exercises the real SQLite schema, so it is a meaningful gate: run
`node --test test/backend-test/monitors/test-rtsp-*.js` before
`docker buildx build`.

### 3.3 Core-file coupling

RTSP knowledge still lives in `server.js` (add/edit), `model/monitor.js`
(`toJSON`, `SkipCheckError` branch) and `api-router.js`. Each is a merge
hazard on every upstream sync. The durable fix is an upstream
`MonitorType` hook for validate / apply-fields / serialise; until then,
keep these touch points as small as they are now.

### 3.4 Frozen-frame detection is weak by construction

Enhanced compares byte-identical JPEGs across a ~0.3–1 s burst. A frozen
sensor pipeline with a live on-screen clock is never detected, and a
static scene vs. a frozen stream is indistinguishable within one burst.
Compare against the previous check's fingerprint instead.

### 3.5 SSRF guard vs. threat model

Reference-URL fetching has a 380-line SSRF guard with a "same private
bucket as the camera" carve-out. Uptime Kuma is a single-admin tool whose
HTTP monitors already reach any internal URL, so this guards little and
blocks legitimate setups (camera on 192.168.x, NAS on 10.x). Keep it, but
do not grow it.

### 3.6 Design process

The 2,500-line HLDS specified libav options that do not exist, and the
test plan explicitly left the decode path out of CI ("exercised by the
staged integration test"). Nothing in the original tests ever decoded a
frame or spoke to an RTSP server with authentication. The new tests
decode committed H.264 fixtures, authenticate against a fake RTSP server,
and run the migration and reference store against real SQLite.

### 3.7 Cleanup for later

- The six emptied `monitor.stream_reference_*` columns can be dropped by a
  future migration that runs with `transaction: false` and foreign keys
  disabled on the migrating connection.
- One transient `Invalid data found when processing input` was observed
  against MediaMTX while a Vite build saturated the CPU; it did not
  reproduce in 86 further captures, including 24 with every core pinned.
  Retries cover it; watch for it on real cameras.

---

## 4. Verification

Before/after, same scenarios through `RtspMonitorType.check()`, against
MediaMTX v1.9.3 (password `p@ss#w&rd`):

| Scenario                                | Original           | Fixed                          |
| --------------------------------------- | ------------------ | ------------------------------ |
| Basic, RTSP                             | UP                 | UP                             |
| Enhanced, RTSP/TCP, form credentials    | **DOWN** 401       | UP (5 frames, ~3 s)            |
| Enhanced, RTSP/TCP, URL credentials     | **DOWN** 401       | UP                             |
| Enhanced, RTSP/UDP, form credentials    | **DOWN** 401       | UP                             |
| Enhanced, wrong password                | DOWN 401           | DOWN 401                       |
| Enhanced, RTSPS self-signed, verify on  | **UP**             | DOWN `self-signed certificate` |
| Enhanced, RTSPS self-signed, ignore TLS | UP                 | UP                             |
| Enhanced, RTMP                          | **DOWN** timed out | UP (~2.3 s)                    |

Also run:

- RTSP backend suite: 121 tests, 0 failures, 0 skipped (adds frame
  capture, credential, silent-camera, migration, reference-store and
  end-to-end Enhanced/Full tests).
- Real server + Chromium: setup → create Enhanced monitor → Test (UP) →
  switch to Full → upload 11 MB PNG → Test (matched 6/128) → scheduled
  heartbeats DOWN "requires at least one reference" before upload, UP
  "matched single at distance 0/128" after.
- 62 consecutive captures (32 at 4-way concurrency) plus 24 under full CPU
  saturation: all succeeded.

## 5. Upgrade notes

- The migration runs automatically and preserves existing references.
- Enhanced/Full monitors with credentials that were DOWN with 401 will go
  UP.
- Enhanced/Full RTSPS/RTMPS monitors with untrusted certificates will go
  DOWN unless "Ignore TLS errors" is enabled.
- Live frames are now downscaled to 640 px before fingerprinting, like
  references; Full-mode distances can shift by a few bits. Re-check
  thresholds that sit close to their limit.
