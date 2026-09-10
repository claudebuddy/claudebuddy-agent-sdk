import test from 'node:test'
import assert from 'node:assert/strict'
import { QueryEngine } from '../src/engine.js'
import { defineTool } from '../src/tools/types.js'
const final = { content: [{ type: 'text', text: 'hello' }], stopReason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } }
function engine(provider: any, tools: any[] = []) {
  return new QueryEngine({ provider, tools, model: 'test', maxTurns: 1, maxTokens: 100, systemPrompt: 'test', cwd: process.cwd(), includePartialMessages: true } as any)
}
test('partial messages arrive before final response and closing iterator closes transport', async () => {
  let completed = false; let closed = false
  const provider = { apiType: 'openai-completions', createMessage: async () => { throw Error('buffered fallback called') }, async *streamMessage() {
    try { yield { type: 'text', text: 'hel' }; yield { type: 'text', text: 'lo' }; completed = true; yield { type: 'response', response: final } }
    finally { closed = true }
  } }
  for await (const event of engine(provider).submitMessage('hi')) {
    if (event.type === 'partial_message') { assert.equal(completed, false); break }
  }
  assert.equal(closed, true)
  const events: any[] = []
  for await (const event of engine(provider).submitMessage('hi')) events.push(event)
  assert.deepEqual(events.filter(e => e.type === 'partial_message').map(e => e.partial.text), ['hel', 'lo'])
  assert.equal(events.at(-1).subtype, 'success')
  assert.equal(events.at(-1).usage.input_tokens, 2)
})
test('failed partial stream never retries or dispatches unfinished tool arguments', async () => {
  let attempts = 0; let ran = false
  const tool = defineTool({ name: 'Write', description: '', inputSchema: { type: 'object' }, call: async () => { ran = true; return '' } })
  const provider = { apiType: 'openai-completions', async *streamMessage() { attempts++; yield { type: 'tool_use', index: 0, name: 'Write', input: '{' }; throw Object.assign(Error('disconnect'), { status: 500 }) } }
  const events: any[] = []
  for await (const event of engine(provider, [tool]).submitMessage('hi')) events.push(event)
  assert.equal(events.at(-1).is_error, true); assert.equal(attempts, 1); assert.equal(ran, false)
})
test('scheduler preserves mutation barriers and only overlaps explicitly safe adjacent reads', async () => {
  const order: string[] = []; let value = 0; let reads = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => release = resolve)
  const write = defineTool({ name: 'Write', description: '', inputSchema: { type: 'object' }, call: async () => { value = 1; order.push('write'); return '' } })
  const safe = (name: string) => defineTool({ name, description: '', inputSchema: { type: 'object' }, isReadOnly: true, isConcurrencySafe: true, call: async () => {
    assert.equal(value, 1); order.push(name); if (++reads === 2) release(); await gate; return ''
  } })
  const serial = defineTool({ name: 'UnsafeRead', description: '', inputSchema: { type: 'object' }, isReadOnly: true, isConcurrencySafe: false, call: async () => { assert.equal(reads, 2); order.push('serial'); return '' } })
  const tools = [write, safe('Read1'), safe('Read2'), serial]
  const provider = { apiType: 'openai-completions', createMessage: async () => ({ ...final, stopReason: 'tool_use', content: tools.map((tool, index) => ({ type: 'tool_use', id: String(index), name: tool.name, input: {} })) }) }
  for await (const event of engine(provider, tools).submitMessage('hi')) {}
  assert.deepEqual(order, ['write', 'Read1', 'Read2', 'serial'])
})
