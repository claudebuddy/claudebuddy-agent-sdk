import { sessionStore, type SessionState } from './session-state.js'
/**
 * Cron/Scheduling Tools
 *
 * CronCreate, CronDelete, CronList - Schedule recurring tasks.
 * RemoteTrigger - Manage remote scheduled agent triggers.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'

/**
 * Cron job definition.
 */
export interface CronJob {
  id: string
  name: string
  schedule: string // cron expression
  command: string
  enabled: boolean
  createdAt: string
  lastRunAt?: string
  nextRunAt?: string
}

// In-memory cron store

/**
 * Get all cron jobs.
 */
export function getAllCronJobs(sessionState?: SessionState): CronJob[] {
  const state = getState(sessionState)
  return Array.from(state.cronStore.values())
}

/**
 * Clear all cron jobs.
 */
export function clearCronJobs(sessionState?: SessionState): void {
  const state = getState(sessionState)
  state.cronStore.clear()
  state.cronCounter = 0
}

export const CronCreateTool: ToolDefinition = {
  name: 'CronCreate',
  description: 'Store a cron definition only. No scheduler is installed, so this does not execute jobs.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Job name' },
      schedule: { type: 'string', description: 'Cron expression (e.g., "*/5 * * * *" for every 5 minutes)' },
      command: { type: 'string', description: 'Command or prompt to execute' },
    },
    required: ['name', 'schedule', 'command'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => false,
  async prompt() { return 'Create a scheduled cron job.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    const id = `cron_${++state.cronCounter}`
    const job: CronJob = {
      id,
      name: input.name,
      schedule: input.schedule,
      command: input.command,
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    state.cronStore.set(id, job)

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Cron definition stored (not scheduled; execution unavailable): ${id} "${job.name}" schedule="${job.schedule}"`,
    }
  },
}

export const CronDeleteTool: ToolDefinition = {
  name: 'CronDelete',
  description: 'Delete a scheduled cron job.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Cron job ID to delete' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => false,
  async prompt() { return 'Delete a cron job.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    if (!state.cronStore.has(input.id)) {
      return { type: 'tool_result', tool_use_id: '', content: `Cron job not found: ${input.id}`, is_error: true }
    }
    state.cronStore.delete(input.id)
    return { type: 'tool_result', tool_use_id: '', content: `Cron job deleted: ${input.id}` }
  },
}

export const CronListTool: ToolDefinition = {
  name: 'CronList',
  description: 'List all scheduled cron jobs.',
  inputSchema: { type: 'object', properties: {} },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => false,
  async prompt() { return 'List cron jobs.' },
  async call(_input: any, context?: ToolContext): Promise<ToolResult> {
    const jobs = getAllCronJobs(context?.sessionState)
    if (jobs.length === 0) {
      return { type: 'tool_result', tool_use_id: '', content: 'No cron jobs scheduled.' }
    }
    const lines = jobs.map(j =>
      `[${j.id}] ${j.enabled ? '✓' : '✗'} "${j.name}" schedule="${j.schedule}" command="${j.command.slice(0, 50)}"`
    )
    return { type: 'tool_result', tool_use_id: '', content: lines.join('\n') }
  },
}

export const RemoteTriggerTool: ToolDefinition = {
  name: 'RemoteTrigger',
  description: 'Manage remote scheduled agent triggers. Supports list, get, create, update, and run operations.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'create', 'update', 'run'],
        description: 'Operation to perform',
      },
      id: { type: 'string', description: 'Trigger ID (for get/update/run)' },
      name: { type: 'string', description: 'Trigger name (for create)' },
      schedule: { type: 'string', description: 'Cron schedule (for create/update)' },
      prompt: { type: 'string', description: 'Agent prompt (for create/update)' },
    },
    required: ['action'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => false,
  async prompt() { return 'Manage remote agent triggers.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    // RemoteTrigger operations are typically handled by the remote backend
    // In standalone SDK mode, we provide a stub implementation
    return {
      type: 'tool_result',
      tool_use_id: '',
      is_error: true,
      content: `RemoteTrigger ${input.action}: This feature requires a connected remote backend. No remote backend is configured. Local cron definitions do not execute without a scheduler.`,
    }
  },
}

function getState(sessionState?: SessionState) {
  return sessionStore(sessionState, 'cron-tools', () => ({
    cronStore: new Map<string, CronJob>(),
    cronCounter: 0,
  }))
}
