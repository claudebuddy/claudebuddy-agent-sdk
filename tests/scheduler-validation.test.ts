import assert from 'node:assert/strict'
import test from 'node:test'
import {
  nextCronOccurrence,
  normalizeSchedulerOptions,
  validateScheduleInput,
} from '../src/scheduler/schedule.js'

test('scheduler options reject invalid limits and time zones', () => {
  assert.throws(
    () => normalizeSchedulerOptions({ enabled: true, maxConcurrentRuns: 0 }),
    /maxConcurrentRuns must be a positive integer/,
  )
  assert.throws(
    () => normalizeSchedulerOptions({ enabled: true, timeZone: 'Mars/Olympus' }),
    /Invalid time zone/,
  )
})

test('schedule input requires one valid schedule and a non-empty prompt', () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  assert.throws(
    () => validateScheduleInput({ name: 'x', prompt: 'p', cron: '* * * * *', runAt: future }),
    /exactly one of cron or runAt/,
  )
  assert.throws(
    () => validateScheduleInput({ name: 'x', prompt: ' ', cron: '* * * * *' }),
    /prompt must be non-empty/,
  )
  assert.throws(
    () => validateScheduleInput({ name: 'x', prompt: 'p', cron: '* * * * * *' }),
    /five-field cron/,
  )
})

test('one-shot creation rejects timestamps in the past', () => {
  assert.throws(
    () => validateScheduleInput({ name: 'x', prompt: 'p', runAt: '2020-01-01T00:00:00.000Z' }),
    /future/,
  )
  assert.throws(
    () => validateScheduleInput({ name: 'x', prompt: 'p', runAt: 'September 12, 2027' }),
    /ISO 8601/,
  )
})

test('next cron occurrence honors the configured IANA time zone', () => {
  const after = new Date('2026-09-11T00:00:00.000Z')
  assert.equal(
    nextCronOccurrence('0 9 * * *', 'Asia/Shanghai', after).toISOString(),
    '2026-09-11T01:00:00.000Z',
  )
})

test('next cron occurrence follows daylight-saving transitions', () => {
  const beforeSpringForward = new Date('2026-03-07T13:59:59.000Z')
  assert.equal(
    nextCronOccurrence('0 9 * * *', 'America/New_York', beforeSpringForward).toISOString(),
    '2026-03-07T14:00:00.000Z',
  )
  assert.equal(
    nextCronOccurrence('0 9 * * *', 'America/New_York', new Date('2026-03-07T14:00:01.000Z')).toISOString(),
    '2026-03-08T13:00:00.000Z',
  )
})
