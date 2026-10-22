/**
 * The graceful stop: ask a session to finish its current step, then hand over.
 *
 * ## What this module deliberately does not do
 *
 * It never cancels anything. There is no `agent.cancel()` anywhere in this
 * plugin, and `AgentLike` does not even declare the method, so an accidental
 * call is a type error rather than a silent behaviour change. A handoff that
 * interrupted a running tool call would leave a half-written file or a killed
 * test suite behind, and the new session would inherit an unknown state.
 *
 * Instead the plugin sets a latch and lets the harness close the step it is
 * already running. The latch is enforced at exactly one place: the
 * `agent/pre-step` waterfall, which runs *before* a step starts. Returning
 * `{ kind: 'reject' }` there means "do not begin the next step", and the turn
 * closes as `blocked` with everything already committed intact.
 *
 * ## The human guard
 *
 * A rejected step claims its messages but never persists or re-queues them
 * (an explicit contract of the agent loop). Rejecting a step that carries a new
 * human message would therefore silently swallow what the user just typed. So
 * before rejecting, the listener inspects the batch: if it contains any
 * message from a human (`source.kind === 'user'`, which includes the browser's
 * `user-rpc`), the latch yields and the step proceeds. Plugin-injected
 * messages (`kind: 'plugin'`, `kind: 'goal'`) do not count as human input.
 *
 * ## Deadlines
 *
 * `waitMs` bounds how long the caller waits for the boundary. Expiry is a
 * *failure of the handoff*, never a reason to touch the session: the latch is
 * released, the session continues, and the caller reports why.
 */

import type { AgentLike, AgentMessageLike, PreStepDecisionLike } from './contracts.ts'

/** One session's stop request and its bookkeeping. */
export interface StopLatch {
  readonly sessionId: string
  /** Monotonic id so a stale release cannot clear a newer latch. */
  readonly token: number
  /** Wall-clock when the latch was set. */
  readonly requestedAt: number
  /** Resolved when the agent reaches a step boundary, or the waiter times out. */
  readonly released: Promise<void>
  /** Settle the promise exactly once, whoever gets there first. */
  readonly settle: () => void
  /** True once the waiter observed the latch; used for diagnostics. */
  waited: boolean
}

/** Reasons a latch can be released, for logging and status. */
export type ReleaseReason = 'boundary' | 'cancel' | 'timeout' | 'error'

/**
 * True when this batch of pre-step messages contains human input.
 *
 * `unknown` sources are treated as human: a message the plugin cannot classify
 * might be something the user typed, and swallowing it is worse than letting a
 * step run one more turn.
 */
export function batchHasHumanInput(messages: readonly AgentMessageLike[] | undefined): boolean {
  if (messages === undefined || messages.length === 0) return false
  for (const message of messages) {
    const kind = message?.source?.kind
    if (kind === 'user') return true
    if (kind === undefined) return true
  }
  return false
}

/**
 * Decide the pre-step outcome while a latch is held.
 *
 * Returns the decision to use, or `undefined` when the listener must call
 * `next()` and leave the decision alone (another plugin may still rewrite it).
 */
export function decidePreStep(
  latched: boolean,
  messages: readonly AgentMessageLike[] | undefined,
): PreStepDecisionLike | undefined {
  if (!latched) return undefined
  if (batchHasHumanInput(messages)) return undefined
  return { kind: 'reject' }
}

/**
 * Flatten the human text of one pre-step batch.
 *
 * The latch lets a human message through so the old session can act on it, but
 * once the task has moved the message belongs to the NEW session. Carrying the
 * text is what makes that possible; an empty result means the batch held only
 * non-human or contentless messages, which are not worth rerouting.
 */
export function humanTexts(messages: readonly AgentMessageLike[] | undefined): readonly string[] {
  if (messages === undefined || messages.length === 0) return []
  const texts: string[] = []
  for (const message of messages) {
    const kind = message?.source?.kind
    // `unknown` counts as human everywhere else in this module; keep one rule.
    if (kind !== undefined && kind !== 'user') continue
    const text = blocksToText(message?.content)
    if (text.length > 0) texts.push(text)
  }
  return texts
}

/** Flatten a message's content blocks into text, ignoring non-text blocks. */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      return typeof record['text'] === 'string' ? record['text'] : ''
    })
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trim()
}

/** Human input observed while an action was in flight, held for rerouting. */
export class HumanInputBuffer {
  private readonly bySession = new Map<string, string[]>()

  /** Record texts for a session; returns how many were added. */
  capture(sessionId: string, texts: readonly string[]): number {
    if (texts.length === 0) return 0
    const existing = this.bySession.get(sessionId) ?? []
    existing.push(...texts)
    this.bySession.set(sessionId, existing)
    return texts.length
  }

