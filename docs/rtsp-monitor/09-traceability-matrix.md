# 09 — Traceability Matrix

Two-way map. Use this to verify nothing in your original brief was silently
dropped, and to see at a glance which reviewer concerns are addressed.

## A. Original brief → requirement IDs

Each bullet from the original prompt is reproduced verbatim and mapped to
one or more requirements. "—" means the bullet is met by overall design,
not a single REQ-ID; "Won't" items have explicit owner sign-off in
**[08-open-questions.md](./08-open-questions.md)** decisions log.

| # | Original brief excerpt | Requirements / docs | Status |
|---|---|---|---|
| 1 | "Ability to monitor RTSP and RTMP streams in three modes (determine the best way to name these yourself): **Basic**, **Enhanced**, **Full**." | FR-001, FR-002, FR-010 | Confirmed |
| 2 | "RTSP and RTMP over TCP and UDP should be supported." | FR-020, FR-021, FR-023, FR-026, **[02-protocol-coverage.md](./02-protocol-coverage.md)** §1, UI-008 | Owner-confirmed scope: RTMP-over-UDP dropped; "RTSP-over-UDP" rendered as RTSP-control-over-TCP + RTP-over-UDP with UI tooltip |
| 3 | "RTSP over TLS should be supported as well for TCP, with optional certificate validation..." | FR-022, NFR-021 | Met |
| 4 | "RTSP over DTLS for RTSP UDP should be planned for..." | — | Owner confirmed: removed entirely (not a real protocol) |
| 5 | "**Basic** only monitors that the port is open and responds..." | FR-011, FR-012, **[02-protocol-coverage.md](./02-protocol-coverage.md)** §4–5, **[03-monitoring-modes.md](./03-monitoring-modes.md)** §3 | Met |
| 6 | "**Enhanced** monitors that the server is sending video frames..." | FR-013, FR-014, **[03-monitoring-modes.md](./03-monitoring-modes.md)** §4, **[07-script-analysis.md](./07-script-analysis.md)** | Met; script reviewed |
| 7 | "**Full** skips monitoring using **Enhanced** methods and skips straight to image match verification..." | FR-015, FR-016, OP-004 | Met (no temp files) |
| 8 | "...compared to reference images provided by the user. The reference images should have two types..." | FR-017, FR-018, FR-019, FR-019b, **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** §3, §5 | Met |
| 9 | "Use the best technology available... matching one image against another, with fuzz..." | NFR-034, **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** §1–2, §6 | Met (`sharp`) |
| 10 | "...if no such technology is available... research the best fit..." | **[05-image-comparison-strategy.md](./05-image-comparison-strategy.md)** §1 | Met |
| 11 | "Maximum efficiency, minimal resources used, and ideally no storage..." | OP-004, NFR-001, NFR-002, NFR-003, NFR-004 | Met |
| 12 | "Minimal new dependencies, if any." | NFR-034 | Met (exactly 2: `sharp`, `node-av`) |
| 13 | "Follows both Uptime Kuma's official style and coding standards..." | NFR-030, **[01-vision-and-scope.md](./01-vision-and-scope.md)** AGENTS section | Met |
| 14 | "Solves for or considers the suggestions, requirements, or code review concerns in [issue #2851]..." | **[06-prior-art-review.md](./06-prior-art-review.md)** | Met |
| 15 | "Neat, but comprehensive UI and UX..." | UI-001 through UI-015 | Met |
| 16 | "Should be designed in a manner that is virtually impossible to fail..." | NFR-010, NFR-011, NFR-012, NFR-013, OP-003, UI-005 | Met |
| 17 | "Code should impress even the most skeptical and conservative of coders (like CommanderStorm)..." | FR-031, FR-032, UI-002, UI-006, NFR-031, NFR-032, NFR-050, NFR-051, **[06-prior-art-review.md](./06-prior-art-review.md)** §7, three-PR plan | Met |
| 18 | "Don't be shy to suggest or solve for things I've failed to consider..." | **[08-open-questions.md](./08-open-questions.md)** Q12 (resolved); Q13–Q20 (new round-2 items) | Met |
| 19 | "Consider, but not necessarily adopt, other PRs already submitted..." | **[06-prior-art-review.md](./06-prior-art-review.md)** §2, §3 | Met |
| 20 | "If you have any questions, ask them upfront and throughout..." | Round-1 clarifying-question round done; **[08-open-questions.md](./08-open-questions.md)** decisions log + round-2 open items | Ongoing |

