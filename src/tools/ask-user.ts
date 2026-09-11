import { waitForQuestion } from '../interaction.js'
import { sessionStore, type SessionState } from './session-state.js'
/**
 * AskUserQuestionTool - Interactive user questions
 *
 * In SDK mode, returns a permission_request event and waits
 * for the consumer to provide an answer.
 * In non-interactive mode, returns a default or denies.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'

export type QuestionHandler = (question: string, options?: string[], context?: { signal: AbortSignal; allowMultiselect: boolean }) => Promise<string>

// Callback for handling user questions (set by the host)

/**
 * Set the question handler for AskUserQuestion.
 */
export function setQuestionHandler(
  handler: QuestionHandler,
  sessionState?: SessionState,
): void {
  const state = getState(sessionState)
  state.questionHandler = handler
}

/**
 * Clear the question handler.
 */
export function clearQuestionHandler(sessionState?: SessionState): void {
  const state = getState(sessionState)
  state.questionHandler = null
}

export const AskUserQuestionTool: ToolDefinition = {
  name: 'AskUserQuestion',
  description: 'Ask the user a question and wait for their response. Use when you need clarification or input from the user.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of choices for the user',
      },
      allow_multiselect: {
        type: 'boolean',
        description: 'Whether to allow multiple selections (for options)',
      },
    },
    required: ['question'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Ask the user a question.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    if (state.questionHandler || context?.askQuestion) {
      try {
        const handler = state.questionHandler
        const answer = await waitForQuestion(signal => handler
          ? handler(input.question, input.options, { signal, allowMultiselect: input.allow_multiselect === true })
          : context!.askQuestion!({ question: input.question, options: input.options, allow_multiselect: input.allow_multiselect === true }, signal), context?.abortSignal, context?.questionTimeoutMs)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: answer,
        }
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `Question unanswered: ${err.message}`,
          is_error: true,
        }
      }
    }

    // Non-interactive: return informative message
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `[Non-interactive mode] Question: ${input.question}${input.options ? `\nOptions: ${input.options.join(', ')}` : ''}\n\nNo user available to answer. Proceeding with best judgment.`,
    }
  },
}

function getState(sessionState?: SessionState) {
  return sessionStore(sessionState, 'ask-user', () => ({
    questionHandler: null as QuestionHandler | null,
  }))
}
