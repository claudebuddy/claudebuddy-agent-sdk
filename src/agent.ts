/**
 * Agent - High-level API
 *
 * Provides createAgent() and query() interfaces compatible with
 * open-agent-sdk.
 *
 * Usage:
 *   import { createAgent } from 'open-agent-sdk'
 *   const agent = createAgent({ model: 'claude-sonnet-4-6' })
 *   for await (const event of agent.query('Hello')) { ... }
 *
 *   // OpenAI-compatible models
 *   const agent = createAgent({
 *     apiType: 'openai-completions',
 *     model: 'gpt-4o',
 *     apiKey: 'sk-...',
 *     baseURL: 'https://api.openai.com/v1',
 *   })
 */

import type {
  AgentOptions,
  QueryResult,
  SDKMessage,
  ToolDefinition,
  ExecutionBudget,
  SDKResultMessage,
  Message,
  PermissionMode,
} from './types.js'
import type { ScheduleInput, SchedulePatch, ScheduledJob } from './scheduler/types.js'
import { Scheduler } from './scheduler/scheduler.js'
import { RunInteraction } from './interaction.js'
import type { UserMessageReceipt, QuestionAnswer, PendingQuestion } from './types.js'
import { QueryEngine } from './engine.js'
import { getAllBaseTools, filterTools } from './tools/index.js'
import { setSessionScheduler } from './tools/cron-tools.js'
import { clearTasks, getAllTasks, settleTaskGroup } from './tools/task-tools.js'
import { connectMCPServer, type MCPConnection } from './mcp/client.js'
import { setMcpConnections } from './tools/mcp-resource-tools.js'
import { isSdkServerConfig } from './sdk-mcp-server.js'
import { createPermissionPolicy, restrictTools, validateRunOptions } from './utils/permissions.js'
import {
  saveSession,
  appendSessionEvent,
  loadSession,
} from './session.js'
import { createHookRegistry, type HookRegistry } from './hooks.js'
import { initBundledSkills } from './skills/index.js'
import { createProvider, type LLMProvider, type ApiType } from './providers/index.js'
import type { NormalizedMessageParam } from './providers/types.js'
import {
  createUpdateGoalTool,
  buildGoalSystemPrompt,
  getGoalState,
  createGoalState,
} from './tools/update-goal.js'

// --------------------------------------------------------------------------
// Agent class
// --------------------------------------------------------------------------

export class Agent {
  private cfg: AgentOptions
  private toolPool: ToolDefinition[]
  private modelId: string
  private apiType: ApiType
  private apiCredentials: { key?: string; baseUrl?: string }
  private provider: LLMProvider
  private mcpLinks: MCPConnection[] = []
  private history: NormalizedMessageParam[] = []
  private messageLog: Message[] = []
  private setupDone: Promise<void>
  private sid: string
  private abortCtrl: AbortController | null = null
  private currentEngine: QueryEngine | null = null
  private hookRegistry: HookRegistry
  private sessionState = new Map<string, unknown>()
  private interaction: RunInteraction | null = null
  private inputReceipts = new Map<string, UserMessageReceipt>()
  private activeRun = false
  private closed = false
  private scheduler: Scheduler | null = null

