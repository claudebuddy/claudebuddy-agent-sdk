import { sessionStore, type SessionState } from './session-state.js'
/**
 * ToolSearchTool - Discover deferred/lazy-loaded tools
 *
 * Allows the model to search for tools that haven't been loaded yet.
 * Supports keyword search and exact name selection.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'

// Registry of deferred tools (set by the agent)

/**
 * Set deferred tools available for search.
 */
export function setDeferredTools(tools: ToolDefinition[], sessionState?: SessionState): void {
  const state = getState(sessionState)
  state.deferredTools = tools
}

export const ToolSearchTool: ToolDefinition = {
  name: 'ToolSearch',
  description: 'Search for additional tools that may be available but not yet loaded. Use keyword search or exact name selection.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query. Use "select:ToolName" for exact match or keywords for search.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum results to return (default: 5)',
      },
    },
    required: ['query'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Search for available tools.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    const { query, max_results = 5 } = input

    if (state.deferredTools.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'No deferred tools available.',
      }
    }

    let matches: ToolDefinition[]

    if (query.startsWith('select:')) {
      // Exact name selection
      const names = query.slice(7).split(',').map((n: string) => n.trim())
      matches = state.deferredTools.filter(t => names.includes(t.name))
    } else {
      // Keyword search
      const keywords: string[] = query.toLowerCase().split(/\s+/)
      matches = state.deferredTools
        .filter(t => {
          const searchText = `${t.name} ${t.description}`.toLowerCase()
          return keywords.some((kw: string) => searchText.includes(kw))
        })
        .slice(0, max_results)
    }

    if (matches.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `No tools found matching "${query}"`,
      }
    }

    const lines = matches.map(t =>
      `- ${t.name}: ${t.description.slice(0, 200)}`
    )

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Found ${matches.length} tool(s):\n${lines.join('\n')}`,
    }
  },
}

function getState(sessionState?: SessionState) {
  return sessionStore(sessionState, 'tool-search', () => ({
    deferredTools: [] as ToolDefinition[],
  }))
}
