import { sessionStore, type SessionState } from './session-state.js'
/**
 * MCP Resource Tools
 *
 * ListMcpResources / ReadMcpResource - Access resources from MCP servers.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'
import type { MCPConnection } from '../mcp/client.js'

// Registry of MCP connections (set by the agent)

/**
 * Set MCP connections for resource access.
 */
export function setMcpConnections(connections: MCPConnection[], sessionState?: SessionState): void {
  const state = getState(sessionState)
  state.mcpConnections = connections
}

export const ListMcpResourcesTool: ToolDefinition = {
  name: 'ListMcpResources',
  description: 'List available resources from connected MCP servers. Resources can include files, databases, and other data sources.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Filter by MCP server name' },
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'List MCP resources.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    if (context?.abortSignal?.aborted) return { type: 'tool_result', tool_use_id: '', content: 'MCP resource request cancelled.', is_error: true }
    const state = getState(context?.sessionState)
    const connections = input.server
      ? state.mcpConnections.filter(c => c.name === input.server)
      : state.mcpConnections

    if (connections.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'No MCP servers connected.',
      }
    }

    const results: string[] = []

    for (const conn of connections) {
      if (conn.status !== 'connected') continue

      try {
        context?.abortSignal?.throwIfAborted()
        if (!conn.listResources) {
          results.push(`Server: ${conn.name} (resource listing not supported)`)
          continue
        }
        const { resources } = await conn.listResources(context?.abortSignal)
        results.push(`Server: ${conn.name}`)
        for (const resource of resources) {
          results.push(`  - ${resource.name}: ${resource.description || resource.uri}`)
        }
        if (resources.length === 0) results.push('  No resources found.')
      } catch (err: any) {
        return {
          type: 'tool_result', tool_use_id: '',
          content: `Error listing resources from ${conn.name}: ${err.message}`,
          is_error: true,
        }
      }
    }

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: results.join('\n') || 'No resources found.',
    }
  },
}

export const ReadMcpResourceTool: ToolDefinition = {
  name: 'ReadMcpResource',
  description: 'Read a specific resource from an MCP server.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      uri: { type: 'string', description: 'Resource URI to read' },
    },
    required: ['server', 'uri'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Read an MCP resource.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    if (context?.abortSignal?.aborted) return { type: 'tool_result', tool_use_id: '', content: 'MCP resource request cancelled.', is_error: true }
    const state = getState(context?.sessionState)
    const conn = state.mcpConnections.find(c => c.name === input.server)
    if (!conn) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `MCP server not found: ${input.server}`,
        is_error: true,
      }
    }

    try {
      context?.abortSignal?.throwIfAborted()
      if (conn.status !== 'connected' || !conn.readResource) {
        throw new Error(`Resource reading not supported by ${conn.name}`)
      }
      const result = await conn.readResource(input.uri, context?.abortSignal)
      if (result.contents.length > 0) {
        const texts = result.contents.map(c => 'text' in c ? c.text : JSON.stringify(c)).join('\n')
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: texts,
        }
      }
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Resource read returned no content.',
        is_error: true,
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error reading resource: ${err.message}`,
        is_error: true,
      }
    }
  },
}

function getState(sessionState?: SessionState) {
  return sessionStore(sessionState, 'mcp-resource-tools', () => ({
    mcpConnections: [] as MCPConnection[],
  }))
}
