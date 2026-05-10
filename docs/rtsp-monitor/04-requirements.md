# 04 — Functional and Non-Functional Requirements

The canonical contract. Every requirement has a stable ID. **REQUIRED-BY-BRIEF**
items come from the original prompt; **PROPOSED** items are my additions or
elaborations; **PUSHBACK** items mark where I'm proposing scope reduction or
substitution.

MoSCoW levels: **Must / Should / Could / Won't**. "Won't" is included where
the original brief explicitly named something — to make the rejection
visible rather than silent.

Each requirement lists an **acceptance criterion**: an objective, testable
sentence that an adversarial reviewer can use to verify completion.

---

## A. Functional requirements

### A.1 Monitor type

#### FR-001 — New monitor type
**Must.** **REQUIRED-BY-BRIEF.**
A new monitor type with a stable identifier (proposed: `rtsp`) MUST be
selectable in the monitor edit form, listed under a "Streaming" or
"Multimedia" `optgroup`.
- **Source:** Original brief; existing pattern in
  `src/pages/EditMonitor.vue:30-107`.
- **Acceptance:** the type appears in the dropdown; saving a monitor with
  this type persists and round-trips through the WebSocket layer.

#### FR-002 — Single monitor type covers RTSP and RTMP
**Should.** **PROPOSED.**
A single monitor type SHOULD cover both RTSP and RTMP, with a per-monitor
"Protocol" selector. Two separate types are rejected because the
monitoring depth modes are identical and the configuration surface is
~80% shared.
- **Source:** Inference from "Ability to monitor RTSP and RTMP streams in
  three modes."
- **Acceptance:** the same type id and same monitor row supports both.

### A.2 Modes

#### FR-010 — Three depth modes
**Must.** **REQUIRED-BY-BRIEF.**
The monitor MUST offer exactly three depth modes named **Basic**,
**Enhanced**, and **Full**, selectable per-monitor.
- **Source:** Brief, user-confirmed naming in clarifying questions.
- **Acceptance:** `mode` column accepts only those three values; UI radio
  group shows them.

#### FR-011 — Basic mode behaviour
**Must.** **REQUIRED-BY-BRIEF.**
Basic mode MUST verify that the configured port is open AND that the
peer responds with a syntactically-recognisable RTSP or RTMP message.
A bare TCP-port-open SHALL NOT count as Basic-pass.
- **Source:** Brief: *"that the port is open and responds to (Roughly)
  proper RTSP protocol commands."*
- **Acceptance:** the test plan includes a fixture that listens on TCP
  but answers with HTTP — Basic must mark this DOWN.

#### FR-012 — Vendor quirk tolerance in Basic
**Must.** **REQUIRED-BY-BRIEF.**
Basic mode MUST treat HTTP-style RTSP responses with status 401, 403,
404, 405 as UP. It MUST treat status 5xx as UP-with-warning. It MUST
require the leading `RTSP/` prefix on the response.
- **Source:** Brief: *"with variance allowed for known quirks of some
  very popular vendors."*
- **Acceptance:** unit fixtures for Hikvision-401, Dahua-401-with-spaces,
  and a generic-5xx all produce the expected status.

#### FR-013 — Enhanced mode behaviour
**Must.** **REQUIRED-BY-BRIEF.**
Enhanced mode MUST capture between 2 and 15 video frames (default 5),
validate each as a structurally-correct JPEG with sane dimensions, and
explicitly test for the frozen-frame condition.
- **Source:** Brief; reviewer concern from PR #5954 (PoleTransformer).
- **Acceptance:** a fixture that emits 5 byte-identical frames produces
  DOWN with `"frozen"` in the message.

#### FR-014 — Black/uniform frame rejection
**Should.** **PROPOSED.**
Enhanced mode SHOULD reject frames whose mean luminance is below 5/255
*and* standard deviation is below 2/255 across a 32×32 greyscale
downsample of the last frame.
- **Source:** Enhances FR-013 to also catch sensor-fault / lens-cap.
- **Acceptance:** a fixture that emits 5 different solid-black frames
  produces DOWN with `"black or uniform"`.

#### FR-015 — Full mode behaviour
**Must.** **REQUIRED-BY-BRIEF.**
Full mode MUST capture exactly one frame and compare it (via the
fingerprinting strategy in
**[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)**)
against user-supplied reference image(s).
- **Source:** Brief.
- **Acceptance:** a fixture frame within Hamming distance ≤ threshold of
  the reference produces UP; outside it produces DOWN.

