/**
 * The coordinator: one action at a time per session, and the phase machine that
 * describes what that action is doing.
 *
 * Invariants it owns (each one has cost a design iteration somewhere else):
 *
 * - **One action per session.** A second request while one is running is
 *   rejected by name, not queued, because a queued second handoff would fire
 *   against a session that no longer exists.
 * - **The latch is always released.** Success, failure, cancellation or
 *   deadline all pass through the same `finally`, so no code path can leave a
 *   session unable to start its next step.
 * - **Nothing is cancelled.** The stop is a latch plus `whenIdle`; this module
 *   has no cancel call to make.
 * - **New human input during the early phases aborts the action**, and the
 *   message is never dropped: the latch yields to it, and the old session
 *   continues. Once the new session exists, the message is re-delivered there
 *   instead, so the user's input still reaches work.
 * - **A deadline is a failure, not a kill.** Expiry releases the latch and
 *   reports why; the original session is left exactly as it was.
 */
import type { AgentLike } from './contracts.ts'
import { type CompactOutcome } from './compact-handler.ts'
import {
  type BoundaryOutcome,
  type LatchRegistry,
  type ReleaseReason,
  waitForBoundary,
} from './graceful-stop.ts'
import type { ActionResult, FailureRecord, Phase } from './types.ts'

/** The steps the coordinator delegates; each is injected so it stays testable. */
export interface CoordinatorDeps {
  readonly latches: LatchRegistry
  /** Build and render the brief; throwing means "abort, keep the session". */
  readonly summarize: (agent: AgentLike) => Promise<{ brief: string; redactions: readonly string[] }>
  /** Create the new session and inherit; must not throw for ordinary failures. */
  readonly migrate: (brief: string) => Promise<ActionResult>
  /** Run a compaction; only used by the compact action. */
  readonly compact: (agent: AgentLike) => Promise<CompactOutcome>
  /** Wait for idle; injected so tests need not sleep. */
  readonly waitIdle: (agent: AgentLike) => Promise<void>
  /** Deliver a human message that arrived mid-flight to the new session. */
  readonly reroute?: (newSessionId: string, text: string) => Promise<boolean>
  readonly now?: () => number
  readonly log?: (message: string) => void
}

/** Live bookkeeping for one session's action. */
interface Run {
  readonly kind: 'handoff' | 'compact'
  phase: Phase
  cancelRequested: boolean
  boundary: BoundaryOutcome | undefined
}

/** What a caller asked for. */
export interface ActionRequest {
  readonly sessionId: string
  readonly agent: AgentLike | undefined
  readonly kind: 'handoff' | 'compact'
  readonly reason: 'manual' | 'context' | 'cumulative'
  readonly detail?: string
  /** Only automatic actions count against the per-session cap. */
  readonly automatic: boolean
}

/** Status the UI reads. Pure data, no live objects. */
export interface SessionStatus {
  readonly sessionId: string
  readonly phase: Phase
  readonly busy: boolean
  readonly latched: boolean
  readonly cancelRequested: boolean
  readonly kind: 'handoff' | 'compact' | undefined
  readonly waitingForStep: boolean
  readonly slowWarning: boolean
  readonly newSessionId: string | undefined
  readonly lastResult: ActionResult | undefined
  readonly lastFailure: FailureRecord | undefined
  readonly failures: number
}

export class Coordinator {
  private readonly runs = new Map<string, Run>()
  private readonly lastResults = new Map<string, ActionResult>()
  private readonly lastFailures = new Map<string, FailureRecord>()
  private readonly newSessions = new Map<string, string>()
  private readonly failureCounts = new Map<string, number>()
  private readonly slowWarned = new Set<string>()

  constructor(private readonly deps: CoordinatorDeps) {}

  /** True while this session has an action in flight. */
  isBusy(sessionId: string): boolean {
    return this.runs.has(sessionId)
  }

  /** The phase a session is in, for the trigger engine's pending check. */
  phaseOf(sessionId: string): Phase {
    return this.runs.get(sessionId)?.phase ?? 'idle'
  }

