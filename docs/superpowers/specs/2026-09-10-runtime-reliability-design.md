# Runtime reliability release

Implements the first reliability batch approved in the conversation. Keep TypeScript,
Node >=18, the in-process engine, and the existing query()/prompt() entry points.
No live model requests or credential changes are needed: provider doubles and local
HTTP servers exercise the external boundary without API keys.

## Contracts

- All tool pools (including MCP and overrides) obey the configured allow/deny bounds.
  An explicit empty allow-list means no tools. Plan allows only read-only tools.
  Default/dontAsk/auto permit read-only or explicitly allowed tools; default/auto
  may consult canUseTool for other tools. acceptEdits additionally permits built-in
  file edits. bypassPermissions retains existing unrestricted behavior. A custom
  callback can deny allowed operations; it cannot override plan or a deny-list.
- sandbox settings requesting enforcement fail explicitly; this batch does not
  implement OS isolation. Read-only metadata is a trusted tool-author declaration.
- Every engine execution has a single explicit final status. API errors and
  cancellation remain visible in prompt() through additive result fields.
- AbortSignal reaches providers, retry waits, compaction, and subagents. No new
  tool starts after cancellation. Custom tools must cooperate with cancellation;
  arbitrary JavaScript side effects cannot be forcibly rolled back.
- Compaction returns an explicit success indication and finite recovery attempts.
  Normal completion at the last permitted model turn is success.
- One Agent accepts one active query/goal run at a time. Early consumer exit saves
  in-memory history and releases the run lock through finally.
- Built-in mutable tool state and agent definitions are session scoped. Child agents
  share their parent's session state deliberately, not state from other Agent instances.
- An execution ledger is shared by goal rounds, compaction and child engines. It
  holds cost and usage; admission checks stop subsequent requests at the limit.
  One in-flight request can exceed an estimate: maxBudgetUsd is not a billing guarantee.
- Goal mode emits a single aggregate final result and stops on cancel, provider
  failure or budget exhaustion. Goal reports belong to that run. Ordinary queries
  retain per-query budgets. Keep default maxTurns=10 and default bypassPermissions.

## Non-goals

No streaming protocol rewrite, RPC server, database persistence, new model backend,
OS sandbox, token reservation scheduler, or new automatic completion verifier.
