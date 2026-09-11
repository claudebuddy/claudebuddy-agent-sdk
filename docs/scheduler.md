# Session scheduler

The scheduler runs Agent prompts while the owning Node.js process and `Agent` are
alive. Enable it explicitly:

```ts
import { createAgent } from '@claudebuddy/claudebuddy-agent-sdk'

const agent = createAgent({
  scheduler: {
    enabled: true,
    timeZone: 'Asia/Shanghai',
    maxConcurrentRuns: 2,
    onEvent: event => console.log(event.type, event.jobId, event.runId),
  },
})

const daily = await agent.createSchedule({
  name: 'daily review',
  prompt: 'Review the current project and report actionable problems.',
  cron: '0 9 * * *',
})

const once = await agent.createSchedule({
  name: 'release check',
  prompt: 'Run the release checks and summarize failures.',
  runAt: '2026-09-12T02:00:00.000Z',
})

await agent.updateSchedule(daily.id, { enabled: false })
await agent.updateSchedule(daily.id, { enabled: true })
const runId = await agent.runSchedule(daily.id)
console.log(runId, await agent.getSchedule(daily.id))
await agent.deleteSchedule(once.id)
await agent.close()
```

The six model-facing tools are `CronCreate`, `CronList`, `CronGet`, `CronUpdate`,
`CronRun`, and `CronDelete`. They appear only when scheduling is enabled. Existing
`CronCreate` callers may keep using `schedule` for `cron` and `command` for
`prompt`. `RemoteTrigger` remains unavailable because it requires a remote control
plane.

Recurring schedules use five cron fields and the job's IANA time zone. One-shot
schedules use an ISO 8601 timestamp. Each invocation has isolated conversation and
mutable tool state, inherits the owner's provider and permission bounds, and runs
non-interactively. Scheduler-management tools are removed from scheduled runs.

Only one invocation of a job can be queued or running. Different jobs enter a FIFO
queue and run up to `maxConcurrentRuns` at once. A one-shot job becomes completed
after its first admitted attempt, including a failed attempt. Run history is capped
by `maxHistoryPerJob`.

With session persistence enabled, definitions and history are stored in
`scheduler.json` beside the transcript. A local lock rejects another scheduler for
the same session. On restart, the scheduler admits at most one missed run within
`maxCatchUpAgeMs`; older occurrences are recorded as misfires. A process crash
cannot guarantee exactly-once external side effects. With `persistSession: false`,
jobs stay in memory and restart catch-up is disabled.

Call `Agent.close()` during shutdown. It stops new admission, cancels queued and
running jobs, records their terminal state, releases the session lock, and then
closes MCP connections. Scheduling does not install an operating-system daemon, so
no prompt runs while the host process is stopped.
