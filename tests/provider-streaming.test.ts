import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { OpenAIProvider } from '../src/providers/openai.js'
import { AnthropicProvider } from '../src/providers/anthropic.js'
import { readSSE } from '../src/providers/sse.js'
const request = { model: 'fixture', maxTokens: 100, system: 'test', messages: [{ role: 'user' as const, content: 'hello' }] }
const frame = (event: any) => `event: ${event.type || 'message'}\ndata: ${JSON.stringify(event)}\n\n`

test('SSE decoder handles split UTF-8, CRLF, comments and multiline data', async () => {
  const bytes = new TextEncoder().encode(': ping\r\ndata: 你好\r\ndata: world\r\n\r\n')
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } })
  const frames: string[] = []
  for await (const data of readSSE(body)) frames.push(data)
  assert.deepEqual(frames, ['你好\nworld'])
})
for (const kind of ['openai', 'anthropic']) test(`${kind} streams real transport deltas before completion and retains usage`, async t => {
  let release!: () => void
  const gate = new Promise<void>(resolve => release = resolve)
  let ended = false
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    assert.equal(JSON.parse(body).stream, true)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (kind === 'openai') {
      res.write(frame({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] }))
      await gate
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } }))
      res.end('data: [DONE]\n\n')
    } else {
      res.write(frame({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } }))
      res.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      res.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }))
      await gate
      res.write(frame({ type: 'content_block_stop', index: 0 }))
      res.write(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }))
      res.end(frame({ type: 'message_stop' }))
    }
    ended = true
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { release(); server.closeAllConnections(); server.close() })
  const baseURL = `http://127.0.0.1:${(server.address() as any).port}`
  const provider = kind === 'openai' ? new OpenAIProvider({ apiKey: 'unused', baseURL }) : new AnthropicProvider({ apiKey: 'unused', baseURL })
  const events: any[] = []
  for await (const event of provider.streamMessage(request)) {
    events.push(event)
    if (event.type === 'text') { assert.equal(ended, false); release() }
  }
  assert.equal(events[0].text, 'hello')
  assert.deepEqual(events.at(-1).response.content, [{ type: 'text', text: 'hello' }])
  assert.equal(events.at(-1).response.usage.input_tokens, 7)
  assert.equal(events.at(-1).response.usage.output_tokens, 2)
})

test('OpenAI assembles interleaved tool arguments by index and rejects truncated streams', async t => {
  let truncated = false
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const delta = (tool_calls: any[]) => frame({ choices: [{ index: 0, delta: { tool_calls } }] })
    res.write(delta([{ index: 1, id: 'b', function: { name: 'Second', arguments: '{"y":' } }, { index: 0, id: 'a', function: { name: 'First', arguments: '{"x":' } }]))
    if (truncated) { res.end(); return }
    res.write(delta([{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '2}' } }]))
    res.end(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const provider = new OpenAIProvider({ baseURL: `http://127.0.0.1:${(server.address() as any).port}` })
  const events: any[] = []
  for await (const event of provider.streamMessage(request)) events.push(event)
  assert.deepEqual(events.at(-1).response.content, [{ type: 'tool_use', id: 'a', name: 'First', input: { x: 1 } }, { type: 'tool_use', id: 'b', name: 'Second', input: { y: 2 } }])
  truncated = true
  await assert.rejects(async () => { for await (const event of provider.streamMessage(request)) {} }, /before finish_reason/)
})

for (const kind of ['openai', 'anthropic']) test(`${kind} aborts a live stream without a final response`, { timeout: 3000 }, async t => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (kind === 'openai') res.write(frame({ choices: [{ index: 0, delta: { content: 'hello' } }] }))
    else {
      res.write(frame({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }))
      res.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      res.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const baseURL = `http://127.0.0.1:${(server.address() as any).port}`
  const provider = kind === 'openai' ? new OpenAIProvider({ baseURL }) : new AnthropicProvider({ apiKey: 'unused', baseURL })
  const controller = new AbortController()
  let final = false
  await assert.rejects(async () => {
    for await (const event of provider.streamMessage({ ...request, signal: controller.signal })) {
      if (event.type === 'text') controller.abort()
      if (event.type === 'response') final = true
    }
  }, /abort/i)
  assert.equal(final, false)
})
