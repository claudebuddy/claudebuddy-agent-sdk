# Runtime interaction design

Implement the approved first priority: user steering at safe boundaries and
answerable questions during an active Agent run. Preserve one owner of history.

Agent.sendMessage(text) synchronously returns a receipt ID during an active query
or goal. Queue at most 128 pending messages; reject empty input and inactive/closing
runs. Receipts report queued/applied/not_applied; retain the last 256 receipts for
inspection. Applied means appended to model history, not completed. FIFO input
passes UserPromptSubmit hooks. Denied inputs remain unapplied with a reason.

The engine checks input before a model request, before starting tools and after a
completed response. Already running operations finish normally. Skip remaining
unstarted tool calls with paired error results, append the new user input, and
replan within the existing turn/budget limits. Never widen permissions or consume
parent messages from child engines. Do not promise immediate transport preemption.
Unconsumed messages at run termination receive not_applied status; no silent
carryover into the next run. Inputs arriving during final cleanup are reported
unapplied. Strong cancellation continues through interrupt().

Interactive questions are opt-in with interactive:true. Emit system/question with
an ID and the question/options; answerQuestion(id, string|string[]) and
cancelQuestion(id) resolve the matching pending request only. Options are
suggestions; free text remains valid. Arrays require allow_multiselect. Expose
pending questions for hosts using prompt(). Default question timeout is 300000 ms,
configurable through questionTimeoutMs (finite positive milliseconds). Answers,
cancellation, timeout and run abort remove listeners and pending state. Never choose
an answer on timeout. Existing setQuestionHandler callbacks remain supported and
receive optional cancellation context as a third argument.

A pull-driven event multiplexer wraps each source iterator.next() and exposes
question events while a tool/provider is waiting. It does not eagerly request the
next source item after yielding an assistant message. On consumer exit it aborts
the run before joining any pending next()/return(), avoiding question deadlocks.
Background/foreground child questions share the same Agent broker and retain IDs.

Persist semantic interaction events through the existing journal and applied input
in checkpoints/history. Pending questions/messages are in-memory only and are not
restored after process restart. Persisting an event does not atomically persist the
receipt queue. No HTTP server, UI, Cron, LSP or new release in this task.
