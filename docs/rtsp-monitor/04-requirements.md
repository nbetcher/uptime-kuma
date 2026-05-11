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
Basic mode MUST treat RTSP responses with status 2xx, 401, 403, 404,
405 as UP. It MUST treat status 3xx as UP-with-warning (redirect from
an RTSP server still proves liveness). It MUST treat status 5xx as
UP-with-warning. It MUST require the leading `RTSP/` prefix on the
response.
- **Source:** Brief: *"with variance allowed for known quirks of some
  very popular vendors."*
- **Acceptance:** unit fixtures for Hikvision-401, Dahua-401-with-spaces,
  a generic-3xx, and a generic-5xx all produce the expected status
  and message.

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
Enhanced mode SHOULD reject frames whose mean luminance is below 5
*and* standard deviation is below 2 (on a 0–255 raw scale) across a
32×32 greyscale downsample of the last frame.
- **Source:** Enhances FR-013 to also catch sensor-fault / lens-cap.
- **Acceptance:** a fixture that emits 5 different solid-black frames
  produces DOWN with `"black or uniform"`.

#### FR-015 — Full mode behaviour
**Must.** **REQUIRED-BY-BRIEF.**
Full mode MUST capture exactly one frame and compare it (via the
fingerprinting strategy in
**[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)**)
against user-supplied reference image(s). If frame capture fails
(connection refused, timeout, or decode error), Full mode produces DOWN
with the capture-failure reason. Full mode does NOT run Enhanced's
multi-frame frozen/black-frame heuristics; the fingerprint comparison
is the sole pass/fail signal.
- **Source:** Brief.
- **Acceptance:** a fixture frame within Hamming distance ≤ threshold of
  the reference produces UP; outside it produces DOWN.