  /** Ask a running action to stop at its next safe point. */
  requestCancel(sessionId: string): boolean {
    const run = this.runs.get(sessionId)
    if (run === undefined) return false
    run.cancelRequested = true
    this.deps.log?.(`handoff: 已请求取消 ${sessionId}（在下一个安全检查点生效）`)
    return true
  }

  /** The `newSessionId` a browser may jump to, once one exists. */
  newSessionOf(sessionId: string): string | undefined {
    return this.newSessions.get(sessionId)
  }

  /** Drop every trace of a session that no longer exists. */
  forget(sessionId: string): void {
    this.deps.latches.release(sessionId, 'cancel')
    this.runs.delete(sessionId)
    this.lastResults.delete(sessionId)
    this.lastFailures.delete(sessionId)
    this.failureCounts.delete(sessionId)
    this.slowWarned.delete(sessionId)
    // `newSessions` is intentionally kept: the browser may still be following a
    // handoff that completed just before the old session was disposed.
  }

  /** Everything the status surface shows for one session. */
  statusOf(sessionId: string): SessionStatus {
    const run = this.runs.get(sessionId)
    const latch = this.deps.latches.get(sessionId)
    return {
      sessionId,
      phase: run?.phase ?? this.lastResults.get(sessionId)?.phase ?? 'idle',
      busy: run !== undefined,
      latched: latch !== undefined,
      cancelRequested: run?.cancelRequested ?? false,
      kind: run?.kind,
      waitingForStep: run?.phase === 'waiting-for-step-boundary',
      slowWarning: this.slowWarned.has(sessionId),
      newSessionId: this.newSessions.get(sessionId),
      lastResult: this.lastResults.get(sessionId),
      lastFailure: this.lastFailures.get(sessionId),
      failures: this.failureCounts.get(sessionId) ?? 0,
    }
  }

