# Session Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, recoverable, in-process scheduler that runs isolated Agent prompts from cron or one-shot schedules.

**Architecture:** A focused `Scheduler` service owns validation, timers, admission, persistence, locking, and bounded history. `Agent` owns one service, supplies an isolated execution callback, and exposes the same operations through host methods and six model tools.

**Tech Stack:** TypeScript, Node.js 18+, `cron-parser`, `node:test`, existing Agent/QueryEngine/session infrastructure.

**Spec:** `docs/superpowers/specs/2026-09-11-session-scheduler-design.md`

## Global Constraints

- Scheduling is disabled unless `scheduler.enabled` is exactly `true`.
- Support five-field cron expressions and ISO 8601 one-shot timestamps; cron seconds are unsupported.
- Default limits are 100 jobs, 2 concurrent runs, 20 history records per job, and 24 hours catch-up age.
- The same job must never overlap; recovery admits at most one missed invocation.
- `RemoteTrigger` remains disabled and scheduler control tools do not enter scheduled child runs.
- `persistSession: false` uses memory only and performs no restart catch-up or lock acquisition.
- Add `cron-parser` as the only production dependency.
- Keep all existing tests green and use fake time/offline providers for scheduler tests.

---

### Task 1: Public scheduler types and validation

**Files:**
- Create: `src/scheduler/types.ts`
- Create: `src/scheduler/schedule.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Test: `tests/scheduler-validation.test.ts`

**Interfaces:**
- Produces: `SchedulerOptions`, `ScheduleInput`, `SchedulePatch`, `ScheduledJob`, `ScheduledRun`, `SchedulerEvent`, `normalizeSchedulerOptions()`, `validateScheduleInput()`, and `nextCronOccurrence()`.

- [ ] **Step 1: Write failing tests** for invalid time zones/limits, mutually exclusive `cron` and `runAt`, past one-shot creation, five-field cron validation, and DST-aware next occurrence.

```ts
assert.throws(() => normalizeSchedulerOptions({ enabled: true, maxConcurrentRuns: 0 }), /positive integer/)
assert.throws(() => validateScheduleInput({ name: 'x', prompt: 'p', cron: '* * * * *', runAt: future }), /exactly one/)
assert.equal(nextCronOccurrence('0 9 * * *', 'Asia/Shanghai', after).toISOString(), expected)
```

- [ ] **Step 2: Run the focused test and verify it fails.**

```bash
npx tsx --test tests/scheduler-validation.test.ts
```

- [ ] **Step 3: Implement exported discriminated schedule/run types and strict validation.** `ScheduledJob` stores `cron?: string`, `runAt?: string`, `timeZone`, `status`, `nextRunAt`, overrides, timestamps, and `runs`; `ScheduledRun` stores queue/start/finish times, trigger, status, result, text, usage, cost, and errors.

- [ ] **Step 4: Run the focused test and build.**

```bash
npx tsx --test tests/scheduler-validation.test.ts && npm run build
```

- [ ] **Step 5: Commit.**

```bash
git add package.json package-lock.json src/scheduler src/types.ts src/index.ts tests/scheduler-validation.test.ts
git commit -m "feat: define scheduler types and validation"
```

### Task 2: Atomic scheduler storage and session lock

**Files:**
- Create: `src/scheduler/storage.ts`
- Test: `tests/scheduler-storage.test.ts`

**Interfaces:**
- Consumes: `ScheduledJob` from Task 1.
- Produces: `SchedulerStorage.load()`, `save(jobs)`, `acquireLock()`, `releaseLock()`, and `quarantineCorruptFile()`.

- [ ] **Step 1: Write failing tests** using `AGENT_SDK_SESSION_DIR` temp directories for mode `0600`, atomic replacement, stale PID recovery, live-lock rejection, strict whole-file validation, and `.corrupt-<timestamp>` quarantine.

```ts
await storage.acquireLock()
await assert.rejects(new SchedulerStorage(id, dir).acquireLock(), /already active/)
assert.equal((await stat(file)).mode & 0o777, 0o600)
```

- [ ] **Step 2: Run the test and verify it fails.**

```bash
npx tsx --test tests/scheduler-storage.test.ts
```

- [ ] **Step 3: Implement versioned JSON persistence** with `open('wx', 0o600)`, file sync, rename, cleanup, strict validation, PID liveness via `process.kill(pid, 0)`, and ownership-token checked unlock.

- [ ] **Step 4: Run storage tests and build.**

```bash
npx tsx --test tests/scheduler-storage.test.ts && npm run build
```

- [ ] **Step 5: Commit.**

```bash
git add src/scheduler/storage.ts tests/scheduler-storage.test.ts
git commit -m "feat: persist scheduler state safely"
```

### Task 3: Scheduler lifecycle, admission, and recovery

**Files:**
- Create: `src/scheduler/scheduler.ts`
- Create: `src/scheduler/index.ts`
- Test: `tests/scheduler-runtime.test.ts`

**Interfaces:**
- Consumes: validation/storage from Tasks 1-2 and an injected `execute(job, signal): Promise<QueryResult>` callback.
- Produces: `Scheduler.start()`, `create()`, `list()`, `get()`, `update()`, `runNow()`, `delete()`, and `close()`.

- [ ] **Step 1: Write failing fake-clock tests** for nearest timer selection, FIFO at the global limit, same-job overlap skip, manual admission, one-shot completion, bounded history, no catch-up in memory mode, one catch-up on restart, old misfire skip, and persisted `running` recovery as `interrupted_unknown`.

```ts
const scheduler = new Scheduler({ clock, execute, options, storage })
await scheduler.start()
const job = await scheduler.create({ name: 'minute', prompt: 'work', cron: '* * * * *' })
clock.advance(60_000)
assert.equal((await scheduler.get(job.id))!.runs[0].status, 'running')
```

- [ ] **Step 2: Run the test and verify it fails.**

```bash
npx tsx --test tests/scheduler-runtime.test.ts
```

- [ ] **Step 3: Implement the state machine.** Persist mutations and queue admission before returning/emitting, treat queued jobs as active, advance recurring due time on admission/skip, cap timers at `2_147_483_647`, dispatch FIFO within `maxConcurrentRuns`, trim terminal history, and isolate `onEvent` failures.

- [ ] **Step 4: Implement close and recovery.** Stop admission, clear timers, cancel queued runs, abort active runs, await settlement, persist terminal states, and release the lock.

- [ ] **Step 5: Run runtime/storage/validation tests and build.**

```bash
npx tsx --test tests/scheduler-*.test.ts && npm run build
```

- [ ] **Step 6: Commit.**

```bash
git add src/scheduler tests/scheduler-runtime.test.ts
git commit -m "feat: add recoverable scheduler runtime"
```

### Task 4: Agent integration and isolated scheduled execution

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/engine.ts`
- Test: `tests/scheduler-agent.test.ts`

