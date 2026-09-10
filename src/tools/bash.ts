/** Shell execution with bounded output and real task cancellation. */
import { spawn } from 'child_process'
import { defineTool } from './types.js'
import { startBackgroundTask, type TaskExecutionResult } from './task-tools.js'

export const BashTool = defineTool({
  name: 'Bash',
  description: 'Execute a bash command. Set run_in_background to receive a task_id for TaskOutput/TaskStop. Background work is scoped to the current query.',
  inputSchema: { type: 'object', properties: {
    command: { type: 'string', description: 'Shell command' },
    timeout: { type: 'number', description: 'Timeout in milliseconds, 1–600000 (default 120000)' },
    run_in_background: { type: 'boolean', description: 'Return a task_id immediately' },
  }, required: ['command'] },
  isReadOnly: false, isConcurrencySafe: false,
  async call(input, context) {
    const timeout = input.timeout ?? 120000
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600000) throw new Error('Invalid command timeout')
    if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('command must be non-empty')
    if (input.run_in_background) {
      const task = startBackgroundTask(context, 'bash', input.command.slice(0, 200), (signal, append) => executeShell(input.command, context.cwd, timeout, signal, append))
      return JSON.stringify({ task_id: task.id, status: task.status })
    }
    const result = await executeShell(input.command, context.cwd, timeout, context.abortSignal)
    return { data: result.output, is_error: result.is_error }
  },
})

function executeShell(command: string, cwd: string, timeout: number, signal?: AbortSignal, append?: (text: string) => void): Promise<TaskExecutionResult> {
  signal?.throwIfAborted()
  return new Promise((resolve) => {
    let output = ''; let truncated = false; let timedOut = false; let settled = false
    let escalation: ReturnType<typeof setTimeout> | undefined
    const proc = spawn('bash', ['-c', command], { cwd, env: { ...process.env }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const add = (text: string) => { output += text; if (output.length > 100000) { output = output.slice(-100000); truncated = true }; append?.(text) }
    const kill = (sig: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, sig); else proc.kill(sig) } catch (error: any) { if (error.code !== 'ESRCH') add(`\nTermination error: ${error.message}`) }
    }
    const stop = () => { kill('SIGTERM'); if (!escalation) escalation = setTimeout(() => kill('SIGKILL'), 500) }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeout)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', add); proc.stderr.on('data', add)
    const finish = (code: number | null, error?: Error, killedBy?: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer); if (escalation) { kill('SIGKILL'); clearTimeout(escalation) }
      signal?.removeEventListener('abort', stop)
      if (error) add(`\nError executing command: ${error.message}`)
      else if (timedOut) add('\nCommand timed out')
      else if (signal?.aborted) add('\nCommand cancelled')
      else if (code !== 0) add(`\nExit code: ${code}${killedBy ? ` (${killedBy})` : ''}`)
      resolve({ output: (truncated ? '(earlier output truncated)\n' : '') + (output || '(no output)'), is_error: !!error || timedOut || !!signal?.aborted || code !== 0, exitCode: code })
    }
    proc.on('error', error => finish(null, error))
    proc.on('close', (code, sig) => finish(code, undefined, sig))
  })
}