#### FR-016 — Full mode does NOT run Enhanced heuristics
**Should.** **PROPOSED.**
Full mode SHALL skip Enhanced's multi-frame frozen-frame detection and
multi-frame black/uniform detection. The fingerprint comparison result
is the sole pass/fail signal once a single frame is captured.
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
a BLOB on the monitor row) or supply a URL that is fetched at upload
time and cached as a BLOB. The two sources are exclusive per slot.
- **Source:** Brief, user-confirmed in clarifying questions ("BLOB *and*
  URL").
- **Acceptance:** uploading produces a row with `reference_day_blob`
  populated; choosing URL fetches once and populates the same BLOB plus
  `reference_day_url`; runtime checks ALWAYS use the cached BLOB, never
  fetch the URL.

#### FR-019b — Reference required at save time for Full mode
**Must.** **PROPOSED.** Resolves Q5(a).
Saving a monitor in Full mode MUST fail UI validation if no reference is
configured. Specifically: at least one reference (Day or single) MUST be
present; if "Separate Day/Night" is enabled (default), BOTH Day and
Night MUST be present.
- **Source:** User decision on Q5(a).
- **Acceptance:** form submission with Full mode and no reference
  produces a validation error and does not save the monitor.

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

#### FR-026 — RTMP over UDP
**Won't.** **PUSHBACK (accepted).**
RTMP is TCP-only by specification.
- **Source:** Pushback resolved in
  **[08-open-questions.md](./08-open-questions.md)** decisions log.
- **Acceptance:** no UDP code paths exist for RTMP.

### A.4 Authentication

#### FR-030 — RTSP authentication
**Must.** **PROPOSED.**
The monitor MUST support both Basic and Digest authentication for RTSP.
For Basic mode, an authentication challenge (401 with
`WWW-Authenticate`) counts as UP without retrying with credentials. For
Enhanced/Full, the credentials (if supplied) MUST be passed to the
underlying decode stack (`node-av` AVDictionary options).
- **Source:** Vendor quirk research; HTTP-monitor parity.
- **Acceptance:** unit tests cover (a) anonymous OPTIONS → 401 → UP for
  Basic; (b) credentialed OPTIONS → 200 → UP for Basic; (c) Enhanced
  with credentials supplied via the form fields succeeds. If both URL
  credentials (`rtsp://user:pass@host/path`) and form credentials are
  set simultaneously, the form fields win and a non-blocking UI warning
  is shown — validated by a unit test and a UI smoke test.

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

### A.4b Codec coverage

#### FR-035 — Common codec support
**Must.** **PROPOSED.** Resolves Q4.
The monitor MUST decode H.264, H.265 (HEVC), and AV1 streams via the
chosen decode stack (`node-av`). No explicit codec filter is applied;
whatever the stack supports, the monitor supports.
- **Acceptance:** unit fixtures (or staged integration tests) cover at
  minimum H.264 and H.265 RTSP streams.

### A.5 UI / UX

#### UI-001 — Visual style parity
**Must.** **REQUIRED-BY-BRIEF.**
All form fields, validation messages, and error toasts MUST match
existing Uptime Kuma monitor types in style and structure. The Vue
template MUST follow the same `v-if="monitor.type === '...'"` pattern
used throughout `EditMonitor.vue`.
- **Source:** Brief.
- **Acceptance:** (a) the new monitor section uses the same Bootstrap
  grid classes and field-group structure visible in the HTTP-keyword
  section of `EditMonitor.vue`; (b) no custom CSS is introduced — only
  Uptime Kuma's existing utility classes; (c) every field that carries
  a tooltip uses the same `question-icon`/`<font-awesome>` pattern
  visible in the existing monitor fields.

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

#### UI-005 — Decode-stack failure surfaces clearly
**Must.** **PROPOSED.**
If `node-av` fails to load at server startup (e.g., the prebuilt
binary for the platform is missing and source-build also failed), the
RTSP monitor type MUST register itself in a degraded state:
- The monitor type still appears in the dropdown.
- Saving any monitor of this type produces a clear server-side error.
- Existing monitors of this type produce DOWN heartbeats with the
  message `"node-av failed to load — RTSP monitoring unavailable"`.
- The server MUST NOT crash on startup because of this failure.
- **Source:** "virtually impossible to fail for any reason at any
  point."
- **Acceptance:** unit test simulates a `node-av` import failure and
  verifies the server starts cleanly, the monitor type is registered,
  and existing monitors report the precise error message.

#### UI-007 — Warn when URL contains `?rtsp_transport=`
**Must.** **PROPOSED.** Resolves Q11.c.
If the user-entered URL contains a `?rtsp_transport=` query parameter,
the form MUST display a non-blocking warning beneath the URL field
indicating that transport is configured by the dedicated UI option, and
the URL parameter will be ignored.
- **Acceptance:** entering
  `rtsp://host/path?rtsp_transport=tcp` shows a warning chip; saved
  monitor's transport is the form's selected value.

#### UI-008 — Tooltip clarifying "RTSP/UDP" semantics
**Must.** **PROPOSED.**
The transport selector's "RTSP/UDP" option MUST display a `?` tooltip
(matching the existing Uptime Kuma tooltip pattern) clarifying that
this means RTSP control over TCP with RTP media over UDP — not
RTSP-control-over-UDP, which is unsupported.
- **Source:** User decision on the protocol-naming clarification.
- **Acceptance:** the tooltip text reads, in substance: "RTSP control
  is always over TCP; this option uses UDP for the actual RTP video
  packets, which is the form most cameras call 'UDP transport.'"

#### UI-009 — Path field tooltip with vendor examples
**Must.** **PROPOSED.** Resolves Q11.a.
The Path field MUST expose vendor-specific RTSP-path conventions for
the five most popular homelab/consumer camera vendors as inline help
(tooltip or expanded help block, whichever Uptime Kuma's pattern is for
larger inline help). Concise but clear.
- **Source:** User decision on Q11.a.
- **Suggested content** (subject to verification at HLD time, since
  vendor URLs change with firmware):
  - **Hikvision:** `/Streaming/Channels/101` (main) or `/102` (sub)
  - **Dahua / Amcrest:** `/cam/realmonitor?channel=1&subtype=0` (main),
    `subtype=1` (sub)
  - **Reolink:** `/h264Preview_01_main` or `/h264Preview_01_sub`
  - **Axis:** `/axis-media/media.amp`
  - **Unifi:** `/<random-token>` (assigned by the controller per camera)
  - **Note line:** "Consult your camera's documentation; paths vary by
    firmware version."
- **Acceptance:** the help element exists and contains the five
  vendor entries above; the entries pass a basic smoke check at HLD
  time against current vendor docs.

#### UI-010 — "Test" button on the edit form
**Must.** **PROPOSED.** Resolves Q12.f.
The edit form MUST include a one-shot probe button that runs the
selected mode's check against the entered configuration and reports
the result in-line. The button label MUST match Uptime Kuma's existing
verbiage for similar affordances (research at HLD time; if there's no
existing precedent, "Test" is the proposed label).
- **Source:** User decision on Q12.f.
- **Acceptance:** clicking the button against a working stream
  produces an UP-style result panel; against an unreachable stream
  produces the same DOWN-style message format that the heartbeat
  would.

#### UI-011 — Test button reports keyframe interval
**Should.** **PROPOSED.** Resolves Q12.a.
When Enhanced or Full mode is selected, the Test button SHOULD measure
the I-frame (keyframe) interval of the stream and warn the user if
the interval exceeds half the configured monitor `interval`. A camera
with a 10-second keyframe interval on a 5-second monitor interval will
intermittently fail because the first keyframe may arrive after the
wall-clock budget expires.
- **Source:** User decision on Q12.a.
- **Acceptance:** Test against a fixture with a 10-second keyframe
  interval and a 5-second monitor interval emits a "keyframe interval
  is longer than half your monitor interval" warning.

#### UI-012 — Lazy-load reference BLOBs in the edit form
**Must.** **PROPOSED.** Resolves Q7.
Reference image BLOBs MUST NOT be included in the default
WebSocket-serialised monitor object. Instead, the monitor JSON
includes boolean `referenceDayHasBlob` / `referenceNightHasBlob`
flags, and the edit form fetches the BLOB(s) on demand from a
dedicated endpoint (`GET /api/monitor/:id/reference/:slot`) when the
Reference Images section is opened.
- **Source:** User decision on Q7.
- **Acceptance:** initial monitor list payload size is unchanged
  whether references are configured or not; opening the references
  section issues an HTTP GET that returns the BLOB.

#### UI-013 — Status-page thumbnail of last matching frame
**Should.** **PROPOSED.** Resolves Q12.g (first half), default off.
Full-mode monitors MAY surface a thumbnail of the most recent matching
frame on status pages. This is OFF by default and per-monitor opt-in
to respect privacy; when enabled, the thumbnail is derived from the
last UP-result captured frame, re-resampled to a status-page-sized
JPEG and stored alongside the monitor's last-match data.
- **Source:** User decision on Q12.g.
- **Acceptance:** toggle on, status-page rendering shows a recent
  thumbnail; toggle off, no image surfaces.

#### UI-014 — Status-page thumbnails of last 5 DOWN frames
**Should.** **PROPOSED.** Resolves Q12.g (second half), default off.
When status-page thumbnails are enabled, the monitor's incident-detail
view MAY surface up to the **5 most recent DOWN frames** captured by
the monitor. Storage is bounded by a small dedicated table:
`monitor_rtsp_down_image (id PK, monitor_id FK, captured_at, image_blob)`.
On every DOWN heartbeat that successfully captured a frame, INSERT a
row, then DELETE rows for that monitor where the `captured_at` is
older than the 5th most recent — atomic, no daemon, no cron. Storage
ceiling: ~5 × ~80 KB = ~400 KB per monitor.
- **Source:** User decision on Q12.g extension.
- **Implementation note:** if at HLD time the small-table pattern
  doesn't fit cleanly with Uptime Kuma's existing patterns (no
  precedent for similar bounded-history tables), the entire feature
  — including UI-013 thumbnails and image storage — is dropped per
  the user's contingency, and a TODO is logged for the future
  webhook-based alternative (see UI-015).
- **Acceptance:** running 6 successive DOWN checks results in exactly
  5 rows in the new table for that monitor.

#### UI-015 — Future webhook outputs (documented, not implemented)
**Won't (this work).** **PROPOSED future-work docket.** Resolves Q12.h.
Documented for a future sprint; NOT implemented in this work:
- Webhook on Full-mode distance climbing toward threshold (early
  warning).
- Webhook POST of periodic UP-mode frames (configurable interval) and
  every DOWN-mode frame to a user-specified URL, so images need not
  be stored in Uptime Kuma's database at all. Replaces UI-013/UI-014
  for users who'd rather externalise image retention.
- **Source:** User decision on Q12.h.
- **Acceptance:** an entry exists in the future-work docket.

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

#### OP-001 — `node-av` is the decode stack
**Must.** **PROPOSED.** Resolves Q3 (and supersedes earlier
draft of OP-001 / OP-002 about FFmpeg subprocess detection).
The implementation MUST use `node-av` (`seydx/node-av`) as the in-process
decode stack. No system FFmpeg detection, no PATH search, no subprocess
spawn. `node-av` ships prebuilt binaries via npm optional-deps for
Linux x64/arm64, macOS x64/arm64, and Windows x64/arm64.

**Platform gap — arm/v7 and musl:** `node-av` does NOT currently ship
prebuilds for `linux/arm/v7` (armv7l) or musl (Alpine). Uptime Kuma's
official Docker builds include `linux/arm/v7`. On platforms where no
prebuild is available and source-build also fails, the monitor MUST
degrade gracefully per UI-005: Enhanced and Full modes are unavailable
but Basic mode still works (it does not use `node-av`). See OP-002 for
the `FrameSource` interface that makes this substitution localised.
- **Source:** User decision on Q3, aligning with `@louislam`'s recommendation
  on PR #5822.
- **Acceptance:** `package.json` adds `node-av` as a dependency; no
  `child_process.spawn("ffmpeg")` exists in the new code; simulated
  `node-av` load failure leaves Basic mode functional.

#### OP-002 — Implementation factored behind a `FrameSource` interface
**Should.** **PROPOSED.**
The decode-source code MUST be wrapped behind a small internal
interface (proposed: `FrameSource.open(url, opts)`,
`FrameSource.next()`, `FrameSource.close()`) so a future replacement
(e.g., a subprocess fallback for an edge platform `node-av` cannot
prebuild for) is a localised change. The default and only initial
implementation is `NodeAvFrameSource`.
- **Acceptance:** the interface and its single implementation are
  separately testable; substitute implementations in tests use a stub
  that emits canned JPEGs.

#### OP-003 — Decode session hard-stop
**Must.** **PROPOSED.**
Every `node-av` decode session MUST be wrapped in a Promise that
rejects at wall-clock budget. On rejection, the session is closed and
all libav resources released in a `finally`. The implementation MUST
ensure no Node-side handles or libav contexts leak across check
invocations.
- **Source:** Defensive design.
- **Acceptance:** stress test of 1,000 sequential checks against a
  hung fixture results in stable RSS (no leak) and zero orphaned
  decode sessions.

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
  per-check CPU is dominated by libav decode, not by `sharp`.

#### OP-007 — Audit log of reference upload/refresh
**Must.** **PROPOSED.** Resolves Q12.e.
Every reference-image upload (BLOB or URL) and every URL "Refresh"
action MUST be recorded with at minimum: monitor id, slot (Day /
Night / single), source (upload / url-fetch), byte size, sha-256 of
canonical bytes, originating user (if Uptime Kuma's auth context
provides one), timestamp. Stored in a small audit table aligned with
Uptime Kuma's existing audit/log patterns (or in
`monitor.notification_id_list`-style metadata if no audit subsystem
exists — to be confirmed at HLD time).
- **Source:** User decision on Q12.e.
- **Acceptance:** uploading and then refreshing a reference produces
  two audit records visible to the user.

