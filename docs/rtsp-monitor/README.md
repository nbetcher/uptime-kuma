# RTSP / RTMP Monitor — Planning Documentation

This directory contains the formal requirements and design-level documentation
for adding RTSP and RTMP video-stream monitoring to this Uptime Kuma fork.

**Status:** Planning only. No code changes are gated on these documents. A
High-Level Design Specification will follow once these are reviewed,
critiqued, and approved.

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

## How to read these

Each document is self-contained but cross-references the others. For an
adversarial review pass, I suggest:

1. Skim **01** to confirm scope alignment.
2. Read **08** first if you want to argue with my conclusions early.
3. Read **04** end-to-end as the canonical contract.
4. Use **09** to verify nothing in your original brief was dropped.

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
