import { sessionStore, type SessionState } from './session-state.js'
/**
 * Plan Mode Tools
 *
 * EnterPlanMode / ExitPlanMode - Structured planning workflow.
 * Allows the agent to enter a design/planning phase before execution.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'

// Track plan mode state

export function isPlanModeActive(sessionState?: SessionState): boolean {
  const state = getState(sessionState)
  return state.planModeActive
}

export function getCurrentPlan(sessionState?: SessionState): string | null {
  const state = getState(sessionState)
  return state.currentPlan
}

export const EnterPlanModeTool: ToolDefinition = {
  name: 'EnterPlanMode',
  description: 'Enter plan/design mode for complex tasks. In plan mode, the agent focuses on designing the approach before executing.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Enter plan mode for structured planning.' },
  async call(_input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    if (state.planModeActive) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Already in plan mode.',
      }
    }

    state.planModeActive = true
    state.currentPlan = null

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: 'Entered plan mode. Design your approach before executing. Use ExitPlanMode when the plan is ready.',
    }
  },
}

export const ExitPlanModeTool: ToolDefinition = {
  name: 'ExitPlanMode',
  description: 'Exit plan mode with a completed plan. The plan will be recorded and execution can proceed.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The completed plan' },
      approved: { type: 'boolean', description: 'Whether the plan is approved for execution' },
    },
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Exit plan mode with a completed plan.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getState(context?.sessionState)
    if (!state.planModeActive) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Not in plan mode.',
        is_error: true,
      }
    }

    state.planModeActive = false
    state.currentPlan = input.plan || null

    const status = input.approved !== false ? 'approved' : 'pending approval'

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Plan mode exited. Plan status: ${status}.${state.currentPlan ? `\n\nPlan:\n${state.currentPlan}` : ''}`,
    }
  },
}

function getState(sessionState?: SessionState) {
  return sessionStore(sessionState, 'plan-tools', () => ({
    planModeActive: false,
    currentPlan: null as string | null,
  }))
}
