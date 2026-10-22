/**
 * The bridge between the session log and the trigger engine.
 *
 * The engine is pure: given an event position and a measurement, it decides
 * whether an action is due. This module is the noisy half — it receives every
 * committed session event, filters to the ones that can change the surface, and
 * executes the decision.
 *
 * ## Which events matter
 *
 * Only the surface events change how full the context is: a user message, an
 * assistant reply, and a tool result. `turn/end`, `step/start`, and the dozens
 * of bookkeeping events cannot move the ratio, and measuring on them would cost
 * O(surface) per event for nothing.
 *
 * ## Why the state table is keyed by session and pruned
 *
 * The trigger needs per-session bookkeeping (watermark, rearm gates, counters).
 * A long-running host sees many sessions; keeping their rows after disposal
 * would be a slow leak, so `session/disposed` prunes the row.
 */
import type { AgentLike, SessionEventLike, SessionLike } from './contracts.ts'
import { Coordinator, type ActionRequest } from './coordinator.ts'
import { compact, type CompactOutcome } from './compact-handler.ts'
import { LatchRegistry } from './graceful-stop.ts'
import {
  readContextOccupancy,
  readCumulativeUsage,
  type ContextOccupancy,
  type CumulativeUsage,
} from './measure.ts'
import {
  createTriggerState,
  evaluate,
  noteActionFinished,
  noteActionSucceeded,
  type SessionTriggerState,
} from './trigger.ts'
import type { HostServices } from './contracts.ts'
import type { Config } from './settings.ts'
import type { ActionResult, Phase } from './types.ts'
import { triggerUsesCumulative } from './settings.ts'

/** The events whose arrival can change the model-visible surface size. */
export const SURFACE_EVENTS = new Set(['user/message', 'assistant/message', 'tool/result'])

export interface MonitorDeps {
  readonly services: () => HostServices
  readonly config: () => Config
  readonly coordinator: Coordinator
  readonly latches: LatchRegistry
  /** Resolve the live agent for a session id. */
  readonly agentOf: (sessionId: string) => AgentLike | undefined
  /** Resolve the session log object. */
  readonly sessionOf: (sessionId: string) => SessionLike | undefined
  readonly summarize: (agent: AgentLike) => Promise<{ brief: string; redactions: readonly string[] }>
  readonly migrate: (brief: string) => Promise<ActionResult>
  readonly now: () => number
  readonly log: (message: string) => void
  /**
   * Run one action with the source session id in scope.
   *
   * The coordinator's migration callback only receives the brief, so the id has
   * to be carried by the caller. The entry point supplies a scoped runner; a
   * test may supply the coordinator's own `run`.
   */
  readonly runAction: (request: ActionRequest) => Promise<ActionResult>
  /** Called after an automatic action settles, so the caller can re-evaluate. */
  readonly onAutoAction?: (sessionId: string, kind: 'handoff' | 'compact', succeeded: boolean) => void
  readonly sleep?: (ms: number) => Promise<void>
}

/** One session's trigger bookkeeping plus its last measurement. */
interface SessionRow {
  readonly state: SessionTriggerState
  occupancy: ContextOccupancy | undefined
  cumulative: CumulativeUsage | undefined
}

export class Monitor {
  private readonly rows = new Map<string, SessionRow>()

  constructor(private readonly deps: MonitorDeps) {}

  /** Access or create one session's row. */
  private rowFor(sessionId: string): SessionRow {
    let row = this.rows.get(sessionId)
    if (row === undefined) {
      row = { state: createTriggerState(), occupancy: undefined, cumulative: undefined }
      this.rows.set(sessionId, row)
    }
    return row
  }

  /** Forget one session entirely. */
  forget(sessionId: string): void {
    this.rows.delete(sessionId)
    this.deps.coordinator.forget(sessionId)
  }

  /** Drop every row (plugin unload). */
  dispose(): void {
    this.deps.latches.releaseAll('cancel')
    for (const sessionId of [...this.rows.keys()]) this.rows.delete(sessionId)
  }

