/**
 * Core type definitions for the Agent SDK
 */

import type { NormalizedMessageParam } from './providers/types.js'

// Content block types (provider-agnostic, compatible with Anthropic format)
export type ContentBlockParam =
  | { type: 'text'; text: string }
  | { type: 'image'; source: any }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string | any[]; is_error?: boolean }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'thinking'; thinking: string }

// --------------------------------------------------------------------------
// Message Types
// --------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant'

export interface ConversationMessage {
  role: MessageRole
  content: string | ContentBlockParam[]
}

export interface UserMessage {
  type: 'user'
  message: ConversationMessage
  uuid: string
  timestamp: string
}

export interface AssistantMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  uuid: string
  timestamp: string
  usage?: TokenUsage
  cost?: number
}

export type Message = UserMessage | AssistantMessage

// --------------------------------------------------------------------------
// SDK Message Types (streaming events)
// --------------------------------------------------------------------------

export interface UserMessageReceipt {
  id: string
  text: string
  status: 'queued' | 'applied' | 'not_applied'
  reason?: string
}
export interface QuestionRequest {
  question: string
  options?: string[]
  allow_multiselect?: boolean
}
export interface PendingQuestion extends QuestionRequest { question_id: string }
export type QuestionAnswer = string | string[]
export type SDKInteractionMessage =
  | ({ type: 'system'; subtype: 'user_message' } & UserMessageReceipt)
  | ({ type: 'system'; subtype: 'question' } & PendingQuestion)
  | { type: 'system'; subtype: 'question_closed'; question_id: string; status: 'answered' | 'cancelled' | 'timed_out' }

export type SDKMessage =
  | SDKInteractionMessage
  | SDKAssistantMessage
  | SDKToolResultMessage
  | SDKResultMessage
  | SDKPartialMessage
  | SDKSystemMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKTaskNotificationMessage
  | SDKRateLimitEvent

export interface SDKAssistantMessage {
  type: 'assistant'
  uuid?: string
  session_id?: string
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  parent_tool_use_id?: string | null
}

export interface SDKToolResultMessage {
  type: 'tool_result'
  result: {
    tool_use_id: string
    tool_name: string
    output: string
  }
}

export interface SDKResultMessage {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd' | string
  uuid?: string
  session_id?: string
  is_error?: boolean
  num_turns?: number
  result?: string
  stop_reason?: string | null
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  usage?: TokenUsage
  model_usage?: Record<string, { input_tokens: number; output_tokens: number }>
  permission_denials?: Array<{ tool: string; reason: string }>
  structured_output?: unknown
  errors?: string[]
  /** @deprecated Use total_cost_usd */
  cost?: number
}

export interface SDKPartialMessage {
  type: 'partial_message'
  partial: {
    type: 'text' | 'tool_use'
    index?: number
    id?: string
    text?: string
    name?: string
    input?: string
  }
}

/** Emitted once at session start with initialization info. */
export interface SDKSystemMessage {
  type: 'system'
  subtype: 'init'
  uuid?: string
  session_id: string
  tools: string[]
  model: string
  cwd: string
  mcp_servers: Array<{ name: string; status: string }>
  permission_mode: string
}

/** Marks a compaction boundary in the conversation. */
export interface SDKCompactBoundaryMessage {
  type: 'system'
  subtype: 'compact_boundary'
  summary?: string
}

/** Status update during long operations. */
export interface SDKStatusMessage {
  type: 'system'
  subtype: 'status'
  message: string
}

/** Task lifecycle notification. */
export interface SDKTaskNotificationMessage {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  status: string
  message?: string
}

/** Rate limit event. */
export interface SDKRateLimitEvent {
  type: 'system'
  subtype: 'rate_limit'
  retry_after_ms?: number
  message: string
}

// --------------------------------------------------------------------------
// Token Usage
// --------------------------------------------------------------------------

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** Shared accounting for a query or goal and all of its child model calls. */
export interface ExecutionBudget {
  cost: number
  usage: TokenUsage
  modelUsage?: Record<string, TokenUsage>
}

