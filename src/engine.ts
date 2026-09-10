/**
 * QueryEngine - Core agentic loop
 *
 * Manages the full conversation lifecycle:
 * 1. Take user prompt
 * 2. Build system prompt with context (git status, project context, tools)
 * 3. Call LLM API with tools (via provider abstraction)
 * 4. Stream response
 * 5. Execute tool calls (concurrent for read-only, serial for mutations)
 * 6. Send results back, repeat until done
 * 7. Auto-compact when context exceeds threshold
 * 8. Retry with exponential backoff on transient errors
 */

import { settleTaskGroup, type Task } from './tools/task-tools.js'
import type {
  SDKMessage,
  QueryEngineConfig,
  ToolDefinition,
  ToolResult,
  ToolContext,
  TokenUsage,
  ExecutionBudget,
} from './types.js'
import type {
  LLMProvider,
  CreateMessageResponse,
  NormalizedMessageParam,
  NormalizedTool,
} from './providers/types.js'
import {
  estimateCost,
} from './utils/tokens.js'
import {
  shouldAutoCompact,
  compactConversation,
  microCompactMessages,
  createAutoCompactState,
  type AutoCompactState,
} from './utils/compact.js'
import {
  withRetry,
  isPromptTooLongError,
} from './utils/retry.js'
import { getSystemContext, getUserContext } from './utils/context.js'
import { normalizeMessagesForAPI } from './utils/messages.js'
import {
  SpillStore,
  applySpillPolicy,
  shouldNeverSpill,
} from './utils/spill.js'
import type { HookRegistry, HookInput, HookOutput } from './hooks.js'

// ============================================================================
// Tool format conversion
// ============================================================================

/** Convert a ToolDefinition to the normalized provider tool format. */
function toProviderTool(tool: ToolDefinition): NormalizedTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

// ============================================================================
// ToolUseBlock (internal type for extracted tool_use blocks)
// ============================================================================

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: any
}

// ============================================================================
// System Prompt Builder
// ============================================================================

async function buildSystemPrompt(config: QueryEngineConfig): Promise<string> {
  if (config.systemPrompt) {
    const base = config.systemPrompt
    return config.appendSystemPrompt
      ? base + '\n\n' + config.appendSystemPrompt
      : base
  }

  const parts: string[] = []

  parts.push(
    'You are an AI assistant with access to tools. Use the tools provided to help the user accomplish their tasks.',
    'You should use tools when they would help you complete the task more accurately or efficiently.',
  )

  // List available tools with descriptions
  parts.push('\n# Available Tools\n')
  for (const tool of config.tools) {
    parts.push(`- **${tool.name}**: ${tool.description}`)
  }

  // Add agent definitions
  if (config.agents && Object.keys(config.agents).length > 0) {
    parts.push('\n# Available Subagents\n')
    for (const [name, def] of Object.entries(config.agents)) {
      parts.push(`- **${name}**: ${def.description}`)
    }
  }

  // System context (git status, etc.)
  try {
    const sysCtx = await getSystemContext(config.cwd)
    if (sysCtx) {
      parts.push('\n# Environment\n')
      parts.push(sysCtx)
    }
  } catch {
    // Context is best-effort
  }

  // User context (AGENT.md, date)
  try {
    const userCtx = await getUserContext(config.cwd)
    if (userCtx) {
      parts.push('\n# Project Context\n')
      parts.push(userCtx)
    }
  } catch {
    // Context is best-effort
  }

  // Working directory
  parts.push(`\n# Working Directory\n${config.cwd}`)

  if (config.appendSystemPrompt) {
    parts.push('\n' + config.appendSystemPrompt)
  }

  return parts.join('\n')
}

// ============================================================================
// QueryEngine
// ============================================================================

export class QueryEngine {
  private config: QueryEngineConfig
  private provider: LLMProvider
  public messages: NormalizedMessageParam[] = []
  private ledger: ExecutionBudget
  private initialUsage: TokenUsage
  private initialCost: number
  private initialModelUsage: Record<string, TokenUsage> = {}
  private turnCount = 0
  private compactState: AutoCompactState
  private sessionId: string
  private taskGroup = new Set<string>()
  private apiTimeMs = 0
  private hookRegistry?: HookRegistry
  private spillStore?: SpillStore

