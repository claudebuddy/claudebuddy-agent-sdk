import { sessionStore, type SessionState } from './session-state.js'
/**
 * Task Management Tools
 *
 * TaskCreate, TaskList, TaskUpdate, TaskGet, TaskStop, TaskOutput
 *
 * Provides in-memory task tracking for agent coordination.
 * Tasks persist across turns within a session.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'

/**
 * Task status.
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/**
 * Task entry.
 */
export interface Task {
  id: string
  kind?: 'bash' | 'agent'
  exitCode?: number | null
  subject: string
  description?: string
  status: TaskStatus
  owner?: string
  createdAt: string
  updatedAt: string
  output?: string
  blockedBy?: string[]
  blocks?: string[]
  metadata?: Record<string, unknown>
}

/**
 * Task state is shared across tools within the supplied session.
 */


/**
 * Get all tasks.
 */
export function getAllTasks(sessionState?: SessionState): Task[] {
  const state = getState(sessionState)
  return Array.from(state.taskStore.values())
}

/**
 * Get a task by ID.
 */
export function getTask(id: string, sessionState?: SessionState): Task | undefined {
  const state = getState(sessionState)
  return state.taskStore.get(id)
}

/**
 * Clear all tasks (for session reset).
 */
export function clearTasks(sessionState?: SessionState): void {
  const state = getState(sessionState)
  for (const execution of state.executions.values()) execution.controller.abort()
  state.taskStore.clear()
  state.taskCounter = 0
}

// ============================================================================
// TaskCreateTool
// ============================================================================

export const TaskCreateTool: ToolDefinition = {
  name: 'TaskCreate',
  description: 'Create a new task for tracking work progress. Tasks help organize multi-step operations.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Short task title' },
      description: { type: 'string', description: 'Detailed task description' },
      owner: { type: 'string', description: 'Task owner/assignee' },
      status: { type: 'string', enum: ['pending', 'in_progress'], description: 'Initial status' },
    },
    required: ['subject'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Create a task for tracking progress.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    const id = `task_${++state.taskCounter}`
    const task: Task = {
      id,
      subject: input.subject,
      description: input.description,
      status: input.status || 'pending',
      owner: input.owner,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    state.taskStore.set(id, task)

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Task created: ${id} - "${task.subject}" (${task.status})`,
    }
  },
}

// ============================================================================
// TaskListTool
// ============================================================================

export const TaskListTool: ToolDefinition = {
  name: 'TaskList',
  description: 'List all tasks with their status, ownership, and dependencies.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Filter by status' },
      owner: { type: 'string', description: 'Filter by owner' },
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'List tasks.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    let tasks = getAllTasks(context?.sessionState)

    if (input.status) {
      tasks = tasks.filter(t => t.status === input.status)
    }
    if (input.owner) {
      tasks = tasks.filter(t => t.owner === input.owner)
    }

    if (tasks.length === 0) {
      return { type: 'tool_result', tool_use_id: '', content: 'No tasks found.' }
    }

    const lines = tasks.map(t =>
      `[${t.id}] ${t.status.toUpperCase()} - ${t.subject}${t.owner ? ` (owner: ${t.owner})` : ''}`
    )

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: lines.join('\n'),
    }
  },
}

// ============================================================================
// TaskUpdateTool
// ============================================================================

export const TaskUpdateTool: ToolDefinition = {
  name: 'TaskUpdate',
  description: 'Update a task\'s status, description, or other properties.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] },
      description: { type: 'string', description: 'Updated description' },
      owner: { type: 'string', description: 'New owner' },
      output: { type: 'string', description: 'Task output/result' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Update a task.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    const task = state.taskStore.get(input.id)
    if (!task) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }

    if (task.kind && (input.status !== undefined || input.output !== undefined)) {
      return { type: 'tool_result', tool_use_id: '', content: 'Execution status and output are managed by the runtime. Use TaskStop to cancel.', is_error: true }
    }
    if (input.status) task.status = input.status
    if (input.description) task.description = input.description
    if (input.owner) task.owner = input.owner
    if (input.output) task.output = input.output
    task.updatedAt = new Date().toISOString()

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Task updated: ${task.id} - ${task.status} - "${task.subject}"`,
    }
  },
}

// ============================================================================
// TaskGetTool
// ============================================================================

export const TaskGetTool: ToolDefinition = {
  name: 'TaskGet',
  description: 'Get full details of a specific task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID' },
    },
    required: ['id'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Get task details.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    const task = state.taskStore.get(input.id)
    if (!task) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: JSON.stringify(task, null, 2),
    }
  },
}

// ============================================================================
// TaskStopTool
// ============================================================================

