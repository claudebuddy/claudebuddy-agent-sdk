import assert from 'node:assert/strict'
import test from 'node:test'
import { Scheduler } from '../src/scheduler/scheduler.js'
import { SchedulerStorage } from '../src/scheduler/storage.js'
import type { QueryResult } from '../src/types.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const success = (text = 'ok'): QueryResult => ({ text, subtype: 'success', is_error: false, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1, duration_ms: 1, messages: [] })
const future = () => new Date(Date.now() + 3_600_000).toISOString()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

test('manual runs obey global FIFO concurrency', async () => {
  const first = deferred<QueryResult>()
  const started: string[] = []
  const scheduler = new Scheduler('fifo', { enabled: true, maxConcurrentRuns: 1 }, {
    persistent: false,
    execute: async job => {
      started.push(job.name)
      return job.name === 'first' ? first.promise : success(job.name)
    },
  })
  await scheduler.start()
  const a = await scheduler.create({ name: 'first', prompt: 'a', runAt: future() })
  const b = await scheduler.create({ name: 'second', prompt: 'b', runAt: future() })
  await scheduler.runNow(a.id)
  await scheduler.runNow(b.id)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, ['first'])
  assert.equal((await scheduler.get(b.id))!.runs[0].status, 'queued')
  first.resolve(success('first'))
  await scheduler.whenIdle()
  assert.deepEqual(started, ['first', 'second'])
  await scheduler.close()
})

test('the same job cannot overlap even while queued or running', async () => {
  const gate = deferred<QueryResult>()
  const scheduler = new Scheduler('overlap', { enabled: true }, { persistent: false, execute: () => gate.promise })
  await scheduler.start()
  const job = await scheduler.create({ name: 'job', prompt: 'work', cron: '* * * * *' })
  await scheduler.runNow(job.id)
  const skippedId = await scheduler.runNow(job.id)
  const current = await scheduler.get(job.id)
  assert.equal(current!.runs.find(run => run.id === skippedId)!.status, 'skipped_overlap')
  gate.resolve(success())
  await scheduler.whenIdle()
  await scheduler.close()
})

test('one-shot jobs complete after an admitted terminal attempt', async () => {
  const scheduler = new Scheduler('once', { enabled: true }, { persistent: false, execute: async () => success() })
  await scheduler.start()
  const job = await scheduler.create({ name: 'once', prompt: 'work', runAt: future() })
  await scheduler.runNow(job.id)
  await scheduler.whenIdle()
  assert.equal((await scheduler.get(job.id))!.status, 'completed')
  await assert.rejects(scheduler.runNow(job.id), /completed/)
  await scheduler.close()
})

test('history is bounded and returned jobs are defensive copies', async () => {
  const scheduler = new Scheduler('history', { enabled: true, maxHistoryPerJob: 2 }, { persistent: false, execute: async () => success() })
  await scheduler.start()
  const job = await scheduler.create({ name: 'repeat', prompt: 'work', cron: '* * * * *' })
  for (let i = 0; i < 3; i++) { await scheduler.runNow(job.id); await scheduler.whenIdle() }
  const copy = (await scheduler.get(job.id))!
  assert.equal(copy.runs.length, 2)
  copy.name = 'changed'
  assert.equal((await scheduler.get(job.id))!.name, 'repeat')
  await scheduler.close()
})

test('close cancels active execution and rejects later admission', async () => {
  let aborted = false
  const scheduler = new Scheduler('close', { enabled: true }, {
    persistent: false,
    execute: (_job, signal) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve({ ...success(), subtype: 'cancelled', is_error: true }) }, { once: true })),
  })
  await scheduler.start()
  const job = await scheduler.create({ name: 'job', prompt: 'work', cron: '* * * * *' })
  await scheduler.runNow(job.id)
  await new Promise(resolve => setImmediate(resolve))
  await scheduler.close()
  assert.equal(aborted, true)
  await assert.rejects(scheduler.list(), /closed/)
})

test('an expired one-shot outside the catch-up window becomes completed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'scheduler-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const storage = new SchedulerStorage('expired', root)
  await storage.save([{
    id: 'old', name: 'old', prompt: 'work', runAt: '2026-01-01T00:00:00.000Z', timeZone: 'UTC',
    status: 'enabled', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    nextRunAt: '2026-01-01T00:00:00.000Z', runs: [],
  }])
  const scheduler = new Scheduler('expired', { enabled: true, maxCatchUpAgeMs: 1 }, { storage, execute: async () => success(), now: () => new Date('2026-09-11T00:00:00.000Z') })
  await scheduler.start()
  const job = await scheduler.get('old')
  assert.equal(job?.status, 'completed')
  assert.equal(job?.runs[0].status, 'skipped_misfire')
  await scheduler.close()
})
