import { sessionStore, type SessionState } from './session-state.js'
/**
 * SendMessageTool - Inter-agent messaging
 *
 * Supports plain text and structured protocol messages
 * between teammates in a multi-agent setup.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'

/**
 * Message inbox for inter-agent communication.
 */
export interface AgentMessage {
  from: string
  to: string
  content: string
  timestamp: string
  type: 'text' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response'
}


/**
 * Read messages from a mailbox.
 */
export function readMailbox(agentName: string, sessionState?: SessionState): AgentMessage[] {
  const state = getState(sessionState)
  const messages = state.mailboxes.get(agentName) || []
  state.mailboxes.set(agentName, []) // Clear after reading
  return messages
}

/**
 * Write to a mailbox.
 */
export function writeToMailbox(agentName: string, message: AgentMessage, sessionState?: SessionState): void {
  const state = getState(sessionState)
  const messages = state.mailboxes.get(agentName) || []
  messages.push(message)
  state.mailboxes.set(agentName, messages)
}

/**
 * Clear all state.mailboxes.
 */
export function clearMailboxes(sessionState?: SessionState): void {
  const state = getState(sessionState)
  state.mailboxes.clear()
}

export const SendMessageTool: ToolDefinition = {
  name: 'SendMessage',
  description: 'Send a message to another agent or teammate. Supports plain text and structured protocol messages.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient agent name or ID. Use "*" for broadcast.' },
      content: { type: 'string', description: 'Message content' },
      type: {
        type: 'string',
        enum: ['text', 'shutdown_request', 'shutdown_response', 'plan_approval_response'],
        description: 'Message type (default: text)',
      },
    },
    required: ['to', 'content'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Send a message to another agent.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    const message: AgentMessage = {
      from: 'self',
      to: input.to,
      content: input.content,
      timestamp: new Date().toISOString(),
      type: input.type || 'text',
    }

    if (input.to === '*') {
      // Broadcast to all known state.mailboxes
      for (const [name] of state.mailboxes) {
        writeToMailbox(name, { ...message, to: name }, context?.sessionState)
      }
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Message broadcast to all agents`,
      }
    }

    writeToMailbox(input.to, message, context?.sessionState)
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Message sent to ${input.to}`,
    }
  },
}

function getState(sessionState?: SessionState) {
  return sessionStore(sessionState, 'send-message', () => ({
    mailboxes: new Map<string, AgentMessage[]>(),
  }))
}