// --------------------------------------------------------------------------
// Tool Types
// --------------------------------------------------------------------------

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
  call: (input: any, context: ToolContext) => Promise<ToolResult>
  isReadOnly?: () => boolean
  isConcurrencySafe?: () => boolean
  isEnabled?: () => boolean
  prompt?: (context: ToolContext) => Promise<string>
}

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, any>
  required?: string[]
}

export interface ToolContext {
  askQuestion?: (request: QuestionRequest, signal: AbortSignal) => Promise<string>
  questionTimeoutMs?: number
  /** Engine-owned background tasks, drained before the run result. */
  taskGroup?: Set<string>
  cwd: string
  abortSignal?: AbortSignal
  /** Parent agent's LLM provider (inherited by subagents) */
  provider?: import('./providers/types.js').LLMProvider
  /** Parent agent's model ID */
  model?: string
  /** Parent agent's API type */
  apiType?: import('./providers/types.js').ApiType
  /** Mutable state shared within one Agent session, never across instances. */
  sessionState?: Map<string, unknown>
  tools?: ToolDefinition[]
  agents?: Record<string, AgentDefinition>
  canUseTool?: CanUseToolFn
  executionBudget?: ExecutionBudget
  maxBudgetUsd?: number
  pricingPerMillion?: { input: number; output: number }
  hookRegistry?: import('./hooks.js').HookRegistry
  sessionId?: string
}

export interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string | any[]
  is_error?: boolean
}

// --------------------------------------------------------------------------
// Permission Types
// --------------------------------------------------------------------------

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

export type PermissionBehavior = 'allow' | 'deny'

export type CanUseToolResult = {
  behavior: PermissionBehavior
  updatedInput?: unknown
  message?: string
}

export type CanUseToolFn = (
  tool: ToolDefinition,
  input: unknown,
) => Promise<CanUseToolResult>

// --------------------------------------------------------------------------
// MCP Types
// --------------------------------------------------------------------------

export type McpServerConfig =
  | McpStdioConfig
  | McpSseConfig
  | McpHttpConfig

export interface McpStdioConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpSseConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export interface McpHttpConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

// --------------------------------------------------------------------------
// Agent Types
// --------------------------------------------------------------------------

export interface AgentDefinition {
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit' | string
  mcpServers?: Array<string | { name: string; tools?: string[] }>
  skills?: string[]
  maxTurns?: number
  criticalSystemReminder_EXPERIMENTAL?: string
}

export interface ThinkingConfig {
  type: 'adaptive' | 'enabled' | 'disabled'
  budgetTokens?: number
}

// --------------------------------------------------------------------------
// Sandbox Types
// --------------------------------------------------------------------------

export interface SandboxSettings {
  enabled?: boolean
  autoAllowBashIfSandboxed?: boolean
  excludedCommands?: string[]
  allowUnsandboxedCommands?: boolean
  network?: SandboxNetworkConfig
  filesystem?: SandboxFilesystemConfig
  ignoreViolations?: Record<string, string[]>
  enableWeakerNestedSandbox?: boolean
  ripgrep?: { command: string; args?: string[] }
}

export interface SandboxNetworkConfig {
  allowedDomains?: string[]
  allowManagedDomainsOnly?: boolean
  allowLocalBinding?: boolean
  allowUnixSockets?: string[]
  allowAllUnixSockets?: boolean
  httpProxyPort?: number
  socksProxyPort?: number
}

export interface SandboxFilesystemConfig {
  allowWrite?: string[]
  denyWrite?: string[]
  denyRead?: string[]
}

// --------------------------------------------------------------------------
// Output Format
// --------------------------------------------------------------------------

export interface OutputFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
}

// --------------------------------------------------------------------------
// Setting Sources
// --------------------------------------------------------------------------

export type SettingSource = 'user' | 'project' | 'local'

// --------------------------------------------------------------------------
// Model Info
// --------------------------------------------------------------------------

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

