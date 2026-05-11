# RTSP / RTMP Monitor — Planning Documentation

This directory contains the formal requirements and design-level documentation
for adding RTSP and RTMP video-stream monitoring to this Uptime Kuma fork.

**Status:** HLDS round-1 complete. The High-Level Design Specification is
in **[10-high-level-design.md](./10-high-level-design.md)** and resolves
the round-2 open items (Q13–Q21) from
**[08-open-questions.md](./08-open-questions.md)** plus a handful of
sanity-check corrections cataloged in §18 of the HLDS. Implementation may
proceed once the HLDS has received an adversarial review pass.

**Implementation strategy (agreed by fork owner):**
1. **PR 1 (fork-only):** all three modes shipped together to `nbetcher/uptime-kuma`.
2. **PR 2 (upstream):** Basic mode only, extracted as a clean subset.
3. **PR 3 (upstream):** Enhanced mode, layered on the merged Basic.

Full mode is fork-specific. Branches will be created at implementation time.

**Audience:** the fork owner (primary reviewer, adversarial disposition),
future implementers, and — if any subset is ever proposed for upstream — the
upstream Uptime Kuma maintainers (notably `@CommanderStorm` and `@louislam`).

## Document map

| # | Document | Purpose |
|---|----------|---------|
| 1 | [01-vision-and-scope.md](./01-vision-and-scope.md) | Why this monitor exists, what is and isn't in scope, glossary, fork-vs-upstream posture, AGENTS.md implications |
| 2 | [02-protocol-coverage.md](./02-protocol-coverage.md) | Which protocols and transports are supported, with explicit reasoning for what is excluded; vendor-quirk allowances |
| 3 | [03-monitoring-modes.md](./03-monitoring-modes.md) | The Basic, Enhanced, and Full modes — definitions, mechanics, pass/fail criteria, resource budgets |
| 4 | [04-requirements.md](./04-requirements.md) | Numbered functional and non-functional requirements with REQ-IDs, MoSCoW levels, acceptance criteria, traceability |
| 5 | [05-image-comparison-strategy.md](./05-image-comparison-strategy.md) | Full-mode strategy: library selection, fingerprint algorithm, day/night handling, reference-image storage |
| 6 | [06-prior-art-review.md](./06-prior-art-review.md) | Upstream issue #2851, prior PRs #5822 and #5954, screenshot-diff issue #6325, reviewer concerns |
| 7 | [07-script-analysis.md](./07-script-analysis.md) | Critical review of the existing `check_rtsp_stream_up.sh` script and how Enhanced mode supersedes it |
| 8 | [08-open-questions.md](./08-open-questions.md) | Pushbacks on parts of the original requirements, alternatives I recommend you weigh, items still to decide |
| 9 | [09-traceability-matrix.md](./09-traceability-matrix.md) | Two-way map between original prompt bullets, REQ-IDs, and reviewer concerns — for adversarial review |
| 10 | [10-high-level-design.md](./10-high-level-design.md) | High-Level Design Specification — module layout, data model, interfaces, sequence flows, error model, test strategy. Resolves Q13–Q21 and corrects sanity-check items found while writing the HLDS |

## How to read these

Each document is self-contained but cross-references the others. For an
adversarial review pass on the HLDS, I suggest:

1. Skim **01** to confirm scope alignment.
2. Read **04** end-to-end as the canonical requirements contract.
3. Read **10** end-to-end as the canonical design contract. Pay
   particular attention to §17 (round-2 resolutions), §18 (sanity-check
   corrections to docs 01–09), and §19 (open items deferred to code
   time).
4. Use **09** to verify nothing in your original brief was dropped.
5. Read **08** if you want to argue with the planning-round decisions.

## Conventions

- **Confidence markers** appear inline where relevant: `[HIGH]` for claims
  backed by code, RFCs, or maintainer statements; `[MEDIUM]` for claims
  backed by community/blog evidence; `[LOW]` for inferences I drew myself.
- **REQ-IDs** are stable: `FR-NNN` (functional), `NFR-NNN` (non-functional),
  `MOD-NNN` (mode-specific), `UI-NNN` (interface), `OP-NNN` (operations).
- **Recommendation vs. requirement:** items the original brief dictated are
  marked **REQUIRED-BY-BRIEF**; items I am proposing are marked
  **PROPOSED**, and items I am pushing back on are marked
  **PUSHBACK** with rationale.