## B. CommanderStorm review-pattern checklist (from #5822 and #5954)

| Pattern | First seen on | Encoded as | Doc |
|---|---|---|---|
| Tests required, every PR | #5822, #5954 | NFR-031 | 04 |
| Mock the network, no live server in CI | #5954 | NFR-032 | 04 |
| Scope discipline: Basic first, Enhanced/Full later | #5822 | NFR-051 + three-PR plan | 04, 06 |
| Reuse generic `username`/`password` columns | #5954 | FR-031 | 04 |
| Use `HiddenInput.vue` for password | #5954 | FR-032 | 04 |
| i18n keys must include protocol prefix | #5954 | UI-006 | 04 |
| Translations only in `en.json`; rest via Weblate | #5954 | UI-006 commentary | 04, 06 |
| Placeholders / help on every non-obvious field | #5954 | UI-002, UI-009 | 04 |
| Clean rebase before re-submission | #5954 | Process item, three-PR plan | 06 |
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
| FR-019 | Brief #8, owner clarifying-question answer (BLOB **and** URL) |
| FR-019b | Owner decision on Q5(a) |
| FR-020, FR-021, FR-023 | Brief #2 |
| FR-022 | Brief #3 |
| FR-024 | Brief #2 (RTMP) + #3 (TLS, by analogy) |
| FR-026 | Brief #2 — owner accepted Won't (Q2) |
| FR-030 | Vendor-quirk research; HTTP-monitor parity |
| FR-031, FR-032 | Brief #17 (CommanderStorm); PR #5954 review |
| FR-035 | Owner decision on Q4 (HEVC/AV1) |
| UI-001 | Brief #15 |
| UI-002 | PR #5954 review |
| UI-003 | Standard UX hygiene |
| UI-004 | Storage-budget hygiene |
| UI-005 | Brief #16 (graceful degradation) |
| UI-006 | PR #5954 review |
| UI-007 | Owner decision on Q11.c |
| UI-008 | Owner decision on transport naming clarification |
| UI-009 | Owner decision on Q11.a (vendor-specific Path tooltip) |
| UI-010 | Owner decision on Q12.f |
| UI-011 | Owner decision on Q12.a |
| UI-012 | Owner decision on Q7 (lazy-load BLOBs) |
| UI-013 | Owner decision on Q12.g (status-page thumbnails) |
| UI-014 | Owner decision on Q12.g (last-5-DOWN-images) |
| UI-015 | Owner decision on Q12.h (future webhook docket) |
| OP-001 | Owner decision on Q3 (`node-av`) |
| OP-002 | Architectural hygiene (factor decode source) |
| OP-003 | Brief #16; defensive design |
| OP-004 | Brief #11 |
| OP-005 | Brief #11 (efficiency) |
| OP-006 | SSRF defence (security hygiene) |
| OP-007 | Owner decision on Q12.e (audit trail) |
| OP-008 | Architectural hygiene (bounded DOWN-image cleanup) |
| NFR-001, NFR-002 | Brief #11; owner decision on Q11.b (interval-scaled budget) |
| NFR-003 | Brief #11 (resource minimisation) |
| NFR-004 | Brief #11; owner decision on Q9 |
| NFR-005 | Brief #11 |
| NFR-010, NFR-011, NFR-012, NFR-013, NFR-014 | Brief #16 |
| NFR-020, NFR-021, NFR-022, NFR-023 | Security defaults |
| NFR-030, NFR-031, NFR-032, NFR-033 | Brief #13, #17 |
| NFR-034 | Brief #12 |
| NFR-040, NFR-041 | Operability |
| NFR-050, NFR-051 | Brief #17; AGENTS.md; three-PR plan |

## D. Documents and their primary audiences

| Doc | Primary reader | Time to skim |
|---|---|---|
| 01 — Vision and scope | New contributor | 5 min |
| 02 — Protocol coverage | Implementer; protocol-curious reviewer | 5 min |
| 03 — Monitoring modes | Implementer | 7 min |
| 04 — Requirements | Adversarial reviewer (round-2 critique pass) | 14 min |
| 05 — Image comparison | Implementer; algorithm reviewer | 7 min |
| 06 — Prior art | Anyone wondering "why this approach?" | 5 min |
| 07 — Script analysis | Owner (closure on the existing script) | 4 min |
| 08 — Decisions log + open questions | Owner (round-2 decisions) | 8 min |
| 09 — This file | Anyone verifying coverage | 3 min |

Total: ~1 hour for a thorough adversarial second-round read.
