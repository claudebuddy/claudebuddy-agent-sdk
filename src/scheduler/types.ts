import type { QueryResult, TokenUsage } from '../types.js'

export interface SchedulerOptions {
  enabled: boolean
  timeZone?: string
  maxJobs?: number
  maxConcurrentRuns?: number
  maxHistoryPerJob?: number
  maxCatchUpAgeMs?: number
  onEvent?: (event: SchedulerEvent) => void | Promise<void>
}

export interface NormalizedSchedulerOptions {
  enabled: true
  timeZone: string
  maxJobs: number
  maxConcurrentRuns: number
  maxHistoryPerJob: number
  maxCatchUpAgeMs: number
  onEvent?: SchedulerOptions['onEvent']
}

export interface ScheduleInput {
  name: string
  prompt: string
  cron?: string
  runAt?: string
  timeZone?: string
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
}

export interface SchedulePatch {
  name?: string
  prompt?: string
  cron?: string
  runAt?: string
  timeZone?: string
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  enabled?: boolean
}

export type ScheduledJobStatus = 'enabled' | 'paused' | 'completed'
export type ScheduledRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted_unknown' | 'skipped_overlap' | 'skipped_misfire'
export type ScheduledRunTrigger = 'scheduled' | 'catch_up' | 'manual'

export interface ScheduledRun {
  id: string
  scheduledAt: string
  admittedAt?: string
  startedAt?: string
  finishedAt?: string
  trigger: ScheduledRunTrigger
  status: ScheduledRunStatus
  resultSubtype?: QueryResult['subtype']
  text?: string
  errors?: string[]
  usage?: TokenUsage
  costUsd?: number
}

export interface ScheduledJob extends ScheduleInput {
  id: string
  timeZone: string
  status: ScheduledJobStatus
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  runs: ScheduledRun[]
}

export type SchedulerEventType =
  | 'job_created' | 'job_updated' | 'job_deleted'
  | 'run_queued' | 'run_started' | 'run_succeeded' | 'run_failed' | 'run_cancelled'
  | 'run_skipped_overlap' | 'run_skipped_misfire' | 'storage_error'

export interface SchedulerEvent {
  type: SchedulerEventType
  timestamp: string
  sessionId: string
  jobId?: string
  runId?: string
  error?: string
}
