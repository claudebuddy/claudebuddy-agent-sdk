import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SchedulerStorage } from '../src/scheduler/storage.js'
import type { ScheduledJob } from '../src/scheduler/types.js'

async function tempStorage(t: test.TestContext, id = 'session') {
  const root = await mkdtemp(join(tmpdir(), 'scheduler-storage-'))
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })) })
  return { root, storage: new SchedulerStorage(id, root) }
}

function job(): ScheduledJob {
  return { id: 'job-1', name: 'daily', prompt: 'work', cron: '0 9 * * *', timeZone: 'UTC', status: 'enabled', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', nextRunAt: '2026-01-01T09:00:00.000Z', runs: [] }
}

test('scheduler state is atomically saved with private permissions', async t => {
  const { root, storage } = await tempStorage(t)
  await storage.save([job()])
  const file = join(root, 'session', 'scheduler.json')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await storage.load(), [job()])
  assert.equal((await readdir(join(root, 'session'))).some(name => name.endsWith('.tmp')), false)
})

test('a live scheduler lock rejects a second writer', async t => {
  const { root, storage } = await tempStorage(t)
  await storage.acquireLock()
  t.after(() => storage.releaseLock())
  await assert.rejects(new SchedulerStorage('session', root).acquireLock(), /already active/)
})

test('a stale scheduler lock is recovered', async t => {
  const { root, storage } = await tempStorage(t)
  await storage.ensureDirectory()
  await writeFile(join(root, 'session', 'scheduler.lock'), JSON.stringify({ pid: 99999999, token: 'old', createdAt: '2020-01-01T00:00:00.000Z' }))
  await storage.acquireLock()
  await storage.releaseLock()
  await assert.rejects(readFile(join(root, 'session', 'scheduler.lock')), /ENOENT/)
})

test('corrupt scheduler state is quarantined instead of partially loaded', async t => {
  const { root, storage } = await tempStorage(t)
  await storage.ensureDirectory()
  await writeFile(join(root, 'session', 'scheduler.json'), JSON.stringify({ version: 1, jobs: [{ id: 'broken' }] }))
  await assert.rejects(storage.load(), /Invalid scheduler state/)
  assert.equal((await readdir(join(root, 'session'))).some(name => name.startsWith('scheduler.json.corrupt-')), true)
})
