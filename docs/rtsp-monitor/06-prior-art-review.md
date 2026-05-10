# 06 — Prior Art Review

A targeted summary of the upstream conversation: the issue, the prior PRs,
the screenshot-diff issue that's adjacent in spirit, the maintainer
recommendations I'm propagating into this design, and the reviewer
patterns the design must satisfy.

## 1. Issue #2851 — "RTSP (Real Time Streaming Protocol) support"

- Author: `@myxor`. Opened **2023-02-27**. Still **open** as of May 2026.
- Labels: `A:monitor`, `feature-request`. ~7 thumbs-up.
- Discussion is sparse on the issue itself; substantive technical debate
  is on the two attempted PRs.

The unmet need is the basic gap our Basic mode covers: monitor an IP
camera the way you'd monitor an HTTP service.

## 2. PR #5822 — `harrisonhjones`, "Add rtsp monitor" (closed Oct 2025, no merge)

### What was proposed

Two depth tiers:

- **Simple** — RTSP socket + look for `RTSP/1.0 200 OK` in the
  response.
- **Deep** — `ffprobe` to verify a real video stream.

The author asked whether `ffprobe` should be added as a dependency or
"installed just in time."

### Reviewer feedback that matters here

`@CommanderStorm` (collaborator, key reviewer):

> "Lets do only simple at first. This way, it is also testable. For
> ffprobe you likely want to extract a screenshot and display it
> which is a lot of work. → splitting keeps it maintainable"

`@louislam` (project owner) — on a follow-up:

> "FYI: Just saw node-av recently, which is ffmpeg bindings for Node.js.
> Since there are too many pull requests, I am cleaning some stalled
> pull requests. Feel free to re-open if you decide to work on it."

The PR was bulk-closed during a stale-PR cleanup; the author did not
return.

### What this design takes from #5822

- The two-tier idea is a precedent for the three-tier (Basic / Enhanced /
  Full) of the current design.
- `@louislam`'s `node-av` mention is a maintainer-blessed alternative to
  shelling out to FFmpeg — see
  **[08-open-questions.md](./08-open-questions.md)** §3.
- `@CommanderStorm`'s "split keeps it maintainable" guidance directly
  motivates **NFR-051** (Basic must be independently extractable) in
  **[04-requirements.md](./04-requirements.md)**.

## 3. PR #5954 — `hemanth5544`, "RTSP monitor" (closed Jan 2026, awaiting rebase)

### What was implemented

A handshake-only monitor. Files:

- `db/knex_migrations/2025-06-27-0001-add-rtsp.js` — three new columns
  `rtsp_username`, `rtsp_password`, `rtsp_path`.
- `package.json` — `rtsp-client@^1.4.5` dependency.
- `server/monitor-types/rtsp.js` — uses `RTSPClient.connect()` then
  `describe()`. Status 200 = UP; 503/error = DOWN.
- `src/lang/en.json` — keys `"RTSP Username"`, `"RTSP Password"`,
  `"RTSP Path"`, `"Path"`.
- `src/pages/EditMonitor.vue` — host, port, path, username, password
  fields.
- `test/backend-test/test-rtsp.js` — three mocked tests (success,
  connection failure, 503).

### Reviewer feedback the design must address

`@CommanderStorm`:

1. **Tests required.** First review comment on every monitor PR.
2. **Translation keys must include the prefix.** *"please translate
   always with full translation keys. → `"RTSP-Username"` instead of
   excluding RTSP."* When the author cited MQTT as a precedent for
   omitting the prefix, the reply was: *"that was a mistake for MQTT
   then which was missed."* So this is a stable maintainer policy, not
   a per-PR judgement.
3. **Translation-only-`en.json`.** *"Important: only add things to
   `en.json`, all other translations have to go via weblate to prevent
   merge conflicts."*
4. **Help/placeholder on `Path`.** *"do these have a typical format? if
   yes, could you add a placeholder or helptext? What a path is, might
   otherwise not be very self-explanatory without extra docs."*
