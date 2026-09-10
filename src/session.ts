/**
 * Session Storage & Management
 *
 * Persists conversation transcripts to disk for resumption.
 * Manages session lifecycle (create, resume, list, fork).
 */

import { readFile, writeFile, mkdir, readdir, stat, open, rename, unlink } from 'fs/promises'
import { join } from 'path'
import type { Message, SDKMessage } from './types.js'
import type { NormalizedMessageParam } from './providers/types.js'

/**
 * Session metadata.
 */
export interface SessionMetadata {
  id: string
  cwd: string
  model: string
  createdAt: string
  updatedAt: string
  messageCount: number
  summary?: string
}

/**
 * Session data on disk.
 */
export interface SessionData {
  metadata: SessionMetadata
  messages: NormalizedMessageParam[]
}

/**
 * Get the sessions directory path.
 */
function getSessionsDir(): string {
  if (process.env.AGENT_SDK_SESSION_DIR) return process.env.AGENT_SDK_SESSION_DIR
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  return join(home, '.open-agent-sdk', 'sessions')
}

/**
 * Get the path for a specific session.
 */
function getSessionPath(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id')
  return join(getSessionsDir(), sessionId)
}

/**
 * Save session to disk.
 */
export async function saveSession(
  sessionId: string,
  messages: NormalizedMessageParam[],
  metadata: Partial<SessionMetadata>,
): Promise<void> {
  const dir = getSessionPath(sessionId)
  await mkdir(dir, { recursive: true })

  const previous = await readFile(join(dir, 'transcript.json'), 'utf8').then(
    text => JSON.parse(text) as SessionData,
    (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined },
  )

  const data: SessionData = {
    metadata: {
      id: sessionId,
      cwd: metadata.cwd || process.cwd(),
      model: metadata.model || 'claude-sonnet-4-6',
      createdAt: metadata.createdAt || previous?.metadata.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: messages.length,
      summary: metadata.summary,
    },
    messages,
  }

  const temporary = join(dir, `transcript-${crypto.randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(data, null, 2)); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary, join(dir, 'transcript.json'))
  } finally { await unlink(temporary).catch(() => {}) }

}

/**
 * Load session from disk.
 */
export async function loadSession(sessionId: string): Promise<SessionData | null> {
  try {
    const filePath = join(getSessionPath(sessionId), 'transcript.json')
    const content = await readFile(filePath, 'utf-8')
    const data = JSON.parse(content) as SessionData
    // A crash after a tool request leaves its outcome unknown. Pair it with an
    // explicit failure, never replay a possibly completed external mutation.
    for (let i = 0; i < data.messages.length; i++) {
      const message = data.messages[i]
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
      const calls = message.content.filter(block => block.type === 'tool_use')
      const next = data.messages[i + 1]
      const results = next?.role === 'user' && Array.isArray(next.content) ? next.content : []
      const missing = calls.filter(call => !results.some(result => result.type === 'tool_result' && result.tool_use_id === call.id))
      if (missing.length) {
        const interrupted = missing.map(call => ({ type: 'tool_result' as const, tool_use_id: call.id, content: 'Execution interrupted; tool outcome unknown. Verify external state before retrying.', is_error: true }))
        if (results.length) results.push(...interrupted)
        else data.messages.splice(i + 1, 0, { role: 'user', content: interrupted })
      }
    }
    return data
  } catch {
    return null
  }
}

/**
 * List all sessions.
 */
export async function listSessions(): Promise<SessionMetadata[]> {
  try {
    const dir = getSessionsDir()
    const entries = await readdir(dir)
    const sessions: SessionMetadata[] = []

    for (const entry of entries) {
      try {
        const data = await loadSession(entry)
        if (data?.metadata) {
          sessions.push(data.metadata)
        }
      } catch {
        // Skip invalid sessions
      }
    }

    // Sort by updatedAt descending
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    return sessions
  } catch {
    return []
  }
}

/**
 * Fork a session (create a copy with a new ID).
 */
export async function forkSession(
  sourceSessionId: string,
  newSessionId?: string,
): Promise<string | null> {
  const data = await loadSession(sourceSessionId)
  if (!data) return null

  const forkId = newSessionId || crypto.randomUUID()

  await saveSession(forkId, data.messages, {
    ...data.metadata,
    id: forkId,
    createdAt: new Date().toISOString(),
    summary: `Forked from session ${sourceSessionId}`,
  })

  return forkId
}

/**
 * Get session messages.
 */
export async function getSessionMessages(
  sessionId: string,
): Promise<NormalizedMessageParam[]> {
  const data = await loadSession(sessionId)
  return data?.messages || []
}

/**
 * Append a message to a session transcript.
 */
export async function appendToSession(
  sessionId: string,
  message: NormalizedMessageParam,
): Promise<void> {
  const data = await loadSession(sessionId)
  if (!data) return

  data.messages.push(message)
  data.metadata.updatedAt = new Date().toISOString()
  data.metadata.messageCount = data.messages.length

  await saveSession(sessionId, data.messages, data.metadata)
}

/**
 * Delete a session.
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  try {
    const { rm } = await import('fs/promises')
    await rm(getSessionPath(sessionId), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Get info about a specific session.
 */
export async function getSessionInfo(
  sessionId: string,
  options?: { dir?: string },
): Promise<SessionMetadata | null> {
  const data = await loadSession(sessionId)
  return data?.metadata || null
}

/**
 * Rename a session.
 */
export async function renameSession(
  sessionId: string,
  title: string,
  options?: { dir?: string },
): Promise<void> {
  const data = await loadSession(sessionId)
  if (!data) return

  data.metadata.summary = title
  data.metadata.updatedAt = new Date().toISOString()

  await saveSession(sessionId, data.messages, data.metadata)
}

/**
 * Tag a session.
 */
export async function tagSession(
  sessionId: string,
  tag: string | null,
  options?: { dir?: string },
): Promise<void> {
  const data = await loadSession(sessionId)
  if (!data) return

  ;(data.metadata as any).tag = tag
  data.metadata.updatedAt = new Date().toISOString()

  await saveSession(sessionId, data.messages, data.metadata)
}

/** Durable semantic event log. File order is authoritative; id is a replay cursor. */
export interface SessionEvent {
  version: 1
  id: string
  timestamp: string
  event: SDKMessage
}

export async function appendSessionEvent(sessionId: string, event: SDKMessage): Promise<void> {
  // Token deltas are ephemeral; complete assistant messages are persisted instead.
  if (event.type === 'partial_message') return
  const dir = getSessionPath(sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'events.jsonl')
  const record: SessionEvent = { version: 1, id: crypto.randomUUID(), timestamp: new Date().toISOString(), event }
  const handle = await open(path, 'a+', 0o600)
  try {
    // Normally read just the last byte. Scan backwards only after a torn append.
    const { size } = await handle.stat()
    if (size) {
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, size - 1)
      if (last[0] !== 10) {
        let end = size
        let boundary = 0
        while (end > 0) {
          const start = Math.max(0, end - 65536)
          const chunk = Buffer.alloc(end - start)
          await handle.read(chunk, 0, chunk.length, start)
          const newline = chunk.lastIndexOf(10)
          if (newline >= 0) { boundary = start + newline + 1; break }
          end = start
        }
        await handle.truncate(boundary)
      }
    }
    await handle.writeFile(JSON.stringify(record) + '\n')
    await handle.sync()
  } finally { await handle.close() }

}

export async function readSessionEvents(sessionId: string, afterId?: string): Promise<SessionEvent[]> {
  const content = await readFile(join(getSessionPath(sessionId), 'events.jsonl'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return ''
  })
  const lines = content.split('\n')
  lines.pop() // ignore a torn final record, or the empty trailing line
  const records = lines.filter(Boolean).map(line => JSON.parse(line) as SessionEvent)
  if (!afterId) return records
  const index = records.findIndex(record => record.id === afterId)
  if (index < 0) throw new Error('Unknown session event cursor')
  return records.slice(index + 1)
}