  constructor(options: AgentOptions = {}) {
    validateRunOptions(options)
    // Snapshot permission bounds and agent definitions rather than sharing caller arrays.
    this.cfg = {
      ...options,
      allowedTools: options.allowedTools ? [...options.allowedTools] : options.allowedTools,
      disallowedTools: options.disallowedTools ? [...options.disallowedTools] : options.disallowedTools,
      agents: structuredClone(options.agents ?? {}),
    }

    // Merge credentials from options.env map, direct options, and process.env
    this.apiCredentials = this.pickCredentials()
    this.modelId = this.cfg.model ?? this.readEnv('MODEL') ?? 'claude-sonnet-4-6'
    this.sid = this.cfg.sessionId ?? crypto.randomUUID()

    // Resolve API type
    this.apiType = this.resolveApiType()

    // Create LLM provider
    this.provider = createProvider(this.apiType, {
      apiKey: this.apiCredentials.key,
      baseURL: this.apiCredentials.baseUrl,
    })

    // Initialize bundled skills
    initBundledSkills()

    // Build hook registry from options
    this.hookRegistry = createHookRegistry()
    if (this.cfg.hooks) {
      // Convert AgentOptions hooks format to HookConfig
      for (const [event, defs] of Object.entries(this.cfg.hooks)) {
        for (const def of defs) {
          for (const handler of def.hooks) {
            this.hookRegistry.register(event as any, {
              matcher: def.matcher,
              timeout: def.timeout,
              handler: async (input) => {
                const result = await handler(input, input.toolUseId || '', {
                  signal: this.abortCtrl?.signal || new AbortController().signal,
                })
                return result || undefined
              },
            })
          }
        }
      }
    }

    // Build tool pool from options (supports ToolDefinition[], string[], or preset)
    this.toolPool = this.buildToolPool()

    // Kick off async setup (MCP connections, agent registration, session resume)
    this.setupDone = this.setup()
  }

  /**
   * Resolve API type from options, env, or model name heuristic.
   */
  private resolveApiType(): ApiType {
    // Explicit option
    if (this.cfg.apiType) return this.cfg.apiType

    // Env var
    const envType =
      this.envMapValue('API_TYPE') ??
      this.readEnv('API_TYPE')
    if (envType === 'openai-completions' || envType === 'anthropic-messages') {
      return envType
    }

    // Heuristic from model name
    const model = this.modelId.toLowerCase()
    if (
      model.includes('gpt-') ||
      model.includes('o1') ||
      model.includes('o3') ||
      model.includes('o4') ||
      model.includes('deepseek') ||
      model.includes('qwen') ||
      model.includes('yi-') ||
      model.includes('glm') ||
      model.includes('mistral') ||
      model.includes('gemma')
    ) {
      return 'openai-completions'
    }

    return 'anthropic-messages'
  }

  /** Pick API key and base URL from options or CLAUDEBUDDY_* env vars. */
  private pickCredentials(): { key?: string; baseUrl?: string } {
    return {
      key:
        this.cfg.apiKey ??
        this.envMapValue('API_KEY') ??
        this.envMapValue('AUTH_TOKEN') ??
        this.readEnv('API_KEY') ??
        this.readEnv('AUTH_TOKEN'),
      baseUrl:
        this.cfg.baseURL ??
        this.envMapValue('BASE_URL') ??
        this.readEnv('BASE_URL'),
    }
  }

  /**
   * Read an env var by its short key using the CLAUDEBUDDY_ prefix.
   * e.g. readEnv('MODEL') checks CLAUDEBUDDY_MODEL.
   */
  private readEnv(shortKey: string): string | undefined {
    return process.env[`CLAUDEBUDDY_${shortKey}`] || undefined
  }

  /** Read a value from the options `env` map using the CLAUDEBUDDY_ prefix. */
  private envMapValue(shortKey: string): string | undefined {
    return this.cfg.env?.[`CLAUDEBUDDY_${shortKey}`]
  }

  /** Assemble the available tool set based on options. */
  private buildToolPool(): ToolDefinition[] {
    const raw = this.cfg.tools
    let pool: ToolDefinition[]

    if (!raw || (typeof raw === 'object' && !Array.isArray(raw) && 'type' in raw)) {
      pool = getAllBaseTools()
    } else if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
      pool = filterTools(getAllBaseTools(), raw as string[])
    } else {
      pool = raw as ToolDefinition[]
    }