  constructor(config: QueryEngineConfig) {
    config.tools = config.tools.filter(tool => tool.isEnabled?.() !== false)
    this.config = config
    this.ledger = config.executionBudget ?? { cost: 0, usage: { input_tokens: 0, output_tokens: 0 } }
    this.initialUsage = { ...this.ledger.usage }
    this.initialCost = this.ledger.cost
    config.sessionState ??= new Map()
    this.provider = config.provider
    this.compactState = createAutoCompactState()
    this.sessionId = config.sessionId || crypto.randomUUID()
    this.hookRegistry = config.hookRegistry
    if (config.spill) {
      this.spillStore = new SpillStore({ spillDir: config.spill.spillDir })
    }
  }

  /**
   * Execute hooks for a lifecycle event.
   * Returns hook outputs; never throws.
   */
  private async executeHooks(
    event: import('./hooks.js').HookEvent,
    extra?: Partial<HookInput>,
  ): Promise<HookOutput[]> {
    if (!this.hookRegistry?.hasHooks(event)) return []
    try {
      return await this.hookRegistry.execute(event, {
        event,
        sessionId: this.sessionId,
        cwd: this.config.cwd,
        ...extra,
      })
    } catch {
      return []
    }
  }

  /**
   * Submit a user message and run the agentic loop.
   * Yields SDKMessage events as the agent works.
   */
  async *submitMessage(
    prompt: string | any[],
  ): AsyncGenerator<SDKMessage> {
    this.initialUsage = { ...this.ledger.usage }
    this.initialCost = this.ledger.cost
    this.initialModelUsage = Object.fromEntries(Object.entries(this.ledger.modelUsage ?? {}).map(([model, usage]) => [model, { ...usage }]))
    this.turnCount = 0
    this.apiTimeMs = 0
    this.taskGroup.clear()
    let backgroundTasks: Task[] = []
    let status = 'error_max_turns'
    let errors: string[] | undefined
    let pendingTools: ToolUseBlock[] = []
    const atBudget = () => this.config.maxBudgetUsd !== undefined && this.ledger.cost >= this.config.maxBudgetUsd
    const compact = async () => {
      this.config.abortSignal?.throwIfAborted()
      await this.executeHooks('PreCompact')
      this.config.abortSignal?.throwIfAborted()
      const result = await compactConversation(this.provider, this.config.model,
        this.messages, this.compactState, {
          signal: this.config.abortSignal,
          onUsage: usage => this.chargeUsage(usage),
        })
      this.messages = result.compactedMessages
      this.compactState = result.state
      if (result.success) await this.executeHooks('PostCompact')
      return result.success
    }
    try {
      await this.executeHooks('SessionStart')
      this.config.abortSignal?.throwIfAborted()
      const userHookResults = await this.executeHooks('UserPromptSubmit', { toolInput: prompt })
      if (userHookResults.some(r => r.block)) throw new Error('Blocked by UserPromptSubmit hook')
      this.messages.push({ role: 'user', content: prompt as any })
      const tools = this.config.tools.map(toProviderTool)
      const systemPrompt = await buildSystemPrompt(this.config)
      yield {
        type: 'system', subtype: 'init', session_id: this.sessionId,
        tools: this.config.tools.map(t => t.name), model: this.config.model,
        cwd: this.config.cwd, mcp_servers: [], permission_mode: this.config.permissionMode ?? 'bypassPermissions',
      } as SDKMessage
      let recoveryAttempts = 0
      let outputRecoveryAttempts = 0
      while (this.turnCount < this.config.maxTurns) {
        this.config.abortSignal?.throwIfAborted()
        if (atBudget()) { status = 'error_max_budget_usd'; break }
        if (shouldAutoCompact(this.messages, this.config.model, this.compactState, this.config.contextWindowSize)) {
          await compact()
        }
        this.config.abortSignal?.throwIfAborted()
        if (atBudget()) { status = 'error_max_budget_usd'; break }
        const apiMessages = microCompactMessages(normalizeMessagesForAPI(this.messages)) as NormalizedMessageParam[]
        this.turnCount++
        let response: CreateMessageResponse
        let emittedPartial = false
        const apiStart = performance.now()
        try {
          const request = {
            signal: this.config.abortSignal,
            model: this.config.model, maxTokens: this.config.maxTokens,
            system: systemPrompt, messages: apiMessages,
            tools: tools.length ? tools : undefined,
            thinking: this.config.thinking?.type === 'enabled' && this.config.thinking.budgetTokens
              ? { type: 'enabled', budget_tokens: this.config.thinking.budgetTokens } : undefined,
          }
          if (this.config.includePartialMessages && this.provider.streamMessage) {
            let complete: CreateMessageResponse | undefined
            for await (const event of this.provider.streamMessage(request)) {
              this.config.abortSignal?.throwIfAborted()
              if (event.type === 'response') complete = event.response
              else { emittedPartial = true; yield { type: 'partial_message', partial: event } }
            }
            if (!complete) throw new Error('Stream ended without a complete response')
            response = complete
          } else {
            response = await withRetry(() => this.provider.createMessage(request), undefined, this.config.abortSignal)
          }
        } catch (err) {
          this.config.abortSignal?.throwIfAborted()
          if (!emittedPartial && isPromptTooLongError(err) && recoveryAttempts < 1 && !atBudget()) {
            recoveryAttempts++
            if (await compact()) { this.turnCount--; continue }
          }
          throw err
        } finally {
          this.apiTimeMs += performance.now() - apiStart
        }
        if (response.usage) this.chargeUsage(response.usage)
        this.config.abortSignal?.throwIfAborted()
        this.messages.push({ role: 'assistant', content: response.content })
        pendingTools = response.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
        yield { type: 'assistant', message: { role: 'assistant', content: response.content } }
        this.config.abortSignal?.throwIfAborted()
        if (pendingTools.length) {
          if (response.stopReason === 'max_tokens') throw new Error('Tool response was truncated before completion')
          outputRecoveryAttempts = 0
          const results = await this.executeTools(pendingTools)
          const spilled = this.spillStore ? await this.applySpillToResults(results) : results
          // Persist all results before yielding so an early consumer exit preserves valid history.
          this.messages.push({ role: 'user', content: spilled.map(r => ({
            type: 'tool_result', tool_use_id: r.tool_use_id,
            content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content), is_error: r.is_error,
          })) })
          pendingTools = []
          for (const r of spilled) yield { type: 'tool_result', result: {
            tool_use_id: r.tool_use_id, tool_name: r.tool_name ?? '',
            output: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
          } }
          this.config.abortSignal?.throwIfAborted()
        } else if (response.stopReason === 'max_tokens') {
          if (outputRecoveryAttempts++ >= 3) {
            status = 'error_during_execution'; errors = ['Maximum output recovery attempts exceeded']; break
          }
          this.messages.push({ role: 'user', content: 'Please continue from where you left off.' })
        } else {
          status = 'success'; break
        }
      }
      this.config.abortSignal?.throwIfAborted()
      if (status === 'error_max_turns' && atBudget()) status = 'error_max_budget_usd'
    } catch (err: any) {
      status = this.config.abortSignal?.aborted ? 'cancelled' : 'error_during_execution'
      errors = [err?.message ? String(err.message) : String(err)]
    } finally {
      if (pendingTools.length) {
        this.messages.push({ role: 'user', content: pendingTools.map(block => ({
          type: 'tool_result', tool_use_id: block.id,
          content: 'Tool execution interrupted before a result was recorded.', is_error: true,
        })) })
      }
      backgroundTasks = await settleTaskGroup(this.taskGroup, this.config.sessionState, status !== 'success')
      if (this.config.abortSignal?.aborted) { status = 'cancelled'; errors = ['Run cancelled'] }
      await this.executeHooks('Stop')
      await this.executeHooks('SessionEnd')
    }
    for (const task of backgroundTasks) yield { type: 'system', subtype: 'task_notification', task_id: task.id, status: task.status, message: task.output }
    const usage = this.getUsage()
    const cost = this.getCost()
    const modelUsage = Object.fromEntries(Object.entries(this.ledger.modelUsage ?? {}).map(([model, value]) => [model, {
      input_tokens: value.input_tokens - (this.initialModelUsage[model]?.input_tokens ?? 0),
      output_tokens: value.output_tokens - (this.initialModelUsage[model]?.output_tokens ?? 0),
    }]))
    yield {
      type: 'result', subtype: status, session_id: this.sessionId,
      is_error: status !== 'success', errors, num_turns: this.turnCount,
      total_cost_usd: cost, cost, usage, duration_api_ms: Math.round(this.apiTimeMs),
      model_usage: modelUsage,
    }
  }

  private chargeUsage(usage: TokenUsage): void {
    this.ledger.modelUsage ??= {}
    const modelUsage = this.ledger.modelUsage[this.config.model] ??= { input_tokens: 0, output_tokens: 0 }
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
      if (usage[key] !== undefined) {
        this.ledger.usage[key] = (this.ledger.usage[key] ?? 0) + usage[key]!
        modelUsage[key] = (modelUsage[key] ?? 0) + usage[key]!
      }
    }
    this.ledger.cost += estimateCost(this.config.model, usage, this.config.pricingPerMillion)
  }

  /**
   * Execute tool calls with concurrency control.
   *
   * Adjacent explicitly concurrency-safe read-only tools run concurrently (up to 10).
   * Mutation tools run sequentially.
   */
  private async executeTools(
    toolUseBlocks: ToolUseBlock[],
  ): Promise<(ToolResult & { tool_name?: string })[]> {
    const context: ToolContext = {
      taskGroup: this.taskGroup,
      cwd: this.config.cwd,
      abortSignal: this.config.abortSignal,
      provider: this.provider,
      model: this.config.model,
      apiType: this.provider.apiType,
      sessionState: this.config.sessionState,
      tools: this.config.tools,
      agents: this.config.agents,
      canUseTool: this.config.canUseTool,
      executionBudget: this.ledger,
      maxBudgetUsd: this.config.maxBudgetUsd,
      pricingPerMillion: this.config.pricingPerMillion,
      hookRegistry: this.hookRegistry,
      sessionId: this.sessionId,
    }

    const configuredConcurrency = Number(process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY ?? 10)
    const MAX_CONCURRENCY = Number.isFinite(configuredConcurrency) && configuredConcurrency >= 1
      ? Math.floor(configuredConcurrency) : 10

    const results: (ToolResult & { tool_name?: string })[] = []
    // Mutations and tools without an explicit concurrency guarantee are barriers.
    // Parallelize only adjacent safe reads; never move a read before an earlier write.
    for (let i = 0; i < toolUseBlocks.length;) {
      this.config.abortSignal?.throwIfAborted()
      const block = toolUseBlocks[i]
      const tool = this.config.tools.find(t => t.name === block.name)
      const safe = (t?: ToolDefinition) => t?.isReadOnly?.() === true && t.isConcurrencySafe?.() === true
      if (!safe(tool)) {
        results.push(await this.executeSingleTool(block, tool, context))
        i++
        continue
      }
      const batch: Array<{ block: ToolUseBlock; tool?: ToolDefinition }> = []
      while (i < toolUseBlocks.length && batch.length < MAX_CONCURRENCY) {
        const next = toolUseBlocks[i]
        const nextTool = this.config.tools.find(t => t.name === next.name)
        if (!safe(nextTool)) break
        batch.push({ block: next, tool: nextTool })
        i++
      }
      results.push(...await Promise.all(batch.map(item => this.executeSingleTool(item.block, item.tool, context))))
    }

    return results
  }

  /**
   * Apply the spill policy to each tool result that exceeds the inline cap.
   * Best-effort: a spill failure leaves the original content untouched and
   * never turns a success into an error. Reading tools are skipped to avoid a
   * read -> spill -> read loop.
   */
  private async applySpillToResults(
    results: (ToolResult & { tool_name?: string })[],
  ): Promise<(ToolResult & { tool_name?: string })[]> {
    const policy = this.config.spill
    if (!policy || !this.spillStore) return results

    const out: (ToolResult & { tool_name?: string })[] = []
    for (const result of results) {
      if (result.is_error) {
        out.push(result)
        continue
      }
      const toolName = result.tool_name || ''
      // Whitelist: if enabledFor is provided and non-empty, only listed tools spill.
      if (policy.enabledFor && policy.enabledFor.length > 0) {
        const inWhitelist = policy.enabledFor.some(
          (n) => toolName === n || toolName.toLowerCase().includes(n.toLowerCase()),
        )
        if (!inWhitelist) {
          out.push(result)
          continue
        }
      }
      if (shouldNeverSpill(toolName, policy.neverSpillTools)) {
        out.push(result)
        continue
      }
      if (typeof result.content !== 'string') {
        out.push(result)
        continue
      }

      const applied = await applySpillPolicy(result.content, this.spillStore, {
        maxInlineBytes: policy.maxInlineBytes,
        previewBytes: policy.previewBytes,
      })

      if (applied.kind === 'spill') {
        // Keep the original content accessible for fidelity tools but swap the
        // model-visible string to the preview + locator.
        out.push({ ...result, content: applied.content })
      } else {
        // keep or failed: unchanged (best-effort, never lose data)
        out.push({ ...result, content: applied.content })
      }
    }
    return out
  }

  /**
   * Execute a single tool with permission checking.
   */
  private async executeSingleTool(
    block: ToolUseBlock,
    tool: ToolDefinition | undefined,
    context: ToolContext,
  ): Promise<ToolResult & { tool_name?: string }> {
    const cancelled = () => ({ type: 'tool_result' as const, tool_use_id: block.id,
      content: 'Tool execution cancelled', is_error: true, tool_name: block.name })
    if (context.abortSignal?.aborted) return cancelled()
    if (!tool) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: Unknown tool "${block.name}"`,
        is_error: true,
        tool_name: block.name,
      }
    }

    // Check enabled
    if (tool.isEnabled && !tool.isEnabled()) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: Tool "${block.name}" is not enabled`,
        is_error: true,
        tool_name: block.name,
      }
    }

    // Check permissions
    if (this.config.canUseTool) {
      try {
        const permission = await this.config.canUseTool(tool, block.input)
        if (permission.behavior === 'deny') {
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: permission.message || `Permission denied for tool "${block.name}"`,
            is_error: true,
            tool_name: block.name,
          }
        }
        if (permission.updatedInput !== undefined) {
          block = { ...block, input: permission.updatedInput }
        }
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Permission check error: ${err.message}`,
          is_error: true,
          tool_name: block.name,
        }
      }
    }

    if (context.abortSignal?.aborted) return cancelled()

    // Hook: PreToolUse
    const preHookResults = await this.executeHooks('PreToolUse', {
      toolName: block.name,
      toolInput: block.input,
      toolUseId: block.id,
    })
    // Check if any hook blocks this tool
    if (preHookResults.some((r) => r.block)) {
      const msg = preHookResults.find((r) => r.message)?.message || 'Blocked by PreToolUse hook'
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: msg,
        is_error: true,
        tool_name: block.name,
      }
    }

    // Execute the tool
    try {
      if (context.abortSignal?.aborted) return cancelled()
      const result = await tool.call(block.input, context)

      // Hook: PostToolUse
      await this.executeHooks('PostToolUse', {
        toolName: block.name,
        toolInput: block.input,
        toolOutput: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        toolUseId: block.id,
      })

      return { ...result, tool_use_id: block.id, tool_name: block.name }
    } catch (err: any) {
      // Hook: PostToolUseFailure
      await this.executeHooks('PostToolUseFailure', {
        toolName: block.name,
        toolInput: block.input,
        toolUseId: block.id,
        error: err.message,
      })

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Tool execution error: ${err.message}`,
        is_error: true,
        tool_name: block.name,
      }
    }
  }

  /**
   * Get current messages for session persistence.
   */
  getMessages(): NormalizedMessageParam[] {
    return [...this.messages]
  }

  /**
   * Get total usage across all turns.
   */
  getUsage(): TokenUsage {
    const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
      if (this.ledger.usage[key] !== undefined) usage[key] = (this.ledger.usage[key] ?? 0) - (this.initialUsage[key] ?? 0)
    }
    return usage
  }

  /**
   * Get total cost.
   */
  getCost(): number {
    return this.ledger.cost - this.initialCost
  }
}