5. **Reuse generic schema.** Don't add `rtsp_username`/`rtsp_password`;
   reuse the generic `username`/`password` columns the HTTP monitor
   uses. (Captured from the file-level review thread.)
6. **`HiddenInput` Vue component.** The masked-credential input
   component used elsewhere should be used for the password field;
   don't roll your own.
7. **Closing comment, Jan 2026:** *"I think this will be a new PR (with
   this one rebased and the changes I requested done)."*

`@PoleTransformer` (Jan 2026):

> "I have a pesky IP cam and sometimes the RTSP stream just goes to a
> black screen. Rebooting camera fixes it. The response codes are all
> fine, but camera feed is black. This monitor wouldn't catch that. Is
> it possible to add a check on the stream contents itself? Maybe
> detect if the data is all zeros?"

This is exactly the failure mode our **Enhanced mode** is built for —
and the black-frame check in **FR-014** is a direct response.

### What this design takes from #5954

- **FR-031 / FR-032 / UI-006** all encode CommanderStorm's review
  patterns explicitly so the same comments are not earned a second
  time.
- The dependency choice is *away* from `rtsp-client@1.4.5` because the
  package is classified Inactive on Snyk and last published 2020. The
  Basic mode plan uses a hand-rolled probe (~30 lines) instead — see
  **[03-monitoring-modes.md](./03-monitoring-modes.md)** §3 — to avoid
  inheriting an abandoned dependency.
- Mocked-network tests in `test/backend-test/test-rtsp.js` are the
  template for **NFR-031** / **NFR-032**.

## 4. Critical look at `rtsp-client@1.4.5`

- Last npm publish: **~5 years ago (2020)**.
- Snyk maintenance health: **Inactive**.
- No published vulnerabilities at the time of writing, but no fixes
  either.
- Implements signalling only (handshake / DESCRIBE / SETUP / PLAY) —
  exactly what Basic mode needs, but the staleness is itself a
  maintainability red flag (which `@CommanderStorm` is likely to flag
  on the next PR).

**PROPOSED:** do not depend on `rtsp-client`. RTSP/1.0 is text-based and
small; an in-tree `OPTIONS`-only probe is ~30 lines and gives full
control over the response parser, so vendor quirks (Hikvision 401,
Dahua spaced-realm, etc., per
**[02-protocol-coverage.md](./02-protocol-coverage.md)** §4) can be
matched precisely.

Other RTSP-client npm packages surveyed:

| Package | Maintained | Notes |
|---|---|---|
| `yellowstone` | Last npm 2018; community fork in 2020 | Pure-JS RTSP/RTP client, full feature set, but stale upstream. |
| `media-stream-library-js` (Axis) | **Archived** by Axis | Heavy, well-engineered, but archived — using it requires vendoring. |
| `seydx/rtsp-client` (fork) | Sporadic | Fork of the abandoned base. |
| `node-rtsp-stream` | ~6 yrs stale | Just an FFmpeg subprocess wrapper, not a real client. |

None has a healthy bus factor. Hand-roll the OPTIONS probe.

## 5. Issue #6325 — "Screenshot diff uptime monitor type" (`@forabi`, Nov 2025)

A different monitor type, but conceptually adjacent: takes a baseline
screenshot via Chromium, then re-screenshots on each run, and uses
**`pixelmatch`** with a tolerance threshold to detect visual regression.

Why I'm not aligning the Full mode's image-compare with this issue's
proposal:

- `pixelmatch` is for *exact-render comparison* (browser screenshots
  are deterministic to within a few anti-aliasing pixels). Camera
  feeds are not — JPEG noise alone can shift hundreds of pixels per
  frame. Using `pixelmatch` here would either alarm constantly (low
  threshold) or miss real failures (high threshold).
- Day/night cross-matching is fundamentally outside pixelmatch's
  design. Perceptual hashing handles it elegantly.

