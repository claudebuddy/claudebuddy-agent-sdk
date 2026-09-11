import test from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from '../src/agent.js'
import { defineTool } from '../src/tools/types.js'
import { AskUserQuestionTool, setQuestionHandler } from '../src/tools/ask-user.js'
const done = (text = 'done'): any => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
const call = (name: string, input: any = {}): any => ({ ...done(), stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'call1', name, input }] })
function fixture(t: any, fn: any, options: any = {}) {
  const a = new Agent({ apiType: 'openai-completions', apiKey: 'unused', tools: [], systemPrompt: 'test', persistSession: false, ...options })
  ;(a as any).provider = { apiType: 'openai-completions', createMessage: fn }
  t.after(async () => { await a.interrupt(); await a.close() })
  return a
}

test('steering skips unstarted writes and reaches the model in FIFO history order', async t => {
  let writes = 0; let calls = 0; let sent: any[] = []
  const write = defineTool({ name: 'WriteProbe', description: 'test', inputSchema: { type: 'object' }, call: async () => { writes++; return 'changed' } })
  const a = fixture(t, async (p: any) => { sent = p.messages; return ++calls === 1 ? call('WriteProbe') : done() }, { tools: [write], maxTurns: 2 })
  const ids: string[] = []; const events: any[] = []
  for await (const event of a.query('edit')) {
    events.push(event)
    if (event.type === 'assistant' && ids.length === 0) ids.push(a.sendMessage('do not edit'), a.sendMessage('explain only'))
  }
  assert.equal(writes, 0); assert.equal(calls, 2)
  const texts = sent.flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text))
  assert.deepEqual(texts.slice(-2), ['do not edit', 'explain only'])
  assert.ok(JSON.stringify(sent).includes('superseded'))
  for (const id of ids) assert.equal(a.getMessageStatus(id)?.status, 'applied')
  assert.deepEqual(a.getMessages().filter(m => m.type === 'user').map(m => m.message.content), ['edit', 'do not edit', 'explain only'])
  assert.equal(events.at(-1).subtype, 'success')
})

test('turn exhaustion reports unapplied input and does not carry it into a later run', async t => {
  const a = fixture(t, async () => done(), { maxTurns: 1 })
  let id = ''
  for await (const event of a.query('test')) if (event.type === 'assistant') id = a.sendMessage('another request')
  assert.equal(a.getMessageStatus(id)?.status, 'not_applied')
  assert.throws(() => a.sendMessage('idle'), /active/)
  await a.prompt('new query')
  assert.ok(!JSON.stringify(a.getMessages()).includes('another request'))
})

test('interactive question event can be answered within the same iterator', { timeout: 2000 }, async t => {
  let calls = 0; let received: any[] = []
  const a = fixture(t, async (p: any) => { received = p.messages; return ++calls === 1 ? call('AskUserQuestion', { question: 'Which?', options: ['A', 'B'] }) : done() }, { tools: [AskUserQuestionTool], interactive: true })
  for await (const event of a.query('test')) if (event.type === 'system' && event.subtype === 'question') {
    assert.equal(a.getPendingQuestions().length, 1)
    a.answerQuestion(event.question_id, 'A')
    assert.throws(() => a.answerQuestion(event.question_id, 'B'), /pending/)
  }
  assert.equal(a.getPendingQuestions().length, 0)
  assert.ok(JSON.stringify(received).includes('"content":"A"'))
})

test('breaking on a pending question cancels the wait and releases run ownership', { timeout: 2000 }, async t => {
  const a = fixture(t, async () => call('AskUserQuestion', { question: 'Wait?' }), { tools: [AskUserQuestionTool], interactive: true })
  for await (const event of a.query('test')) if (event.type === 'system' && event.subtype === 'question') break
  assert.equal(a.getPendingQuestions().length, 0)
  await a.close()
})

test('legacy question handler can be interrupted even if it never resolves', { timeout: 2000 }, async t => {
  let started!: () => void
  const entered = new Promise<void>(resolve => started = resolve)
  const a = fixture(t, async () => call('AskUserQuestion', { question: 'Wait?' }), { tools: [AskUserQuestionTool] })
  setQuestionHandler(async () => { started(); return new Promise<string>(() => {}) }, a.getToolState())
  const running = a.prompt('test')
  await entered; await a.interrupt()
  const result = await running
  assert.equal(result.subtype, 'cancelled')
})

test('steering during a running mutation lets it finish but skips the next mutation', { timeout: 2000 }, async t => {
  let entered!: () => void; let release!: () => void
  const started = new Promise<void>(resolve => entered = resolve)
  const gate = new Promise<void>(resolve => release = resolve)
  let writes = 0; let calls = 0
  const tool = defineTool({ name: 'WriteProbe', description: '', inputSchema: { type: 'object' }, call: async () => { writes++; entered(); await gate; return 'first completed' } })
  const a = fixture(t, async () => ++calls === 1 ? { ...call('WriteProbe'), content: [{ type: 'tool_use', id: '1', name: 'WriteProbe', input: {} }, { type: 'tool_use', id: '2', name: 'WriteProbe', input: {} }] } : done(), { tools: [tool] })
  const run = a.prompt('test')
  await started
  const id = a.sendMessage('stop editing; explain instead')
  release()
  const result = await run
  assert.equal(writes, 1); assert.equal(result.is_error, false); assert.equal(a.getMessageStatus(id)?.status, 'applied')
})

