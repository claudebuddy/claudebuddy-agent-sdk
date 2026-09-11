# Runtime Interaction Implementation Plan

Execute locally using the existing test-driven workflow.

**Goal:** Add execution-time steering and cancellable user questions.
**Architecture:** Agent owns a run-local interaction broker; QueryEngine consumes
FIFO input at safe boundaries; AskUserQuestion uses broker or legacy callback.
**Tech Stack:** TypeScript, existing Node test runner, no new dependencies.
**Spec:** ../specs/2026-09-11-runtime-interaction-design.md

- [x] Add failing offline Agent integration tests for steering, skipped writes,
  ordered history, end-of-run receipts, interactive answer/cancel/timeout and abort.
- [x] Add src/interaction.ts for receipt tracking, question routing and pull-driven
  event multiplexing; add public event/options types and exports.
- [x] Wire Agent methods/run lifecycle and engine input safe points, keeping child
  input independent and propagating question context.
- [x] Make legacy question callbacks abortable and timeout bounded.
- [x] Add race/early-exit, background-question, hook and budget-boundary regressions.
- [x] Document usage and limits; run full offline tests, build and diff checks.

## Verification outcome

- 87 offline tests passed (18 new interaction regressions); TypeScript build passed.
- git diff --check passed.
- Independent review found premature permission callbacks and lost cleanup journal
  events; regressions reproduced and fixed these, including mid-batch exit.
- Additional regression prevents stale question callbacks from entering a later run.
- Branch codex/runtime-interaction; uncommitted and unreleased, based on v0.5.0.
