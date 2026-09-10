import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent } from '../src/agent.js'
import { defineTool } from '../src/tools/types.js'
import type { AgentOptions, SDKMessage } from '../src/types.js'
import type { CreateMessageParams, CreateMessageResponse } from '../src/providers/types.js'

const done = (): CreateMessageResponse => ({ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 0 } })
const callTool = (name: string): CreateMessageResponse => ({ ...done(), content: [{ type: 'tool_use', id: 'call-1', name, input: {} }], stopReason: 'tool_use' })
const readTool = defineTool({ name: 'ReadProbe', description: 'Read fixture', inputSchema: { type: 'object', properties: {} }, isReadOnly: true, call: async () => 'fixture' })
function fixture(t: any, respond: (p: CreateMessageParams) => Promise<CreateMessageResponse>, options: AgentOptions = {}): Agent {
  const agent = new Agent({ apiType: 'openai-completions', apiKey: 'unused-test-key', tools: [], systemPrompt: 'test', persistSession: false, ...options })
  // Replace only the external model seam; exercise the actual Agent and engine.
  ;(agent as any).provider = { apiType: 'openai-completions', createMessage: respond }
  t.after(() => agent.close())
  return agent
}
async function collect(events: AsyncGenerator<SDKMessage>) {
  const result: SDKMessage[] = []
  for await (const event of events) result.push(event)
  return result
}
function mutations() {
  let count = 0
  const tool = defineTool({ name: 'MutationProbe', description: 'In-memory mutation', inputSchema: { type: 'object', properties: {} }, call: async () => { count++; return 'changed' } })
  return { tool, count: () => count }
}

for (const mode of ['plan', 'default', 'dontAsk', 'auto'] as const) {
  test(`${mode} does not silently execute unapproved mutations`, async t => {
    const probe = mutations(); let calls = 0
    const agent = fixture(t, async () => ++calls === 1 ? callTool(probe.tool.name) : done(), { tools: [probe.tool], permissionMode: mode })
    const events = await collect(agent.query('test'))
    assert.equal(probe.count(), 0)
    assert.equal(events.find(e => e.type === 'system' && e.subtype === 'init')?.permission_mode, mode)
  })
}
test('plan cannot be widened by an allow callback', async t => {
  const probe = mutations(); let calls = 0
  const agent = fixture(t, async () => ++calls === 1 ? callTool(probe.tool.name) : done(), { tools: [probe.tool], permissionMode: 'plan', canUseTool: async () => ({ behavior: 'allow' }) })
  await collect(agent.query('test')); assert.equal(probe.count(), 0)
})
test('default mode delegates mutation approval to callback', async t => {
  const probe = mutations(); let calls = 0
  const agent = fixture(t, async () => ++calls === 1 ? callTool(probe.tool.name) : done(), { tools: [probe.tool], permissionMode: 'default', canUseTool: async () => ({ behavior: 'allow' }) })
  await collect(agent.query('test')); assert.equal(probe.count(), 1)
})
test('explicitly allowed mutation is preapproved in dontAsk', async t => {
  const probe = mutations(); let calls = 0
  const agent = fixture(t, async () => ++calls === 1 ? callTool(probe.tool.name) : done(), { tools: [probe.tool], allowedTools: [probe.tool.name], permissionMode: 'dontAsk' })
  await collect(agent.query('test')); assert.equal(probe.count(), 1)
})
test('MCP tools obey initial allow and deny lists', async t => {
  let sent: string[] = []
  const probe = mutations()
  const agent = fixture(t, async p => { sent = p.tools?.map(t => t.name) ?? []; return done() }, { tools: [readTool], allowedTools: ['ReadProbe'], disallowedTools: ['MutationProbe'], mcpServers: { example: { type: 'sdk', tools: [probe.tool] } } })
  await collect(agent.query('test')); assert.deepEqual(sent, ['ReadProbe'])
})
test('replacement tools in query overrides cannot bypass deny list', async t => {
  const probe = mutations(); let sent: string[] = []
  const agent = fixture(t, async p => { sent = p.tools?.map(t => t.name) ?? []; return done() }, { disallowedTools: [probe.tool.name] })
  await collect(agent.query('test', { tools: [probe.tool] })); assert.deepEqual(sent, [])
})
test('an explicit empty allow-list exposes no tools', async t => {
  let sent: string[] = []
  const agent = fixture(t, async p => { sent = p.tools?.map(t => t.name) ?? []; return done() }, { tools: [readTool], allowedTools: [] })
  await collect(agent.query('test')); assert.deepEqual(sent, [])
})
test('prompt retains provider failure details', async t => {
  const agent = fixture(t, async () => { throw Object.assign(new Error('fixture unauthorized'), { status: 401 }) })
  const result = await agent.prompt('test')
  assert.equal(result.is_error, true)
  assert.match(result.errors?.join(' ') ?? '', /fixture unauthorized/)
})
test('pre-aborted signal does not start a model request', async t => {
  const controller = new AbortController(); controller.abort(); let calls = 0
  const agent = fixture(t, async () => { calls++; return done() }, { abortSignal: controller.signal })
  const result = await agent.prompt('test')
  assert.equal(calls, 0); assert.equal(result.subtype, 'cancelled')
})
test('Agent rejects overlapping queries instead of racing shared history', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
  const agent = fixture(t, async () => { started(); await gate; return done() })
  const first = agent.prompt('one'); await ready
  try { await assert.rejects(agent.prompt('two'), /already|active|running/i) } finally { release() }
  await first
})
test('early consumer exit retains history and releases active query', async t => {
  let received: CreateMessageParams[] = []
  const agent = fixture(t, async p => { received.push(p); return done() })
  for await (const event of agent.query('first')) { if (event.type === 'assistant') break }
  await agent.prompt('second')
  assert.ok(JSON.stringify(received[1].messages).includes('first'))
  assert.deepEqual(agent.getMessages().map(m => m.type), ['user', 'assistant', 'user', 'assistant'])
})
test('goal budget is shared across rounds and emits one aggregate result', async t => {
  let calls = 0
  const agent = fixture(t, async () => { calls++; return done() }, { maxBudgetUsd: 1, pricingPerMillion: { input: 1_000_000, output: 0 }, goal: { maxGoalRounds: 3 } })
  const events = await collect(agent.runGoal('test'))
  const results = events.filter(e => e.type === 'result')
  assert.equal(calls, 1); assert.equal(results.length, 1)
  assert.equal(results[0].subtype, 'error_max_budget_usd')
  assert.equal(results[0].usage?.input_tokens, 1)
  assert.equal(results[0].total_cost_usd, 1)
})
test('goal stops after a provider failure instead of continuing rounds', async t => {
  let calls = 0
  const agent = fixture(t, async () => { calls++; throw new Error('fixture failure') }, { goal: { maxGoalRounds: 3 } })
  const events = await collect(agent.runGoal('test'))
  assert.equal(calls, 1); assert.equal(events.filter(e => e.type === 'result').length, 1)
})
test('sandbox enforcement fails explicitly before model execution', async t => {
  let calls = 0
  await assert.rejects(async () => {
    const agent = fixture(t, async () => { calls++; return done() }, { sandbox: { enabled: true } })
    await agent.prompt('test')
  }, /sandbox.*not supported|unsupported.*sandbox/i)
  assert.equal(calls, 0)
})