#### OP-008 — Bounded DOWN-image storage cleanup
**Must (if UI-014 is kept).** **PROPOSED.**
The cleanup of older-than-5 DOWN images for a monitor MUST run inside
the same SQL transaction as the INSERT, so the table size never
exceeds 5 entries per monitor at any commit boundary. No daemon, no
cron.
- **Source:** User concern about cleanup; resolved by inline DELETE.
- **Acceptance:** concurrent INSERTs against the same monitor (forced
  via test) never produce a > 5-row state.

#### OP-006 — URL-reference fetch hardening
**Must.** **PROPOSED.**
URL-sourced references MUST be fetched with the following safeguards:

(a) **Protocol:** HTTP/HTTPS only.

(b) **SSRF — IP blocklist:** reject resolved IPs in RFC 1918 ranges
(10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), loopback (127.0.0.0/8,
::1), and link-local ranges (169.254.0.0/16, fe80::/10) UNLESS the
monitor's own target host resolves to an address in the same /8 subnet
(i.e., the monitored camera is demonstrably on a private network). The
subnet comparison MUST use the resolved IP, not the hostname, to prevent
DNS rebinding: the IP is resolved once, checked against the blocklist,
and then used directly for the connection (no second resolution).

(c) **No redirects:** the fetch MUST NOT follow HTTP redirects. A
redirect response is treated as an error. This prevents redirect-based
SSRF bypasses.

