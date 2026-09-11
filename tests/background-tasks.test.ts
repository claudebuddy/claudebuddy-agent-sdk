import test from 'node:test'
import assert from 'node:assert/strict'
import { BashTool } from '../src/tools/bash.js'
import { AgentTool } from '../src/tools/agent-tool.js'
import { TaskOutputTool, TaskStopTool, TaskUpdateTool, getTask } from '../src/tools/task-tools.js'
import { QueryEngine } from '../src/engine.js'
import type { ToolContext } from '../src/types.js'
const context = (): ToolContext => ({ cwd: process.cwd(), sessionState: new Map() })
const parse = (result: any) => JSON.parse(result.content)

test('background Bash returns a task id, captures output and exit failure', { timeout: 5000 }, async () => {
  const ctx = context()
  const launched = parse(await BashTool.call({ command: 'sleep 0.1; printf ready; exit 7', run_in_background: true }, ctx))
  assert.ok(launched.task_id)
  const out = parse(await TaskOutputTool.call({ id: launched.task_id, block: true, timeout: 2000 }, ctx))
  assert.equal(out.status, 'failed'); assert.match(out.output, /ready/); assert.equal(out.exitCode, 7)
  assert.equal((await TaskOutputTool.call({ id: launched.task_id }, context())).is_error, true)
})

test('TaskStop cancels execution; TaskUpdate cannot forge runtime completion', { timeout: 5000 }, async () => {
  const ctx = context()
  const { task_id } = parse(await BashTool.call({ command: 'sleep 30', run_in_background: true }, ctx))
  try {
    assert.equal((await TaskUpdateTool.call({ id: task_id, status: 'completed' }, ctx)).is_error, true)
    const stopped = await TaskStopTool.call({ id: task_id }, ctx)
    assert.equal(stopped.is_error, undefined)
    const result = parse(await TaskOutputTool.call({ id: task_id, block: true, timeout: 2000 }, ctx))
    assert.equal(result.status, 'cancelled')
  } finally { await TaskStopTool.call({ id: task_id }, ctx) }
})

test('foreground Bash nonzero and timeout are observable errors', { timeout: 5000 }, async () => {
  assert.equal((await BashTool.call({ command: 'exit 3' }, context())).is_error, true)
  const result = await BashTool.call({ command: 'sleep 30', timeout: 30 }, context())
  assert.equal(result.is_error, true); assert.match(String(result.content), /timed out/i)
})

test('background subagent inherits provider, budget and real cancellation', { timeout: 5000 }, async () => {
  const ctx = context()
  let entered!: () => void
  const started = new Promise<void>(resolve => entered = resolve)
  let aborted = false
  ctx.provider = { apiType: 'openai-completions', createMessage: async params => {
    entered()
    return await new Promise((_, reject) => params.signal!.addEventListener('abort', () => { aborted = true; reject(Error('cancelled')) }, { once: true }))
  } }
  ctx.tools = []; ctx.agents = {}
  const { task_id } = parse(await AgentTool.call({ prompt: 'test', description: 'test', run_in_background: true }, ctx))
  await started
  await TaskStopTool.call({ id: task_id }, ctx)
  await TaskOutputTool.call({ id: task_id, block: true, timeout: 2000 }, ctx)
  assert.equal(aborted, true); assert.equal(getTask(task_id, ctx.sessionState)?.status, 'cancelled')
})

