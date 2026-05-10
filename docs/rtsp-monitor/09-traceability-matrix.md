# 09 — Traceability Matrix

Two-way map. Use this to verify nothing in your original brief was silently
dropped, and to see at a glance which reviewer concerns are addressed.

## A. Original brief → requirement IDs

Each bullet from the original prompt is reproduced verbatim and mapped to
one or more requirements. "—" means the bullet is met by overall design,
not a single REQ-ID; "PUSHBACK" means I am proposing not to do it.

| # | Original brief excerpt | Requirements / docs | Status |
|---|---|---|---|
| 1 | "Ability to monitor RTSP and RTMP streams in three modes (determine the best way to name these yourself): **Basic**, **Enhanced**, **Full**." | FR-001, FR-002, FR-010 | Confirmed (you kept Basic/Enhanced/Full) |
| 2 | "RTSP and RTMP over TCP and UDP should be supported." | FR-020, FR-021, FR-023, FR-026, **[02-protocol-coverage.md](./02-protocol-coverage.md)** §1, **[08-open-questions.md](./08-open-questions.md)** Q2, Q10 | Partial pushback: RTMP-over-UDP doesn't exist, see Q2 |
| 3 | "RTSP over TLS should be supported as well for TCP, with optional certificate validation (e.g. toggle on/off in UI for self-signed certs)." | FR-022, NFR-021 | Met |
| 4 | "RTSP over DTLS for RTSP UDP should be planned for (...if this is even something some vendors use...)." | FR-025, **[08-open-questions.md](./08-open-questions.md)** Q1 | PUSHBACK: not a real protocol |
| 5 | "**Basic** only monitors that the port is open and responds to (Roughly) proper RTSP protocol commands (with variance allowed for known quirks of some very popular vendors, if applicable)." | FR-011, FR-012, **[02-protocol-coverage.md](./02-protocol-coverage.md)** §4–5, **[03-monitoring-modes.md](./03-monitoring-modes.md)** §3 | Met |
| 6 | "**Enhanced** monitors that the server is sending video frames (see attached script -- ... DO NOT BLINDLY IMPLEMENT THAT SCRIPT...)." | FR-013, FR-014, **[03-monitoring-modes.md](./03-monitoring-modes.md)** §4, **[07-script-analysis.md](./07-script-analysis.md)** | Met; script reviewed in 07 |
| 7 | "**Full** skips monitoring using **Enhanced** methods and skips straight to image match verification: images are pulled most efficiently (ideally avoiding files, if it is easily possible)..." | FR-015, FR-016, OP-004, **[03-monitoring-modes.md](./03-monitoring-modes.md)** §5, **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** | Met |
| 8 | "...compared to reference images provided by the user. The reference images should have two types (if the user selects 'Separate Day/Night' -- default selected)..." | FR-017, FR-018, FR-019, **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** §3, §5 | Met |
| 9 | "Use the best technology available to us in Uptime Kuma's existing stack which is fully capable of matching one image against another, with fuzz (... camera artifacts ... compression ... video enhancement ... night vision [infrared], and, if possible, being able to use only one reference image..." | NFR-034, **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** §1–2, §6 | Met (recommendation: `sharp`) |
| 10 | "...if no such technology is available in Uptime Kuma's existing stack...then research the best fit and suggest that." | **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** §1 | Met (`sharp` recommended; `jimp` fallback) |
| 11 | "Maximum efficiency, minimal resources used, and ideally no storage (even temporary) written to at any point if possible..." | OP-004, NFR-001, NFR-002, NFR-003, NFR-004 | Met |
| 12 | "Minimal new dependencies, if any." | NFR-034 | Met (≤ 2 new deps; one is the chosen image library, one is the optional decode stack) |
| 13 | "Follows both Uptime Kuma's official style and coding standards (if applicable) as well as unofficial." | NFR-030, **[01-vision-and-scope.md](./01-vision-and-scope.md)** AGENTS section | Met |
| 14 | "Solves for or considers the suggestions, requirements, or code review concerns in: github.com/louislam/uptime-kuma/issues/2851 as well as all of the nested links..." | **[06-prior-art-review.md](./06-prior-art-review.md)** entire document | Met |
| 15 | "Neat, but comprehensive UI and UX, and should match on both to Uptime Kuma's normal style and standards as well as existing UIs in other, existing, Uptime Kuma monitor types." | UI-001, UI-002, UI-003, UI-004, UI-005, UI-006 | Met |
| 16 | "Should be designed in a manner that is virtually impossible to fail for any reason at any point." | NFR-010, NFR-011, NFR-012, NFR-013, OP-003 | Met (graceful degradation; deterministic failure paths) |
| 17 | "Code should impress even the most skeptical and conservative of coders (like Github user `CommanderStorm`) -- make sure to solve for `CommanderStorm`'s concerns in others' implementations, too." | FR-031, FR-032, UI-002, UI-006, NFR-031, NFR-032, NFR-050, NFR-051, **[06-prior-art-review.md](./06-prior-art-review.md)** §7 | Met |
| 18 | "Don't be shy to suggest or solve for things I've failed to consider..." | **[08-open-questions.md](./08-open-questions.md)** Q12 (a–h) | Met |
| 19 | "Consider, but not necessarily adopt (if they do not meet the above requirements with flying colors), other PRs already submitted for this which are all (2 of them) linked..." | **[06-prior-art-review.md](./06-prior-art-review.md)** §2, §3 | Met |
| 20 | "If you have any questions, ask them upfront and throughout all of the process." | Clarifying-question round done; **[08-open-questions.md](./08-open-questions.md)** Q3, Q4, Q5, Q6, Q7, Q8, Q9, Q10, Q11, Q12 | Met (open items captured for your adversarial round) |

