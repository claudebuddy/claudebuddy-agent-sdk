import type { QueryResult } from '../types.js'
import { nextCronOccurrence, normalizeSchedulerOptions, validateScheduleInput } from './schedule.js'
import { SchedulerStorage } from './storage.js'
import type { NormalizedSchedulerOptions, ScheduleInput, SchedulePatch, ScheduledJob, ScheduledRun, ScheduledRunTrigger, SchedulerEvent } from './types.js'

const MAX_TIMER_DELAY = 2_147_483_647

export interface SchedulerDependencies {
  execute: (job: ScheduledJob, signal: AbortSignal) => Promise<QueryResult>
  persistent?: boolean
  storage?: SchedulerStorage
  now?: () => Date
}

interface QueuedRun { jobId: string; runId: string }

export class Scheduler {
  private readonly options: NormalizedSchedulerOptions
  private readonly storage?: SchedulerStorage
  private readonly jobs = new Map<string, ScheduledJob>()
  private readonly queue: QueuedRun[] = []
  private readonly activeJobs = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly executions = new Set<Promise<void>>()
  private timer?: NodeJS.Timeout
  private runningCount = 0
  private started = false
  private closed = false

  constructor(private readonly sessionId: string, options: import('./types.js').SchedulerOptions, private readonly deps: SchedulerDependencies) {
    this.options = normalizeSchedulerOptions(options)
    if (deps.persistent !== false) this.storage = deps.storage ?? new SchedulerStorage(sessionId)
  }

  async start(): Promise<void> {
    if (this.started) return
    if (this.closed) throw new Error('Scheduler is closed')
    if (this.storage) {
      await this.storage.acquireLock()
      try {
        for (const job of await this.storage.load()) this.jobs.set(job.id, job)
        await this.recover()
      } catch (error) {
        await this.emit({ type: 'storage_error', timestamp: this.iso(), sessionId: this.sessionId, error: error instanceof Error ? error.message : String(error) })
        if (!String(error).includes('Invalid scheduler state')) { await this.storage.releaseLock(); throw error }
      }
    }
    this.started = true
    this.armTimer()
  }

  async create(input: ScheduleInput): Promise<ScheduledJob> {
    this.assertUsable()
    if (this.jobs.size >= this.options.maxJobs) throw new Error(`Scheduler job limit reached (${this.options.maxJobs})`)
    const normalized = validateScheduleInput({ ...input, timeZone: input.timeZone ?? this.options.timeZone }, this.now())
    const now = this.iso()
    const job: ScheduledJob = {
      ...normalized,
      id: crypto.randomUUID(),
      timeZone: normalized.timeZone!,
      status: 'enabled',
      createdAt: now,
      updatedAt: now,
      nextRunAt: normalized.cron ? nextCronOccurrence(normalized.cron, normalized.timeZone!, this.now()).toISOString() : normalized.runAt,
      runs: [],
    }
    this.jobs.set(job.id, job)
    await this.persist()
    await this.emitJob('job_created', job.id)
    this.armTimer()
    return this.copy(job)
  }

  async list(): Promise<ScheduledJob[]> { this.assertUsable(); return [...this.jobs.values()].map(job => this.copy(job)) }
  async get(id: string): Promise<ScheduledJob | undefined> { this.assertUsable(); const job = this.jobs.get(id); return job ? this.copy(job) : undefined }

  async update(id: string, patch: SchedulePatch): Promise<ScheduledJob> {
    this.assertUsable()
    const job = this.requireJob(id)
    if (this.activeJobs.has(id) && (patch.cron !== undefined || patch.runAt !== undefined)) throw new Error('Cannot change the schedule while a run is active')
    const scheduleChanged = patch.cron !== undefined || patch.runAt !== undefined
    const merged = validateScheduleInput({
      name: patch.name ?? job.name,
      prompt: patch.prompt ?? job.prompt,
      cron: scheduleChanged ? patch.cron : job.cron,
      runAt: scheduleChanged ? patch.runAt : job.runAt,
      timeZone: patch.timeZone ?? job.timeZone,
      model: patch.model ?? job.model,
      maxTurns: patch.maxTurns ?? job.maxTurns,
      maxBudgetUsd: patch.maxBudgetUsd ?? job.maxBudgetUsd,
    }, this.now())
    Object.assign(job, merged, {
      status: patch.enabled === undefined ? job.status : patch.enabled ? 'enabled' : 'paused',
      updatedAt: this.iso(),
      nextRunAt: scheduleChanged || patch.timeZone !== undefined
        ? merged.cron ? nextCronOccurrence(merged.cron, merged.timeZone!, this.now()).toISOString() : merged.runAt
        : job.nextRunAt,
    })
    await this.persist(); await this.emitJob('job_updated', id); this.armTimer()
    return this.copy(job)
  }