for (const action of ['cancel', 'timeout', 'multiselect'] as const) test(`interactive question ${action} has explicit resolution`, { timeout: 2000 }, async t => {
  let calls = 0; let received = ''; const closed: string[] = []
  const a = fixture(t, async (p: any) => { received = JSON.stringify(p.messages); return ++calls === 1 ? call('AskUserQuestion', { question: 'Which?', options: ['A', 'B'], allow_multiselect: true }) : done() }, { interactive: true, questionTimeoutMs: action === 'timeout' ? 25 : 1000, tools: [AskUserQuestionTool] })
  for await (const event of a.query('test')) {
    if (event.type === 'system' && event.subtype === 'question') {
      if (action === 'cancel') a.cancelQuestion(event.question_id)
      if (action === 'multiselect') a.answerQuestion(event.question_id, ['A', 'B'])
    }
    if (event.type === 'system' && event.subtype === 'question_closed') closed.push(event.status)
  }
  assert.deepEqual(closed, [action === 'cancel' ? 'cancelled' : action === 'timeout' ? 'timed_out' : 'answered'])
  assert.equal(a.getPendingQuestions().length, 0)
  if (action !== 'multiselect') assert.match(received, /Question unanswered/)
  else assert.ok(received.includes('A') && received.includes('B'))
})

test('question IDs are session-scoped and invalid answers do not consume a question', async t => {
  let calls = 0
  const a = fixture(t, async () => ++calls === 1 ? call('AskUserQuestion', { question: 'Which?' }) : done(), { interactive: true, tools: [AskUserQuestionTool] })
  const b = fixture(t, async () => done())
  for await (const event of a.query('test')) if (event.type === 'system' && event.subtype === 'question') {
    assert.throws(() => b.answerQuestion(event.question_id, 'wrong'), /pending/)
    assert.throws(() => a.answerQuestion(event.question_id, ['A']), /Invalid/)
    assert.throws(() => a.answerQuestion(event.question_id, ''), /non-empty/)
    assert.equal(a.getPendingQuestions().length, 1)
    a.answerQuestion(event.question_id, 'free text')
  }
})

test('input is still checked by UserPromptSubmit hooks', async t => {
  let calls = 0; let received = ''
  const a = fixture(t, async (p: any) => { received = JSON.stringify(p.messages); calls++; return done() }, {
    hooks: { UserPromptSubmit: [{ timeout: 100, hooks: [async (input: any) => ({ block: input.toolInput === 'forbidden' })] }] },
  })
  let id = ''
  for await (const event of a.query('test')) if (event.type === 'assistant' && !id) id = a.sendMessage('forbidden')
  assert.equal(a.getMessageStatus(id)?.status, 'not_applied')
  assert.match(a.getMessageStatus(id)?.reason || '', /hook/)
  assert.ok(!received.includes('forbidden')); assert.equal(calls, 2)
})

test('early exit records unapplied messages and enforces bounded pending input', async t => {
  const a = fixture(t, async () => done())
  const ids: string[] = []
  for await (const event of a.query('test')) if (event.type === 'assistant') {
    assert.throws(() => a.sendMessage(' '), /non-empty/)
    for (let i = 0; i < 128; i++) ids.push(a.sendMessage(`message ${i}`))
    assert.throws(() => a.sendMessage('overflow'), /limit/)
    break
  }
  for (const id of ids) assert.equal(a.getMessageStatus(id)?.status, 'not_applied')
})

test('background child questions are delivered while the parent waits for child completion', { timeout: 2000 }, async t => {
  const { AgentTool } = await import('../src/tools/agent-tool.js')
  let parentCalls = 0; let childCalls = 0
  const a = fixture(t, async (p: any) => {
    if (p.system === 'child') return ++childCalls === 1 ? call('AskUserQuestion', { question: 'Child question?' }) : done('child answered')
    return ++parentCalls === 1 ? call('Agent', { prompt: 'test', description: 'child', subagent_type: 'child', run_in_background: true }) : done()
  }, { interactive: true, tools: [AgentTool, AskUserQuestionTool], agents: { child: { description: 'child', prompt: 'child', tools: ['AskUserQuestion'] } } })
  let questions = 0
  for await (const event of a.query('test')) if (event.type === 'system' && event.subtype === 'question') { questions++; a.answerQuestion(event.question_id, 'yes') }
  assert.equal(questions, 1); assert.equal(childCalls, 2)
})

