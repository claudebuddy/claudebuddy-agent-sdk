import { CronExpressionParser } from 'cron-parser'
import type { NormalizedSchedulerOptions, ScheduleInput, SchedulerOptions } from './types.js'

function positiveInteger(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export function validateTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
    return timeZone
  } catch {
    throw new Error(`Invalid time zone: ${timeZone}`)
  }
}

export function normalizeSchedulerOptions(options: SchedulerOptions): NormalizedSchedulerOptions {
  const timeZone = validateTimeZone(options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const maxCatchUpAgeMs = options.maxCatchUpAgeMs ?? 86_400_000
  if (!Number.isFinite(maxCatchUpAgeMs) || !Number.isInteger(maxCatchUpAgeMs) || maxCatchUpAgeMs < 0) {
    throw new Error('maxCatchUpAgeMs must be a non-negative integer')
  }
  return {
    enabled: true,
    timeZone,
    maxJobs: positiveInteger('maxJobs', options.maxJobs ?? 100),
    maxConcurrentRuns: positiveInteger('maxConcurrentRuns', options.maxConcurrentRuns ?? 2),
    maxHistoryPerJob: positiveInteger('maxHistoryPerJob', options.maxHistoryPerJob ?? 20),
    maxCatchUpAgeMs,
    onEvent: options.onEvent,
  }
}

export function nextCronOccurrence(cron: string, timeZone: string, after: Date): Date {
  validateTimeZone(timeZone)
  if (cron.trim().split(/\s+/).length !== 5) throw new Error('Schedule must use a five-field cron expression')
  try {
    return CronExpressionParser.parse(cron, { currentDate: after, tz: timeZone }).next().toDate()
  } catch (error) {
    throw new Error(`Invalid five-field cron expression: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function validateScheduleInput(input: ScheduleInput, now = new Date()): ScheduleInput {
  if (!input.name?.trim()) throw new Error('name must be non-empty')
  if (!input.prompt?.trim()) throw new Error('prompt must be non-empty')
  if (!!input.cron === !!input.runAt) throw new Error('Provide exactly one of cron or runAt')
  const timeZone = validateTimeZone(input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  if (input.cron) nextCronOccurrence(input.cron, timeZone, now)
  if (input.runAt) {
    const timestamp = Date.parse(input.runAt)
    if (!Number.isFinite(timestamp)) throw new Error('runAt must be a valid ISO 8601 timestamp')
    if (timestamp <= now.getTime()) throw new Error('runAt must be in the future')
  }
  if (input.maxTurns !== undefined) positiveInteger('maxTurns', input.maxTurns)
  if (input.maxBudgetUsd !== undefined && (!Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd < 0)) {
    throw new Error('maxBudgetUsd must be a non-negative finite number')
  }
  return { ...input, name: input.name.trim(), prompt: input.prompt.trim(), timeZone }
}
