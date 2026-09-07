/**
 * update_goal — internal tool for the goal-driven loop
 *
 * The model calls this tool to report whether the goal is complete, blocked,
 * or still in progress. It does NOT perform any real action; it only records
 * the reported status so the goal driver in agent.ts can decide whether to
 * keep running another round.
 *
 * Because the engine faithfully executes tools and feeds the tool_result back
 * to the model, calling this tool both (a) gives the model a structured way to
 * declare task state, and (b) lets the driver read that state from the shared
 * module-level record below.
 */

import type { ToolDefinition } from '../types.js'

/** Reported goal status by the latest update_goal call. */
export interface GoalReport {
  status: 'complete' | 'blocked' | 'in_progress'
  summary?: string
  /** Increments on every report so callers can detect "no new report". */
  revision: number
}

/** Module-level recorded goal state shared with the driver. */
const goalState: GoalReport = {
  status: 'in_progress',
  summary: undefined,
  revision: 0,
}

/** Reset the goal record (call at the start of a runGoal). */
export function resetGoalState(revision = 0): void {
  goalState.status = 'in_progress'
  goalState.summary = undefined
  goalState.revision = revision
}

/** Read the latest reported goal state without consuming it. */
export function getGoalState(): Readonly<GoalReport> {
  return { ...goalState }
}

/** Whether a report with this revision has been recorded (i.e. model spoke). */
export function hasGoalReport(revision: number): boolean {
  return goalState.revision > revision
}

/**
 * The internal update_goal tool definition.
 * Schema: { goal_status, summary?, error? }
 */
export function createUpdateGoalTool(): ToolDefinition {
  return {
    name: 'update_goal',
    description:
      'Report the status of the goal you are working toward. Call this when the goal is COMPLETED (goal_status=complete), when you are BLOCKED and cannot make further progress (goal_status=blocked), or to record progress. You should call this at least once before stopping. Provide a concise summary of what was accomplished.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_status: {
          type: 'string',
          enum: ['complete', 'blocked', 'in_progress'],
          description: 'Whether the goal is complete, blocked, or still in progress.',
        },
        summary: {
          type: 'string',
          description: 'Concise summary of what was accomplished or why blocked.',
        },
        error: {
          type: 'string',
          description: 'Optional error description when blocked.',
        },
      },
      required: ['goal_status'],
    },
    isReadOnly: () => false,
    isEnabled: () => true,
    async prompt() {
      return 'Call update_goal with goal_status=complete when the goal is done, blocked when stuck. Always include a brief summary.'
    },
    async call(input: any): Promise<any> {
      const status = input?.goal_status === 'complete'
        ? 'complete'
        : input?.goal_status === 'blocked'
          ? 'blocked'
          : 'in_progress'
      goalState.status = status
      goalState.summary = input?.summary ?? input?.error ?? input?.summary ?? undefined
      goalState.revision++
      const ack =
        status === 'complete'
          ? 'Goal reported complete. Well done.'
          : status === 'blocked'
            ? 'Goal reported blocked. Stopping current round.'
            : 'Goal progress noted.'
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: ack,
      }
    },
  }
}

/**
 * Build the system-prompt appendix that instructs the model to work toward a
 * goal and to call update_goal when finished or blocked.
 */
export function buildGoalSystemPrompt(goal: string, maxRounds: number): string {
  return [
    '',
    '# Goal-Driven Mode',
    `You are working toward the following goal:`,
    ``,
    `"""`,
    goal,
    `"""`,
    ``,
    `- Work autonomously toward this goal using your tools. Do not stop early.`,
    `- When you believe the goal is FULLY achieved, call the update_goal tool with goal_status="complete" and a summary.`,
    `- If you are truly blocked and cannot proceed, call update_goal with goal_status="blocked".`,
    `- You may have up to ${maxRounds} rounds to achieve this goal. Use your turns efficiently.`,
    ``,
  ].join('\n')
}