/**
 * The two measurements this plugin acts on.
 *
 * An earlier design keyed only on cumulative spend, which answers "how much has
 * this cost". Users actually watch the other number: "how full is the context
 * right now". They are different quantities, and a session can be cheap but
 * nearly full (a long tool-output-heavy turn) or expensive but half empty
 * (frequent compaction). Both are measured here, and the trigger decides which
 * one the user asked for.
 *
 * Neither function throws: measurement happens on the event hot path, and a
 * service that misbehaves must degrade the trigger, not the session.
 */
import { sessionEvents, type SessionEventLike, type SessionLike } from './contracts.ts'
import type {
  SessionProjectionsLike,
  TokenMeterLike,
} from './contracts.ts'
import type { MeasureQuality } from './types.ts'

/** Context occupancy: the share of the model window the current surface occupies. */
export interface ContextOccupancy {
  readonly quality: MeasureQuality
  /** Tokens currently visible to the model. Zero when measurement failed. */
  readonly used: number
  /** The routed model's window, when it reports one. */
  readonly window: number | undefined
  /** `used / window`, or `undefined` when the window is unknown. */
  readonly percent: number | undefined
  /** Where `used` came from: real provider usage, a heuristic, or nothing. */
  readonly baseline: 'usage' | 'estimated' | 'none'
  /**
   * Which accessor produced `used`.
   *
   * `contextPressure` is the projection the composer's own meter reads, so this
   * is what makes the plugin's number agree with the number the user sees.
   * `meter-surface` is the older heuristic replay, kept as the fallback for a
   * deployment that folds no projection. Optional so a caller that only cares
   * about the numbers (tests, older fixtures) need not fill it in.
   */
  readonly source?: 'contextPressure' | 'meter-surface' | 'none'
  /** Populated only when measurement failed. */
  readonly error?: string
}

/** Cumulative spend: total tokens billed across the whole session. */
export interface CumulativeUsage {
  readonly quality: MeasureQuality
  readonly tokens: number
  readonly source: 'projection' | 'meter' | 'none'
  readonly error?: string
}

const EMPTY_CONTEXT: ContextOccupancy = {
  quality: 'unavailable',
  used: 0,
  window: undefined,
  percent: undefined,
  baseline: 'none',
  source: 'none',
}

/**
 * Read the `contextPressure` projection the composer's meter also reads.
 *
 * Returns `undefined` when the unit is not registered on this deployment, which
 * is not an error: the meter replay below is the documented fallback.
 *
 * ## Why `projectedTokens` is computed here, not read
 *
 * `sessionProjections.stateOf()` returns the unit's RAW state, not its wire
 * view: `dsh-session-projection/lib/index.js` `stateOf() { …; return
 * this.cellFor(registration, session).state }`, while the client-visible value
 * is produced by a separate `viewCell()` → `wire.view(state)` path. The raw
 * `contextPressure` state schema is `.strict()` and carries only
 * `contextWindow`, `pressureTokens`, `surfaceTokens`, `sampledSurfaceTokens`,
 * and `claim` — **there is no `projectedTokens` field in it at all**.
 *
 * An earlier version of this function read `state.projectedTokens`, which is
 * therefore always `undefined` on a real host: the projected reading never
 * applied and every occupancy was reported as `exact` from a stale sample.
 * Its unit test passed because the test helper handed back a hand-built state
 * containing that field — a shape the host never produces.
 *
 * So the derive happens here, using the host's own wire-view formula
 * (`dsh-token-meter/lib/index.js`, `contextPressureProjectionDefinition.wire`):
 *
 *     projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)
 *
 * Matching the formula rather than calling `snapshot()` keeps this plugin off an
 * API the host does not declare for plugins, and keeps the two numbers equal by
 * construction instead of by coincidence.
 */