export const TaskStopTool: ToolDefinition = {
  name: 'TaskStop',
  description: 'Stop/cancel a running task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID to stop' },
      reason: { type: 'string', description: 'Reason for stopping' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Stop a task.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    const task = state.taskStore.get(input.id)
    if (!task) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }

    const execution = state.executions.get(task.id)
    if (execution) {
      execution.controller.abort(new Error(input.reason || 'Task cancelled'))
      return { type: 'tool_result', tool_use_id: '', content: `Cancellation requested: ${task.id}` }
    }
    if (task.kind) return { type: 'tool_result', tool_use_id: '', content: `Task already ${task.status}: ${task.id}` }
    task.status = 'cancelled'
    task.updatedAt = new Date().toISOString()
    if (input.reason) task.output = `Stopped: ${input.reason}`

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Task stopped: ${task.id}`,
    }
  },
}

// ============================================================================
// TaskOutputTool
// ============================================================================

export const TaskOutputTool: ToolDefinition = {
  name: 'TaskOutput',
  description: 'Get the output/result of a task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID' },
      block: { type: 'boolean', description: 'Wait for completion, bounded by timeout (default false)' },
      timeout: { type: 'number', description: 'Maximum wait in milliseconds, 0–600000 (default 30000)' },
    },
    required: ['id'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Get task output.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    const task = state.taskStore.get(input.id)
    if (!task) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }

    const execution = state.executions.get(task.id)
    if (execution && input.block) {
      const timeout = input.timeout ?? 30000
      if (!Number.isFinite(timeout) || timeout < 0 || timeout > 600000) return { type: 'tool_result', tool_use_id: '', content: 'Invalid wait timeout', is_error: true }
      await waitForTask(execution.done, timeout, context?.abortSignal)
    }
    if (task.kind) return { type: 'tool_result', tool_use_id: '', content: JSON.stringify({ task_id: task.id, status: task.status, output: task.output || '', exitCode: task.exitCode }), is_error: task.status === 'failed' || task.status === 'cancelled' }
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: task.output || '(no output yet)',
    }
  },
}

function getState(sessionState?: SessionState) {
  return sessionStore(sessionState, 'task-tools', () => ({
    taskStore: new Map<string, Task>(),
    executions: new Map<string, { controller: AbortController; done: Promise<void> }>(),
    taskCounter: 0,
  }))
}

export interface TaskExecutionResult { output: string; is_error?: boolean; exitCode?: number | null }

/** Start real work and retain only a bounded output tail in this session. */
export function startBackgroundTask(
  context: ToolContext, kind: 'bash' | 'agent', subject: string,
  run: (signal: AbortSignal, append: (text: string) => void) => Promise<TaskExecutionResult>,
): Task {
  context.abortSignal?.throwIfAborted()
  const state = getState(context.sessionState)
  const id = `background_${crypto.randomUUID()}`
  const task: Task = { id, kind, subject, status: 'in_progress', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), output: '' }
  const controller = new AbortController()
  const abort = () => controller.abort(context.abortSignal?.reason)
  context.abortSignal?.addEventListener('abort', abort, { once: true })
  const append = (text: string) => { task.output = ((task.output || '') + text).slice(-100000); task.updatedAt = new Date().toISOString() }
  state.taskStore.set(id, task)
  context.taskGroup?.add(id)
  const done = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted()
    const result = await run(controller.signal, append)
    task.output = result.output.slice(-100000)
    task.exitCode = result.exitCode
    task.status = controller.signal.aborted ? 'cancelled' : result.is_error ? 'failed' : 'completed'
  }).catch(error => {
    task.status = controller.signal.aborted ? 'cancelled' : 'failed'
    append(`\n${error?.message || error}`)
  }).finally(() => {
    task.updatedAt = new Date().toISOString()
    context.abortSignal?.removeEventListener('abort', abort)
    state.executions.delete(id)
  })
  state.executions.set(id, { controller, done })
  return task
}

export async function settleTaskGroup(ids: Set<string>, sessionState?: SessionState, cancel = false): Promise<Task[]> {
  const state = getState(sessionState)
  const executions = [...ids].map(id => state.executions.get(id)).filter(e => e !== undefined)
  if (cancel) for (const execution of executions) execution.controller.abort()
  await Promise.all(executions.map(execution => execution.done))
  return [...ids].map(id => state.taskStore.get(id)).filter((task): task is Task => task !== undefined)
}

export async function stopTaskExecution(id: string, sessionState?: SessionState): Promise<void> {
  const state = getState(sessionState)
  const execution = state.executions.get(id)
  if (execution) { execution.controller.abort(); await execution.done }
}

async function waitForTask(done: Promise<void>, timeout: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const finish = () => { cleanup(); resolve() }
    const abort = () => { cleanup(); reject(signal?.reason || new Error('Cancelled')) }
    const timer = setTimeout(finish, timeout)
    signal?.addEventListener('abort', abort, { once: true })
    done.then(finish, error => { cleanup(); reject(error) })
    if (signal?.aborted) abort()
  })
}
