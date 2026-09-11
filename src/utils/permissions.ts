import type { AgentOptions, CanUseToolFn, PermissionMode, ToolDefinition } from '../types.js'
import { FileEditTool, FileWriteTool, NotebookEditTool } from '../tools/index.js'

/** Final allow/deny bounds apply to every source, including query overrides. */
export function restrictTools(tools: ToolDefinition[], base: AgentOptions, overrides?: Partial<AgentOptions>): ToolDefinition[] {
  return tools.filter(tool => tool.isEnabled?.() !== false && [base, overrides].every(options => !options || (
    (options.allowedTools === undefined || options.allowedTools.includes(tool.name)) &&
    !options.disallowedTools?.includes(tool.name)
  )))
}

/** Modes are SDK policy; trusted tool metadata describes the operation's effects. */
export function createPermissionPolicy(
  mode: PermissionMode,
  allowedTools: string[] | undefined,
  callback?: CanUseToolFn,
): CanUseToolFn {
  return async (tool, input) => {
    const readOnly = tool.isReadOnly?.() === true
    if (mode === 'plan' && !readOnly) {
      return { behavior: 'deny', message: `Plan mode does not allow tool "${tool.name}"` }
    }
    const preapproved = readOnly || allowedTools?.includes(tool.name) ||
      mode === 'bypassPermissions' ||
      (mode === 'acceptEdits' && [FileEditTool, FileWriteTool, NotebookEditTool].includes(tool))
    if (!preapproved && (mode === 'dontAsk' || !callback)) {
      return { behavior: 'deny', message: `Tool "${tool.name}" requires explicit approval` }
    }
    return callback ? callback(tool, input) : { behavior: 'allow' }
  }
}

export function validateRunOptions(options: AgentOptions): void {
  if (options.questionTimeoutMs !== undefined && (!Number.isFinite(options.questionTimeoutMs) || options.questionTimeoutMs < 1 || options.questionTimeoutMs > 2147483647)) throw new Error('questionTimeoutMs must be between 1 and 2147483647')
  const sandbox = options.sandbox
  if (sandbox && (sandbox.enabled === true || Object.entries(sandbox).some(([key, value]) => key !== 'enabled' && value !== undefined))) {
    throw new Error('Sandbox enforcement is not supported by this in-process runtime')
  }
  const modes: PermissionMode[] = ['default', 'acceptEdits', 'dontAsk', 'auto', 'plan', 'bypassPermissions']
  if (options.permissionMode !== undefined && !modes.includes(options.permissionMode)) {
    throw new Error(`Unsupported permission mode: ${options.permissionMode}`)
  }
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)) {
    throw new Error('maxTurns must be a positive integer')
  }
  if (options.maxBudgetUsd !== undefined && (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd < 0)) {
    throw new Error('maxBudgetUsd must be a finite non-negative number')
  }
}