function readPressureProjection(
  session: SessionLike,
  projections: SessionProjectionsLike | undefined,
): { used: number; baseline: 'usage' | 'estimated'; window?: number } | undefined {
  if (projections === undefined) return undefined
  let state: unknown
  try {
    state = projections.stateOf(session, 'contextPressure')
  } catch {
    return undefined
  }
  if (state === null || typeof state !== 'object') return undefined
  const record = state as {
    pressureTokens?: unknown
    surfaceTokens?: unknown
    sampledSurfaceTokens?: unknown
    contextWindow?: unknown
  }

  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined

  const pressure = num(record.pressureTokens)
  const surface = num(record.surfaceTokens)
  const sampled = num(record.sampledSurfaceTokens)

  /*
   * Same precedence as the UI: a reading that can be projected forward wins,
   * because it answers "how full will the NEXT request be" — which is the
   * question a handoff threshold is actually asking. All three inputs are
   * required: with any of them missing the sample cannot be moved forward, and
   * silently treating the gap as zero would under-report occupancy.
   */
  const projected =
    pressure !== undefined && surface !== undefined && sampled !== undefined
      ? Math.max(0, pressure + surface - sampled)
      : undefined

  const used = projected ?? pressure
  if (used === undefined || !Number.isFinite(used) || used <= 0) return undefined

  const window = num(record.contextWindow)
  return {
    used,
    /*
     * `pressureTokens` is a provider-reported prompt size, so the reading rests
     * on real usage. Adding the surface delta since that sample makes it an
     * estimate — the same demotion the UI makes.
     */
    baseline: projected === undefined ? 'usage' : 'estimated',
    ...(window === undefined ? {} : { window }),
  }
}

/**
 * Read context occupancy for one session.
 *
 * ## Why the projection comes first
 *
 * The composer's meter (`dsh-client-ui-conversation`) reads the
 * `contextPressure` projection and computes `projected ?? pressureTokens` over
 * `contextWindow`. This plugin used to price the surface by itself
 * (`tokenMeter.measure().surfaceTokens`, a ~4-chars-per-token replay), so the
 * two disagreed on the SAME session: 27% in the composer versus 32% in
 * `/handoff status`, a gap that moves with how much Chinese and code the
 * conversation holds.
 *
 * Two numbers describing one session is a defect regardless of which is more
 * accurate: the user cannot tell whether a handoff is imminent. Reading the same
 * projection the UI reads makes the plugin agree by construction, and keeps the
 * provider-reported usage instead of discarding it for a guess.
 *
 * `contextWindow` still comes from the session's request context when the
 * projection does not carry one, so switching to a model with a smaller window
 * changes the denominator immediately.
 */