(d) **Content-type enforcement:** the `Content-Type` response header
MUST begin with `image/` before the response body is consumed. If the
content type does not match, the connection is closed without reading
the body.

(e) **Download cap:** the response body is capped at 10 MB. The cap is
enforced *during streaming* (bytes-received counter, abort on exceed),
not as a post-download check.

(f) **Re-validation:** the fetched bytes are re-decoded and re-encoded
by `sharp` before fingerprinting and storage, sanitising any
adversarial or malformed content.
- **Source:** Defensive design; standard SSRF protection.
- **Acceptance:** (i) a URL pointing to `http://169.254.169.254/...`
  (AWS metadata) is rejected; (ii) `http://127.0.0.1/secret` is
  rejected; (iii) `http://192.168.1.100/cam.jpg` is rejected unless
  the monitor target is also in 192.168.1.0/24; (iv) a URL that
  redirects to an otherwise-allowed image is rejected; (v) a URL
  with `Content-Type: text/html` is rejected before body bytes are
  read; (vi) a URL serving a >10 MB body is aborted mid-stream.

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
**Must.** **PROPOSED.** Resolves Q11.b (wall-clock).
Enhanced and Full mode CHECK functions MUST complete within a
wall-clock budget that scales with the monitor's `interval`:
`budget = clamp(interval / 3, 5, 30)` seconds. Per-monitor override
permitted in the form. Hard-stop applied at `budget` (not `budget + 5`,
since `node-av` cleanup is in-process and bounded).
- **Source:** User decision on Q11.b.
- **Acceptance:** a fixture that emits exactly 5 frames at 1 fps on a
  60-second-interval monitor finishes in ≤ 6 s; one that hangs is
  hard-stopped at the 20-second budget.

