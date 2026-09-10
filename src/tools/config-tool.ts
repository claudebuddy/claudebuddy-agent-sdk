import { sessionStore, type SessionState } from './session-state.js'
/**
 * ConfigTool - Dynamic configuration management
 *
 * Get/set global configuration and session settings.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'

// In-memory config store

/**
 * Get a config value.
 */
export function getConfig(key: string, sessionState?: SessionState): unknown {
  const state = getState(sessionState)
  return state.configStore.get(key)
}

/**
 * Set a config value.
 */
export function setConfig(key: string, value: unknown, sessionState?: SessionState): void {
  const state = getState(sessionState)
  state.configStore.set(key, value)
}

/**
 * Clear all config.
 */
export function clearConfig(sessionState?: SessionState): void {
  const state = getState(sessionState)
  state.configStore.clear()
}

export const ConfigTool: ToolDefinition = {
  name: 'Config',
  description: 'Get or set configuration values. Supports session-scoped settings.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'list'],
        description: 'Operation to perform',
      },
      key: { type: 'string', description: 'Config key' },
      value: { description: 'Config value (for set)' },
    },
    required: ['action'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Manage configuration settings.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    switch (input.action) {
      case 'get': {
        if (!input.key) {
          return { type: 'tool_result', tool_use_id: '', content: 'key required for get', is_error: true }
        }
        const value = state.configStore.get(input.key)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: value !== undefined ? JSON.stringify(value) : `Config key "${input.key}" not found`,
        }
      }
      case 'set': {
        if (!input.key) {
          return { type: 'tool_result', tool_use_id: '', content: 'key required for set', is_error: true }
        }
        state.configStore.set(input.key, input.value)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `Config set: ${input.key} = ${JSON.stringify(input.value)}`,
        }
      }
      case 'list': {
        const entries = Array.from(state.configStore.entries())
        if (entries.length === 0) {
          return { type: 'tool_result', tool_use_id: '', content: 'No config values set.' }
        }
        const lines = entries.map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        return { type: 'tool_result', tool_use_id: '', content: lines.join('\n') }
      }
      default:
        return { type: 'tool_result', tool_use_id: '', content: `Unknown action: ${input.action}`, is_error: true }
    }
  },
}

function getState(sessionState?: SessionState) {
  return sessionStore(sessionState, 'config-tool', () => ({
    configStore: new Map<string, unknown>(),
  }))
}
