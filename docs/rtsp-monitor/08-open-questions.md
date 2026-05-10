# 08 — Decisions Log and Remaining Open Questions

This document evolves with each adversarial review pass. Items at the top
are resolved; items at the bottom are still open. New questions added in
later rounds preserve original numbering and append a sub-letter (e.g.,
Q9.b).

---

## Resolved decisions (round 1)

### Q1 — RTSP-over-DTLS — RESOLVED: dropped

The original brief asked us to plan for it; research confirmed it isn't
a real protocol. Owner accepted the pushback and asked that all mention
be removed from documentation as if never suggested. Done — references
purged from §01, §02, §04.

### Q2 — RTMP-over-UDP — RESOLVED: dropped (FR-026 Won't)

`[HIGH]` confidence: RTMP is TCP-only by specification. Owner accepted.

### Q3 — Decode stack: `node-av` chosen

`@louislam`'s recommendation. Removes the need for system FFmpeg
detection, PATH search, subprocess management, and zombie-process
defence. Encoded as **OP-001 / OP-002 / OP-003** in
**[04-requirements.md](./04-requirements.md)**. The wall-clock-budget
backstop is now in-process (Promise rejection) rather than SIGKILL.

### Q4 — HEVC / H.265 / AV1 codec coverage — RESOLVED: supported

Encoded as **FR-035**. `node-av` includes them; we don't filter.

### Q5 — Behaviour when reference image is missing in Full mode — RESOLVED: option (a)

Refuse to save. Encoded as **FR-019b**. UI validation rejects Full-mode
saves without at least the required references.

### Q6 — Three-PR scope split — RESOLVED: agreed

- **PR 1 (fork-only):** all three modes shipped together to
  `nbetcher/uptime-kuma`.
- **PR 2 (upstream):** Basic mode only.
- **PR 3 (upstream):** Enhanced mode.

Full mode is fork-specific. Branches will be created at implementation
time. **NFR-051** (scope-split readiness) is the architectural
constraint that makes PRs 2 and 3 mechanically extractable.

### Q7 — Reference BLOB storage and frontend serialisation — RESOLVED

- Storage: BLOB column on the monitor row (built-in Uptime Kuma
  database).
- Frontend: BLOB excluded from default monitor JSON; a dedicated
  endpoint serves the BLOB; the edit form fetches it lazily when the
  references section is opened.
- Encoded as **FR-019** (storage) and **UI-012** (lazy-load).
- Implementation note: at HLD time, confirm which "accordion or
  similar section" pattern Uptime Kuma's other monitor types use
  (`<details>` element, Bootstrap collapse, custom Vue component) and
  match it.

### Q8 — Minimum FFmpeg version — RESOLVED: superseded

Originally framed for FFmpeg-subprocess scenarios. With `node-av`, the
bundled libav version is whatever `node-av`'s prebuilds ship with —
currently FFmpeg 6.x — so the "≥ 5.0" floor is automatically met. No
explicit user-facing version requirement.

### Q9 — Concurrency cap — RESOLVED: scaled by CPU count

Default: `max(2, min(4, floor(os.cpus().length / 2)))`. Override via
`RTSP_CONCURRENCY` env var. Encoded as **NFR-004**.

### Q10 — "RTSP and RTMP over TCP and UDP" semantics — RESOLVED

- RTSP/TCP: RTSP control on TCP/554, RTP media on TCP-interleaved.
- RTSP/UDP: RTSP control on TCP/554, RTP media on UDP. Tooltip
  clarifies the actual semantics — encoded as **UI-008**. UI label
  stays compact.
- RTMP/TCP: standard.
- RTMP/UDP: dropped (FR-026).

### Q11.a — Path field tooltip — RESOLVED with vendor list

Encoded as **UI-009**. Five-vendor list (Hikvision, Dahua/Amcrest,
Reolink, Axis, Unifi) with concise path examples. Larger inline help
block if Uptime Kuma has a precedent for that pattern.

