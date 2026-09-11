# Session Scheduler Design

## Goal

Turn the disabled cron definition tools into an opt-in, in-process scheduler that
can execute Agent prompts, survive process restarts, and stop cleanly with its
owning Agent. This is a session service, not a system daemon or hosted scheduler.

## Product boundary

Scheduling is disabled by default. `AgentOptions.scheduler.enabled: true` starts
the scheduler after Agent setup and exposes its tools to the model. With scheduling
disabled, the tools remain absent from provider schemas. `RemoteTrigger` stays
disabled because it requires a remote control plane.

The scheduler supports:

- recurring five-field cron expressions;
- one-shot ISO 8601 timestamps;
- create, list, inspect, pause, resume, run-now, and delete operations;
- durable definitions and bounded run history;
- no overlapping invocation of the same job;
- at most one catch-up invocation after restart;
- lifecycle events for host monitoring.

It does not provide a daemon, distributed leader election, multiple writers for
one session, guaranteed wall-clock execution while the process is stopped,
exactly-once external side effects, or automatic retries.

## Public API

Add this optional configuration:

```ts
interface SchedulerOptions {
  enabled: boolean
  timeZone?: string                 // IANA zone; host local zone by default
  maxJobs?: number                  // default 100
  maxConcurrentRuns?: number        // default 2
  maxHistoryPerJob?: number         // default 20
  maxCatchUpAgeMs?: number          // default 24 hours; 0 disables catch-up
  onEvent?: (event: SchedulerEvent) => void | Promise<void>
}
```

Invalid time zones, limits, schedules, timestamps, and past one-shot timestamps
are rejected before storage. Limits must be finite positive integers, except
`maxCatchUpAgeMs`, which may be zero. Job prompts must be non-empty. A recurring
schedule uses standard five-field minute/hour/day-of-month/month/day-of-week cron
syntax. Seconds are deliberately unsupported.

Add Agent methods for hosts that do not want the model to manage schedules:

```ts
agent.createSchedule(input): Promise<ScheduledJob>
agent.listSchedules(): Promise<ScheduledJob[]>
agent.getSchedule(id): Promise<ScheduledJob | undefined>
agent.updateSchedule(id, patch): Promise<ScheduledJob>
agent.runSchedule(id): Promise<string>       // returns run ID after admission
agent.deleteSchedule(id): Promise<boolean>
```

`updateSchedule` handles pause/resume and editable name, prompt, schedule, model,
maxTurns, and maxBudgetUsd. Returned values are defensive copies. Host calls and
model tools use the same validation and scheduler implementation.

Tool names are `CronCreate`, `CronList`, `CronGet`, `CronUpdate`, `CronRun`, and
`CronDelete`. `CronCreate` accepts exactly one of `cron` or `run_at`; its existing
`schedule` and `command` fields remain accepted as deprecated aliases for `cron`
and `prompt`. `CronUpdate` performs pause/resume/update. `CronRun` starts run-now.

## Ownership and execution

One scheduler belongs to one Agent and session ID. Each firing creates a fresh,
isolated child execution with its own conversation and built-in mutable tool state.
It inherits a snapshot of the owning Agent's provider credentials, model, system
prompt, cwd, available tools, allow/deny bounds, permission mode, approval callback,
hooks, connected MCP tool wrappers, agents, pricing, compaction, and spill policy.
It shares the already connected MCP clients without reconnecting or owning their
lifecycle. Scheduler management tools are excluded from the child execution so a
scheduled prompt cannot recursively create or mutate schedules. A job may override
the model and lower maxTurns and maxBudgetUsd; it cannot widen tool or permission
bounds. Scheduled runs set `interactive: false`: unanswered questions receive the
normal non-interactive response rather than waiting for a UI.

Each invocation gets a fresh execution budget. A recurring schedule therefore has
a per-invocation USD cap, not a lifetime cap. Usage and child/subagent costs follow
the existing shared-ledger rules inside that invocation.

Scheduled execution must not take ownership of the parent Agent's conversation,
`activeRun`, history, interaction queue, or abort controller. It may run alongside
an interactive query. Tools and callbacks that touch the same external files can
still conflict; hosts control that risk through permission policy and separate
working directories. The same scheduled job never overlaps: if its next firing
arrives while it is active, record a `skipped_overlap` run and advance normally.
Different jobs may run concurrently up to `scheduler.maxConcurrentRuns`, default 2.
When every global slot is occupied, an admitted invocation enters a persistent FIFO
queue and its job counts as active. A later occurrence of that same job is therefore
recorded as `skipped_overlap`. `run_started` is emitted only when execution actually
receives a slot. Run-now returns its run ID after durable queue admission.

