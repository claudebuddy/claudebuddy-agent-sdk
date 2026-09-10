# Streaming, scheduling and recovery

This second runtime batch retains the in-process TypeScript architecture and the
first batch's permission, cancellation and budget contracts.

## Incremental responses

Enable `includePartialMessages: true` to receive `partial_message` events while the
provider is still responding. Built-in Anthropic and OpenAI-compatible providers
implement an optional `LLMProvider.streamMessage` async generator. Custom providers
without this method continue through the buffered `createMessage` path.

Text partials contain incremental `text`, not the accumulated response. Tool partials
contain `index`, optional `id`/`name`, and incremental JSON `input`. They are for
presentation only. Execute tools only after receiving and validating the complete
response. A completed `assistant` event contains the authoritative full message;
UIs should replace/finalize their partial display rather than append it again.

Streams are not automatically retried. On interruption, emitted partial text may
remain visible but is not committed to conversation history. Incomplete tool calls
are never dispatched. Usage is charged once when a complete provider response is
available; interrupted streams can incur provider charges that are not reported in
the local ledger. Some OpenAI-compatible servers do not support `stream_options`;
use buffered mode for these servers.

## Tool ordering

The scheduler preserves the model's call order across barriers. Only adjacent tools
that explicitly declare both `isReadOnly()` and `isConcurrencySafe()` true may run
in parallel, bounded by `AGENT_SDK_MAX_TOOL_CONCURRENCY` (default 10). Mutations,
unknown tools, and reads without a concurrency guarantee run serially. Results stay
in request order. This avoids reading a file before an earlier requested edit.

## Durable progress

With `persistSession` enabled (the existing default), the Agent checkpoints its
normalized history during execution, before publishing semantic events, and in
cleanup. Snapshots use a temporary file, fsync and atomic rename. This reduces the
loss window from “until close” to the current incomplete operation.

`events.jsonl` records semantic events with a version, unique cursor ID and timestamp.
Token deltas are intentionally ephemeral. Use `readSessionEvents(sessionId, afterId?)`
to replay committed events. Goal runs log their public aggregate terminal result,
not the hidden per-round results. A torn final append is ignored on reads and repaired
before the next append. Checkpoints and the event log are separate writes, not a
transaction: a crash can leave a newer checkpoint than the last published event.

On resume, a tool request without a recorded result receives an explicit unknown-
outcome error. The SDK never automatically replays such a call: inspect external
state before asking the model to retry. This is conversation recovery, not exactly-
once external side effects or restoration of in-memory task state.

Storage is single-writer per session ID. Multiple processes must not write the same
session concurrently. `AGENT_SDK_SESSION_DIR` can select a storage directory. Set
`persistSession: false` for hosts that own persistence. Storage errors during a run
surface to the caller rather than claiming the event was durably published.

## Offline verification

Run `npm run test:all`. Added checks cover true HTTP SSE delivery before completion,
UTF-8 fragmentation, interleaved tool argument assembly, truncated streams, generator
cleanup, mutation/read ordering, safe parallel reads, event replay, torn tails,
unknown tool outcomes and persistence before Agent.close(). No paid API calls.