**Interfaces:**
- Consumes: `Scheduler` from Task 3.
- Produces: six asynchronous Agent schedule methods and a run-local abort signal path for query execution/hooks.

- [ ] **Step 1: Write failing tests** proving disabled-by-default behavior, setup failure propagation, history/session-state isolation, per-run budget reset, concurrent interactive and scheduled execution, inherited permission denial, scheduler-tool exclusion, MCP-client non-ownership, abort-aware callbacks/hooks, and close cancellation.

```ts
const agent = fixture({ scheduler: { enabled: true }, persistSession: false })
const job = await agent.createSchedule({ name: 'once', prompt: 'work', runAt: future })
assert.equal((await agent.getSchedule(job.id))?.name, 'once')
await agent.close()
await assert.rejects(agent.listSchedules(), /closed/)
```

- [ ] **Step 2: Run the focused test and verify it fails.**

```bash
npx tsx --test tests/scheduler-agent.test.ts
```

- [ ] **Step 3: Refactor execution ownership** so each run passes its own controller/signal, hook wrappers use that signal, and scheduled runs do not mutate parent `history`, `messageLog`, `interaction`, `activeRun`, `currentEngine`, or `abortCtrl`.

- [ ] **Step 4: Initialize and expose the scheduler.** Start it after MCP setup, snapshot filtered tools excluding `CronCreate/CronList/CronGet/CronUpdate/CronRun/CronDelete`, execute with `interactive: false`, append scheduler journal events when persistent, and close it before MCP clients.