  async runNow(id: string): Promise<string> {
    this.assertUsable()
    const job = this.requireJob(id)
    if (job.status === 'completed') throw new Error('One-shot job is completed and cannot run again')
    return this.admit(job, 'manual', this.iso())
  }

  async delete(id: string): Promise<boolean> {
    this.assertUsable()
    if (this.activeJobs.has(id)) throw new Error('Cannot delete a job while a run is active')
    const deleted = this.jobs.delete(id)
    if (deleted) { await this.persist(); await this.emitJob('job_deleted', id); this.armTimer() }
    return deleted
  }

  async whenIdle(): Promise<void> {
    while (this.executions.size || this.queue.length) await Promise.allSettled([...this.executions])
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    for (const queued of this.queue.splice(0)) this.finishCancelled(queued.jobId, queued.runId)
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.allSettled([...this.executions])
    await this.persist()
    await this.storage?.releaseLock()
  }

  private async recover(): Promise<void> {
    const now = this.now()
    for (const job of this.jobs.values()) {
      for (const run of job.runs) {
        if (run.status === 'running' || run.status === 'queued') {
          run.status = 'interrupted_unknown'; run.finishedAt = now.toISOString()
        }
      }
      if (job.status !== 'enabled' || !job.nextRunAt || Date.parse(job.nextRunAt) > now.getTime()) continue
      const age = now.getTime() - Date.parse(job.nextRunAt)
      if (this.options.maxCatchUpAgeMs > 0 && age <= this.options.maxCatchUpAgeMs) await this.admit(job, 'catch_up', job.nextRunAt)
      else await this.skip(job, 'skipped_misfire', job.nextRunAt)
    }
    await this.persist()
  }

  private async admit(job: ScheduledJob, trigger: ScheduledRunTrigger, scheduledAt: string): Promise<string> {
    const run: ScheduledRun = { id: crypto.randomUUID(), scheduledAt, admittedAt: this.iso(), trigger, status: 'queued' }
    if (this.activeJobs.has(job.id)) {
      run.status = 'skipped_overlap'; run.finishedAt = this.iso(); this.addRun(job, run)
      if (trigger !== 'manual') this.advance(job)
      await this.persist(); await this.emitRun('run_skipped_overlap', job.id, run.id)
      return run.id
    }
    this.activeJobs.add(job.id); this.addRun(job, run)
    if (trigger !== 'manual') this.advance(job)
    this.queue.push({ jobId: job.id, runId: run.id })
    await this.persist(); await this.emitRun('run_queued', job.id, run.id)
    this.dispatch(); this.armTimer()
    return run.id
  }

  private dispatch(): void {
    while (!this.closed && this.runningCount < this.options.maxConcurrentRuns && this.queue.length) {
      const item = this.queue.shift()!
      const task = this.execute(item).finally(() => { this.executions.delete(task); this.dispatch() })
      this.executions.add(task)
    }
  }

