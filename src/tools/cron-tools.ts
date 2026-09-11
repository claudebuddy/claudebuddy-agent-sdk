import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'
import type { Scheduler } from '../scheduler/scheduler.js'

const STATE_KEY = 'session-scheduler'
export function setSessionScheduler(value: Scheduler, state: Map<string, unknown>): void { state.set(STATE_KEY, value) }
function get(context?: ToolContext): Scheduler {
  const value = context?.sessionState?.get(STATE_KEY)
  if (!value) throw new Error('Scheduler is not enabled for this Agent')
  return value as Scheduler
}
const ok = (value: unknown): ToolResult => ({ type: 'tool_result', tool_use_id: '', content: JSON.stringify(value, null, 2) })
const fail = (error: unknown): ToolResult => ({ type: 'tool_result', tool_use_id: '', is_error: true, content: error instanceof Error ? error.message : String(error) })
async function invoke(operation: () => Promise<unknown>): Promise<ToolResult> { try { return ok(await operation()) } catch (error) { return fail(error) } }
const flags = { isConcurrencySafe: () => true, isEnabled: () => false }

export const CronCreateTool: ToolDefinition = {
  name: 'CronCreate', description: 'Create a recurring cron or one-shot Agent prompt schedule.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, prompt: { type: 'string' }, cron: { type: 'string' }, run_at: { type: 'string' }, time_zone: { type: 'string' }, model: { type: 'string' }, max_turns: { type: 'number' }, max_budget_usd: { type: 'number' }, schedule: { type: 'string', description: 'Deprecated alias for cron' }, command: { type: 'string', description: 'Deprecated alias for prompt' } }, required: ['name'] },
  ...flags, isReadOnly: () => false, async prompt() { return 'Create a scheduled Agent prompt.' },
  async call(input: any, context?: ToolContext) { return invoke(() => get(context).create({ name: input.name, prompt: input.prompt ?? input.command, cron: input.cron ?? input.schedule, runAt: input.run_at, timeZone: input.time_zone, model: input.model, maxTurns: input.max_turns, maxBudgetUsd: input.max_budget_usd })) },
}
export const CronListTool: ToolDefinition = {
  name: 'CronList', description: 'List Agent prompt schedules and bounded run history.', inputSchema: { type: 'object', properties: {} },
  ...flags, isReadOnly: () => true, async prompt() { return 'List scheduled Agent prompts.' }, async call(_input: any, context?: ToolContext) { return invoke(() => get(context).list()) },
}
export const CronGetTool: ToolDefinition = {
  name: 'CronGet', description: 'Inspect one Agent prompt schedule.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  ...flags, isReadOnly: () => true, async prompt() { return 'Inspect a scheduled Agent prompt.' }, async call(input: any, context?: ToolContext) { return invoke(async () => { const job = await get(context).get(input.id); if (!job) throw new Error(`Scheduled job not found: ${input.id}`); return job }) },
}
export const CronUpdateTool: ToolDefinition = {
  name: 'CronUpdate', description: 'Update, pause, or resume an Agent prompt schedule.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['update', 'pause', 'resume'] }, name: { type: 'string' }, prompt: { type: 'string' }, cron: { type: 'string' }, run_at: { type: 'string' }, time_zone: { type: 'string' }, model: { type: 'string' }, max_turns: { type: 'number' }, max_budget_usd: { type: 'number' } }, required: ['id'] },
  ...flags, isReadOnly: () => false, async prompt() { return 'Update a scheduled Agent prompt.' }, async call(input: any, context?: ToolContext) { const enabled = input.action === 'pause' ? false : input.action === 'resume' ? true : undefined; return invoke(() => get(context).update(input.id, { enabled, name: input.name, prompt: input.prompt, cron: input.cron, runAt: input.run_at, timeZone: input.time_zone, model: input.model, maxTurns: input.max_turns, maxBudgetUsd: input.max_budget_usd })) },
}
export const CronRunTool: ToolDefinition = {
  name: 'CronRun', description: 'Queue an immediate run of an Agent prompt schedule.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  ...flags, isReadOnly: () => false, async prompt() { return 'Run a scheduled Agent prompt now.' }, async call(input: any, context?: ToolContext) { return invoke(async () => ({ runId: await get(context).runNow(input.id) })) },
}
export const CronDeleteTool: ToolDefinition = {
  name: 'CronDelete', description: 'Delete an Agent prompt schedule.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  ...flags, isReadOnly: () => false, async prompt() { return 'Delete a scheduled Agent prompt.' }, async call(input: any, context?: ToolContext) { return invoke(async () => ({ deleted: await get(context).delete(input.id) })) },
}
export const RemoteTriggerTool: ToolDefinition = {
  name: 'RemoteTrigger', description: 'Manage remote triggers through a remote control plane.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
  isReadOnly: () => false, isConcurrencySafe: () => true, isEnabled: () => false, async prompt() { return 'Manage remote Agent triggers.' }, async call() { return fail(new Error('RemoteTrigger requires a connected remote backend')) },
}
