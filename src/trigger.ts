/**
 * The trigger engine: when an automatic action is allowed to fire.
 *
 * This module is deliberately pure. It owns no timers, subscribes to nothing,
 * and never touches a service beyond the measurement functions passed in. The
 * caller (`monitor.ts`) feeds it session events and executes the decisions it
 * returns. That split is what makes the loop-prevention rules unit-testable
 * without a running harness.
 *
 * ## Why each guard exists
 *
 * - **Watermark.** `session/event` fires per committed event; without a
 *   watermark the same log position is judged repeatedly and one threshold
 *   crossing becomes N handoffs.
 * - **Debounce.** `tokenMeter.measure()` is O(surface). Judging every event of
 *   a long turn would make the plugin a measurable tax on the session.
 * - **Rearm.** A successful compaction drops occupancy, but a handoff might not
 *   happen immediately; without an accumulator-style guard the same argument
 *   (`cumulative >= threshold`) stays true forever and fires on every event.
 * - **Hysteresis.** A compaction that buys ten points must not immediately
 *   re-trigger at the same threshold. Requiring occupancy to drop below
 *   `threshold - delta` before re-arming separates "still full" from "full
 *   again".
 * - **Baseline on first sight.** A plugin loaded into a session that is already
 *   at 90% must not yank it out from under the user. The first observation
 *   only records numbers.
 * - **Per-session cap.** The only remaining backstop if all the above disagree.
 *
 * ## Priority
 *
 * Handoff beats compaction. Compaction is a stay of execution; a handoff is the
 * end state. Checking compaction first would produce the worst sequence: fill,
 * compact, refill, compact again, never finish the task.
 */
import {
  readContextOccupancy,
  readCumulativeUsage,
  type ContextOccupancy,
  type CumulativeUsage,
} from './measure.ts'
import type {
  SessionLike,
  SessionProjectionsLike,
  TokenMeterLike,
} from './contracts.ts'
import { triggerUsesContext, triggerUsesCumulative, type Config } from './settings.ts'
import type { ActionKind, ActionReason } from './types.ts'

/** What the engine wants the coordinator to do, or `undefined` for nothing. */
export interface Decision {
  readonly kind: ActionKind
  readonly reason: ActionReason
  readonly occupancy: ContextOccupancy
  readonly cumulative: CumulativeUsage
  /** Human-readable justification, shown in status and logs. */
  readonly detail: string
}

/** Per-session bookkeeping the engine needs between events. */
export interface SessionTriggerState {
  /** Highest log position already judged. */
  lastEvaluatedSeq: number
  /** Wall-clock of the last measurement, for the debounce. */
  lastEvaluatedAt: number
  /** Automatic actions taken so far (handoff and compaction shared). */
  autoActions: number
  /** True once the first observation has been recorded. */
  baselineEstablished: boolean
  /** Set while an action is executing; blocks new decisions. */
  pending: boolean
  /** Occupancy that re-arms the context trigger; `undefined` means armed. */
  contextRearmBelow: number | undefined
  /** Cumulative spend that re-arms the cumulative trigger; `undefined` means armed. */
  cumulativeRearmAt: number | undefined
  /** Occupancy that re-arms the compaction trigger. */
  compactRearmBelow: number | undefined
  /** Last measurement, retained so status can answer without re-measuring. */
  lastOccupancy: ContextOccupancy | undefined
  lastCumulative: CumulativeUsage | undefined
}

export function createTriggerState(): SessionTriggerState {
  return {
    lastEvaluatedSeq: -1,
    lastEvaluatedAt: 0,
    autoActions: 0,
    baselineEstablished: false,
    pending: false,
    contextRearmBelow: undefined,
    cumulativeRearmAt: undefined,
    compactRearmBelow: undefined,
    lastOccupancy: undefined,
    lastCumulative: undefined,
  }
}

/** Inputs the engine cannot obtain by itself. */
export interface EvaluateDeps {
  readonly config: Config
  readonly tokenMeter: TokenMeterLike | undefined
  readonly projections: SessionProjectionsLike | undefined
  /** Injectable clock, so tests do not sleep. */
  readonly now: () => number
}

/**
 * Judge one event for one session.
 *
 * Returns `undefined` when the event must not cause an action: not a surface
 * event, debounced, already judged, already pending, capped, or below every
 * threshold.
 */