    const schedulerTools = new Set(['CronCreate', 'CronList', 'CronGet', 'CronUpdate', 'CronRun', 'CronDelete'])
    pool = pool.filter(tool => tool.name !== 'RemoteTrigger' && (this.cfg.scheduler?.enabled || !schedulerTools.has(tool.name)))
    if (this.cfg.scheduler?.enabled) pool = pool.map(tool => schedulerTools.has(tool.name) ? { ...tool, isEnabled: () => true } : tool)
    return filterTools(pool, this.cfg.allowedTools, this.cfg.disallowedTools)
  }

  /**
   * Async initialization: connect MCP servers, register agents, resume sessions.
   */
  private async setup(): Promise<void> {
    // Connect MCP servers (supports stdio, SSE, HTTP, and in-process SDK servers)
    if (this.cfg.mcpServers) {
      for (const [name, config] of Object.entries(this.cfg.mcpServers)) {
        try {
          if (isSdkServerConfig(config)) {
            // In-process SDK MCP server - directly add tools
            this.toolPool = [...this.toolPool, ...config.tools]
          } else {
            // External MCP server
            const connection = await connectMCPServer(name, config)
            this.mcpLinks.push(connection)

            if (connection.status === 'connected' && connection.tools.length > 0) {
              this.toolPool = [...this.toolPool, ...connection.tools]
            }
          }
        } catch (err: any) {
          console.error(`[MCP] Failed to connect to "${name}": ${err.message}`)
        }
      }
    }

    setMcpConnections(this.mcpLinks, this.sessionState)

    // Resume or continue session. An explicitly supplied history wins: hosts
    // that keep sessions in their own store (a database) pass it here and the
    // session files are never read.
    if (this.cfg.history?.length) {
      this.history = [...this.cfg.history]
      if (this.cfg.resume) this.sid = this.cfg.resume
    } else if (this.cfg.resume) {
      const sessionData = await loadSession(this.cfg.resume)
      if (sessionData) {
        this.history = sessionData.messages
        this.sid = this.cfg.resume
      }
    }

    if (this.cfg.scheduler?.enabled) {
      const configuredEvent = this.cfg.scheduler.onEvent
      this.scheduler = new Scheduler(this.sid, {
        ...this.cfg.scheduler,
        onEvent: async event => {
          if (this.cfg.persistSession !== false) {
            await appendSessionEvent(this.sid, {
              type: 'system', subtype: 'status', message: `scheduler:${JSON.stringify(event)}`,
            })
          }
          await configuredEvent?.(event)
        },
      }, {
        persistent: this.cfg.persistSession !== false,
        execute: (job, signal) => this.executeScheduledJob(job, signal),
      })
      await this.scheduler.start()
      setSessionScheduler(this.scheduler, this.sessionState)
    }
  }

  /** Execute a scheduled prompt without touching the owning Agent's run state. */
  private async executeScheduledJob(job: ScheduledJob, signal: AbortSignal): Promise<QueryResult> {
    const schedulerTools = new Set(['CronCreate', 'CronList', 'CronGet', 'CronUpdate', 'CronRun', 'CronDelete'])
    const childOptions: AgentOptions = {
      ...this.cfg,
      model: job.model ?? this.modelId,
      maxTurns: job.maxTurns ?? this.cfg.maxTurns,
      maxBudgetUsd: job.maxBudgetUsd ?? this.cfg.maxBudgetUsd,
      tools: this.toolPool.filter(tool => !schedulerTools.has(tool.name)),
      mcpServers: undefined,
      scheduler: undefined,
      sessionId: `${this.sid}_${job.id}_${crypto.randomUUID()}`,
      resume: undefined,
      continue: false,
      history: [],
      persistSession: false,
      interactive: false,
      abortController: undefined,
      abortSignal: signal,
    }
    const child = new Agent(childOptions)
    ;(child as any).provider = this.provider
    try { return await child.prompt(job.prompt) }
    finally { await child.close() }
  }

  /** Run one query, or an explicitly configured goal, with exclusive session ownership. */
  async *query(prompt: string | any[], overrides?: Partial<AgentOptions>): AsyncGenerator<SDKMessage, void> {
    const opts = { ...this.cfg, ...overrides }
    const configuredGoal = typeof this.cfg.goal === 'object' ? this.cfg.goal : undefined
    const overriddenGoal = typeof overrides?.goal === 'object' ? overrides.goal : undefined
    const autoGoal = overrides?.goal === false ? false :
      overriddenGoal?.enabledOnQuery ?? configuredGoal?.enabledOnQuery ?? false
    yield* this.withRun(opts, budget => autoGoal && typeof prompt === 'string'
      ? this.runGoalInternal(prompt, overrides, budget)
      : this.queryOnce(prompt, overrides, budget))
  }

  /** A controller and ledger outlive every round/child in this run. */
  private async *withRun(
    opts: AgentOptions,
    run: (budget: ExecutionBudget) => AsyncGenerator<SDKMessage, void>,
  ): AsyncGenerator<SDKMessage, void> {
    if (this.closed) throw new Error('Agent is closed')
    if (this.activeRun) throw new Error('Agent already has an active query or goal')
    validateRunOptions(opts)
    // A per-query override cannot turn off configured sandbox enforcement.
    validateRunOptions(this.cfg)
    this.activeRun = true
    const controller = new AbortController()
    this.abortCtrl = controller
    const interaction = new RunInteraction(this.inputReceipts)
    this.interaction = interaction
    const sources = new Set([opts.abortSignal, opts.abortController?.signal].filter((signal): signal is AbortSignal => !!signal))
    const listeners: Array<() => void> = []
    for (const source of sources) {
      const abort = () => controller.abort(source.reason)
      if (source.aborted) abort()
      else {
        source.addEventListener('abort', abort, { once: true })
        listeners.push(() => source.removeEventListener('abort', abort))
      }
    }
    const budget: ExecutionBudget = { cost: 0, usage: { input_tokens: 0, output_tokens: 0 } }
    try {
      await this.setupDone
      for await (const event of interaction.merge(run(budget), () => controller.abort())) {
        if (event.type === 'result') {
          interaction.finish()
          let pendingEvent: SDKMessage | undefined
          while ((pendingEvent = interaction.shiftEvent())) {
            if (opts.persistSession !== false) await appendSessionEvent(this.sid, pendingEvent)
            yield pendingEvent
          }
        }
        if (opts.persistSession !== false) await appendSessionEvent(this.sid, event)
        yield event
      }
    } finally {
      interaction.finish()
      try {
        if (opts.persistSession !== false) {
          for (const event of interaction.drain()) await appendSessionEvent(this.sid, event)
        }
      } finally {
        this.interaction = null
        controller.abort()
        for (const remove of listeners) remove()
        this.currentEngine = null
        this.abortCtrl = null
        this.activeRun = false
      }
    }
  }

  private async *queryOnce(
    prompt: string | any[],
    overrides: Partial<AgentOptions> | undefined,
    budget: ExecutionBudget,
    internalTools: ToolDefinition[] = [],
  ): AsyncGenerator<SDKMessage, void> {
    const opts = { ...this.cfg, ...overrides }
    const cwd = opts.cwd || process.cwd()
    let systemPrompt: string | undefined
    let appendSystemPrompt = opts.appendSystemPrompt
    if (typeof opts.systemPrompt === 'object') {
      appendSystemPrompt = [appendSystemPrompt, opts.systemPrompt.append].filter(Boolean).join('\n')
    } else {
      systemPrompt = opts.systemPrompt
    }

    let tools = this.toolPool
    const replacement = overrides?.tools
    if (Array.isArray(replacement)) {
      tools = replacement.length && typeof replacement[0] === 'string'
        ? filterTools(this.toolPool, replacement as string[])
        : replacement as ToolDefinition[]
    }
    tools = restrictTools(tools, this.cfg, overrides)
    const mode = opts.permissionMode ?? 'bypassPermissions'
    const policy = createPermissionPolicy(mode, opts.allowedTools, opts.canUseTool)
    // Internal goal reporting is control-plane bookkeeping, not an external action.
    const canUseTool = (tool: ToolDefinition, input: unknown) => internalTools.includes(tool)
      ? Promise.resolve({ behavior: 'allow' as const })
      : policy(tool, input)
    tools = [...tools, ...internalTools]

    let provider = this.provider
    if (overrides?.apiType || overrides?.apiKey || overrides?.baseURL) {
      provider = createProvider(overrides.apiType ?? this.apiType, {
        apiKey: overrides.apiKey ?? this.apiCredentials.key,
        baseURL: overrides.baseURL ?? this.apiCredentials.baseUrl,
      })
    }
    const engine = new QueryEngine({
      inputController: this.interaction ?? undefined,
      askQuestion: opts.interactive ? this.interaction!.ask.bind(this.interaction) : undefined,
      questionTimeoutMs: opts.questionTimeoutMs,
      cwd, model: opts.model || this.modelId, provider, tools, systemPrompt,
      appendSystemPrompt, maxTurns: opts.maxTurns ?? 10,
      maxBudgetUsd: opts.maxBudgetUsd, executionBudget: budget,
      maxTokens: opts.maxTokens ?? 16384, thinking: opts.thinking,
      jsonSchema: opts.jsonSchema, canUseTool, permissionMode: mode,
      includePartialMessages: opts.includePartialMessages ?? false,
      abortSignal: this.abortCtrl!.signal, agents: opts.agents ?? {},
      sessionState: this.sessionState, hookRegistry: this.hookRegistry,
      sessionId: this.sid, contextWindowSize: opts.contextWindowSize,
      pricingPerMillion: opts.pricingPerMillion, spill: opts.spill,
    })
    this.currentEngine = engine
    engine.messages.push(...this.history)
    let userRecorded = false
    try {
      for await (const event of engine.submitMessage(prompt)) {
        if (event.type === 'system' && event.subtype === 'init' && !userRecorded) {
          this.messageLog.push({ type: 'user', message: { role: 'user', content: prompt }, uuid: crypto.randomUUID(), timestamp: new Date().toISOString() })
          userRecorded = true
        }
        if (event.type === 'system' && event.subtype === 'user_message' && event.status === 'applied') {
          this.messageLog.push({ type: 'user', message: { role: 'user', content: event.text }, uuid: event.id, timestamp: new Date().toISOString() })
        }
        if (event.type === 'assistant') {
          this.messageLog.push({ type: 'assistant', message: event.message, uuid: crypto.randomUUID(), timestamp: new Date().toISOString() })
        }
        if (opts.persistSession !== false && event.type !== 'partial_message') {
          // Checkpoint before publishing durable semantic events to the consumer.
          await saveSession(this.sid, engine.getMessages(), { cwd, model: opts.model || this.modelId })
        }
        yield event
      }
    } finally {
      this.history = engine.getMessages()
      if (opts.persistSession !== false) await saveSession(this.sid, this.history, { cwd, model: opts.model || this.modelId })
      this.currentEngine = null
    }
  }

  /** Collect text and retain the final status instead of hiding engine failures. */
  async prompt(text: string, overrides?: Partial<AgentOptions>): Promise<QueryResult> {
    const start = performance.now()
    let output = ''
    let result: SDKResultMessage = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Query ended without a final result'] }
    for await (const event of this.query(text, overrides)) {
      if (event.type === 'assistant') {
        const fragments = event.message.content.filter(block => block.type === 'text').map(block => block.text)
        if (fragments.length) output = fragments.join('')
      } else if (event.type === 'result') result = event
    }
    return {
      text: output, subtype: result.subtype, is_error: result.is_error ?? result.subtype !== 'success',
      errors: result.errors, total_cost_usd: result.total_cost_usd ?? result.cost ?? 0,
      usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
      num_turns: result.num_turns ?? 0, duration_ms: Math.round(performance.now() - start),
      messages: [...this.messageLog],
    }
  }

  /** Goal rounds share cancellation, accounting and a run-local goal report. */
  async *runGoal(goal: string, overrides?: { maxGoalRounds?: number; turnsPerRound?: number }): AsyncGenerator<SDKMessage, void> {
    const goalOptions = typeof this.cfg.goal === 'object' ? this.cfg.goal : {}
    const queryOverrides: Partial<AgentOptions> = { goal: { ...goalOptions, ...overrides } }
    yield* this.withRun(this.cfg, budget => this.runGoalInternal(goal, queryOverrides, budget))
  }

  private async *runGoalInternal(
    goal: string,
    overrides: Partial<AgentOptions> | undefined,
    budget: ExecutionBudget,
  ): AsyncGenerator<SDKMessage, void> {
    const opts = { ...this.cfg, ...overrides }
    const settings = typeof opts.goal === 'object' ? opts.goal : {}
    const maxRounds = settings.maxGoalRounds ?? 10
    const turnsPerRound = settings.turnsPerRound ?? opts.maxTurns ?? 10
    const maxStalls = settings.maxConsecutiveStalls
    for (const [name, value] of Object.entries({ maxGoalRounds: maxRounds, turnsPerRound, maxConsecutiveStalls: maxStalls })) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer`)
    }
    const state = createGoalState()
    const goalTool = createUpdateGoalTool(state)
    let lastRevision = 0
    let stalls = 0
    let turns = 0
    let apiTime = 0
    let terminal: SDKResultMessage = { type: 'result', subtype: 'error_max_rounds', errors: [`Goal not completed after ${maxRounds} rounds`] }
    for (let round = 0; round < maxRounds; round++) {
      if (this.abortCtrl!.signal.aborted) {
        terminal = { type: 'result', subtype: 'cancelled', errors: ['Run cancelled'] }
        break
      }
      const roundOverrides: Partial<AgentOptions> = {
        ...overrides,
        appendSystemPrompt: [opts.appendSystemPrompt, buildGoalSystemPrompt(goal, maxRounds)].filter(Boolean).join('\n\n'),
        maxTurns: turnsPerRound,
      }
      let result: SDKResultMessage | undefined
      for await (const event of this.queryOnce(round === 0 ? goal : 'Continue working toward the goal. Report complete only when finished, or blocked when unable to proceed.', roundOverrides, budget, [goalTool])) {
        if (event.type === 'result') result = event
        else yield event
      }
      if (result) {
        turns += result.num_turns ?? 0
        apiTime += result.duration_api_ms ?? 0
        if (result.subtype !== 'success' && result.subtype !== 'error_max_turns') {
          terminal = result
          break
        }
      }
      if (this.abortCtrl!.signal.aborted) {
        terminal = { type: 'result', subtype: 'cancelled', errors: ['Run cancelled'] }
        break
      }
      const report = getGoalState(state)
      if (report.revision > lastRevision) {
        stalls = 0
        lastRevision = report.revision
        if (report.status === 'complete' || report.status === 'blocked') {
          terminal = { type: 'result', subtype: report.status === 'complete' ? 'success' : 'goal_blocked', errors: report.status === 'blocked' ? [report.summary || 'Goal blocked'] : undefined }
          break
        }
      } else if (maxStalls && ++stalls >= maxStalls) {
        terminal = { type: 'result', subtype: 'goal_blocked', errors: [`No progress reported for ${stalls} consecutive rounds`] }
        break
      }
    }
    yield { ...terminal, session_id: this.sid, is_error: terminal.subtype !== 'success', num_turns: turns,
      usage: { ...budget.usage }, total_cost_usd: budget.cost, cost: budget.cost, duration_api_ms: apiTime,
      model_usage: budget.modelUsage ? structuredClone(budget.modelUsage) : undefined }
  }

  /**
   * Get conversation messages.
   */
  getMessages(): Message[] {
    return [...this.messageLog]
  }

  /** Pass this session handle to built-in state helpers such as setQuestionHandler. */
  getToolState(): Map<string, unknown> {
    return this.sessionState
  }

  /**
   * Reset conversation history.
   */
  clear(): void {
    if (this.activeRun) throw new Error('Cannot clear an active query or goal')
    clearTasks(this.sessionState)
    this.inputReceipts.clear()
    this.sessionState.clear()
    setMcpConnections(this.mcpLinks, this.sessionState)
    this.history = []
    this.messageLog = []
  }

  /** Queue steering input for the current run; returns a receipt ID immediately. */
  sendMessage(text: string): string {
    if (!this.activeRun || !this.interaction || this.abortCtrl?.signal.aborted) throw new Error('Agent has no active input window')
    return this.interaction.send(text)
  }

  getMessageStatus(id: string): UserMessageReceipt | undefined {
    const receipt = this.inputReceipts.get(id)
    return receipt ? { ...receipt } : undefined
  }

  getPendingQuestions(): PendingQuestion[] { return this.interaction?.pendingQuestions() ?? [] }

  answerQuestion(id: string, answer: QuestionAnswer): void {
    if (!this.interaction) throw new Error('Question is not pending in this Agent')
    this.interaction.answer(id, answer)
  }

  cancelQuestion(id: string): void {
    if (!this.interaction) throw new Error('Question is not pending in this Agent')
    this.interaction.cancel(id)
  }

  /**
   * Interrupt the current query.
   */
  async interrupt(): Promise<void> {
    this.abortCtrl?.abort()
  }

  /**
   * Change the model during a session.
   */
  async setModel(model?: string): Promise<void> {
    if (model) {
      this.modelId = model
      this.cfg.model = model
    }
  }

  /**
   * Change the permission mode during a session.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.cfg.permissionMode = mode
  }

  /**
   * Set maximum thinking tokens.
   */
  async setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void> {
    if (maxThinkingTokens === null) {
      this.cfg.thinking = { type: 'disabled' }
    } else {
      this.cfg.thinking = { type: 'enabled', budgetTokens: maxThinkingTokens }
    }
  }

  /**
   * Get the session ID.
   */
  getSessionId(): string {
    return this.sid
  }

  /**
   * Get the current API type.
   */
  getApiType(): ApiType {
    return this.apiType
  }

  private async requireScheduler(): Promise<Scheduler> {
    await this.setupDone
    if (!this.scheduler) throw new Error(this.closed ? 'Agent is closed' : 'Scheduler is not enabled')
    return this.scheduler
  }

  async createSchedule(input: ScheduleInput): Promise<ScheduledJob> { return (await this.requireScheduler()).create(input) }
  async listSchedules(): Promise<ScheduledJob[]> { return (await this.requireScheduler()).list() }
  async getSchedule(id: string): Promise<ScheduledJob | undefined> { return (await this.requireScheduler()).get(id) }
  async updateSchedule(id: string, patch: SchedulePatch): Promise<ScheduledJob> { return (await this.requireScheduler()).update(id, patch) }
  async runSchedule(id: string): Promise<string> { return (await this.requireScheduler()).runNow(id) }
  async deleteSchedule(id: string): Promise<boolean> { return (await this.requireScheduler()).delete(id) }

  /**
   * Stop a background task.
   */
  async stopTask(taskId: string): Promise<void> {
    const { getTask, stopTaskExecution } = await import('./tools/task-tools.js')
    await stopTaskExecution(taskId, this.sessionState)
    const task = getTask(taskId, this.sessionState)
    if (task && !task.kind) {
      task.status = 'cancelled'
    }
  }

  /**
   * Close MCP connections and clean up.
   * Optionally persist session to disk.
   */
  async close(): Promise<void> {
    if (this.closed) return
    if (this.activeRun) throw new Error('Interrupt and finish the active query before closing the Agent')
    this.closed = true
    await this.setupDone
    await this.scheduler?.close()
    await settleTaskGroup(new Set(getAllTasks(this.sessionState).filter(task => task.kind).map(task => task.id)), this.sessionState, true)
    // Persist session if enabled
    if (this.cfg.persistSession !== false && this.history.length > 0) {
      try {
        await saveSession(this.sid, this.history, {
          cwd: this.cfg.cwd || process.cwd(),
          model: this.modelId,
          summary: undefined,
        })
      } catch {
        // Session persistence is best-effort
      }
    }

    for (const conn of this.mcpLinks) {
      await conn.close()
    }
    this.mcpLinks = []
  }
}

// --------------------------------------------------------------------------
// Factory function
// --------------------------------------------------------------------------

/** Factory: shorthand for `new Agent(options)`. */
export function createAgent(options: AgentOptions = {}): Agent {
  return new Agent(options)
}

// --------------------------------------------------------------------------
// Standalone query — one-shot convenience wrapper
// --------------------------------------------------------------------------

/**
 * Execute a single agentic query without managing an Agent instance.
 * The agent is created, used, and cleaned up automatically.
 */
export async function* query(params: {
  prompt: string | any[]
  options?: AgentOptions
}): AsyncGenerator<SDKMessage, void> {
  const ephemeral = createAgent(params.options)
  try {
    yield* ephemeral.query(params.prompt)
  } finally {
    await ephemeral.close()
  }
}
