/**
 * The resident session follower.
 *
 * After a handoff completes, the user is looking at a session that is about to
 * be retired; the work is in a new one. This makes the browser follow.
 *
 * Three failure modes shaped this, each learned the hard way:
 *
 * 1. **Baseline.** A session that already has a `newSessionId` when the page
 *    loads must not hijack the view. Only an `undefined → value` transition
 *    during one page's lifetime is a signal. Without this, every reload would
 *    jump to the most recent handoff's target.
 * 2. **Blank rows.** A freshly created session is published with
 *    `blank: true`, and nothing clears that flag except re-reading the list
 *    (a handoff brief is `kind: 'plugin'`, which does not count as activity).
 *    So the order is `refresh()` → read → `open()`, never `open()` alone.
 * 3. **Bounded retry.** If the brief never started a turn the row stays blank
 *    forever. Retrying indefinitely would refetch the whole list every tick, so
 *    the follower gives up after a bounded number of attempts.
 */
import type { HandoffState } from './protocol'

/** The slice of the session service the follower needs. */
export interface SessionsLike {
  list?: {
    getSnapshot?: () => {
      current?: string | undefined
      byId?: Record<string, { blank?: boolean }>
    }
  }
  refresh?: () => Promise<unknown> | unknown
  open?: (sessionId: string) => void
}

/** How many ticks to wait for a new row before giving up. */
export const FOLLOW_MAX_ATTEMPTS = 12

/** How often to poll, in milliseconds. */
export const FOLLOW_INTERVAL_MS = 2000

export interface FollowDeps {
  readonly sessions: SessionsLike | undefined
  /** Fetch one session's status; resolves `undefined` on any failure. */
  readonly fetchState: (sessionId: string) => Promise<HandoffState | undefined>
  readonly currentSessionId: () => string | undefined
  readonly enabled: () => boolean
  readonly log?: (message: string) => void
  readonly setInterval?: (fn: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

/**
 * One follower per page.
 *
 * `start()` returns a disposer; the plugin's client `apply()` holds it so an
 * unload stops the polling.
 */
export class HandoffFollower {
  /** The last newSessionId seen per source session, for the baseline rule. */
  private readonly seen = new Map<string, string | undefined>()
  private readonly attempts = new Map<string, number>()
  private readonly switchedFor = new Set<string>()
  private handle: unknown
  private disposed = false

  constructor(private readonly deps: FollowDeps) {}

  /** Begin polling. Returns the disposer. */
  start(): () => void {
    const interval = this.deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
    this.handle = interval(() => {
      void this.tick()
    }, FOLLOW_INTERVAL_MS)
    return () => this.stop()
  }

  /** Stop polling. */
  stop(): void {
    if (this.disposed) return
    this.disposed = true
    const clear = this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as never))
    if (this.handle !== undefined) clear(this.handle)
  }

  /** One poll. Exposed so tests can drive it without timers. */
  async tick(): Promise<void> {
    if (this.disposed) return
    if (!this.deps.enabled()) return

    const sessionId = this.deps.currentSessionId()
    if (sessionId === undefined) return

    const state = await this.deps.fetchState(sessionId)
    const next = state?.newSessionId

    // Baseline rule: the first observation of a session only records the value.
    if (!this.seen.has(sessionId)) {
      this.seen.set(sessionId, next)
      if (next !== undefined) this.deps.log?.(`handoff: 会话 ${sessionId} 已在 ${next}，只记录不跳转`)
      return
    }

    const previous = this.seen.get(sessionId)
    this.seen.set(sessionId, next)

    if (previous !== undefined || next === undefined) return
    if (this.switchedFor.has(sessionId)) return

    /*
     * Honour the user's switch.
     *
     * `openNewSessionOnHandoff` exists because some people want to stay put and
     * compare the two sessions. The follower used to jump unconditionally,
     * which made the checkbox a decoration: turning it off changed nothing.
     * The state payload carries the value, so this decision does not depend on
     * the settings card ever having been open.
     */
    if (state?.openNewSession === false) {
      this.switchedFor.add(sessionId)
      this.deps.log?.(`handoff: 设置要求不自动跳转，停留在当前会话（新会话 ${next}）`)
      return
    }

    await this.switchTo(next, state)
  }

  private async switchTo(newSessionId: string, state: HandoffState | undefined): Promise<void> {
    const sessionId = state?.sessionId ?? '<unknown>'
    const attempts = (this.attempts.get(sessionId) ?? 0) + 1
    this.attempts.set(sessionId, attempts)

    if (attempts > FOLLOW_MAX_ATTEMPTS) {
      this.deps.log?.(`handoff: 新会话 ${newSessionId} 在 ${FOLLOW_MAX_ATTEMPTS} 次尝试后仍未就绪，停止跳转`)
      return
    }

    const sessions = this.deps.sessions
    if (sessions === undefined) return

    // Re-read the list so the host recomputes `blank`; without this the
    // sidebar keeps hiding the new row and `open()` lands on nothing visible.
    try {
      await sessions.refresh?.()
    } catch {
      // A failed refresh still leaves the previous snapshot; try to open anyway.
    }

    const row = sessions.list?.getSnapshot?.().byId?.[newSessionId]
    if (row === undefined) {
      this.deps.log?.(`handoff: 新会话 ${newSessionId} 尚未出现在列表中（第 ${attempts} 次）`)
      return
    }
    if (row.blank === true) {
      this.deps.log?.(`handoff: 新会话 ${newSessionId} 仍是空白行（第 ${attempts} 次）`)
      return
    }

    sessions.open?.(newSessionId)
    this.switchedFor.add(sessionId)
    this.deps.log?.(`handoff: 已切换到新会话 ${newSessionId}`)
  }

  /** Drop bookkeeping for a session that no longer matters. */
  forget(sessionId: string): void {
    this.seen.delete(sessionId)
    this.attempts.delete(sessionId)
    this.switchedFor.delete(sessionId)
  }
}