export function readContextOccupancy(
  session: SessionLike | undefined,
  tokenMeter: TokenMeterLike | undefined,
  projections?: SessionProjectionsLike,
): ContextOccupancy {
  if (session === undefined) return EMPTY_CONTEXT

  const fromProjection = readPressureProjection(session, projections)

  let measured: { surfaceTokens?: number; baseline?: { kind?: string } } | undefined
  if (fromProjection === undefined && tokenMeter !== undefined) {
    try {
      measured = tokenMeter.measure(session)
    } catch (error) {
      return {
        ...EMPTY_CONTEXT,
        quality: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  } else if (fromProjection === undefined) {
    // No projection and no meter: nothing can be measured on this deployment.
    return EMPTY_CONTEXT
  }

  const used =
    fromProjection !== undefined
      ? fromProjection.used
      : typeof measured?.surfaceTokens === 'number'
        ? measured.surfaceTokens
        : 0

  const baselineKind = fromProjection !== undefined ? fromProjection.baseline : (measured?.baseline?.kind ?? 'none')
  const baseline: ContextOccupancy['baseline'] =
    baselineKind === 'usage' || baselineKind === 'estimated' || baselineKind === 'none'
      ? baselineKind
      : 'none'

  let window: number | undefined = fromProjection?.window
  if (window === undefined) {
    try {
      window = session.requestContext?.()?.contextWindow
    } catch {
      window = undefined
    }
  }

  /*
   * Fall back to the durable log.
   *
   * `requestContext()` reports the CURRENT request envelope, which is absent for
   * an idle session or one restored without resuming. The model and its window
   * are still recorded in the `request/context` event that established them, so
   * without this fallback an idle session reports "model did not report a
   * context window" while the composer's own meter is happily showing a
   * percentage — two numbers disagreeing about the same session.
   */
  if (window === undefined) {
    window = windowFromEvents(sessionEvents(session))
  }

  // A window of zero or a negative value is a broken report, not a full context.
  const usableWindow =
    typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : undefined

  if (used <= 0) {
    return {
      ...EMPTY_CONTEXT,
      quality: 'unavailable',
      window: usableWindow,
      baseline,
      source: fromProjection === undefined ? 'meter-surface' : 'contextPressure',
    }
  }

  return {
    quality: baseline === 'usage' ? 'exact' : 'estimated',
    used,
    window: usableWindow,
    percent: usableWindow === undefined ? undefined : used / usableWindow,
    baseline,
    source: fromProjection === undefined ? 'meter-surface' : 'contextPressure',
  }
}

/**
 * Read cumulative spend.
 *
 * Prefers the `tokenUsage` projection because it folds the durable log, so the
 * number is reconstructable after a restart. Falls back to the meter's total,
 * which re-prices the surface heuristically. A failed projection read is
 * *not* fatal: the meter still answers.
 */
export function readCumulativeUsage(
  session: SessionLike | undefined,
  projections: SessionProjectionsLike | undefined,
  tokenMeter: TokenMeterLike | undefined,
): CumulativeUsage {
  if (session === undefined) {
    return { quality: 'unavailable', tokens: 0, source: 'none' }
  }

  if (projections !== undefined) {
    try {
      const state = projections.stateOf(session, 'tokenUsage') as
        | {
            totals?: {
              uncachedInputTokens?: number
              outputTokens?: number
              readTokens?: number
              writeTokens?: number
              cacheReadTokens?: number
              cacheWriteTokens?: number
            }
          }
        | undefined

      const totals = state?.totals
      if (totals !== undefined) {
        const sum =
          (totals.uncachedInputTokens ?? 0) +
          (totals.outputTokens ?? 0) +
          (totals.cacheReadTokens ?? totals.readTokens ?? 0) +
          (totals.cacheWriteTokens ?? totals.writeTokens ?? 0)
        if (sum > 0) {
          return { quality: 'exact', tokens: sum, source: 'projection' }
        }
      }
    } catch {
      // Projection key not registered on this deployment, or it threw while
      // folding. Either way the meter below is the documented fallback.
    }
  }

  if (tokenMeter !== undefined) {
    try {
      const measured = tokenMeter.measure(session)
      if (measured.totalTokens > 0) {
        return { quality: 'estimated', tokens: measured.totalTokens, source: 'meter' }
      }
    } catch (error) {
      return {
        quality: 'unavailable',
        tokens: 0,
        source: 'none',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { quality: 'unavailable', tokens: 0, source: 'none' }
}

/**
 * Fold cumulative spend straight from the log, with no services at all.
 *
 * Used by the handoff brief, which must still describe the session when the
 * projection and meter are both absent. Summing `assistant/message.usage` over
 * the log is exactly what the projection does, only slower and recomputed.
 */
export function foldUsageFromEvents(events: readonly SessionEventLike[] | undefined): number {
  if (events === undefined) return 0
  let total = 0
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.['usage'] as
      | {
          inputTokens?: number
          outputTokens?: number
          cacheReadTokens?: number
          cacheWriteTokens?: number
        }
      | undefined
    if (usage === undefined) continue
    total +=
      (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0)
  }
  return total
}

/** Render an occupancy ratio as whole percent, or `undefined` when unknown. */
export function percentOf(occupancy: ContextOccupancy): number | undefined {
  if (occupancy.percent === undefined) return undefined
  return Math.round(occupancy.percent * 100)
}

/**
 * The last context window the log recorded for this session.
 *
 * Scans backwards because the newest `request/context` wins: switching models
 * changes both the provider and the window, and an older event describes a model
 * the session is no longer on.
 */
export function windowFromEvents(
  events: readonly SessionEventLike[] | undefined,
): number | undefined {
  if (events === undefined) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'request/context') continue
    const value = event.data?.['contextWindow']
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}