  /**
   * Run one action to completion.
   *
   * Returns a verdict for every path; it does not throw for expected failures
   * (missing services, empty session, timeout). It does rethrow only if a
   * programming error escapes a dependency, after releasing the latch.
   */
  async run(request: ActionRequest): Promise<ActionResult> {
    const { sessionId } = request

    if (this.runs.has(sessionId)) {
      return this.finish(sessionId, {
        ok: false,
        phase: 'idle',
        text: '当前会话已有正在进行的动作，请等待它结束或先取消。',
        error: 'action-in-flight',
      })
    }

    if (request.kind === 'handoff' && !(await this.hasActivity(sessionId))) {
      return this.finish(sessionId, {
        ok: false,
        phase: 'idle',
        text: '当前没有可迁移的活动会话（空白会话不会被交接）。',
        error: 'session-blank',
      })
    }

    const run: Run = { kind: request.kind, phase: 'preparing', cancelRequested: false, boundary: undefined }
    this.runs.set(sessionId, run)

    const deadline = withDeadline(this.actionDeadlineMs)

    try {
      if (request.kind === 'handoff') {
        return await this.runHandoff(request, run, deadline.signal)
      }
      return await this.runCompact(request, run, deadline.signal)
    } catch (error) {
      return this.fail(
        sessionId,
        run,
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      deadline.dispose()
      this.deps.latches.release(sessionId, 'boundary' as ReleaseReason)
      this.runs.delete(sessionId)
      this.slowWarned.delete(sessionId)
    }
  }

  // ---------------------------------------------------------------- handoff

  private async runHandoff(
    request: ActionRequest,
    run: Run,
    deadlineSignal: AbortSignal,
  ): Promise<ActionResult> {
    const { sessionId, agent } = request

    // 1. Arm the latch. From here the session stops starting new steps.
    run.phase = 'preparing'
    this.deps.latches.arm(sessionId)
    this.deps.log?.(`handoff: ${request.detail ?? '手动触发'}，已设停止闩锁`)

    // 2. Wait for the running step to finish on its own.
    run.phase = 'waiting-for-step-boundary'
    const boundary = await waitForBoundary(agent, this.stepWaitMs, deadlineSignal, this.deps.now)
    run.boundary = boundary

    if (run.cancelRequested) return this.cancelled(sessionId, run, '已按请求取消交接。')
    if (boundary.reason === 'timeout') {
      return this.fail(
        sessionId,
        run,
        `等待 Step 边界超时（${Math.round(boundary.waitedMs / 1000)} 秒）。已释放闩锁，原会话可继续工作。`,
      )
    }
    if (boundary.reason === 'error') {
      return this.fail(sessionId, run, `等待 Step 边界失败：${boundary.error ?? '未知原因'}`)
    }

    // 3. Write the brief. A failure here keeps the session exactly as it is.
    run.phase = 'summarizing'
    let brief: string
    let redactions: readonly string[]
    try {
      const summary = await this.deps.summarize(agent as AgentLike)
      brief = summary.brief
      redactions = summary.redactions
    } catch (error) {
      return this.fail(
        sessionId,
        run,
        `生成交接简报失败，已放弃本次交接并保留原会话：${messageOf(error)}`,
      )
    }

    if (run.cancelRequested) return this.cancelled(sessionId, run, '已按请求取消交接（简报未生成）。')

    // 4. Create the new session and inherit.
    run.phase = 'creating-session'
    const migrated = await this.deps.migrate(brief)

    if (migrated.newSessionId !== undefined) {
      this.newSessions.set(sessionId, migrated.newSessionId)
    }

    if (run.cancelRequested) {
      return this.cancelled(
        sessionId,
        run,
        migrated.newSessionId === undefined
          ? '已按请求取消交接。'
          : `已取消，但新会话已创建：${migrated.newSessionId}`,
        migrated.newSessionId,
      )
    }

    if (!migrated.ok) {
      return this.finish(sessionId, {
        ok: false,
        phase: 'failed',
        text: [
          migrated.text,
          migrated.newSessionId === undefined ? '' : `新会话 id：${migrated.newSessionId}（可手动继续）`,
          migrated.inherited === undefined ? '' : describeInherited(migrated.inherited),
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
        ...(migrated.newSessionId === undefined ? {} : { newSessionId: migrated.newSessionId }),
        ...(migrated.inherited === undefined ? {} : { inherited: migrated.inherited }),
        ...(migrated.error === undefined ? {} : { error: migrated.error }),
      })
    }

    run.phase = 'transferring'
    return this.finish(sessionId, {
      ...migrated,
      phase: 'completed',
      text: [
        `交接完成：新会话 ${migrated.newSessionId ?? '(未知)'} 已接手。`,
        redactions.length === 0
          ? ''
          : `简报中有 ${redactions.length} 类敏感信息已替换为占位符。`,
        migrated.inherited === undefined ? '' : describeInherited(migrated.inherited),
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
    })
  }

  // ---------------------------------------------------------------- compact

  private async runCompact(
    request: ActionRequest,
    run: Run,
    deadlineSignal: AbortSignal,
  ): Promise<ActionResult> {
    const { sessionId, agent } = request
    if (agent === undefined) {
      return this.fail(sessionId, run, '找不到活动 Agent，无法压缩。')
    }

    run.phase = 'preparing'
    const interrupted = this.deps.latches.get(sessionId) !== undefined
    this.deps.latches.arm(sessionId)

    run.phase = 'waiting-for-step-boundary'
    const boundary = await waitForBoundary(agent, this.stepWaitMs, deadlineSignal, this.deps.now)
    run.boundary = boundary
    if (run.cancelRequested) return this.cancelled(sessionId, run, '已按请求取消压缩。')
    if (!boundary.reached) {
      return this.fail(
        sessionId,
        run,
        boundary.reason === 'timeout'
          ? '等待 Step 边界超时，已放弃压缩并释放闩锁。'
          : `等待 Step 边界失败：${boundary.error ?? '未知原因'}`,
      )
    }

    run.phase = 'waiting-for-compact'
    const outcome = await this.deps.compact(agent)

    if (run.cancelRequested) return this.cancelled(sessionId, run, '已按请求取消压缩。')

    if (outcome.kind === 'failed') {
      return this.finish(sessionId, {
        ok: false,
        phase: 'failed',
        text: `压缩失败（${outcome.code}）：${outcome.message}。已释放闩锁，原会话可继续。`,
        error: outcome.code,
      })
    }

    if (outcome.kind === 'nothing-to-do') {
      return this.finish(sessionId, {
        ok: true,
        phase: 'completed',
        text: '没有可安全压缩的内容，本次压缩未做改动。',
      })
    }

    // Only wake a session whose turn this action interrupted.
    if (outcome.continuesTask && typeof agent.followup === 'function') {
      try {
        await agent.followup('继续完成刚才的任务。', { source: { kind: 'plugin' } })
      } catch {
        // The compaction succeeded; failing the whole action over the nudge
        // would hide that.
      }
    }

    return this.finish(sessionId, {
      ok: true,
      phase: 'completed',
      text: outcome.continuesTask
        ? '压缩完成，已让会话继续原任务。'
        : '压缩完成（会话原本空闲，未额外发送消息）。',
    })
  }

  // ------------------------------------------------------------- utilities

  private stepWaitMs = 900_000

  private actionDeadlineMs = 1_800_000

  /** Apply the configured bounds. Called once at startup and on every settings change. */
  configure(bounds: { stepWaitMs: number; actionDeadlineMs: number }): void {
    this.stepWaitMs = bounds.stepWaitMs
    this.actionDeadlineMs = bounds.actionDeadlineMs
  }

  /**
   * Whether a session has any human conversation to hand over.
   *
   * A brand-new session with no prompt has nothing to summarize, and creating a
   * second empty session from it would leave two sessions that both say
   * "nothing here". The host adapter answers this from the durable log; when no
   * check is installed the answer is permissive, because refusing a real
   * handoff is worse than allowing an empty one the user explicitly asked for.
   */
  private async hasActivity(sessionId: string): Promise<boolean> {
    if (this.activityCheck === undefined) return true
    try {
      return await this.activityCheck(sessionId)
    } catch {
      return true
    }
  }

  /** Host-supplied blank-session check. */
  activityCheck: ((sessionId: string) => Promise<boolean> | boolean) | undefined

  private cancelled(
    sessionId: string,
    run: Run,
    text: string,
    newSessionId?: string,
  ): ActionResult {
    return this.finish(sessionId, {
      ok: false,
      phase: 'cancelled',
      text,
      ...(newSessionId === undefined ? {} : { newSessionId }),
    })
  }

  private fail(sessionId: string, run: Run, text: string): ActionResult {
    return this.finish(sessionId, { ok: false, phase: 'failed', text, error: text })
  }

  private finish(sessionId: string, result: ActionResult): ActionResult {
    this.lastResults.set(sessionId, result)
    if (!result.ok && result.phase === 'failed') {
      this.lastFailures.set(sessionId, {
        at: (this.deps.now ?? Date.now)(),
        phase: result.phase,
        message: result.text,
      })
      this.failureCounts.set(sessionId, (this.failureCounts.get(sessionId) ?? 0) + 1)
    }
    this.deps.log?.(`handoff: ${sessionId} → ${result.phase}`)
    return result
  }
}

/**
 * A deadline that aborts the in-flight await without touching the session.
 *
 * Expiry only settles the wait: the caller's `finally` releases the latch and
 * the session continues with whatever it was doing. Nothing is cancelled.
 */
function withDeadline(ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref?: () => void }).unref?.()
  }
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  }
}

function describeInherited(items: readonly { item: string; status: string; detail?: string }[]): string {
  const label: Record<string, string> = { inherited: '已继承', fallback: '回退', skipped: '未继承' }
  return items
    .map((item) => `- ${item.item}：${label[item.status] ?? item.status}${item.detail === undefined ? '' : `（${item.detail}）`}`)
    .join('\n')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