#### FR-016 — Full mode does NOT run Enhanced first
**Should.** **PROPOSED.**
Full mode SHALL skip Enhanced's frozen/black checks. The image-match
result is the sole pass/fail signal in Full mode.
- **Source:** Brief: *"skips monitoring using Enhanced methods and skips
  straight to image match verification."*
- **Acceptance:** a fixture that returns one valid frame matching the
  reference, but where the next 4 frames would have failed Enhanced
  (frozen), still produces UP in Full mode.

#### FR-017 — Day/Night reference toggle
**Must.** **REQUIRED-BY-BRIEF.**
Full mode MUST support a "Separate Day/Night" toggle, default ON. When
ON, the user supplies one Day reference and one Night reference; when
OFF, a single reference applies regardless of time.
- **Source:** Brief.
- **Acceptance:** the toggle persists; the UI hides the second slot when
  OFF; both slots accept references when ON.

#### FR-018 — Day/Night decision logic
**Must.** **REQUIRED-BY-BRIEF.**
When two references are present, Full mode MUST fingerprint the live
frame against both, compute Hamming distance to each, and pass if the
*minimum* distance is ≤ threshold.
- **Source:** Brief, user-confirmed strategy in clarifying questions.
- **Acceptance:** with a Day reference matching at distance 4 and a Night
  reference matching at distance 30 (against a Day live frame),
  threshold 12, the result is UP with `"matched Day at distance 4"`.

