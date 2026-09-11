import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent } from '../src/agent.js'
import type { CreateMessageResponse } from '../src/providers/types.js'

const done = (text = 'done'): CreateMessageResponse => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
const future = () => new Date(Date.now() + 3_600_000).toISOString()

test('Agent exposes scheduler methods only after opt-in setup', async t => {
  const disabled = new Agent({ apiType: 'openai-completions', apiKey: 'unused', tools: [], persistSession: false })
  t.after(() => disabled.close())
  await assert.rejects(disabled.listSchedules(), /not enabled/)

  const enabled = new Agent({ apiType: 'openai-completions', apiKey: 'unused', tools: [], persistSession: false, scheduler: { enabled: true } })
  ;(enabled as any).provider = { apiType: 'openai-completions', createMessage: async () => done('scheduled') }
  t.after(() => enabled.close())
  const job = await enabled.createSchedule({ name: 'once', prompt: 'work', runAt: future() })
  assert.equal((await enabled.getSchedule(job.id))?.name, 'once')
  await enabled.runSchedule(job.id)
  await (enabled as any).scheduler.whenIdle()
  assert.equal((await enabled.getSchedule(job.id))?.runs[0].text, 'scheduled')
})

test('scheduled execution does not modify the parent conversation history', async t => {
  const agent = new Agent({ apiType: 'openai-completions', apiKey: 'unused', tools: [], persistSession: false, scheduler: { enabled: true } })
  ;(agent as any).provider = { apiType: 'openai-completions', createMessage: async () => done() }
  t.after(() => agent.close())
  const job = await agent.createSchedule({ name: 'repeat', prompt: 'scheduled', cron: '* * * * *' })
  await agent.runSchedule(job.id)
  await (agent as any).scheduler.whenIdle()
  assert.deepEqual((agent as any).history, [])
  assert.deepEqual((agent as any).messageLog, [])
})

test('closing Agent closes the scheduler before rejecting further calls', async () => {
  const agent = new Agent({ apiType: 'openai-completions', apiKey: 'unused', tools: [], persistSession: false, scheduler: { enabled: true } })
  await agent.close()
  await assert.rejects(agent.listSchedules(), /closed|not enabled/)
})

test('enabled Agent advertises all local scheduler tools but not RemoteTrigger', async t => {
  let names: string[] = []
  const agent = new Agent({ apiType: 'openai-completions', apiKey: 'unused', persistSession: false, scheduler: { enabled: true }, maxTurns: 1 })
  ;(agent as any).provider = { apiType: 'openai-completions', createMessage: async (params: any) => { names = params.tools.map((tool: any) => tool.name); return done() } }
  t.after(() => agent.close())
  await agent.prompt('inspect')
  for (const name of ['CronCreate', 'CronList', 'CronGet', 'CronUpdate', 'CronRun', 'CronDelete']) assert.ok(names.includes(name), name)
  assert.equal(names.includes('RemoteTrigger'), false)
})
