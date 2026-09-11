# Interaction during execution

Available starting in version 0.6.0.

## Steering an active query

Keep consuming one `agent.query()` iterator. From a UI event handler, call
`agent.sendMessage(text)` to append a new instruction to that active run. It returns
a receipt ID immediately; it does not launch another query or reset the budget.
`agent.getMessageStatus(id)` returns a copy of the receipt:

- `queued`: accepted into the in-memory queue.
- `applied`: appended to the conversation after UserPromptSubmit hooks allowed it;
  this does not mean the request was fulfilled.
- `not_applied`: rejected by a hook or the run ended before insertion; inspect reason
  and explicitly resubmit if still wanted.

The event stream emits `system/user_message` for these transitions. The queue holds
up to 128 pending inputs; the last 256 receipts remain inspectable. Empty messages,
queue overflow, idle Agents and ending/aborted runs reject new input. Calling
`clear()` clears receipts along with the conversation. Unapplied messages do not
silently carry over to another query. Existing maxTurns and budget limits remain
in force; a message queued on the final permitted turn may be left unapplied.

During a model request or stream, the current response finishes first. The engine
then skips unstarted tool calls from the old response, recording paired error
results, and replans with FIFO user input. Already running tools (including an
already dispatched parallel batch), permission callbacks and hooks finish normally.
Parent input is not automatically forwarded to running child agents. Use TaskStop
for a child or interrupt() for strong run cancellation. Custom callbacks/tools
still need to cooperate with cancellation outside the question-handler wrapper.
Input arriving during final background-task cleanup can be marked not_applied.

## Interactive questions

Set `interactive: true` when creating the Agent (or as a query override). When
AskUserQuestion runs, `system/question` carries a unique question_id, question,
optional options and allow_multiselect. The event is delivered while the tool waits.

- `answerQuestion(id, text)` accepts non-empty free text, including text outside the
  suggested options.
- `answerQuestion(id, ['A', 'B'])` requires allow_multiselect and returns JSON-array
  text to the model.
- `cancelQuestion(id)` returns an explicit unanswered-tool error, allowing the model
  to decide its next action without fabricating an answer.
- `getPendingQuestions()` lists the current pending questions. It is also useful
  when using prompt() with a separate UI/event handler.

Answers must target a pending question in the same Agent; duplicate, stale and
foreign IDs are rejected. `system/question_closed` reports answered, cancelled or
timed_out. Default timeout is five minutes; set positive questionTimeoutMs to
change it. Timeout never chooses a default option. interrupt() and closing the
iterator cancel pending questions and release the run. Foreground and background
subagents use the same question broker with independent question IDs.

sendMessage does not answer or cancel a pending question: use answerQuestion or
cancelQuestion explicitly. An installed setQuestionHandler callback takes precedence
over broker events. Existing two-argument callbacks still work; an optional third
argument contains signal and allowMultiselect. Callback waits now honor timeout and
abort even if the callback's Promise does not settle. Its external side effects
still require cooperation with the supplied signal. Without interactive:true or a
callback, the previous non-interactive fallback remains unchanged.

## Host integration sketch

The host must keep consuming events while its UI collects answers. These handlers
illustrate the API boundary; rendering and transport belong to your application:

```ts
const agent = createAgent({ interactive: true, questionTimeoutMs: 120_000 })

// Call from the UI's message-submit handler while the query is active:
function onSteeringMessage(text: string) {
  return agent.sendMessage(text)
}
function onQuestionAnswer(questionId: string, answer: string) {
  agent.answerQuestion(questionId, answer)
}
function onQuestionCancel(questionId: string) {
  agent.cancelQuestion(questionId)
}

for await (const event of agent.query('Analyze the project')) {
  // Forward events to the UI. On system/question, display a question card.
  // Its buttons call the handlers above; do not block event consumption.
  console.log(event)
}
await agent.close()
```

## Persistence and lifecycle

Applied input is included in normal history/checkpoints. Semantic interaction events
are journaled when persistence is enabled, including question closure and unapplied
receipts during early-exit cleanup. Queues, pending questions and receipt lookup are
in-memory only, not restored after a crash; the event journal is an audit/replay
record, not a durable command queue. Checkpoints and events remain separate writes.

Question waits do not add concurrent owners of the conversation. The event merger
pulls only one upstream item at a time, preserving the ability to break on an
assistant event before its tools start. On early exit it aborts before joining a
pending iterator operation so a waiting question cannot deadlock cleanup.