  /** The last occupancy this monitor measured for a session. */
  occupancyOf(sessionId: string): ContextOccupancy {
    const row = this.rows.get(sessionId)
    if (row?.occupancy !== undefined) return row.occupancy
    const services = this.deps.services()
    const measured = readContextOccupancy(
      this.deps.sessionOf(sessionId),
      services.tokenMeter,
      services.sessionProjections,
    )
    return measured
  }

  /** The last cumulative reading, or a fresh one. */
  cumulativeOf(sessionId: string): CumulativeUsage {
    const row = this.rows.get(sessionId)
    if (row?.cumulative !== undefined) return row.cumulative
    const services = this.deps.services()
    return readCumulativeUsage(this.deps.sessionOf(sessionId), services.sessionProjections, services.tokenMeter)
  }

  /** How many automatic actions this session has consumed. */
  autoActionsOf(sessionId: string): number {
    return this.rows.get(sessionId)?.state.autoActions ?? 0
  }

  /**
   * Record an automatic action as in flight, so the engine stops proposing more.
   *
   * The coordinator has its own in-flight guard, but marking here keeps the
   * trigger's `pending` flag honest and lets `note...` bookkeeping decide when
   * it clears.
   */
  markPending(sessionId: string): void {
    this.rowFor(sessionId).state.pending = true
  }

  /**
   * Clear the in-flight flag without touching counters or rearm gates.
   *
   * Every entry point sets `pending` so the engine stops proposing decisions,
   * but only the AUTOMATIC path used to clear it — `settle()` runs from
   * `execute()` and nowhere else. A manual `/handoff` (or a manual call that
   * bounced off the "already in flight" / "blank session" guards) therefore
   * left `pending` true forever, and `evaluate()` returns early on `pending`
   * (trigger.ts). With `archiveSourceAfterHandoff: false` the old session keeps
   * running, so one manual handoff silently disabled automatic handoff for that
   * session with no visible cause.
   *
   * A manual action deliberately does not run the automatic bookkeeping: it
   * must not consume the per-session cap, and it must not move rearm gates that
   * describe threshold crossings.
   */
  releasePending(sessionId: string): void {
    const row = this.rows.get(sessionId)
    if (row !== undefined) row.state.pending = false
  }

  /** Apply an action's outcome to the trigger's rearm gates and counters. */
  settle(
    sessionId: string,
    kind: 'handoff' | 'compact',
    succeeded: boolean,
    consumedFailure = false,
  ): void {
    const row = this.rowFor(sessionId)
    if (!succeeded) {
      noteActionFinished(row.state, consumedFailure)
      return
    }
    noteActionSucceeded(
      row.state,
      kind,
      row.occupancy ?? this.occupancyOf(sessionId),
      row.cumulative ?? this.cumulativeOf(sessionId),
      this.deps.config(),
    )
  }

  /**
   * Feed one committed event.
   *
   * Returns the decision that was taken, if any, so callers (and tests) can
   * assert on it. The action itself runs detached: a trigger must never block
   * the event dispatch that delivered it.
   */
  onSessionEvent(sessionId: string, event: SessionEventLike): void {
    if (!SURFACE_EVENTS.has(event.type)) return

    const row = this.rowFor(sessionId)
    const config = this.deps.config()
    const services = this.deps.services()

    const decision = evaluate(this.deps.sessionOf(sessionId), event.seq, row.state, {
      config,
      tokenMeter: services.tokenMeter,
      projections: services.sessionProjections,
      now: this.deps.now,
    })

    row.occupancy = row.state.lastOccupancy
    row.cumulative = row.state.lastCumulative

    if (decision === undefined) return

    row.state.pending = true
    this.deps.log(
      `handoff: 自动动作 ${decision.kind}（${decision.reason}）触发 —— ${decision.detail}`,
    )
    // Automatic decisions only ever carry the two threshold reasons; `manual`
    // is the command path and never reaches this machine.
    const reason = decision.reason === 'manual' ? 'context' : decision.reason
    void this.execute(sessionId, decision.kind, reason)
  }