export interface AgentOptions {
  /** LLM model ID */
  model?: string
  /**
   * API type: 'anthropic-messages' or 'openai-completions'.
   * Falls back to CLAUDEBUDDY_API_TYPE env var. Default: 'anthropic-messages'.
   */
  apiType?: import('./providers/types.js').ApiType
  /** API key. Falls back to CLAUDEBUDDY_API_KEY env var. */
  apiKey?: string
  /** API base URL override */
  baseURL?: string
  /** Working directory for file/shell tools */
  cwd?: string
  /** System prompt override or preset */
  systemPrompt?: string | { type: 'preset'; preset: 'default'; append?: string }
  /** Append to default system prompt */
  appendSystemPrompt?: string
  /** Available tools (ToolDefinition[] or string[] preset) */
  tools?: ToolDefinition[] | string[] | { type: 'preset'; preset: 'default' }
  /** Maximum number of agentic turns per query */
  maxTurns?: number
  /** Maximum USD budget per query */
  maxBudgetUsd?: number
  /** Extended thinking configuration */
  thinking?: ThinkingConfig
  /** Maximum thinking tokens (deprecated, use thinking.budgetTokens) */
  maxThinkingTokens?: number
  /** Structured output JSON schema */
  jsonSchema?: Record<string, unknown>
  /** Structured output format */
  outputFormat?: OutputFormat
  /** Permission handler callback */
  canUseTool?: CanUseToolFn
  /** Permission mode controlling tool approval behavior */
  permissionMode?: PermissionMode
  /** Abort controller for cancellation */
  abortController?: AbortController
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
  /** Whether to include partial streaming events */
  includePartialMessages?: boolean
  /** Emit answerable question events instead of non-interactive fallback. */
  interactive?: boolean
  /** Positive question wait limit in milliseconds (default 300000). */
  questionTimeoutMs?: number
  /** Environment variables */
  env?: Record<string, string | undefined>
  /** Tool names to pre-approve without prompting */
  allowedTools?: string[]
  /** Tool names to deny */
  disallowedTools?: string[]
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig | any> // supports McpSdkServerConfig
  /** Custom subagent definitions */
  agents?: Record<string, AgentDefinition>
  /** Maximum tokens for responses */
  maxTokens?: number
  /** Effort level for reasoning */
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Fallback model if primary is unavailable */
  fallbackModel?: string
  /** Continue the most recent session in cwd */
  continue?: boolean
  /** Resume a specific session by ID */
  resume?: string
  /** Fork a session instead of continuing it */
  forkSession?: boolean
  /** Persist session to disk */
  persistSession?: boolean
  /**
   * Conversation history to start from, instead of loading it from disk.
   *
   * Lets a host keep sessions in its own store (a database, say) and stay
   * stateless: pass the prior turns here with `persistSession: false` and the
   * SDK never touches the session files. Takes precedence over `resume`.
   */
  history?: NormalizedMessageParam[]
  /** Explicit session ID */
  sessionId?: string
  /** Enable file checkpointing (for rewindFiles) */
  enableFileCheckpointing?: boolean
  /** Sandbox configuration */
  sandbox?: SandboxSettings
  /** Load settings from filesystem */
  settingSources?: SettingSource[]
  /** Plugin configurations */
  plugins?: Array<{ name: string; config?: Record<string, unknown> }>
  /** Additional working directories */
  additionalDirectories?: string[]
  /** Default agent to use */
  agent?: string
  /** Debug mode */
  debug?: boolean
  /** Debug log file */
  debugFile?: string
  /** Tool-specific configuration */
  toolConfig?: Record<string, unknown>
  /** Enable prompt suggestions */
  promptSuggestions?: boolean
  /** Strict MCP config validation */
  strictMcpConfig?: boolean
  /** Extra CLI arguments */
  extraArgs?: Record<string, string | null>
  /** SDK betas to enable */
  betas?: string[]
  /** Permission prompt tool name override */
  permissionPromptToolName?: string
  /** Hook configurations */
  hooks?: Record<string, Array<{
    matcher?: string
    hooks: Array<(input: any, toolUseId: string, context: { signal: AbortSignal }) => Promise<any>>
    timeout?: number
  }>>
  /** 模型上下文窗口大小（单位：tokens），不设置则按原有模型匹配逻辑 */
  contextWindowSize?: number
  /** 模型定价（每百万 tokens，USD），不设置则按原有模型匹配逻辑 */
  pricingPerMillion?: {
    input: number
    output: number
  }
  /**
   * Spill 溢出配置：超长工具结果落盘，head/tail 预览 + locator 替换，
   * 避免超大工具输出撑爆上下文。
   */
  spill?: {
    /** 工具结果超过该字节数即落盘（默认 20000） */
    maxInlineBytes?: number
    /** 给模型的 head/tail 预览字节数（默认 4000） */
    previewBytes?: number
    /** 永不落盘的工具名（如 read，避免 read->spill->read 循环） */
    neverSpillTools?: string[]
    /**
     * 只对这些工具启用落盘（白名单）。若提供非空数组，则仅列表中
     * 的工具超限时才会 spill，其余工具走内联截断。
     */
    enabledFor?: string[]
    /** 落盘目录（默认 <cwd>/.spill） */
    spillDir?: string
  }
  /**
   * Goal 目标驱动循环：给一个目标让 agent 一直执行到完成/受阻。
   * agent 空闲且无新输入时自动注入 continuation，完成判定交给
   * `update_goal` 工具，`maxGoalRounds` 防止无限循环。
   */
  goal?: {
    /** 是否启用目标驱动循环（默认 false） */
    enabled?: boolean
    /**
     * 当 query() 收到一个字符串 prompt 时，自动以该 prompt 为目标进入
     * goal 驱动的自治循环（等价于显式调用 runGoal）。默认 false。
     */
    enabledOnQuery?: boolean
    /** 最大目标轮次，超过则强制停止（默认 10） */
    maxGoalRounds?: number
    /** 连续 N 轮无进展即视为受阻停止（可选） */
    maxConsecutiveStalls?: number
    /** 每个目标轮次内部的最大 turn 数（默认继承 maxTurns） */
    turnsPerRound?: number
  } | boolean
}