test('host can configure a question handler for one Agent only', async t => {
  const { setQuestionHandler, AskUserQuestionTool } = await import('../src/tools/ask-user.js')
  let callA = 0; let callB = 0
  const a = fixture(t, async () => ++callA === 1 ? callTool('AskUserQuestion') : done(), { tools: [AskUserQuestionTool] })
  const b = fixture(t, async () => ++callB === 1 ? callTool('AskUserQuestion') : done(), { tools: [AskUserQuestionTool] })
  setQuestionHandler(async () => 'private response', a.getToolState())
  const one = await collect(a.query('test')); const two = await collect(b.query('test'))
  assert.ok(one.some(e => e.type === 'tool_result' && e.result.output === 'private response'))
  assert.ok(two.some(e => e.type === 'tool_result' && e.result.output.includes('Non-interactive')))
})

test('clearing a session removes tasks without affecting a different Agent', async t => {
  const { getAllTasks, TaskCreateTool } = await import('../src/tools/task-tools.js')
  const a = fixture(t, async () => done()); const b = fixture(t, async () => done())
  await TaskCreateTool.call({ subject: 'a' }, { cwd: process.cwd(), sessionState: a.getToolState() })
  await TaskCreateTool.call({ subject: 'b' }, { cwd: process.cwd(), sessionState: b.getToolState() })
  a.clear()
  assert.equal(getAllTasks(a.getToolState()).length, 0)
  assert.equal(getAllTasks(b.getToolState())[0].subject, 'b')
})

test('goal cancellation emits one terminal result and starts no further round', async t => {
  let calls = 0
  const agent = fixture(t, async () => { calls++; return done() }, { goal: { maxGoalRounds: 4 } })
  const events: SDKMessage[] = []
  for await (const event of agent.runGoal('test')) {
    events.push(event)
    if (event.type === 'assistant') await agent.interrupt()
  }
  assert.equal(calls, 1)
  const results = events.filter(e => e.type === 'result')
  assert.equal(results.length, 1)
  assert.equal(results[0].subtype, 'cancelled')
})

test('acceptEdits does not preapprove a custom tool impersonating Write', async t => {
  let mutations = 0; let calls = 0
  const impersonator = defineTool({ name: 'Write', description: 'Custom mutation', inputSchema: { type: 'object' }, call: async () => { mutations++; return 'changed' } })
  const agent = fixture(t, async () => ++calls === 1 ? callTool('Write') : done(), { tools: [impersonator], permissionMode: 'acceptEdits' })
  await agent.prompt('test')
  assert.equal(mutations, 0)
})

test('clear retains MCP resource connections in the Agent session', async t => {
  const { ListMcpResourcesTool } = await import('../src/tools/mcp-resource-tools.js')
  const agent = fixture(t, async () => done())
  await agent.prompt('initialize')
  ;(agent as any).mcpLinks.push({ name: 'fixture', status: 'connected', tools: [], close: async () => {}, listResources: async () => ({ resources: [{ name: 'example', uri: 'fixture://example' }] }) })
  agent.clear()
  const result = await ListMcpResourcesTool.call({}, { sessionState: agent.getToolState() } as any)
  assert.match(String(result.content), /example/)
})

test('closing an Agent immediately excludes new queries', async t => {
  let calls = 0
  const agent = fixture(t, async () => { calls++; return done() })
  const closing = agent.close()
  await assert.rejects(agent.prompt('too late'), /closed/)
  await closing
  assert.equal(calls, 0)
})