  /** Run one automatic action and reconcile the trigger bookkeeping. */
  private async execute(
    sessionId: string,
    kind: 'handoff' | 'compact',
    reason: 'context' | 'cumulative',
  ): Promise<void> {
    const request: ActionRequest = {
      sessionId,
      agent: this.deps.agentOf(sessionId),
      kind,
      reason,
      automatic: true,
    }
    // `runAction` carries the source session id into the migration callback,
    // the same way the command and HTTP paths do; without it the migration has
    // no session to read its configuration from.
    const result = await this.deps.runAction(request)
    const succeeded = result.phase === 'completed'
    /*
     * A compaction that failed has already exhausted its retries, so it must
     * spend one of the session's automatic actions. Otherwise `pending` clears,
     * the next surface event re-judges the still-full context, and a compaction
     * that can never succeed retries every `evaluateIntervalMs` for the rest of
     * the session's life — never reaching `maxAutoActionsPerSession`.
     *
     * A failed HANDOFF deliberately does not count: it is the case a user
     * retries, and burning the cap on it would strand the session with no
     * automatic escape hatch.
     */
    this.settle(sessionId, kind, succeeded, kind === 'compact' && !succeeded)
    this.deps.onAutoAction?.(sessionId, kind, succeeded)
    // After a compaction the context may still be too full: re-judge at once
    // rather than waiting for the next event, because a compaction that did not
    // buy room is exactly the case where a handoff is due immediately.
    if (kind === 'compact' && succeeded) {
      this.rejudgeAfterCompact(sessionId)
    }
  }

  /**
   * Re-evaluate right after a compaction.
   *
   * The next surface event would do this anyway, but a compaction can take long
   * enough that the pause is visible in the composer. Judging here keeps the
   * decision tied to the moment the room was actually freed.
   */
  private rejudgeAfterCompact(sessionId: string): void {
    const row = this.rows.get(sessionId)
    if (row === undefined) return
    const config = this.deps.config()
    if (!config.autoHandoffEnabled) return

    const services = this.deps.services()
    const occupancy = readContextOccupancy(
      this.deps.sessionOf(sessionId),
      services.tokenMeter,
      services.sessionProjections,
    )
    row.occupancy = occupancy
    const percent = occupancy.percent === undefined ? undefined : occupancy.percent * 100
    if (percent === undefined) return

    if (percent >= config.autoHandoffAtContextPercent && row.state.contextRearmBelow === undefined) {
      row.state.pending = true
      this.deps.log(`handoff: 压缩后占用仍为 ${Math.round(percent)}%，改为交接`)
      void this.execute(sessionId, 'handoff', 'context')
    }
  }

  /** Expose the coordinator's status for commands and the HTTP channel. */
  statusOf(sessionId: string): ReturnType<Coordinator['statusOf']> {
    return this.deps.coordinator.statusOf(sessionId)
  }
}

/**
 * Build the compaction runner for the coordinator.
 *
 * Both inputs come from the caller rather than from this module:
 *
 * - `signal` is the action's hard deadline. It used to be a controller created
 *   once here and never aborted, so a hung compaction outlived
 *   `actionDeadlineMs` and kept the latch armed.
 * - `interruptedRunningTurn` must be decided BEFORE the coordinator arms the
 *   latch. Asking `latches.isLatched()` here — as this function used to —
 *   always answered `true`, because the only latch present was the one the
 *   compaction had just set. Every automatic compaction therefore woke an idle
 *   session with "continue", the loop `compact-handler.ts` warns about.
 *
 * The latch registry is deliberately not a dependency any more: nothing in this
 * module may read the latch to answer a question the coordinator owns.
 */
export function compactRunner(deps: {
  services: () => HostServices
  waitIdle: (agent: AgentLike) => Promise<void>
  sleep?: (ms: number) => Promise<void>
}): (
  agent: AgentLike,
  options: { signal?: AbortSignal; interruptedRunningTurn: boolean },
) => Promise<CompactOutcome> {
  return (agent, options) =>
    compact(agent, {
      compaction: deps.services().compaction,
      waitIdle: deps.waitIdle,
      // A missing deadline is not a reason to refuse: use a signal that is
      // never aborted, which is exactly the old behaviour for callers that do
      // not supply one.
      signal: options.signal ?? new AbortController().signal,
      interruptedRunningTurn: options.interruptedRunningTurn,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    })
}

/** Re-exported so the entry point can build the coordinator without importing three modules. */
export { Coordinator }
export type { Phase }
void triggerUsesCumulative
