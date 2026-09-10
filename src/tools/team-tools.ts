import { sessionStore, type SessionState } from './session-state.js'
/**
 * Team Management Tools
 *
 * TeamCreate, TeamDelete - Multi-agent team coordination.
 * Manages team composition, task lists, and inter-agent messaging.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'

/**
 * Team definition.
 */
export interface Team {
  id: string
  name: string
  members: string[]
  leaderId: string
  taskListId?: string
  createdAt: string
  status: 'active' | 'disbanded'
}

/**
 * Team state is owned by the supplied session.
 */

/**
 * Get all teams.
 */
export function getAllTeams(sessionState?: SessionState): Team[] {
  const state = getState(sessionState)
  return Array.from(state.teamStore.values())
}

/**
 * Get a team by ID.
 */
export function getTeam(id: string, sessionState?: SessionState): Team | undefined {
  const state = getState(sessionState)
  return state.teamStore.get(id)
}

/**
 * Clear all teams.
 */
export function clearTeams(sessionState?: SessionState): void {
  const state = getState(sessionState)
  state.teamStore.clear()
  state.teamCounter = 0
}

// ============================================================================
// TeamCreateTool
// ============================================================================

export const TeamCreateTool: ToolDefinition = {
  name: 'TeamCreate',
  description: 'Create a multi-agent team for coordinated work. Assigns a lead and manages member composition.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Team name' },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of agent/teammate names',
      },
      task_description: { type: 'string', description: 'Description of the team\'s mission' },
    },
    required: ['name'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Create a team for multi-agent coordination.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    const id = `team_${++state.teamCounter}`
    const team: Team = {
      id,
      name: input.name,
      members: input.members || [],
      leaderId: 'self',
      createdAt: new Date().toISOString(),
      status: 'active',
    }
    state.teamStore.set(id, team)

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Team created: ${id} "${team.name}" with ${team.members.length} members`,
    }
  },
}

// ============================================================================
// TeamDeleteTool
// ============================================================================

export const TeamDeleteTool: ToolDefinition = {
  name: 'TeamDelete',
  description: 'Disband a team and clean up resources.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Team ID to disband' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Delete/disband a team.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    const team = state.teamStore.get(input.id)
    if (!team) {
      return { type: 'tool_result', tool_use_id: '', content: `Team not found: ${input.id}`, is_error: true }
    }

    team.status = 'disbanded'
    state.teamStore.delete(input.id)

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Team disbanded: ${team.name}`,
    }
  },
}

function getState(sessionState?: SessionState) {
  return sessionStore(sessionState, 'team-tools', () => ({
    teamStore: new Map<string, Team>(),
    teamCounter: 0,
  }))
}
