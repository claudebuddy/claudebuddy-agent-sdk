# Runtime Reliability Implementation Plan

> Execute task-by-task with test-driven development; use scoped parallel agents for
> the independent engine and tool-state areas, then integrate and review.

**Goal:** Deliver the approved first reliability batch with offline regression tests.
**Architecture:** Keep Agent as the lifecycle owner, QueryEngine as the model/tool
loop, and providers as transport adapters. Pass shared session state and an execution
budget explicitly; centralize permission selection in the Agent layer.
**Tech Stack:** TypeScript, Node test runner, tsx, existing npm dependencies.
**Spec:** ../specs/2026-09-10-runtime-reliability-design.md

## Global constraints

Node >=18; no new production dependency; no live model requests; retain existing
entry points and default bypassPermissions. Do not edit untracked user files.

## Task 1: Engine, cancellation and accounting

Files: src/engine.ts, src/providers/*, src/utils/retry.ts, src/utils/compact.ts,
tests/engine-reliability.test.ts, tests/provider-cancellation.test.ts.

- [x] Add and run failing tests for success at maxTurns=1, observable provider error,
  abort during request/retry, failed compaction recovery, and budget accounting.
- [x] Add optional signal to CreateMessageParams and forward to native transports.
- [x] Add explicit end state and a shared ExecutionBudget {cost, usage}; charge model
  and compaction calls, including children, and use bounded compaction recovery.
- [x] Run `node --import tsx --test tests/engine-reliability.test.ts` and provider tests.

## Task 2: Session-scoped tools and child constraints

Files: src/tools/*, tests/tool-state.test.ts, tests/subagents.test.ts.
Interfaces: ToolContext.sessionState?: Map<string, unknown>, tools?: ToolDefinition[],
agents?: Record<string, AgentDefinition>, canUseTool?: CanUseToolFn,
executionBudget?: ExecutionBudget, maxBudgetUsd?: number, pricingPerMillion?: pricing.

- [x] Write failing tests proving two session contexts cannot read/overwrite each
  other's tasks, goals, definitions and other mutable built-in tool state.
- [x] Store session state through ToolContext; preserve legacy direct tool helpers.
- [x] Restrict children to context.tools and agent-specific tool filters; inherit
  permission callback, abort signal, ledger and pricing. Preserve child error status.
- [x] Run the focused state and subagent tests.

## Task 3: Agent integration and permission policy

Files: src/agent.ts, src/types.ts, src/utils/permissions.ts, tests/agent-reliability.test.ts,
package.json, README.md.

- [x] Add failing integration tests for plan mutations, MCP deny-list, override
  bounds, pre-aborted signals, concurrent runs, prompt errors, goal budget/cancel.
- [x] Centralize effective policy and final tool filtering. Add session/ledger types.
- [x] Use per-run controllers with listeners removed in finally; save history on
  early exit; isolate goal state and aggregate one final result.
- [x] Reject unsupported sandbox enforcement. Add offline `npm test` and retain
  explicit live example scripts with correct failure propagation.
- [x] Document permission and result semantics, budget scope and compatibility changes.

## Task 4: Integration review

- [x] Run `npm test`, `npm run build`, `git diff --check`.
- [x] Review the integrated implementation against the spec, including cancellation
  races and bypass routes, then fix findings with regressions.
- [x] Report checks, changed behavior, and remaining deliberate limitations.

## Verification outcome

- `npm run test:all`: 50 offline regression tests passed; TypeScript build passed.
- `git diff --check`: passed.
- Independent integration review reproduced close/query race and literal `inherit`
  model forwarding; both fixed with regressions.
- MCP cancellation verified over a local SDK stdio transport; provider cancellation
  verified over local HTTP. No paid model requests or credentials used.
- Branch: `codex/sdk-runtime-reliability`; changes remain uncommitted.
- Deliberate limits: cooperative custom-tool cancellation; admission-based cost cap;
  no OS sandbox, token streaming rewrite or durable event store in this batch.