`pixelmatch` is the right tool for #6325; the wrong tool for this work.
**PROPOSED:** add a one-line note in
**[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)**
explaining the divergence so a future reviewer doesn't ask "why don't
you use pixelmatch like #6325 does?"

## 6. `node-av` (`seydx/node-av`)

The library `@louislam` himself surfaced. N-API bindings to FFmpeg with
prebuilt binaries for Linux/macOS/Windows × x64/arm64. MIT-licensed
wrapper; FFmpeg itself is LGPL/GPL.

Implications for our design:

- **Pro:** No subprocess, no PATH detection, no zombie children, no
  stdout parsing. Decoded frames as `Buffer` objects directly. Aligns
  with the maintainer's stated preference. Aligns with the brief's
  "no temp storage" goal even more strongly than the FFmpeg
  subprocess does.
- **Con:** ~30–50 MB install footprint (prebuilds bundle FFmpeg).
  Native binding — adds a compilation fallback if a platform isn't
  prebuilt (Uptime Kuma supports many architectures via Docker).
- **Con:** Younger and less battle-tested than spawning the canonical
  `ffmpeg` binary.

Your earlier answer ("Both: bundle in Docker AND prefer system ffmpeg
if present") implies subprocess. `node-av` is enough of an upgrade and
enough of a maintainer signal that I'm raising it as an open question
in **[08-open-questions.md](./08-open-questions.md)** §3 rather than
silently overriding your selection.

## 7. CommanderStorm's review pattern, consolidated

Treat as a checklist for any code work that follows this planning phase:

| # | Pattern | This design's response |
|---|---|---|
| 1 | Tests required, first comment, every PR | NFR-031, NFR-032 |
| 2 | Mock the network, don't require a server | NFR-032 |
| 3 | Scope discipline: simple first, deep later | NFR-051 (extractable Basic), see §8 below |
| 4 | Reuse existing schema columns | FR-031 |
| 5 | Reuse existing UI components (`HiddenInput`) | FR-032 |
| 6 | Translation keys fully qualified | UI-006 |
| 7 | Translations only in `en.json` | UI-006 (note in commentary) |
| 8 | Placeholder/help text on every non-obvious field | UI-002 |
| 9 | Rebase cleanly | Process item, not a design item — flagged in **[08-open-questions.md](./08-open-questions.md)** §6 |
| 10 | "Wall of Shame" for AI slop — `AGENTS.md` | NFR-050 |

## 8. The scope-discipline tension

The original brief asks for all three modes from day one. `@CommanderStorm`'s
guidance is "simple first, deep later, in separate PRs." These conflict
*if* the work is destined upstream. They do not conflict on the fork.

The design splits the difference:

- The **fork** can run all three modes from day one — the user owns the
  fork and is the only consumer.
- The **codebase** is structured so Basic is independently extractable
  (NFR-051) — separate file, no Enhanced/Full imports, separate
  migration. If a Basic-only PR is ever offered upstream, it is a
  mechanical subset.

This is documented as the recommended path in
**[08-open-questions.md](./08-open-questions.md)** §6 so the reviewer
can challenge it.

## 9. Items the user's brief mentioned that this section confirms

- "Solves for or considers the suggestions, requirements, or code review
  concerns in [issue #2851]" — every PR in the timeline is reviewed
  above, every CommanderStorm review pattern is mapped to a requirement.
- "Solve for `CommanderStorm`'s concerns in others' implementations" —
  §7 above is the consolidated checklist; FR-031, FR-032, UI-002, UI-006,
  NFR-031, NFR-032, NFR-050, NFR-051 are direct responses.
- "Consider, but not necessarily adopt, other PRs already submitted" —
  §2 (PR #5822) and §3 (PR #5954) above. Adopted: the two-tier idea (now
  three-tier), the mocked-test pattern, the `HiddenInput` pattern,
  fully-qualified i18n keys, generic schema columns. Rejected: the
  `rtsp-client@1.4.5` dependency.
