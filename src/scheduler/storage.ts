import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScheduledJob, ScheduledRun } from './types.js'

interface SchedulerFile { version: 1; jobs: ScheduledJob[] }
interface LockFile { pid: number; token: string; createdAt: string }

function isString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }

function validRun(run: unknown): run is ScheduledRun {
  if (!run || typeof run !== 'object') return false
  const value = run as Partial<ScheduledRun>
  return isString(value.id) && isString(value.scheduledAt) && isString(value.trigger) && isString(value.status)
}

function validJob(job: unknown): job is ScheduledJob {
  if (!job || typeof job !== 'object') return false
  const value = job as Partial<ScheduledJob>
  return isString(value.id) && isString(value.name) && isString(value.prompt) &&
    (!!value.cron !== !!value.runAt) && isString(value.timeZone) && isString(value.status) &&
    isString(value.createdAt) && isString(value.updatedAt) && Array.isArray(value.runs) && value.runs.every(validRun)
}

export class SchedulerStorage {
  private readonly directory: string
  private readonly statePath: string
  private readonly lockPath: string
  private lockToken?: string

  constructor(sessionId: string, sessionsDirectory?: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id')
    const root = sessionsDirectory ?? process.env.AGENT_SDK_SESSION_DIR ?? join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.open-agent-sdk', 'sessions')
    this.directory = join(root, sessionId)
    this.statePath = join(this.directory, 'scheduler.json')
    this.lockPath = join(this.directory, 'scheduler.lock')
  }

  async ensureDirectory(): Promise<void> { await mkdir(this.directory, { recursive: true }) }

  async load(): Promise<ScheduledJob[]> {
    let text: string
    try { text = await readFile(this.statePath, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const data = JSON.parse(text) as Partial<SchedulerFile>
      if (data.version !== 1 || !Array.isArray(data.jobs) || !data.jobs.every(validJob)) throw new Error('invalid schema')
      return structuredClone(data.jobs)
    } catch (error) {
      const quarantine = `${this.statePath}.corrupt-${Date.now()}`
      await rename(this.statePath, quarantine).catch(() => {})
      throw new Error(`Invalid scheduler state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async save(jobs: ScheduledJob[]): Promise<void> {
    await this.ensureDirectory()
    const temporary = join(this.directory, `scheduler-${crypto.randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ version: 1, jobs }, null, 2)); await handle.sync() }
      finally { await handle.close() }
      await rename(temporary, this.statePath)
    } finally { await unlink(temporary).catch(() => {}) }
  }

  async acquireLock(): Promise<void> {
    if (this.lockToken) return
    await this.ensureDirectory()
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = crypto.randomUUID()
      try {
        const handle = await open(this.lockPath, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() } satisfies LockFile)); await handle.sync() }
        finally { await handle.close() }
        this.lockToken = token
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let existing: LockFile | undefined
        try { existing = JSON.parse(await readFile(this.lockPath, 'utf8')) as LockFile } catch { /* stale malformed lock */ }
        if (existing && this.pidIsAlive(existing.pid)) throw new Error(`Scheduler is already active for this session (PID ${existing.pid})`)
        await unlink(this.lockPath).catch(() => {})
      }
    }
    throw new Error('Unable to acquire scheduler lock')
  }

  async releaseLock(): Promise<void> {
    if (!this.lockToken) return
    try {
      const existing = JSON.parse(await readFile(this.lockPath, 'utf8')) as LockFile
      if (existing.token === this.lockToken) await unlink(this.lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally { this.lockToken = undefined }
  }

  private pidIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid < 1) return false
    try { process.kill(pid, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
}