test('superseded calls never enter an approval callback or PreToolUse hook', async t => {
  let approvals = 0; let hooks = 0; let calls = 0
  const tool = defineTool({ name: 'WriteProbe', description: '', inputSchema: { type: 'object' }, call: async () => 'changed' })
  const a = fixture(t, async () => ++calls === 1 ? call('WriteProbe') : done(), {
    tools: [tool], canUseTool: async () => { approvals++; return { behavior: 'allow' } },
    hooks: { PreToolUse: [{ timeout: 100, hooks: [async () => { hooks++ }] }] },
  })
  let sent = false
  for await (const event of a.query('test')) if (event.type === 'assistant' && !sent) { sent = true; a.sendMessage('skip this action') }
  assert.equal(approvals, 0); assert.equal(hooks, 0)
})

test('early exit persists question closure and unapplied receipt terminal events', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { readSessionEvents } = await import('../src/session.js')
  const dir = await mkdtemp(join(tmpdir(), 'sdk-interaction-'))
  const prior = process.env.AGENT_SDK_SESSION_DIR
  process.env.AGENT_SDK_SESSION_DIR = dir
  try {
    const a = fixture(t, async () => call('AskUserQuestion', { question: 'Wait?' }), { sessionId: 'question-test', persistSession: true, tools: [AskUserQuestionTool], interactive: true })
    for await (const event of a.query('test')) if (event.type === 'system' && event.subtype === 'question') { a.sendMessage('new direction'); break }
    const events = (await readSessionEvents('question-test')).map(record => record.event)
    assert.equal(events.filter((e: any) => e.subtype === 'question_closed').length, 1)
    assert.equal(events.filter((e: any) => e.subtype === 'user_message' && e.status === 'not_applied').length, 1)
    await a.close()
  } finally {
    if (prior === undefined) delete process.env.AGENT_SDK_SESSION_DIR; else process.env.AGENT_SDK_SESSION_DIR = prior
    await rm(dir, { recursive: true, force: true })
  }
})

test('a stale question callback cannot create questions in a later run', async t => {
  let ask: any; let calls = 0
  const tool = defineTool({ name: 'Capture', description: '', inputSchema: { type: 'object' }, isReadOnly: true, call: async (_input, context) => { ask = context.askQuestion; return 'captured' } })
  const a = fixture(t, async () => ++calls === 1 ? call('Capture') : done(), { interactive: true, tools: [tool] })
  await a.prompt('test')
  for await (const event of a.query('next')) if (event.type === 'system' && event.subtype === 'init') {
    const attempt = ask({ question: 'stale' }, new AbortController().signal).catch((error: Error) => error)
    const pending = a.getPendingQuestions()
    for (const question of pending) a.cancelQuestion(question.question_id)
    const error = await attempt
    assert.equal(pending.length, 0)
    assert.match(error.message, /ending/)
  }
})

test('closing midway through terminal receipts persists every unapplied message', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { readSessionEvents } = await import('../src/session.js')
  const dir = await mkdtemp(join(tmpdir(), 'sdk-receipts-'))
  const prior = process.env.AGENT_SDK_SESSION_DIR
  process.env.AGENT_SDK_SESSION_DIR = dir
  const a = fixture(t, async () => done(), { maxTurns: 1, sessionId: 'receipts', persistSession: true })
  try {
    for await (const event of a.query('test')) {
      if (event.type === 'assistant') { a.sendMessage('one'); a.sendMessage('two') }
      if (event.type === 'system' && event.subtype === 'user_message' && event.status === 'not_applied') break
    }
    const events = await readSessionEvents('receipts')
    assert.equal(events.filter((record: any) => record.event.status === 'not_applied').length, 2)
  } finally {
    await a.close()
    if (prior === undefined) delete process.env.AGENT_SDK_SESSION_DIR; else process.env.AGENT_SDK_SESSION_DIR = prior
    await rm(dir, { recursive: true, force: true })
  }
})

test('steering during partial output skips the eventual tool call without replaying the stream', async t => {
  let writes = 0; let streams = 0; let received = ''
  const tool = defineTool({ name: 'WriteProbe', description: '', inputSchema: { type: 'object' }, call: async () => { writes++; return 'changed' } })
  const a = fixture(t, async () => { throw Error('buffered request should not run') }, { tools: [tool], includePartialMessages: true })
  ;(a as any).provider.streamMessage = async function* (params: any) {
    received = JSON.stringify(params.messages)
    if (++streams === 1) { yield { type: 'text', text: 'planning an edit' }; yield { type: 'response', response: call('WriteProbe') } }
    else yield { type: 'response', response: done('explained') }
  }
  let id = ''
  for await (const event of a.query('edit')) if (event.type === 'partial_message') id = a.sendMessage('do not edit')
  assert.equal(streams, 2); assert.equal(writes, 0)
  assert.ok(received.includes('do not edit')); assert.equal(a.getMessageStatus(id)?.status, 'applied')
})
