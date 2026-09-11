import type { SDKMessage, UserMessageReceipt, QuestionRequest, PendingQuestion, QuestionAnswer } from './types.js'

export interface InputController {
  hasPending(): boolean
  take(): UserMessageReceipt[]
  settle(id: string, applied: boolean, reason?: string): void
}

/** One run's queues; the Agent retains bounded receipt history between runs. */
export class RunInteraction implements InputController {
  private accepting = true
  private input: UserMessageReceipt[] = []
  private events: SDKMessage[] = []
  private wake?: () => void
  private questions = new Map<string, { question: PendingQuestion; finish: (answer?: QuestionAnswer, error?: Error) => void }>()
  constructor(private receipts: Map<string, UserMessageReceipt>) {}

  send(text: string): string {
    if (!this.accepting) throw new Error('Agent has no active input window')
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message must be non-empty text')
    if ([...this.receipts.values()].filter(r => r.status === 'queued').length >= 128) throw new Error('Pending message limit reached')
    const receipt: UserMessageReceipt = { id: crypto.randomUUID(), text, status: 'queued' }
    this.input.push(receipt); this.receipts.set(receipt.id, receipt)
    while (this.receipts.size > 256) {
      const oldest = [...this.receipts.values()].find(r => r.status !== 'queued')
      if (!oldest) break
      this.receipts.delete(oldest.id)
    }
    this.emit({ type: 'system', subtype: 'user_message', ...receipt })
    return receipt.id
  }
  hasPending(): boolean { return this.input.length > 0 }
  take(): UserMessageReceipt[] { return this.input.splice(0) }
  settle(id: string, applied: boolean, reason?: string): void {
    const receipt = this.receipts.get(id)
    if (!receipt || receipt.status !== 'queued') return
    receipt.status = applied ? 'applied' : 'not_applied'
    receipt.reason = reason
  }
  pendingQuestions(): PendingQuestion[] { return [...this.questions.values()].map(({ question }) => ({ ...question, options: question.options?.slice() })) }
  ask(request: QuestionRequest, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (!this.accepting) return Promise.reject(new Error('Run is ending'))
    const question: PendingQuestion = { ...request, options: request.options?.slice(), question_id: crypto.randomUUID() }
    return new Promise((resolve, reject) => {
      const abort = () => finish(undefined, signal.reason instanceof Error ? signal.reason : new Error('Question cancelled'))
      const finish = (answer?: QuestionAnswer, error?: Error) => {
        if (!this.questions.delete(question.question_id)) return
        signal.removeEventListener('abort', abort)
        this.emit({ type: 'system', subtype: 'question_closed', question_id: question.question_id, status: error ? error.name === 'TimeoutError' ? 'timed_out' : 'cancelled' : 'answered' })
        if (error) reject(error)
        else resolve(Array.isArray(answer) ? JSON.stringify(answer) : answer!)
      }
      this.questions.set(question.question_id, { question, finish })
      signal.addEventListener('abort', abort, { once: true })
      this.emit({ type: 'system', subtype: 'question', ...question })
      if (signal.aborted) abort()
    })
  }
  answer(id: string, answer: QuestionAnswer): void {
    const pending = this.questions.get(id)
    if (!pending) throw new Error('Question is not pending in this Agent')
    if (Array.isArray(answer)) {
      if (!pending.question.allow_multiselect || !answer.length || answer.some(a => typeof a !== 'string' || !a.trim())) throw new Error('Invalid multiple-choice answer')
    } else if (typeof answer !== 'string' || !answer.trim()) throw new Error('Answer must be non-empty text')
    pending.finish(answer)
  }
  cancel(id: string): void {
    const pending = this.questions.get(id)
    if (!pending) throw new Error('Question is not pending in this Agent')
    pending.finish(undefined, new Error('User cancelled the question'))
  }
  finish(reason = 'Run ended before this message could be applied'): void {
    this.accepting = false
    this.input = []
    for (const receipt of this.receipts.values()) if (receipt.status === 'queued') {
      this.settle(receipt.id, false, reason)
      this.emit({ type: 'system', subtype: 'user_message', ...receipt })
    }
    for (const pending of this.questions.values()) pending.finish(undefined, new Error('Run ended'))
  }
  emit(event: SDKMessage): void { this.events.push(event); this.wake?.() }
  drain(): SDKMessage[] { return this.events.splice(0) }
  shiftEvent(): SDKMessage | undefined { return this.events.shift() }

  /** Pull one source item at a time, exposing questions while next() is blocked. */
  async *merge(source: AsyncGenerator<SDKMessage, void>, abort: () => void): AsyncGenerator<SDKMessage, void> {
    type Outcome = { value: IteratorResult<SDKMessage, void> } | { error: unknown }
    let next: Promise<Outcome> | undefined
    let sourceDone = false
    try {
      while (true) {
        if (this.events.length) { yield this.events.shift()!; continue }
        if (sourceDone) break
        next ??= source.next().then(value => ({ value }), error => ({ error }))
        if (this.events.length) continue
        const wake = new Promise<'wake'>(resolve => { this.wake = () => resolve('wake') })
        const outcome = await Promise.race([next, wake])
        this.wake = undefined
        if (outcome === 'wake') continue
        next = undefined
        if ('error' in outcome) throw outcome.error
        // Keep buffered events in the broker until individually delivered, so
        // early-exit cleanup can journal every event that was not consumed.
        if (outcome.value.done) sourceDone = true
        else this.events.push(outcome.value.value)
      }
    } finally {
      this.wake = undefined
      abort()
      if (next) await next
      await source.return()
    }
  }
}

/** Bound a question wait without requiring legacy callbacks to cooperate. */
export async function waitForQuestion<T>(run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, timeout = 300000): Promise<T> {
  parent?.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { const error = new Error('Question timed out'); error.name = 'TimeoutError'; controller.abort(error) }, timeout)
  let rejectAbort: () => void = () => {}
  try {
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason || new Error('Question cancelled'))
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    return await Promise.race([cancelled, Promise.resolve().then(() => { controller.signal.throwIfAborted(); return run(controller.signal) })])
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', rejectAbort)
    controller.abort()
  }
}