### Q11.b — Default thresholds — RESOLVED

- **Wall-clock budget:** scales with monitor `interval`:
  `clamp(interval / 3, 5, 30)` seconds. Encoded as **NFR-002**.
- **Frame count for Enhanced:** 5 frames default. Already in **FR-013**.
- **Match distance for Full:** 24 / 128. The "what does this mean"
  question is answered with a calibration table now in
  **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** §4.

### Q11.c — `?rtsp_transport=` URL parameter — RESOLVED: warning

If the URL contains `?rtsp_transport=`, a non-blocking warning appears
beneath the field. The dedicated transport selector is canonical.
Encoded as **UI-007**.

### Q11.d — "Capture from current stream" reference button — RESOLVED: dropped

Out of scope. References are uploaded or URL-fetched only. The doc
references to this button have been removed.

### Q12.a — I-frame interval check on Test button — RESOLVED: yes

The Test button measures keyframe interval and warns if it exceeds
half the monitor `interval`. Encoded as **UI-011**.

### Q12.b — Keyframe-only decoding — RESOLVED: WITHDRAWN

Owner is correct; my original proposal was wrong.

The decoder must process every byte that arrives on the wire whether
it emits all output frames or only keyframes — the costly part is
demuxing, parsing NAL units, and decoding (which depends on previous
frames for P/B). `-skip_frame nokey` only changes which frames are
*emitted*, not which are *processed*. For Enhanced (5 frames) it would
slow the check down because we'd have to wait for more keyframes to
accumulate; for Full (1 frame) it's a marginal win at best (one
sub-GOP earlier). Withdrawn.

### Q12.c — One camera per monitor row — RESOLVED: confirmed

### Q12.d — Push-fallback / migration commentary — RESOLVED: dropped

Out of scope. The fork owner doesn't want migration advice on the
existing script. Removed from **[07-script-analysis.md](./07-script-analysis.md)**.

### Q12.e — Audit log of reference uploads — RESOLVED: yes

Encoded as **OP-007**.

### Q12.f — "Test" button — RESOLVED: yes

Encoded as **UI-010**. HLD-time research confirms whether "Test" or
another verbiage matches Uptime Kuma's existing affordance pattern.

### Q12.g — Status-page thumbnails + last-5-DOWN-images — RESOLVED: yes (with contingency)

- Last-match thumbnail on status pages: per-monitor opt-in, off by
  default. Encoded as **UI-013**.
- Last 5 DOWN-frame thumbnails for incident detail: stored in a small
  bounded table with inline cleanup (no daemon). Encoded as **UI-014**.
- **Contingency:** if HLD-time review concludes the bounded-table
  pattern doesn't fit Uptime Kuma's existing patterns, the entire
  feature (UI-013 + UI-014 + storage) is dropped per the owner's
  fallback instruction. A TODO note is logged for the future
  webhook-based alternative (UI-015).

### Q12.h — Future webhook outputs — RESOLVED: documented for later

Encoded as **UI-015** (Won't this work). Two specific future-sprint
items captured:

1. Webhook on Full-mode distance climbing toward threshold (early
   warning).
2. Webhook POST of periodic UP frames + every DOWN frame to a
   user-specified URL, eliminating the need to store images in Uptime
   Kuma's database. Replaces UI-013 / UI-014 for users who'd rather
   externalise image retention.

---

## Open questions (round 2 — for the next adversarial pass)

### Q13. CONFIRM: Uptime Kuma's "accordion" / collapsible section pattern

UI-012 (lazy-load reference BLOBs) and the references section
generally need to know what visual affordance to use for grouped
fields that aren't always expanded. At a quick scan, `EditMonitor.vue`
uses Bootstrap `<div class="collapse">` blocks for advanced HTTP
options (e.g., body / headers). HLD-time confirmation:

- Verify whether `EditMonitor.vue` has an established pattern for
  "expand-on-click sections within a monitor's edit form."
- Match it. If multiple patterns exist, prefer the most recent.
- If no pattern exists, propose the closest Bootstrap-native
  primitive that matches Uptime Kuma's broader style (likely
  `<details>` or `<div class="card">` with a collapse toggle).