  private async execute(item: QueuedRun): Promise<void> {
    const job = this.requireJob(item.jobId)
    const run = job.runs.find(value => value.id === item.runId)!
    const controller = new AbortController()
    this.controllers.set(run.id, controller); this.runningCount++
    run.status = 'running'; run.startedAt = this.iso()
    await this.persist(); await this.emitRun('run_started', job.id, run.id)
    try {
      const result = await this.deps.execute(this.copy(job), controller.signal)
      run.resultSubtype = result.subtype; run.text = result.text; run.errors = result.errors
      run.usage = result.usage; run.costUsd = result.total_cost_usd
      run.status = result.subtype === 'cancelled' || controller.signal.aborted ? 'cancelled' : result.is_error ? 'failed' : 'succeeded'
    } catch (error) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed'
      run.errors = [error instanceof Error ? error.message : String(error)]
    } finally {
      run.finishedAt = this.iso()
      if (job.runAt) job.status = 'completed'
      job.updatedAt = this.iso()
      this.controllers.delete(run.id); this.runningCount--; this.activeJobs.delete(job.id)
      await this.persist()
      await this.emitRun(run.status === 'succeeded' ? 'run_succeeded' : run.status === 'cancelled' ? 'run_cancelled' : 'run_failed', job.id, run.id)
    }
  }

  private async skip(job: ScheduledJob, status: 'skipped_misfire', scheduledAt: string): Promise<void> {
    const run: ScheduledRun = { id: crypto.randomUUID(), scheduledAt, finishedAt: this.iso(), trigger: 'scheduled', status }
    this.addRun(job, run); this.advance(job)
    if (job.runAt) job.status = 'completed'
    await this.persist(); await this.emitRun('run_skipped_misfire', job.id, run.id)
  }

  private finishCancelled(jobId: string, runId: string): void {
    const job = this.jobs.get(jobId); const run = job?.runs.find(value => value.id === runId)
    if (!job || !run) return
    run.status = 'cancelled'; run.finishedAt = this.iso(); this.activeJobs.delete(jobId)
    if (job.runAt) job.status = 'completed'
  }

  private advance(job: ScheduledJob): void {
    if (job.cron) job.nextRunAt = nextCronOccurrence(job.cron, job.timeZone, new Date(job.nextRunAt ?? this.iso())).toISOString()
    else job.nextRunAt = undefined
    job.updatedAt = this.iso()
  }

  private armTimer(): void {
    if (!this.started || this.closed) return
    if (this.timer) clearTimeout(this.timer)
    const next = [...this.jobs.values()].filter(job => job.status === 'enabled' && job.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))[0]
    if (!next) return
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, Date.parse(next.nextRunAt!) - this.now().getTime()))
    this.timer = setTimeout(() => { void this.fireDue() }, delay)
  }

  private async fireDue(): Promise<void> {
    const now = this.now()
    const due = [...this.jobs.values()].filter(job => job.status === 'enabled' && job.nextRunAt && Date.parse(job.nextRunAt) <= now.getTime())
    for (const job of due) await this.admit(job, 'scheduled', job.nextRunAt!)
    this.armTimer()
  }

  private addRun(job: ScheduledJob, run: ScheduledRun): void {
    job.runs.push(run)
    if (job.runs.length > this.options.maxHistoryPerJob) job.runs.splice(0, job.runs.length - this.options.maxHistoryPerJob)
  }

  private requireJob(id: string): ScheduledJob { const job = this.jobs.get(id); if (!job) throw new Error(`Scheduled job not found: ${id}`); return job }
  private assertUsable(): void { if (!this.started) throw new Error('Scheduler has not started'); if (this.closed) throw new Error('Scheduler is closed') }
  private now(): Date { return this.deps.now?.() ?? new Date() }
  private iso(): string { return this.now().toISOString() }
  private copy<T>(value: T): T { return structuredClone(value) }
  private async persist(): Promise<void> { if (this.storage) await this.storage.save([...this.jobs.values()]) }
  private emitJob(type: SchedulerEvent['type'], jobId: string): Promise<void> { return this.emit({ type, timestamp: this.iso(), sessionId: this.sessionId, jobId }) }
  private emitRun(type: SchedulerEvent['type'], jobId: string, runId: string): Promise<void> { return this.emit({ type, timestamp: this.iso(), sessionId: this.sessionId, jobId, runId }) }
  private async emit(event: SchedulerEvent): Promise<void> {
    try { await this.options.onEvent?.(this.copy(event)) }
    catch (error) { console.error(`[Scheduler] Event callback failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
}
