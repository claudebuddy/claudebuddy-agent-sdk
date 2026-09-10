/**
 * Anthropic Messages API Provider
 *
 * Wraps the @anthropic-ai/sdk client. Since our internal format is
 * Anthropic-like, this is mostly a thin pass-through.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  LLMProvider,
  ProviderStreamEvent,
  CreateMessageParams,
  CreateMessageResponse,
} from './types.js'

export class AnthropicProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const
  private client: Anthropic

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    })
  }

  async *streamMessage(params: CreateMessageParams): AsyncGenerator<ProviderStreamEvent> {
    const stream = this.client.messages.stream({
      model: params.model, max_tokens: params.maxTokens, system: params.system,
      messages: params.messages as Anthropic.MessageParam[], tools: params.tools as Anthropic.Tool[],
      ...(params.thinking?.type === 'enabled' ? { thinking: params.thinking as Anthropic.ThinkingConfigEnabled } : {}),
    }, { signal: params.signal, maxRetries: 0 })
    let completed = false
    try {
      for await (const event of stream) {
        if (event.type === 'message_stop') completed = true
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          yield { type: 'tool_use', index: event.index, id: event.content_block.id, name: event.content_block.name }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') yield { type: 'text', text: event.delta.text }
          if (event.delta.type === 'input_json_delta') yield { type: 'tool_use', index: event.index, input: event.delta.partial_json }
        }
      }
      if (!completed) throw new Error('Streaming response ended before message_stop')
      const response = await stream.finalMessage()
      yield { type: 'response', response: { content: response.content as CreateMessageResponse['content'], stopReason: response.stop_reason || 'end_turn', usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined, cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined } } }
    } finally { stream.abort() }
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
    }

    // Add extended thinking if configured
    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      (requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    }

    const response = await this.client.messages.create(requestParams, { signal: params.signal, maxRetries: 0 })

    return {
      content: response.content as CreateMessageResponse['content'],
      stopReason: response.stop_reason || 'end_turn',
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens:
          (response.usage as any).cache_creation_input_tokens,
        cache_read_input_tokens:
          (response.usage as any).cache_read_input_tokens,
      },
    }
  }
}