#### NFR-003 — Memory budget per check
**Should.** **PROPOSED.**
Enhanced/Full mode SHOULD peak at ≤ 50 MB RSS *increase* per check,
including the libav decoder state held by `node-av`.
- **Acceptance:** observed against a 1080p H.264 fixture; documented
  in the test plan.

#### NFR-004 — Concurrency cap
**Must.** **PROPOSED.** Resolves Q9.
The number of concurrently-active Enhanced/Full mode checks across all
monitors MUST be capped at `max(2, min(4, floor(os.cpus().length / 2)))`
by default, with a `RTSP_CONCURRENCY` env var override. If a check
cannot acquire a concurrency token within its configured timeout, the
check is **skipped** (no heartbeat is written; the event is logged at
warn level). This prevents false DOWN alerts from transient resource
saturation.
- **Source:** Resource hygiene; user decision on Q9.
- **Acceptance:** (a) test runs 20 monitors concurrently on a 2-core
  machine, observes never more than 2 active decode sessions at once;
  (b) on an 8-core machine, never more than 4; (c) a check that cannot
  acquire a token within timeout produces no heartbeat and a log line
  matching `"RTSP check skipped: concurrency limit"`.

#### NFR-005 — Reference-fingerprint reuse
**Must.** Implements OP-005 above.
- **Acceptance:** identical to OP-005.

