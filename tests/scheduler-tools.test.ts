import assert from 'node:assert/strict'
import test from 'node:test'
import { Scheduler } from '../src/scheduler/scheduler.js'
import { setSessionScheduler, CronCreateTool, CronListTool, CronGetTool, CronUpdateTool, CronRunTool, CronDeleteTool } from '../src/tools/cron-tools.js'
import type { ToolContext } from '../src/types.js'

function context(scheduler: Scheduler): ToolContext {
  const sessionState = new Map<string, unknown>()
  setSessionScheduler(scheduler, sessionState)
  return { cwd: process.cwd(), sessionState }
}

test('cron tools share the scheduler and accept deprecated aliases', async t => {
  const scheduler = new Scheduler('tools', { enabled: true }, { persistent: false, execute: async () => ({ text: 'ok', subtype: 'success', is_error: false, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, num_turns: 1, duration_ms: 1, messages: [] }) })
  await scheduler.start(); t.after(() => scheduler.close())
  const ctx = context(scheduler)
  const created = await CronCreateTool.call({ name: 'job', schedule: '* * * * *', command: 'work' }, ctx)
  const id = JSON.parse(String(created.content)).id as string
  assert.equal((await CronListTool.call({}, ctx)).is_error, undefined)
  assert.match(String((await CronGetTool.call({ id }, ctx)).content), /"job"/)
  assert.match(String((await CronUpdateTool.call({ id, action: 'pause' }, ctx)).content), /paused/)
  assert.ok(JSON.parse(String((await CronRunTool.call({ id }, ctx)).content)).runId)
  await scheduler.whenIdle()
  assert.equal(JSON.parse(String((await CronDeleteTool.call({ id }, ctx)).content)).deleted, true)
})

test('cron tools report missing scheduler and unknown jobs as tool errors', async () => {
  assert.equal((await CronListTool.call({}, { cwd: process.cwd(), sessionState: new Map() })).is_error, true)
  const scheduler = new Scheduler('missing', { enabled: true }, { persistent: false, execute: async () => { throw new Error('unused') } })
  await scheduler.start()
  const result = await CronGetTool.call({ id: 'missing' }, context(scheduler))
  assert.equal(result.is_error, true)
  await scheduler.close()
})