  /** Take and clear everything held for a session. */
  drain(sessionId: string): readonly string[] {
    const texts = this.bySession.get(sessionId) ?? []
    this.bySession.delete(sessionId)
    return texts
  }

  /** Drop a session's buffer (disposal, unload). */
  forget(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  /** Sessions currently holding text; used by tests and diagnostics. */
  ids(): readonly string[] {
    return [...this.bySession.keys()]
  }
}

/** Bookkeeping for every latch owned by this plugin instance. */
export class LatchRegistry {
  private readonly latches = new Map<string, StopLatch>()
  private nextToken = 1

  /** Set (or replace) the latch for one session. */
  arm(sessionId: string, now: number = Date.now()): StopLatch {
    this.release(sessionId, 'cancel')

    let settle!: () => void
    const released = new Promise<void>((resolve) => {
      settle = resolve
    })

    const latch: StopLatch = {
      sessionId,
      token: this.nextToken++,
      requestedAt: now,
      released,
      settle,
      waited: false,
    }
    this.latches.set(sessionId, latch)
    return latch
  }

  /** The current latch for a session, when one is held. */
  get(sessionId: string): StopLatch | undefined {
    return this.latches.get(sessionId)
  }

  /** True when the latch has been armed and not yet cleared. */
  isLatched(sessionId: string): boolean {
    return this.latches.has(sessionId)
  }

  /**
   * Clear a session's latch.
   *
   * Passing a token makes the release conditional: a late callback from an
   * older attempt cannot clear a newer attempt's latch.
   */
  release(sessionId: string, _reason: ReleaseReason, token?: number): boolean {
    const latch = this.latches.get(sessionId)
    if (latch === undefined) return false
    if (token !== undefined && latch.token !== token) return false
    this.latches.delete(sessionId)
    latch.settle()
    return true
  }

  /** Drop everything (plugin unload). */
  releaseAll(reason: ReleaseReason): void {
    for (const [id, latch] of [...this.latches]) {
      this.latches.delete(id)
      latch.settle()
      void reason
    }
  }

  /** Sessions currently latched; used by status and by unload diagnostics. */
  ids(): readonly string[] {
    return [...this.latches.keys()]
  }
}

/** How one wait finished. */
export interface BoundaryOutcome {
  readonly reached: boolean
  readonly reason: 'boundary' | 'timeout' | 'error'
  readonly waitedMs: number
  readonly error?: string
}

/**
 * Wait for the agent to finish what it is doing.
 *
 * Two independent conditions end the wait, whichever comes first: the agent
 * reporting idle, or the hard deadline. The idle path is preferred because it
 * reflects the harness's own view; a deadline that fires first is reported as a
 * failure so the caller can release the latch and leave the session running.
 */
export async function waitForBoundary(
  agent: AgentLike | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<BoundaryOutcome> {
  const startedAt = now()
  if (agent === undefined) {
    return { reached: false, reason: 'error', waitedMs: 0, error: '找不到活动 Agent' }
  }

  const whenIdle = agent.whenIdle
  if (typeof whenIdle !== 'function') {
    // No idle signal on this deployment: the latch alone is the stop, and the
    // caller cannot know when it took effect. Succeeding here would claim a
    // boundary that was never observed.
    return {
      reached: false,
      reason: 'error',
      waitedMs: 0,
      error: '该宿主未提供 agent.whenIdle()，无法确认 Step 边界',
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    // Do not keep the process alive just for this timer.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      ;(timer as { unref?: () => void }).unref?.()
    }
  })

  const idle = Promise.resolve(whenIdle.call(agent)).then(
    () => 'boundary' as const,
    (error: unknown) => {
      throw error
    },
  )

  /*
   * The abort listener is removed in `finally`, not left on the signal.
   *
   * `{ once: true }` only detaches after it FIRES; a wait that ends via `idle`
   * or the timeout leaves the listener attached for as long as the signal lives.
   * Today's callers pass a per-action signal that dies with the action, so this
   * is not a live leak — but it is an unbounded dependency on that assumption,
   * and a reused or long-lived signal would accumulate one listener per wait.
   */
  let onAbort: (() => void) | undefined
  const abort = new Promise<'error'>((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) return resolve('error')
    onAbort = () => resolve('error')
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    const winner = await Promise.race([idle, timeout, abort])
    const waitedMs = now() - startedAt
    if (winner === 'boundary') return { reached: true, reason: 'boundary', waitedMs }
    if (winner === 'error') {
      return { reached: false, reason: 'error', waitedMs, error: '等待被取消' }
    }
    return { reached: false, reason: 'timeout', waitedMs }
  } catch (error) {
    return {
      reached: false,
      reason: 'error',
      waitedMs: now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}