**DECISION REQUEST at HLD time, not now.**

### Q14. CONFIRM: existing Test-button verbiage

UI-010 says "match Uptime Kuma's existing verbiage." HLD-time research
should: (a) check if HTTP / Push / TCP monitors have a "test now" /
"check now" / "probe" affordance, (b) match exactly. Default proposal
is "Test" if no precedent exists.

### Q15. CONFIRM: Audit-log destination

OP-007 says "stored in a small audit table aligned with Uptime Kuma's
existing audit/log patterns." HLD-time research should confirm whether
Uptime Kuma has a generic audit subsystem. If not, two fallbacks:
(a) a dedicated `monitor_reference_audit` table (preferred), (b)
piggy-back on the existing `notification_log` or similar — only if it
makes semantic sense.

### Q16. CONFIRM: `node-av` API surface for credentials and authentication

`node-av` exposes FFmpeg's AVDictionary at session-open time. Standard
RTSP credentials are passed via URL (`rtsp://user:pass@host/path`) or
via `rtsp_user` / `rtsp_pass` AVOptions. HLD-time work needs to:

- Confirm `node-av` exposes these options.
- Decide whether the form's username / password fields are merged
  into the URL or passed separately. (Owner-stated preference: reuse
  the generic `username` / `password` columns; if the URL also
  contains credentials, the URL form wins, with a UI warning if both
  are set.)

### Q17. CONFIRM: serialisation of reference fingerprints to the frontend

Fingerprints (16 bytes each, ~32 hex chars) are tiny and DO belong in
the default monitor JSON — they let the UI show "currently configured"
status. UI-012 only excludes the BLOB. To verify at HLD: ensure the
hash columns serialise but the BLOB columns do not.

### Q18. CONFIRM: how does Uptime Kuma handle "non-blocking warning beneath a field"

UI-007 (rtsp_transport URL warning) and UI-011 (keyframe-interval
warning) need a visual warning affordance that is non-blocking and
below the field. HLD-time: identify whether `EditMonitor.vue` has a
precedent (Bootstrap `alert-warning`? small chip? icon + tooltip?)
and match it.

### Q19. NEW: should the Test button be available before the monitor is saved?

UI-010 says it's on the edit form. Two sub-questions:
- (a) Is it available before the user has ever clicked Save? (i.e.,
  does it operate on the form's current state, regardless of DB
  persistence?)
- (b) Does it count as a "real" check that produces a heartbeat, or is
  it a side-channel probe whose result is shown only in the UI?

**Proposal:** (a) yes (operate on form state); (b) side-channel only
(no heartbeat written). This matches HTTP-keyword's existing "test"
behaviour if such exists; HLD-time verification.

### Q20. NEW: incident-detail UI to surface DOWN images (UI-014)

If UI-014 is kept, the user-facing surface for the 5 DOWN images is
either:
- (a) The monitor's incident-detail page (existing in Uptime Kuma).
- (b) The status page (status pages are public; this might be too
  privacy-sensitive).
- (c) Both, gated by separate toggles.

**Proposal:** (a) only by default; opt-in to (b) via the same toggle
as UI-013. Confirms at HLD.

---

## How to use this document for adversarial review

Resolved items above should normally not be re-litigated unless new
information has surfaced. Open items (Q13–Q20) should be answered
either now or deferred to HLD time. Mark each:

- **ACK** — proposed direction stands.
- **OVERRIDE: <new direction>** — replace the proposal.
- **DEFER** — keep on the list; revisit at HLD time.
- **REJECT** — drop entirely from scope.