export function evaluate(
  session: SessionLike | undefined,
  seq: number,
  state: SessionTriggerState,
  deps: EvaluateDeps,
): Decision | undefined {
  const { config } = deps

  if (!config.autoHandoffEnabled && !config.autoCompactEnabled) return undefined
  if (session === undefined) return undefined
  if (state.pending) return undefined
  if (seq <= state.lastEvaluatedSeq) return undefined

  const now = deps.now()
  if (now - state.lastEvaluatedAt < config.evaluateIntervalMs) return undefined

  // Past the cheap guards: pay for the measurement.
  const occupancy = readContextOccupancy(session, deps.tokenMeter, deps.projections)
  const cumulative = readCumulativeUsage(session, deps.projections, deps.tokenMeter)

  state.lastEvaluatedSeq = seq
  state.lastEvaluatedAt = now
  state.lastOccupancy = occupancy
  state.lastCumulative = cumulative

  // First sight only records numbers. A session already past a threshold when
  // the plugin loads keeps running: the user may be mid-task.
  if (!state.baselineEstablished) {
    state.baselineEstablished = true
    return undefined
  }

  if (state.autoActions >= config.maxAutoActionsPerSession) return undefined

  const percent = occupancy.percent === undefined ? undefined : occupancy.percent * 100

  // 1) Context-occupancy handoff.
  if (
    config.autoHandoffEnabled &&
    triggerUsesContext(config.autoHandoffTrigger) &&
    percent !== undefined
  ) {
    if (state.contextRearmBelow !== undefined && percent < state.contextRearmBelow) {
      state.contextRearmBelow = undefined
    }
    if (
      state.contextRearmBelow === undefined &&
      percent >= config.autoHandoffAtContextPercent
    ) {
      return {
        kind: 'handoff',
        reason: 'context',
        occupancy,
        cumulative,
        detail: `上下文占用 ${Math.round(percent)}%（${occupancy.used} / ${occupancy.window}）达到交接阈值 ${config.autoHandoffAtContextPercent}%`,
      }
    }
  }

  // 2) Cumulative-spend handoff.
  if (config.autoHandoffEnabled && triggerUsesCumulative(config.autoHandoffTrigger)) {
    if (
      state.cumulativeRearmAt !== undefined &&
      cumulative.tokens >= state.cumulativeRearmAt
    ) {
      state.cumulativeRearmAt = undefined
    }
    if (
      state.cumulativeRearmAt === undefined &&
      cumulative.tokens >= config.autoHandoffThreshold
    ) {
      return {
        kind: 'handoff',
        reason: 'cumulative',
        occupancy,
        cumulative,
        detail: `累计消费 ${cumulative.tokens} tokens 达到交接阈值 ${config.autoHandoffThreshold}`,
      }
    }
  }

  // 3) Compaction, only when the context trigger cannot fire.
  if (config.autoCompactEnabled && percent !== undefined) {
    if (state.compactRearmBelow !== undefined && percent < state.compactRearmBelow) {
      state.compactRearmBelow = undefined
    }
    if (
      state.compactRearmBelow === undefined &&
      percent >= config.autoCompactAtContextPercent
    ) {
      return {
        kind: 'compact',
        reason: 'context',
        occupancy,
        cumulative,
        detail: `上下文占用 ${Math.round(percent)}% 达到压缩阈值 ${config.autoCompactAtContextPercent}%`,
      }
    }
  }

  return undefined
}

/**
 * Record that an automatic action finished, and set the next rearm gate.
 *
 * Called for successes only. A failed action leaves the gates untouched so the
 * next window can retry, while the per-session cap still bounds it.
 */
export function noteActionSucceeded(
  state: SessionTriggerState,
  kind: ActionKind,
  occupancy: ContextOccupancy,
  cumulative: CumulativeUsage,
  config: Config,
): void {
  state.autoActions += 1
  state.pending = false

  if (kind === 'handoff') {
    // A handoff retires the session; both handoff gates re-arm far out of reach.
    state.contextRearmBelow =
      config.autoHandoffAtContextPercent - config.contextRearmDeltaPercent
    state.cumulativeRearmAt = cumulative.tokens + config.rearmDeltaTokens
    return
  }

  // Compaction lowers occupancy; require a real drop before it may fire again.
  state.compactRearmBelow =
    config.autoCompactAtContextPercent - config.contextRearmDeltaPercent
  if (occupancy.percent !== undefined) {
    state.lastOccupancy = occupancy
  }
}

/**
 * Record that an action failed or was cancelled.
 *
 * `consumed` says whether the attempt counts against the per-session cap: a
 * compaction that exhausted its retries does, so a broken compaction cannot
 * spin forever, but the rearm gates stay open for a later window.
 */
export function noteActionFinished(state: SessionTriggerState, consumed: boolean): void {
  state.pending = false
  if (consumed) state.autoActions += 1
}

/**
 * Decide whether a compaction should be followed by "continue".
 *
 * Only when this compaction interrupted a running turn. Injecting "continue"
 * into an idle session would start a turn nobody asked for, and that turn is
 * what turns `compact → handoff → compact` into an infinite loop.
 */
export function shouldContinueAfterCompact(interruptedARunningTurn: boolean): boolean {
  return interruptedARunningTurn
}