- [ ] **Step 5: Run Agent scheduler tests and the reliability suites.**

```bash
npx tsx --test tests/scheduler-agent.test.ts tests/agent-reliability.test.ts tests/interaction.test.ts tests/mcp-reliability.test.ts
```

- [ ] **Step 6: Commit.**

```bash
git add src/agent.ts src/engine.ts tests/scheduler-agent.test.ts
git commit -m "feat: integrate scheduler with Agent"
```

### Task 5: Model-facing scheduler tools

**Files:**
- Replace: `src/tools/cron-tools.ts`
- Modify: `src/tools/index.ts`
- Modify: `src/index.ts`
- Test: `tests/scheduler-tools.test.ts`
- Modify: `tests/background-tasks.test.ts`
- Modify: `tests/tool-state.test.ts`

**Interfaces:**
- Consumes: scheduler instance stored in `SessionState` by Agent.
- Produces: `CronCreateTool`, `CronListTool`, `CronGetTool`, `CronUpdateTool`, `CronRunTool`, and `CronDeleteTool`; keeps `RemoteTriggerTool` disabled.

- [ ] **Step 1: Write failing tests** for tool availability only when configured, deprecated `schedule`/`command` aliases, JSON-safe output, not-found errors, pause/resume/update, run-now, delete, and RemoteTrigger exclusion.

```ts
const result = await CronCreateTool.call({ name: 'x', schedule: '* * * * *', command: 'work' }, context)
assert.match(String(result.content), /created/)
```

- [ ] **Step 2: Run the focused tests and verify failure.**

```bash
npx tsx --test tests/scheduler-tools.test.ts tests/background-tasks.test.ts tests/tool-state.test.ts
```

- [ ] **Step 3: Implement all six thin adapters.** Validate aliases at the boundary, delegate every operation to Scheduler, mark list/get read-only, and return useful tool errors without maintaining a second cron store.

- [ ] **Step 4: Run focused tests and build.**

```bash
npx tsx --test tests/scheduler-tools.test.ts tests/background-tasks.test.ts tests/tool-state.test.ts && npm run build
```

- [ ] **Step 5: Commit.**

```bash
git add src/tools/cron-tools.ts src/tools/index.ts src/index.ts tests/scheduler-tools.test.ts tests/background-tasks.test.ts tests/tool-state.test.ts
git commit -m "feat: expose scheduler tools"
```

### Task 6: Documentation and full verification

**Files:**
- Create: `docs/scheduler.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: final public APIs from Tasks 1-5.
- Produces: shipped package documentation and npm file inclusion.

- [ ] **Step 1: Add runnable host examples** for enabling scheduling, creating cron/one-shot jobs, listening for events, inspecting history, pausing, manually running, deleting, and closing.

```ts
const agent = createAgent({ scheduler: { enabled: true, timeZone: 'Asia/Shanghai' } })
await agent.createSchedule({ name: 'daily review', prompt: 'Review open work', cron: '0 9 * * *' })
```

- [ ] **Step 2: Document guarantees and limits** including process lifetime, catch-up, overlap, FIFO concurrency, persistence path, lock scope, approval callbacks, one-shot completion, and RemoteTrigger status.

- [ ] **Step 3: Run formatting checks, full tests, build, and package inspection.**

```bash
git diff --check
npm test
npm run build
npm pack --dry-run
```

- [ ] **Step 4: Verify the tarball includes `dist` and `docs/scheduler.md`, contains no source tests or temporary files, and commit.**

```bash
git add README.md CHANGELOG.md package.json docs/scheduler.md
git commit -m "docs: document session scheduler"
```

- [ ] **Step 5: Perform final branch review.** Compare against the approved spec, confirm only `cron-parser` was added to production dependencies, and record exact test/build results. Do not publish until separately requested.
