import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSession, loadSession, appendSessionEvent, readSessionEvents } from '../src/session.js'
import { Agent } from '../src/agent.js'

test('durable events tolerate a torn tail and checkpoints repair unknown tool outcomes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-session-'))
  const prior = process.env.AGENT_SDK_SESSION_DIR
  process.env.AGENT_SDK_SESSION_DIR = dir
  t.after(async () => { if (prior === undefined) delete process.env.AGENT_SDK_SESSION_DIR; else process.env.AGENT_SDK_SESSION_DIR = prior; await rm(dir, { recursive: true, force: true }) })
  await saveSession('test', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'write-1', name: 'Write', input: {} }] }], {})
  const raw = JSON.parse(await readFile(join(dir, 'test', 'transcript.json'), 'utf8'))
  assert.equal(raw.messages.length, 1)
  const restored = await loadSession('test')
  assert.equal(restored?.messages.length, 2)
  assert.match(JSON.stringify(restored?.messages[1]), /outcome unknown/)
  await appendSessionEvent('test', { type: 'result', subtype: 'success' })
  const first = await readSessionEvents('test')
  await appendFile(join(dir, 'test', 'events.jsonl'), '{"version":')
  assert.deepEqual(await readSessionEvents('test'), first)
  await appendSessionEvent('test', { type: 'result', subtype: 'cancelled' })
  const rest = await readSessionEvents('test', first[0].id)
  assert.equal(rest.length, 1); assert.equal((rest[0].event as any).subtype, 'cancelled')
  await assert.rejects(readSessionEvents('test', 'missing'), /Unknown/)
  await assert.rejects(saveSession('../escape', [], {}), /Invalid/)

  const agent = new Agent({ tools: [], apiType: 'openai-completions', apiKey: 'unused', systemPrompt: 'test' })
  ;(agent as any).provider = { apiType: 'openai-completions', createMessage: async () => ({ content: [{ type: 'text', text: 'saved before close' }], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) }
  const result = await agent.prompt('hello')
  assert.equal(result.is_error, false)
  const id = (agent as any).sid
  const saved = await loadSession(id)
  assert.match(JSON.stringify(saved?.messages), /saved before close/)
  const events = await readSessionEvents(id)
  assert.deepEqual(events.map(e => e.event.type), ['system', 'assistant', 'result'])
  await agent.close()

  const goalAgent = new Agent({ tools: [], apiType: 'openai-completions', apiKey: 'unused', systemPrompt: 'test', goal: { maxGoalRounds: 2, turnsPerRound: 1 } })
  ;(goalAgent as any).provider = (agent as any).provider
  for await (const event of goalAgent.runGoal('unfinished')) {}
  const goalEvents = await readSessionEvents((goalAgent as any).sid)
  const terminals = goalEvents.filter(e => e.event.type === 'result')
  assert.equal(terminals.length, 1)
  assert.equal((terminals[0].event as any).subtype, 'error_max_rounds')
  await goalAgent.close()
})
