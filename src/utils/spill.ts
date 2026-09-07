/**
 * Spill — overflow text off to disk
 *
 * When a tool result is far larger than the context can afford, we do not
 * truncate it inline (which loses data and wastes tokens on the tail anyway).
 * Instead we "spill" the full text to a file on disk and hand the model a
 * compact head/tail preview plus a locator the model (or a later spill-aware
 * tool) can use to retrieve the full payload on demand.
 *
 * Design rules (mirroring DeepSeek's spill-policy):
 * 1. Purely presentational — it is a post-processing layer, decoupled from
 *    the tool implementation. The underlying tool result is never mutated.
 * 2. Best-effort — if spilling fails (disk full, no permission) the original
 *    successful result is returned unchanged. A spill failure must never turn
 *    a successful tool call into an error.
 * 3. The replacement text must itself stay under the cap, with a reserved
 *    byte budget for the locator/notice so it can never overflow.
 * 4. Skip spill for reading tools to avoid a read -> spill -> read cycle.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** A stored spill: an opaque locator plus a model-visible preview. */
export interface SpillEntry {
  /** Opaque handle used to retrieve the stored full text later. */
  locator: string
  /** File path the full text was written to (locator may reference it). */
  path: string
  /** Byte size of the spilled content. */
  size: number
}

/** Configuration for the spill store. */
export interface SpillStoreOptions {
  /** Directory to write spill files into. Defaults to <cwd>/.spill. */
  spillDir?: string
  /** Maximum bytes stored per file before we still abort a spill attempt. */
  maxSpillBytes?: number
}

/**
 * Append-only spill store. Each spill gets its own file so there is no
 * locking or ordering concern. The locator is the absolute file path — simple,
 * unique per write, and trivially re-fetchable by any file tool.
 */
export class SpillStore {
  private readonly spillDir: string
  private readonly maxSpillBytes: number
  private seq = 0

  constructor(options: SpillStoreOptions = {}) {
    this.spillDir = options.spillDir ?? '.spill'
    this.maxSpillBytes = options.maxSpillBytes ?? 20 * 1024 * 1024
  }

  /** Lazily ensure the spill directory exists. */
  private async ensureDir(): Promise<string> {
    await fs.mkdir(this.spillDir, { recursive: true })
    return this.spillDir
  }

  /**
   * Write `text` to a new spill file if it is non-empty and within limits.
   * Never throws: any failure is reported via the `ok: false` shape.
   */
  async saveText(text: string, tag?: string): Promise<{ ok: true; entry: SpillEntry } | { ok: false; error: string }> {
    try {
      if (typeof text !== 'string' || text.length === 0) {
        return { ok: false, error: 'nothing to spill' }
      }
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > this.maxSpillBytes) {
        return { ok: false, error: `spill exceeds maxSpillBytes (${bytes} > ${this.maxSpillBytes})` }
      }
      const dir = await this.ensureDir()
      const seq = ++this.seq
      const safeTag = (tag ?? 'result').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
      const fileName = `${Date.now()}-${seq}-${safeTag}.spill.txt`
      const filePath = path.join(dir, fileName)
      await fs.writeFile(filePath, text, 'utf8')
      return { ok: true, entry: { locator: filePath, path: filePath, size: bytes } }
    } catch (err: any) {
      return { ok: false, error: err?.message ? String(err.message) : String(err) }
    }
  }

  /** Read a spilled payload back by its locator (the absolute path). */
  async read(locator: string): Promise<string | undefined> {
    try {
      // Defensive: only allow reads of files under our spill directory.
      const resolved = path.resolve(locator)
      const dir = path.resolve(this.spillDir)
      if (!resolved.startsWith(dir + path.sep) && resolved !== dir) {
        return undefined
      }
      return await fs.readFile(resolved, 'utf8')
    } catch {
      return undefined
    }
  }
}

/**
 * Build the compact model-visible preview for a spilled blob: head + "…truncated…"
 * + tail, sized so head+tail+notice fit within `previewBytes` with room to spare.
 */
export function buildPreview(
  text: string,
  previewBytes: number = 4000,
): string {
  // Reserve ~10% for the locator notice so the replacement never overflows.
  const headBudget = Math.floor((previewBytes * 0.9) / 2)
  const tailBudget = Math.floor((previewBytes * 0.9) / 2)
  const total = text.length
  if (total <= previewBytes * 0.9) return text
  const head = text.slice(0, headBudget)
  const tail = text.slice(total - tailBudget)
  const omitted = total - headBudget - tailBudget
  return `${head}\n\n…[${omitted} chars omitted; full result spilled to disk]…\n\n${tail}`
}

/**
 * Policy-level options controlling when a tool result is spilled.
 */
export interface SpillPolicyOptions {
  /** Tool results above this many bytes are spilled. Default 20000. */
  maxInlineBytes?: number
  /** Size of the head/tail preview given to the model. Default 4000. */
  previewBytes?: number
  /** Tool names that should never be spilled (to avoid read->spill->read loops). */
  neverSpillTools?: string[]
}

/**
 * Apply the spill policy to a single tool result content string.
 *
 * Returns a tagged result so the caller can distinguish:
 * - `{ kind: 'keep', content }`       — unchanged (small, or tool excluded)
 * - `{ kind: 'spill', content, entry }` — spilled; preview replaces content
 * - `{ kind: 'failed', content }`     — spill attempted but failed; keep original
 */
export async function applySpillPolicy(
  text: string,
  store: SpillStore,
  options: SpillPolicyOptions = {},
): Promise<
  | { kind: 'keep'; content: string }
  | { kind: 'spill'; content: string; entry: SpillEntry }
  | { kind: 'failed'; content: string; error: string }
> {
  const maxInlineBytes = options.maxInlineBytes ?? 20000
  const previewBytes = options.previewBytes ?? 4000
  const bytes = Buffer.byteLength(text, 'utf8')

  if (bytes <= maxInlineBytes) return { kind: 'keep', content: text }

  const saved = await store.saveText(text)
  if (!saved.ok) {
    // Best-effort: never turn a success into an error, never lose data.
    return { kind: 'failed', content: text, error: saved.error }
  }

  const preview = buildPreview(text, previewBytes)
  const notice = `\n\n[Full ${bytes} bytes spilled to: ${saved.entry.locator}]`
  return { kind: 'spill', content: preview + notice, entry: saved.entry }
}

/** Skip spill for a given tool name (avoid read -> spill -> read loops). */
export function shouldNeverSpill(
  toolName: string,
  neverSpillTools: string[] = [],
): boolean {
  if (neverSpillTools.length === 0) return false
  return neverSpillTools.some((n) => toolName === n || toolName.toLowerCase().includes(n.toLowerCase()))
}