export interface QueryResult {
  /** Final engine status, including cancellation and resource limits. */
  subtype: string
  is_error: boolean
  errors?: string[]
  total_cost_usd: number
  /** Final text output from the assistant */
  text: string
  /** Token usage */
  usage: TokenUsage
  /** Number of agentic turns */
  num_turns: number
  /** Duration in milliseconds */
  duration_ms: number
  /** All conversation messages */
  messages: Message[]
}

// --------------------------------------------------------------------------
// Query Engine Types
// --------------------------------------------------------------------------

export interface QueryEngineConfig {
  inputController?: import('./interaction.js').InputController
  askQuestion?: ToolContext['askQuestion']
  questionTimeoutMs?: number
  cwd: string
  model: string
  /** LLM provider instance (created from apiType) */
  provider: import('./providers/types.js').LLMProvider
  tools: ToolDefinition[]
  systemPrompt?: string
  appendSystemPrompt?: string
  maxTurns: number
  maxBudgetUsd?: number
  executionBudget?: ExecutionBudget
  sessionState?: Map<string, unknown>
  permissionMode?: PermissionMode
  maxTokens: number
  thinking?: ThinkingConfig
  jsonSchema?: Record<string, unknown>
  canUseTool: CanUseToolFn
  includePartialMessages: boolean
  abortSignal?: AbortSignal
  agents?: Record<string, AgentDefinition>
  /** Hook registry for lifecycle events */
  hookRegistry?: import('./hooks.js').HookRegistry
  /** Session ID for hook context */
  sessionId?: string
  contextWindowSize?: number
  pricingPerMillion?: {
    input: number
    output: number
  }
  /** Spill overflow configuration passed to the engine. */
  spill?: NonNullable<AgentOptions['spill']>
}