#### FR-019 — Reference image source: BLOB and URL
**Must.** **REQUIRED-BY-BRIEF.**
The UI MUST allow the user to either upload a reference image (stored as
a BLOB on the monitor row) or supply a URL the monitor fetches at check
time. The two sources are exclusive per slot.
- **Source:** Brief, user-confirmed in clarifying questions ("BLOB *and*
  URL").
- **Acceptance:** uploading produces a row with `reference_day` BLOB
  populated and `reference_day_url` NULL; choosing URL is the inverse;
  switching one to the other clears the discarded value.

### A.3 Protocol coverage

#### FR-020 — RTSP over TCP
**Must.** **REQUIRED-BY-BRIEF.**
- **Acceptance:** see the matrix in
  **[02-protocol-coverage.md](./02-protocol-coverage.md)** §1, all
  RTSP-over-TCP rows pass their fixture tests.

#### FR-021 — RTSP-controlled RTP over UDP
**Must.** **REQUIRED-BY-BRIEF (re-stated).**
*Note: the brief said "RTSP over UDP", which I am rendering as the
correct technical wording — RTSP control over TCP, RTP media over UDP.
See **[08-open-questions.md](./08-open-questions.md)** §2 for why this
correction is necessary.*
- **Acceptance:** Enhanced/Full pass against a fixture that negotiates
  `RTP/AVP/UDP` in the SETUP transport header.

#### FR-022 — RTSP over TLS (RTSPS)
**Must.** **REQUIRED-BY-BRIEF.**
RTSPS over TCP MUST be supported on its standard port (322) and on a
user-overrideable port. Certificate validation MUST be on by default,
with a per-monitor toggle to disable for self-signed deployments.
- **Source:** Brief.
- **Acceptance:** an RTSPS fixture with a self-signed cert fails when
  validation is on and passes when validation is off.

#### FR-023 — RTMP over TCP
**Must.** **REQUIRED-BY-BRIEF.**
- **Acceptance:** Basic, Enhanced, and Full all pass their RTMP-fixture
  tests on TCP/1935.

#### FR-024 — RTMPS over TCP
**Must.** **REQUIRED-BY-BRIEF.**
RTMPS MUST be supported with the same TLS validation toggle as RTSPS.
- **Acceptance:** RTMPS fixtures parallel to FR-022's pass.

#### FR-025 — RTSP over DTLS
**Won't.** **PUSHBACK.**
The original brief asked us to plan for RTSP over DTLS. Research found
no RFC, no FFmpeg flag, no maintained library, no vendor support.
- **Source:** Pushback documented in
  **[08-open-questions.md](./08-open-questions.md)** §1.
- **Acceptance:** no DTLS code paths exist.

#### FR-026 — RTMP over UDP
**Won't.** **PUSHBACK.**
RTMP is TCP-only by specification.
- **Source:** Pushback documented in
  **[08-open-questions.md](./08-open-questions.md)** §2.
- **Acceptance:** no UDP code paths exist for RTMP.

### A.4 Authentication

#### FR-030 — RTSP authentication
**Must.** **PROPOSED.**
The monitor MUST support both Basic and Digest authentication for RTSP.
For Basic mode, an authentication challenge (401 with
`WWW-Authenticate`) counts as UP without retrying with credentials. For
Enhanced/Full, the credentials (if supplied) MUST be passed to the
underlying decode stack (FFmpeg URL or `node-av` options).
- **Source:** Vendor quirk research; HTTP-monitor parity.
- **Acceptance:** unit tests cover (a) anonymous OPTIONS → 401 → UP for
  Basic; (b) credentialed OPTIONS → 200 → UP for Basic; (c) Enhanced
  with credentials embedded in URL and credentials passed via separate
  fields both succeed.

#### FR-031 — Reuse generic credential columns
**Must.** **PROPOSED.**
The `username` and `password` columns already present on the `monitor`
table (used by HTTP and others) MUST be reused. New columns named
`rtsp_username` / `rtsp_password` MUST NOT be introduced.
- **Source:** `@CommanderStorm`'s explicit review of PR #5954.
- **Acceptance:** the migration introduces no protocol-prefixed
  credential columns.

#### FR-032 — HiddenInput for password
**Must.** **PROPOSED.**
The password field in the UI MUST use the existing `HiddenInput.vue`
component (the masked-credentials input used elsewhere in Uptime Kuma).
- **Source:** `@CommanderStorm`'s explicit review of PR #5954.
- **Acceptance:** the EditMonitor template renders `HiddenInput` for the
  password field.

### A.5 UI / UX

#### UI-001 — Visual style parity
**Must.** **REQUIRED-BY-BRIEF.**
All form fields, validation messages, and error toasts MUST match
existing Uptime Kuma monitor types in style and structure. The Vue
template MUST follow the same `v-if="monitor.type === '...'"` pattern
used throughout `EditMonitor.vue`.
- **Source:** Brief.
- **Acceptance:** visual diff against an HTTP-keyword monitor edit page
  shows only field-level differences, no structural divergence.

#### UI-002 — Help text on every non-obvious field
**Must.** **PROPOSED.**
Path, Mode, Threshold, Frame count, and Reference-image fields MUST
each have placeholder text and/or a help-icon tooltip.
- **Source:** `@CommanderStorm`'s review of PR #5954 ("do these have a
  typical format? if yes, could you add a placeholder or helptext?").
- **Acceptance:** every input field exposes either `placeholder=` or a
  sibling tooltip element.

#### UI-003 — Reference-image upload preview
**Should.** **PROPOSED.**
The reference-image upload UI SHOULD show a thumbnail of the uploaded
or URL-fetched reference, plus the resolution and byte-size, so the
user can verify the right image was attached.
- **Source:** Standard UX hygiene.
- **Acceptance:** uploading a 1920×1080 JPEG renders a thumbnail and
  displays "1920×1080 — 187 KB."

#### UI-004 — Reference resampling on upload
**Must.** **PROPOSED.**
On upload, reference images MUST be re-encoded server-side to a
canonical form (max 640 px on the long edge, JPEG quality 85, EXIF
stripped) before storage, to bound BLOB size and remove privacy
metadata.
- **Source:** Storage-budget hygiene; security hygiene.
- **Acceptance:** a 4K reference uploaded ends up ≤ 80 KB in the BLOB
  column; EXIF/GPS tags are absent.

#### UI-005 — Mode warning when prerequisites missing
**Must.** **PROPOSED.**
If Enhanced or Full is selected but the underlying decode stack
(FFmpeg / `node-av` — see
**[08-open-questions.md](./08-open-questions.md)** §3) is not
available, the form MUST display a non-blocking warning AND the saved
monitor MUST report DOWN with a clear `"Enhanced mode requires FFmpeg,
not detected"` message rather than crashing.
- **Source:** "virtually impossible to fail for any reason at any
  point."
- **Acceptance:** unit test removes FFmpeg from PATH and verifies the
  monitor's check method returns a precise error message.

#### UI-006 — Translation keys fully qualified
**Must.** **PROPOSED.**
Every new translatable string in `src/lang/en.json` MUST include the
"RTSP" or "Stream" prefix in the key. Generic keys like `"Username"`
or `"Path"` MUST NOT be added.
- **Source:** `@CommanderStorm`'s explicit policy on PR #5954 (and the
  caveat that the MQTT precedent was a mistake).
- **Acceptance:** lint pass shows new keys are all of the form
  `"RTSP <Field>"` or `"Stream <Field>"`.

### A.6 Operations