### B.2 Reliability

#### NFR-010 — Graceful degradation
**Must.** **REQUIRED-BY-BRIEF (interpretation of "virtually impossible to
fail").**
Every plausible failure mode MUST be caught and reported as a DOWN
heartbeat with a precise message. The check function MUST follow
Uptime Kuma's established monitor-type pattern: **throw a descriptive
`Error` on failure**; the server infrastructure in
`server/model/monitor.js` catches the throw and converts it to a DOWN
heartbeat. The monitor type MUST NOT crash the server process.
- **Acceptance:** fault-injection test (DNS failure, connection
  refused, RST mid-handshake, node-av crash, timeout, malformed
  reference image, missing reference image, oversized reference, etc.)
  produces a deterministic thrown Error with a unique message for each
  case, which the test harness catches and verifies maps to a DOWN.

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

#### NFR-031 — Comprehensive unit-test coverage
**Must.** **REQUIRED-BY-BRIEF (owner emphasis + CommanderStorm pattern).**
Every requirement in this document with measurable runtime behaviour
MUST have at least one corresponding unit test. The test files MUST
follow the existing `test/backend-test/` patterns (Node 20+ built-in
`test` module, `describe`/`test` structure as seen in
`test/backend-test/test-monitor-response.js`), MUST use the same
linting / formatting conventions, and MUST run as part of
`npm run test-backend` without modification to test infrastructure.
At minimum, the test suite covers:
- **Protocol coverage:** protocol-success for RTSP, RTSPS, RTMP, RTMPS
  each; connection-failure; timeout; malformed-response;
  vendor-quirk-401 (Hikvision); Dahua-spaced-realm; non-RTSP-on-port
  (HTTP-on-554); 3xx-with-warning; 5xx-with-warning.
- **Mode behaviour:** Basic-pass (each protocol); Enhanced-pass;
  Enhanced-frozen-frame; Enhanced-black-frame; Enhanced-only-1-of-5;
  Enhanced-zero-frames; Full-pass-Day; Full-pass-Night;
  Full-day-night-min-distance; Full-mismatch; Full-pre-flight-luminance
  short-circuit.
- **Validation:** missing-reference-rejected (FR-019b);
  URL-with-rtsp-transport-warns (UI-007); URL-credentials-and-form-
  credentials-both-set-shows-warning-and-form-wins; reference-resampled-on-upload (UI-004);
  reference-EXIF-stripped (NFR-023).
- **Security:** credential-redaction-in-logs (NFR-020);
  credential-redaction-in-heartbeat (NFR-020); SSRF-rejection-link-local
  (OP-006); SSRF-rejection-loopback (OP-006); SSRF-allows-private-when-
  monitored-host-is-private (OP-006); TLS-validation-on-by-default
  (NFR-021); TLS-validation-disabled-allows-self-signed.
- **Robustness:** decode-session-cleanup-on-timeout (OP-003);
  decode-session-cleanup-on-exception (OP-003); per-monitor-mutex
  (NFR-014); concurrency-cap-honoured (NFR-004);
  node-av-load-failure-graceful (UI-005).
- **Storage / lifecycle:** down-image-cleanup-bounds (OP-008);
  fingerprint-cache-populated-on-upload (OP-005); BLOB-excluded-from-
  default-monitor-JSON (UI-012); reference-audit-record-written (OP-007).
- **i18n:** every new key in `en.json` is referenced from at least one
  Vue template (mirrors `extra/check-lang-json.js`).
- Tests MUST mock the network using in-process stubs and MUST NOT
  require a live media server in CI.
- **Source:** Owner emphasis ("comprehensive unit tests that fall in
  line with Uptime Kuma's requirements and standards"); brief #17;
  `@CommanderStorm`'s review pattern.
- **Acceptance:** every REQ-ID with runtime behaviour traces to ≥ 1
  test; coverage report meets or exceeds the median of existing
  monitor types in `server/monitor-types/`; all tests pass under
  `npm run test-backend` and under `npm run test-backend-22`.

#### NFR-031b — Round-trip integration test (manual / staged)
**Should.** **PROPOSED.**
A documented manual / staged integration test SHOULD exercise the
monitor against real RTSP and RTMP servers (e.g., MediaMTX in a
sidecar Docker container) at least once before each PR merge. This is
NOT a CI requirement (CI tests are mocked per NFR-032) but documented
as a pre-merge gate in the PR description template.
- **Acceptance:** a runbook in this docs directory describes the
  staged test (added at HLD time).

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
The implementation MUST add exactly two new **direct (top-level)
production** dependencies: (a) `sharp` (image processing),
(b) `node-av` (in-process FFmpeg bindings). Transitive dependencies
pulled in by these two packages are expected and acceptable; the
"exactly two" constraint applies only to direct `dependencies` entries
in `package.json`.
- **Acceptance:** `git diff package.json` shows exactly 2 new entries
  in `dependencies`, none in `devDependencies` beyond test fixtures.

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
- `"matched %s at distance %d/128"` (Full UP, %s = Day|Night|reference)
- `"scene mismatch: distance %d > threshold %d"` (Full DOWN)
- `"decode failed: %s"` (decode-stack failure)
- `"timed out after %dms"` (any mode)
- **Acceptance:** the test suite lists each pattern as an expected
  message format.

#### NFR-041 — Debug capture via existing `save_response` infrastructure
**Should.** **PROPOSED.**
The RTSP monitor type MUST integrate with Uptime Kuma's existing
per-monitor `save_response` / `save_error_response` /
`response_max_length` columns on the `monitor` table. When
`save_response` is enabled, the `heartbeat.response` column is
populated with a structured debug summary:

- **Basic:** first 256 bytes of the raw RTSP response.
- **Enhanced:** per-frame summary (size in bytes, dimensions, xxHash).
- **Full:** per-frame summary + 128-bit fingerprint hex + threshold and
  Hamming distance.

This MUST NOT introduce a new "verbose" toggle or column. The existing
`response_max_length` cap (default 10,000 bytes) applies. When
`save_response` is off (the default), `heartbeat.response` is `NULL`.
- **Acceptance:** toggle `save_response = 1`, run a check, verify
  `heartbeat.response` contains structured JSON matching the above;
  toggle `save_response = 0`, verify `heartbeat.response` is NULL.

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
| RTMP over UDP | Not a real protocol; see FR-026 |
| HLS / DASH / WebRTC / ONVIF / SRT / NDI | Out of scope; future work |
| Recording / replay | Not a monitor's job |
| Scene classification ML | Not a monitor's job |
| `pixelmatch`-style strict diff | Wrong tool — too sensitive to camera artefacts. See **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** §3 |
| "Capture from current stream" reference button | Out of scope per fork-owner decision on Q11.d |
| H.264 keyframe-only decoding (`-skip_frame nokey`) | Withdrawn — would slow Enhanced down, not speed it up; see **[08-open-questions.md](./08-open-questions.md)** decisions log on Q12.b |

---

## D. Notes for the adversarial reviewer

- Every requirement above either implements an item from your original
  brief or adds protective scaffolding. Where I'm proposing a deviation
  (FR-026, FR-031, FR-032), the rationale is in
  **[08-open-questions.md](./08-open-questions.md)** decisions log so
  you can attack the reasoning directly.
- Acceptance criteria are written so a green CI run can mechanically
  prove or disprove most items. The few that are subjective (UI
  parity, help-text quality) are flagged as such.
- Two-way traceability is provided in
  **[09-traceability-matrix.md](./09-traceability-matrix.md)** — verify
  there that nothing in your original prompt was silently dropped.