Run-now goes through the same concurrency admission and non-overlap checks. It is
not allowed for a paused one-shot job that already completed, but is allowed for a
paused recurring job as an explicit host/model action. One-shot jobs become
`completed` after their admitted invocation reaches a terminal result, regardless
of success or failure; users can inspect the run record and create another job.

## Time and recovery semantics

Use a maintained cron parser rather than a handwritten parser. Store every due
time as an ISO UTC timestamp and retain the configured IANA time zone on the job.
Cron matching follows that time zone, including the parser's daylight-saving-time
behavior. The scheduler calculates the next occurrence after each admission or
overlap skip and arms only the nearest timer. For delays beyond Node's maximum
timer range, it wakes at the maximum safe delay and recalculates.

On startup, load and validate persisted data before exposing tools. Quarantine a
corrupt scheduler file by renaming it with a `.corrupt-<timestamp>` suffix, emit a
storage-error event, and start with no jobs. Do not silently accept partial jobs.

For an enabled job whose stored due time is in the past:

- if it is within `maxCatchUpAgeMs`, admit one catch-up invocation, regardless of
  how many recurring occurrences were missed;
- otherwise record `skipped_misfire` and advance to the first future occurrence;
- if catch-up is disabled (`maxCatchUpAgeMs: 0`), always skip missed occurrences;
- a missed one-shot follows the same rule and then becomes completed.

A persisted `running` record has unknown outcome after a crash. Mark it
`interrupted_unknown`; never replay it as that same run. The job may receive the
single catch-up invocation under the rules above. External side effects are not
exactly once.

## Persistence

Store scheduler state beside the existing session transcript as `scheduler.json`,
using a versioned schema, mode `0600`, temporary-file write, fsync, and atomic
rename. Persist before acknowledging mutations and before emitting the admitted
run event. Persist terminal run status after execution. Retain at most
`maxHistoryPerJob` records per job.

The process is the single writer for a session ID. Concurrent Agent instances using
the same persisted session ID with scheduling enabled are rejected through an
exclusive lock file. The lock records PID and creation time; stale locks are
recovered only when the recorded local PID no longer exists. `Agent.close()` removes
the lock after cancelling and joining active schedule runs. An unclean process exit
leaves a recoverable stale lock. Locking is local-host coordination, not a network
filesystem or distributed guarantee.

`persistSession: false` also disables scheduler persistence and restart catch-up;
the scheduler still operates in memory while the Agent lives. An optional future
host storage adapter is outside this batch.

## Events and results

`SchedulerEvent` includes session ID, job ID, optional run ID and one subtype:

- `job_created`, `job_updated`, `job_deleted`;
- `run_queued`, `run_started`, `run_succeeded`, `run_failed`, `run_cancelled`;
- `run_skipped_overlap`, `run_skipped_misfire`;
- `storage_error`.

Run records contain scheduled/admitted/started/finished timestamps, trigger
(`scheduled`, `catch_up`, or `manual`), terminal SDK result subtype, errors, text,
usage, and cost. Secrets, full tool inputs, and provider request bodies are not
stored. Event callback failures are isolated, recorded to stderr, and do not change
job execution status. Events are also appended to the existing semantic session
journal as `system/scheduler` messages when persistence is enabled.

## Lifecycle and failure handling

Setup failures caused by invalid configuration or a live lock reject Agent setup;
they do not leave the scheduler tools usable. A job failure is captured in its run
record and does not stop later recurring occurrences. Provider, tool, budget,
max-turn, and cancellation terminal states remain observable without throwing away
details.

Approval callbacks and hooks execute with the scheduled invocation's abort signal,
not the parent Agent's interactive-run signal. Waiting for either must be abort-aware
so `Agent.close()` can settle every queued or running invocation. A host that uses
interactive approval callbacks must support approvals arriving outside an active UI
query; otherwise its existing policy may deny the tool call normally.

`Agent.close()` stops admission, clears timers, aborts active scheduled runs, waits
for them to settle, persists terminal cancellation records, releases the lock, and
then closes MCP connections. New scheduler API calls reject after close starts.
`Agent.clear()` does not delete schedules because they are durable control-plane
objects; hosts delete them explicitly. It clears neither scheduler run history nor
the scheduler lock.

## Testing

Tests use a fake clock and offline providers; no wall-clock sleeps or paid API calls.
Cover cron/one-shot parsing, time zones and DST, nearest-timer recalculation,
create/update/delete persistence, restart catch-up, stale/live locks, corrupt files,
non-overlap, global concurrency, run-now, fresh budgets, permission inheritance,
state/history isolation, event order, callback failure, bounded history, close
cancellation, and `persistSession: false`. Existing 87 tests must remain green.

## Delivery

Implement on a new `codex/session-scheduler` branch after this specification is
approved. Add the cron parser as the only production dependency. Update README,
CHANGELOG, package documentation and exports. Do not publish a release until the
implementation receives independent review and the user explicitly requests it.
