/**
 * OpenAI Chat Completions API Provider
 *
 * Converts between the SDK's internal Anthropic-like message format
 * and OpenAI's Chat Completions API format.
 *
 * Uses native fetch (no openai SDK dependency required).
 */

import { readSSE } from './sse.js'
import type {
  LLMProvider,
  ProviderStreamEvent,
  CreateMessageParams,
  CreateMessageResponse,
  NormalizedMessageParam,
  NormalizedContentBlock,
  NormalizedTool,
  NormalizedResponseBlock,
} from './types.js'

// --------------------------------------------------------------------------
// OpenAI-specific types (minimal, just what we need)
// --------------------------------------------------------------------------

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

interface OpenAIChatResponse {
  id: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  readonly apiType = 'openai-completions' as const
  private apiKey: string
  private baseURL: string

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.apiKey = opts.apiKey || ''
    this.baseURL = (opts.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const response = await this.request(params)
    return this.convertResponse(await response.json() as OpenAIChatResponse)
  }

  private async request(params: CreateMessageParams, stream = false): Promise<Response> {
    // Convert to OpenAI format
    const messages = this.convertMessages(params.system, params.messages)
    const tools = params.tools ? this.convertTools(params.tools) : undefined

    const body: Record<string, any> = {
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }

    if (tools && tools.length > 0) {
      body.tools = tools
    }

    // Make API call
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      signal: params.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      const err: any = new Error(
        `OpenAI API error: ${response.status} ${response.statusText}: ${errBody}`,
      )
      err.status = response.status
      throw err
    }

    return response
  }

  async *streamMessage(params: CreateMessageParams): AsyncGenerator<ProviderStreamEvent> {
    const response = await this.request(params, true)
    if (!response.body) throw new Error('Streaming response has no body')
    let text = ''
    let finish: string | undefined
    let usage: OpenAIChatResponse['usage']
    const calls = new Map<number, OpenAIToolCall>()
    for await (const data of readSSE(response.body)) {
      params.signal?.throwIfAborted()
      if (data === '[DONE]') break
      const chunk = JSON.parse(data)
      if (chunk.error) throw new Error(chunk.error.message || 'Streaming API error')
      if (chunk.usage) usage = chunk.usage
      const choice = chunk.choices?.find((c: any) => c.index === 0)
      if (!choice) continue
      if (choice.finish_reason) finish = choice.finish_reason
      if (choice.delta?.content) {
        text += choice.delta.content
        yield { type: 'text', text: choice.delta.content }
      }
      for (const part of choice.delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } }
        call.id += part.id ?? ''
        call.function.name += part.function?.name ?? ''
        call.function.arguments += part.function?.arguments ?? ''
        calls.set(part.index, call)
        yield { type: 'tool_use', index: part.index, id: part.id, name: part.function?.name, input: part.function?.arguments }
      }
    }
    if (!finish) throw new Error('Streaming response ended before finish_reason')
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
    if (finish !== 'length') for (const call of toolCalls) {
      if (!call.id || !call.function.name) throw new Error('Incomplete streamed tool call')
      JSON.parse(call.function.arguments)
    }
    yield { type: 'response', response: this.convertResponse({ id: '', choices: [{ index: 0, message: { role: 'assistant', content: text, tool_calls: toolCalls }, finish_reason: finish }], usage }) }
  }

  // --------------------------------------------------------------------------
  // Message Conversion: Internal → OpenAI
  // --------------------------------------------------------------------------

  private convertMessages(
    system: string,
    messages: NormalizedMessageParam[],
  ): OpenAIChatMessage[] {
    const result: OpenAIChatMessage[] = []

    // System prompt as first message
    if (system) {
      result.push({ role: 'system', content: system })
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        this.convertUserMessage(msg, result)
      } else if (msg.role === 'assistant') {
        this.convertAssistantMessage(msg, result)
      }
    }

    return result
  }

  private convertUserMessage(
    msg: NormalizedMessageParam,
    result: OpenAIChatMessage[],
  ): void {
    if (typeof msg.content === 'string') {
      result.push({ role: 'user', content: msg.content })
      return
    }

    // Content blocks may contain text, image, and/or tool_result blocks
    const contentParts: OpenAIContentPart[] = []
    const toolResults: Array<{ tool_use_id: string; content: string }> = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        contentParts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const source = block.source
        let imageUrl: string
        if (source?.type === 'base64' && source.data) {
          const mediaType = source.media_type || 'image/png'
          imageUrl = `data:${mediaType};base64,${source.data}`
        } else if (source?.type === 'url' && source.url) {
          imageUrl = source.url
        } else if (typeof source === 'string') {
          imageUrl = source
        } else {
          continue
        }
        contentParts.push({
          type: 'image_url',
          image_url: { url: imageUrl, detail: 'high' },
        })
      } else if (block.type === 'tool_result') {
        toolResults.push({
          tool_use_id: block.tool_use_id,
          content: block.content,
        })
      }
    }

    // Tool results become separate tool messages
    for (const tr of toolResults) {
      result.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: tr.content,
      })
    }

    // Content parts become a user message
    if (contentParts.length > 0) {
      const hasImages = contentParts.some(p => p.type === 'image_url')
      if (!hasImages) {
        const text = contentParts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map(p => p.text)
          .join('\n')
        result.push({ role: 'user', content: text })
      } else {
        result.push({ role: 'user', content: contentParts })
      }
    }
  }

  private convertAssistantMessage(
    msg: NormalizedMessageParam,
    result: OpenAIChatMessage[],
  ): void {
    if (typeof msg.content === 'string') {
      result.push({ role: 'assistant', content: msg.content })
      return
    }

    // Extract text and tool_use blocks
    const textParts: string[] = []
    const toolCalls: OpenAIToolCall[] = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input),
          },
        })
      }
    }

    const assistantMsg: OpenAIChatMessage = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('\n') : null,
    }

    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls
    }

    result.push(assistantMsg)
  }

  // --------------------------------------------------------------------------
  // Tool Conversion: Internal → OpenAI
  // --------------------------------------------------------------------------

  private convertTools(tools: NormalizedTool[]): OpenAITool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))
  }

  // --------------------------------------------------------------------------
  // Response Conversion: OpenAI → Internal
  // --------------------------------------------------------------------------

  private convertResponse(data: OpenAIChatResponse): CreateMessageResponse {
    const choice = data.choices[0]
    if (!choice) {
      return {
        content: [{ type: 'text', text: '' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    }

    const content: NormalizedResponseBlock[] = []

    // Add text content
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content })
    }

    // Add tool calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: any
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {
          input = tc.function.arguments
        }

        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }
    }

    // If no content at all, add empty text
    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    // Map finish_reason to our normalized stop reasons
    const stopReason = this.mapFinishReason(choice.finish_reason)

    return {
      content,
      stopReason,
      usage: {
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
      },
    }
  }

  private mapFinishReason(
    reason: string,
  ): 'end_turn' | 'max_tokens' | 'tool_use' | string {
    switch (reason) {
      case 'stop':
        return 'end_turn'
      case 'length':
        return 'max_tokens'
      case 'tool_calls':
        return 'tool_use'
      default:
        return reason
    }
  }
}