test('engine drains background children before reporting shared usage', { timeout: 5000 }, async () => {
  const ledger = { cost: 0, usage: { input_tokens: 0, output_tokens: 0 } }
  let parentCalls = 0
  const engine = new QueryEngine({ cwd: process.cwd(), model: 'test', systemPrompt: 'parent', tools: [AgentTool], agents: { child: { description: 'child', prompt: 'child', tools: [] } }, maxTurns: 2, maxTokens: 100, includePartialMessages: false, executionBudget: ledger, provider: { apiType: 'openai-completions', createMessage: async params => {
    if (params.system === 'child') { await new Promise(resolve => setTimeout(resolve, 50)); return { content: [{ type: 'text', text: 'child done' }], stopReason: 'end_turn', usage: { input_tokens: 7, output_tokens: 2 } } }
    return { content: ++parentCalls === 1 ? [{ type: 'tool_use', id: '1', name: 'Agent', input: { prompt: 'test', description: 'test', subagent_type: 'child', run_in_background: true } }] : [{ type: 'text', text: 'done' }], stopReason: parentCalls === 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  } } })
  let result: any
  for await (const event of engine.submitMessage('test')) if (event.type === 'result') result = event
  assert.equal(result.subtype, 'success'); assert.equal(result.usage.input_tokens, 9)
})

test('TaskOutput timeout leaves work running; cancellation kills a TERM-resistant process group', { timeout: 5000 }, async () => {
  const ctx = context()
  const { task_id } = parse(await BashTool.call({ command: "trap '' TERM; printf started; sleep 30 & wait", run_in_background: true }, ctx))
  try {
    const deadline = Date.now() + 2000
    while (!getTask(task_id, ctx.sessionState)?.output?.includes('started') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.match(getTask(task_id, ctx.sessionState)?.output || '', /started/)
    const snapshot = parse(await TaskOutputTool.call({ id: task_id, block: true, timeout: 10 }, ctx))
    assert.equal(snapshot.status, 'in_progress')
    await TaskStopTool.call({ id: task_id }, ctx)
    const stopped = parse(await TaskOutputTool.call({ id: task_id, block: true, timeout: 2000 }, ctx))
    assert.equal(stopped.status, 'cancelled')
  } finally { await TaskStopTool.call({ id: task_id }, ctx) }
})

test('early iterator exit cancels and joins running child work', { timeout: 5000 }, async () => {
  let childStarted!: () => void
  const started = new Promise<void>(resolve => childStarted = resolve)
  let childCancelled = false
  const engine = new QueryEngine({ cwd: process.cwd(), model: 'test', systemPrompt: 'parent', tools: [AgentTool], agents: { child: { description: 'child', prompt: 'child', tools: [] } }, maxTurns: 2, maxTokens: 100, includePartialMessages: false, provider: { apiType: 'openai-completions', createMessage: async params => {
    if (params.system === 'child') {
      childStarted()
      return new Promise((_, reject) => params.signal!.addEventListener('abort', () => { childCancelled = true; reject(Error('aborted')) }, { once: true }))
    }
    return { content: [{ type: 'tool_use', id: '1', name: 'Agent', input: { prompt: 'test', description: 'test', subagent_type: 'child', run_in_background: true } }], stopReason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }
  } } })
  for await (const event of engine.submitMessage('test')) if (event.type === 'tool_result') { await started; break }
  assert.equal(childCancelled, true)
})

test('output capture remains bounded for a noisy command', async () => {
  const ctx = context()
  const { task_id } = parse(await BashTool.call({ command: 'yes x | head -c 250000', run_in_background: true }, ctx))
  const result = parse(await TaskOutputTool.call({ id: task_id, block: true, timeout: 2000 }, ctx))
  assert.equal(result.status, 'completed'); assert.ok(result.output.length <= 100000)
})

test('disabled scheduler placeholders are not advertised to the model', async () => {
  const { getAllBaseTools } = await import('../src/tools/index.js')
  let names: string[] = []
  const engine = new QueryEngine({ cwd: process.cwd(), model: 'test', systemPrompt: 'test', tools: getAllBaseTools(), maxTurns: 1, maxTokens: 100, includePartialMessages: false, provider: { apiType: 'openai-completions', createMessage: async params => {
    names = params.tools?.map(tool => tool.name) || []
    return { content: [], stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }
  } } })
  for await (const event of engine.submitMessage('test')) {}
  assert.ok(names.includes('Bash')); assert.ok(names.includes('Agent'))
  for (const name of ['CronCreate', 'CronDelete', 'CronGet', 'CronList', 'CronRun', 'CronUpdate', 'RemoteTrigger']) assert.ok(!names.includes(name))
})