## B. CommanderStorm review-pattern checklist (from #5822 and #5954)

| Pattern | First seen on | Encoded as | Doc |
|---|---|---|---|
| Tests required, every PR | #5822, #5954 | NFR-031 | 04 |
| Mock the network, no live server in CI | #5954 | NFR-032 | 04 |
| Scope discipline: Basic first, Enhanced/Full later | #5822 | NFR-051 | 04 |
| Reuse generic `username`/`password` columns | #5954 | FR-031 | 04 |
| Use `HiddenInput.vue` for password | #5954 | FR-032 | 04 |
| i18n keys must include protocol prefix | #5954 | UI-006 | 04 |
| Translations only in `en.json`; rest via Weblate | #5954 | UI-006 commentary | 04, 06 |
| Placeholders / help on every non-obvious field | #5954 | UI-002 | 04 |
| Clean rebase before re-submission | #5954 | Process item, see 08 Q6 | 08 |
| AGENTS.md compliance for AI-assisted work | upstream policy | NFR-050 | 04 |

## C. Requirement → original-brief origin

(Reverse map; useful for arguing "why does FR-031 exist?")

| REQ-ID | Origin |
|---|---|
| FR-001, FR-010 | Brief #1 |
| FR-002 | My inference; minimises duplication |
| FR-011, FR-012 | Brief #5 |
| FR-013, FR-014 | Brief #6, plus PoleTransformer's #5954 comment |
| FR-015, FR-016 | Brief #7 |
| FR-017, FR-018 | Brief #8 |
| FR-019 | Brief #8, your clarifying-question answer (BLOB **and** URL) |
| FR-020, FR-021, FR-023 | Brief #2 |
| FR-022 | Brief #3 |
| FR-024 | Brief #2 (RTMP) + #3 (TLS, by analogy) |
| FR-025 | Brief #4 — pushback Q1 |
| FR-026 | Brief #2 — pushback Q2 |
| FR-030 | Vendor-quirk research; HTTP-monitor parity |
| FR-031, FR-032 | Brief #17 (CommanderStorm); PR #5954 review |
| UI-001 | Brief #15 |
| UI-002 | PR #5954 review |
| UI-003 | Standard UX hygiene |
| UI-004 | Storage-budget hygiene |
| UI-005 | Brief #16 (graceful degradation) |
| UI-006 | PR #5954 review |
| OP-001, OP-002 | Your clarifying-question answer (subprocess + bundle) |
| OP-003 | Brief #16; defensive design |
| OP-004 | Brief #11 |
| OP-005 | Brief #11 (efficiency) |
| OP-006 | SSRF defence (security hygiene) |
| NFR-001, NFR-002 | Brief #11 (efficiency) |
| NFR-003 | Brief #11 (resource minimisation) |
| NFR-004 | Brief #11 (efficiency under load) |
| NFR-005 | Brief #11 |
| NFR-010, NFR-011, NFR-012, NFR-013, NFR-014 | Brief #16 |
| NFR-020, NFR-021, NFR-022, NFR-023 | Security defaults |
| NFR-030, NFR-031, NFR-032, NFR-033 | Brief #13, #17 |
| NFR-034 | Brief #12 |
| NFR-040, NFR-041 | Operability |
| NFR-050, NFR-051 | Brief #17; AGENTS.md |

## D. Documents and their primary audiences

| Doc | Primary reader | Time to skim |
|---|---|---|
| 01 — Vision and scope | New contributor | 5 min |
| 02 — Protocol coverage | Implementer; protocol-curious reviewer | 5 min |
| 03 — Monitoring modes | Implementer | 7 min |
| 04 — Requirements | Adversarial reviewer (you, on critique pass) | 12 min |
| 05 — Image comparison | Implementer; algorithm reviewer | 7 min |
| 06 — Prior art | Anyone wondering "why this approach?" | 5 min |
| 07 — Script analysis | You (closure on the existing script) | 5 min |
| 08 — Open questions | You (decisions to make before HLD) | 8 min |
| 09 — This file | Anyone verifying coverage | 3 min |

Total: ~1 hour for a thorough adversarial first read.