#### OP-001 — Decode stack auto-detect
**Must.** **PROPOSED.**
At server startup, detect the available decode stack: (a) bundled
binary (Docker image), (b) system FFmpeg on `PATH`, (c) `node-av` (if
chosen). Cache the result. Surface it via a `/api/health` debug field.
- **Source:** User-selected ffmpeg strategy ("Both: bundle in Docker
  AND prefer system ffmpeg if present").
- **Acceptance:** unit tests cover all three detection branches.

#### OP-002 — Decode stack precedence
**Must.** **PROPOSED.**
Resolution order MUST be: (1) explicit `FFMPEG_PATH` env var if set,
(2) system FFmpeg on `PATH`, (3) bundled binary (Docker image only).
Logged once at startup at INFO level.
- **Source:** Per user clarifying-question answer.
- **Acceptance:** test that sets `FFMPEG_PATH` to a fake binary
  observes that path used.

#### OP-003 — Subprocess hard-kill backstop
**Must.** **PROPOSED.**
Every FFmpeg subprocess MUST be wrapped in a wall-clock timeout. SIGTERM
at the budget; SIGKILL at budget + 5 s. The subprocess MUST be reaped
even if Node receives an exception during the await.
- **Source:** Defensive design; the existing bash script's hang-prone
  invocation is the cautionary tale (see
  **[07-script-analysis.md](./07-script-analysis.md)**).
- **Acceptance:** a fixture that hangs FFmpeg on stdin produces no
  zombie children after 30 s.

#### OP-004 — No temp-file usage
**Must.** **REQUIRED-BY-BRIEF.**
Frame capture MUST use stdout pipes / `node-av` buffers; no
`fs.writeFile`, no `mkdtemp`, no temp directory at runtime.
*Exception:* reference images uploaded via the UI may be transiently
written to handle multipart parsing if Express's body parser requires
it; that one write occurs at upload time, not at check time.
- **Source:** Brief: *"ideally no storage (even temporary) written to
  at any point."*
- **Acceptance:** a strace-equivalent test of a check produces zero
  `open` syscalls under the data directory.

#### OP-005 — Fingerprint cache
**Should.** **PROPOSED.**
Reference-image fingerprints SHOULD be computed once at upload (or
URL-fetch) and cached in a column on the monitor row, so each check
only fingerprints the live frame.
- **Source:** Efficiency budget.
- **Acceptance:** a 1-minute interval Full-mode monitor's average
  per-check CPU is dominated by FFmpeg, not by `sharp`.

#### OP-006 — URL-reference fetch hardening
**Must.** **PROPOSED.**
URL-sourced references MUST be: (a) fetched only over HTTP/HTTPS, (b)
SSRF-guarded against RFC 1918 / loopback / link-local addresses *unless*
the monitor's host itself targets such a range, (c) capped at 10 MB
download, (d) re-validated and re-resampled before fingerprinting.
- **Source:** Defensive design; standard SSRF protection.
- **Acceptance:** a URL pointing to `http://169.254.169.254/...` is
  rejected unless the monitored RTSP host is also link-local.

---

## B. Non-functional requirements

### B.1 Performance

#### NFR-001 — Basic-mode budget
**Must.** **PROPOSED.**
Basic-mode CHECK function MUST complete in < 1 s under nominal network
(< 100 ms RTT) and < 11 s under timeout (10 s default + 1 s overhead).
- **Acceptance:** integration test against a local RTSP fixture
  measures median check latency < 200 ms.

#### NFR-002 — Enhanced/Full-mode budget
**Must.** **PROPOSED.**
Enhanced and Full mode CHECK functions MUST complete in ≤ user-
configured wall-clock budget (default 10 s, max 30 s) plus 5 s of
hard-kill grace.
- **Acceptance:** a fixture that emits exactly 5 frames at 1 fps
  finishes in ≤ 6 s; one that hangs is killed by 16 s.

#### NFR-003 — Memory budget per check
**Should.** **PROPOSED.**
Enhanced/Full mode SHOULD peak at ≤ 50 MB RSS *increase* per check,
including the FFmpeg subprocess.
- **Acceptance:** observed against a 1080p H.264 fixture; documented
  in the test plan.

#### NFR-004 — Concurrency cap
**Must.** **PROPOSED.**
The number of concurrently-active Enhanced/Full mode checks across all
monitors MUST be capped (default 4, configurable via env var). Excess
checks queue with a sane wait-then-skip policy.
- **Source:** Resource hygiene; prevents N-camera deployments from
  saturating a small VPS.
- **Acceptance:** test runs 20 monitors concurrently, observes never
  more than 4 FFmpeg processes alive at once.

#### NFR-005 — Reference-fingerprint reuse
**Must.** Implements OP-005 above.
- **Acceptance:** identical to OP-005.

### B.2 Reliability

#### NFR-010 — Graceful degradation
**Must.** **REQUIRED-BY-BRIEF (interpretation of "virtually impossible to
fail").**
Every plausible failure mode MUST be caught and reported as a
heartbeat with a precise message. The check function MUST NOT throw
unhandled exceptions. The monitor type MUST NOT crash the server
process.
- **Acceptance:** fault-injection test (DNS failure, connection
  refused, RST mid-handshake, FFmpeg crash, FFmpeg timeout, malformed
  reference image, missing reference image, oversized reference, etc.)
  produces a deterministic DOWN with a unique message for each case.

#### NFR-011 — No silent failures
**Must.** **PROPOSED.**
A check MUST NOT report UP unless the verification appropriate to the
selected mode actually completed. Specifically: if FFmpeg exits 0 but
zero frames were captured, that is DOWN, not UP.
- **Acceptance:** fixture that exits 0 with zero stdout produces DOWN.

#### NFR-012 — Idempotent state
**Must.** **PROPOSED.**
Running the check function twice in immediate succession against the
same monitor MUST produce the same result (modulo network jitter) and
leave no state on disk that affects subsequent calls.
- **Acceptance:** sequential calls on a local fixture produce identical
  heartbeat structures (apart from `time` and `ping`).

#### NFR-013 — No zombie subprocesses
**Must.** Implements OP-003.
- **Acceptance:** identical to OP-003.

#### NFR-014 — Per-monitor mutex
**Must.** **PROPOSED.**
A given monitor MUST NOT have two checks executing concurrently.
- **Acceptance:** rapidly toggling check intervals does not produce
  parallel FFmpeg processes for the same monitor.

### B.3 Security

#### NFR-020 — Secret handling
**Must.** **PROPOSED.**
Username and password MUST be redacted from log output, heartbeat
messages, and the `response` debug field. URL fields displayed in
heartbeats MUST have any embedded `user:pass@` portion stripped.
- **Acceptance:** unit test asserts `password` never appears in any
  heartbeat or log line.

#### NFR-021 — TLS by default
**Must.** **PROPOSED.**
Certificate validation for RTSPS and RTMPS MUST be ON by default. The
toggle to disable validation MUST require a per-monitor opt-in and
MUST display a warning icon in the monitor list when disabled.
- **Source:** Standard security posture.
- **Acceptance:** monitor saved without explicit override has
  `tls_verify = 1`.

#### NFR-022 — SSRF protection on URL references
**Must.** Implements OP-006.

#### NFR-023 — Reference-image content trust
**Must.** **PROPOSED.**
Uploaded reference images MUST be re-decoded and re-encoded by `sharp`
before storage. The original bytes MUST NOT be stored. This sanitises
malformed or adversarial JPEGs that might exploit downstream decoders.
- **Acceptance:** reference BLOB column never contains EXIF metadata or
  malformed JPEG markers.

### B.4 Maintainability

#### NFR-030 — Coding standards
**Must.** **REQUIRED-BY-BRIEF.**
All code MUST pass `npm run lint` and `npm run lint:prettier`. JSDoc
comments MUST accompany every exported function and every method on
the monitor type class, matching the existing pattern in
`server/monitor-types/monitor-type.js:23-35`.
- **Acceptance:** CI workflow lint job is green.

#### NFR-031 — Test coverage
**Must.** **REQUIRED-BY-BRIEF (CommanderStorm pattern).**
Every monitor type method MUST have unit tests in
`test/backend-test/test-rtsp.js`, covering at minimum: protocol-success,
connection-failure, timeout, malformed-response, vendor-quirk-401,
non-RTSP-on-port, frozen-frame (Enhanced), black-frame (Enhanced),
match-success (Full), match-fail (Full), match-day (Full), match-night
(Full).
- **Source:** Brief; CommanderStorm's review pattern.
- **Acceptance:** the test list is implemented and passes.

#### NFR-032 — Mocked network in tests
**Must.** **PROPOSED.**
Tests MUST NOT require a real RTSP/RTMP server. Network fixtures use
in-process stubs.
- **Acceptance:** the test suite runs in CI without a media server
  side-car.

#### NFR-033 — Migration discipline
**Must.** **PROPOSED.**
DB migrations MUST be additive only (`alterTable` adding columns; no
column drops). They MUST be named per the existing
`db/knex_migrations/` convention and pass
`extra/check-knex-filenames.mjs`.
- **Acceptance:** lint script passes.

#### NFR-034 — Minimal new dependencies
**Must.** **REQUIRED-BY-BRIEF.**
The implementation MAY add at most: (a) one image-processing library
(sharp recommended; jimp acceptable if a no-native-dep rule applies),
(b) zero or one decoding stack (FFmpeg subprocess vs `node-av` —
exactly one chosen, see
**[08-open-questions.md](./08-open-questions.md)** §3). No other new
top-level dependencies.
- **Acceptance:** `git diff package.json` shows ≤ 2 new entries in
  `dependencies`, none in `devDependencies` beyond test fixtures.

### B.5 Observability

#### NFR-040 — Structured heartbeat messages
**Must.** **PROPOSED.**
Heartbeat `msg` text MUST be predictable and pattern-matchable so users
can build alert rules around them. Documented patterns:
- `"RTSP OPTIONS reply: %d"` (Basic UP)
- `"server did not speak %s"` (Basic DOWN, %s = RTSP|RTMP)
- `"connection refused"` / `"connection timeout"` / `"DNS failure: %s"`
- `"captured %d/%d frames in %dms"` (Enhanced UP)
- `"frozen: %d identical frames"` (Enhanced DOWN)
- `"black or uniform frame"` (Enhanced DOWN)
- `"matched %s at distance %d/64"` (Full UP, %s = Day|Night|reference)
- `"scene mismatch: distance %d > threshold %d"` (Full DOWN)
- `"FFmpeg exit %d: %s"` (decode-stack failure)
- `"timed out after %dms"` (any mode)
- **Acceptance:** the test suite lists each pattern as an expected
  message format.

#### NFR-041 — Verbose-mode debug capture
**Should.** **PROPOSED.**
A per-monitor "verbose" debug toggle SHOULD store the last raw
response (Basic) or last frame summary (Enhanced/Full) in the
`response` column for the most recent heartbeat only. Capped at 4 KB.
- **Acceptance:** toggle on, last heartbeat includes structured
  debug; toggle off, column is NULL.

### B.6 Process / governance

#### NFR-050 — AGENTS.md compliance for any upstream PR
**Must (if upstream-targeted).** **PROPOSED.**
Any subset of this work proposed upstream MUST be authored, tested,
and described by the human. This document set is planning material and
does not itself violate the policy; subsequent code work must.
- **Source:** `AGENTS.md` lines 1-12.
- **Acceptance:** when a PR is opened upstream, the description and
  test results are produced by the human; commit messages reflect
  human authorship.

#### NFR-051 — Scope-split readiness
**Should.** **PROPOSED.**
The implementation SHOULD be structured so Basic mode is independently
extractable (separate file, no Enhanced/Full imports), so a Basic-only
upstream PR is mechanically a subset of the fork's work.
- **Source:** `@CommanderStorm`'s "splitting keeps it maintainable"
  guidance.
- **Acceptance:** removing Enhanced and Full implementation files
  leaves a buildable, test-passing monitor type that supports Basic.

---

## C. Won't-have list (explicit rejections)

| Won't | Rationale |
|---|---|
| RTSP control over UDP (raw, non-RTP) | No vendor support; see **[02-protocol-coverage.md](./02-protocol-coverage.md)** §3.1 |
| RTSP over DTLS | Not a real protocol; see FR-025 |
| RTMP over UDP | Not a real protocol; see FR-026 |
| HLS / DASH / WebRTC / ONVIF / SRT / NDI | Out of scope; future work |
| Recording / replay | Not a monitor's job |
| Scene classification ML | Not a monitor's job |
| `pixelmatch`-style strict diff | Wrong tool — too sensitive to camera artefacts. See **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** §3 |

---

## D. Notes for the adversarial reviewer

- Every requirement above either implements an item from your original
  brief or adds protective scaffolding. Where I'm proposing a deviation
  (FR-025, FR-026, FR-031, FR-032), the rationale is in
  **[08-open-questions.md](./08-open-questions.md)** so you can attack
  the reasoning directly.
- Acceptance criteria are written so a green CI run can mechanically
  prove or disprove most items. The few that are subjective (UI
  parity, help-text quality) are flagged as such.
- Two-way traceability is provided in
  **[09-traceability-matrix.md](./09-traceability-matrix.md)** — verify
  there that nothing in your original prompt was silently dropped.
