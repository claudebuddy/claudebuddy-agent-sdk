# Changelog

## Unreleased

- Add an opt-in in-process scheduler for recurring cron and one-shot Agent prompts.
- Add durable definitions, bounded run history, restart catch-up, local single-writer
  locking, FIFO concurrency limits, same-job overlap protection, and shutdown cancellation.
- Add host scheduling methods and six model tools while keeping RemoteTrigger disabled.

## 0.6.0 — 2026-09-11

- Add queued execution-time user instructions with receipt events, hook checks and
  safe-boundary replanning; skip superseded tool calls before permissions/execution.
- Add opt-in interactive question events, answer/cancel methods, per-question IDs,
  multiselect, timeout and cancellation for broker and legacy callback waits.
- Deliver child questions through a pull-driven event merger and persist cleanup
  interaction events when a consumer closes the stream early.

- Add 18 interaction regression tests; all 87 offline tests pass.

## 0.5.0 — 2026-09-10

- Apply tool permissions consistently to built-in, MCP, override and child tools;
  isolate built-in mutable state by Agent session.
- Preserve terminal errors, cancellation and usage in prompt results; share budgets
  across goal rounds, subagents and compaction.
- Forward cancellation to provider/MCP transports and retry waits. Preserve history
  and clean up when consumers exit the query iterator early.
- Stream incremental text/tool arguments from Anthropic and OpenAI-compatible APIs;
  execute tool calls only after complete responses. Preserve mutation barriers in
  tool scheduling and parallelize only explicitly safe adjacent reads.
- Checkpoint conversation progress during execution and record replayable semantic
  events. Resume unknown tool outcomes explicitly without automatically replaying
  side effects.
- Implement query-scoped background Bash/subagent execution with task output,
  waiting, cancellation, bounded output and completion notifications. Join work
  before final accounting and cancel it on interrupted runs.
- Disable scheduler/remote-trigger placeholders in model tool schemas. Clarify that
  the current LSP fallback performs lexical search, not semantic analysis.
- Add 69 offline regression tests, including local HTTP/MCP transport coverage.

### Migration notes

- An explicit empty allowedTools list exposes no tools. Query overrides cannot widen
  constructor allow/deny bounds. Default bypassPermissions remains unchanged.
- Unsupported sandbox enforcement throws. Only one query/goal may own an Agent at
  a time. Use separate Agents for concurrent conversations.
- Pass agent.getToolState() to session-specific built-in helper functions. Global
  helper defaults no longer configure Agent instances.
- Check prompt().is_error and subtype before treating output as success.
- Persistence now occurs during execution; set persistSession:false for host-owned
  storage. Session storage remains single-writer, without exactly-once side effects.
- Background work is scoped to its creating query; it is not a cross-query daemon.
  See docs/background-tasks.md and docs/runtime-progress.md for limits.
