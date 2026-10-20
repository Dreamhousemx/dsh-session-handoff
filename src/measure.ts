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
import type {
  SessionEventLike,
  SessionLike,
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
}

/**
 * Read context occupancy for one session.
 *
 * `surfaceTokens` is the size of the model-visible surface. `contextWindow`
 * comes from the session's current request context, so switching to a model
 * with a smaller window changes the denominator immediately — which is the
 * behaviour a user expects: the new model really is closer to full.
 */
export function readContextOccupancy(
  session: SessionLike | undefined,
  tokenMeter: TokenMeterLike | undefined,
): ContextOccupancy {
  if (session === undefined || tokenMeter === undefined) return EMPTY_CONTEXT

  let measured: { surfaceTokens?: number; baseline?: { kind?: string } }
  try {
    measured = tokenMeter.measure(session)
  } catch (error) {
    return {
      ...EMPTY_CONTEXT,
      quality: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const used = typeof measured.surfaceTokens === 'number' ? measured.surfaceTokens : 0
  const baselineKind = measured.baseline?.kind ?? 'none'
  const baseline: ContextOccupancy['baseline'] =
    baselineKind === 'usage' || baselineKind === 'estimated' || baselineKind === 'none'
      ? baselineKind
      : 'none'

  let window: number | undefined
  try {
    window = session.requestContext?.()?.contextWindow
  } catch {
    window = undefined
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
    }
  }

  return {
    quality: baseline === 'usage' ? 'exact' : 'estimated',
    used,
    window: usableWindow,
    percent: usableWindow === undefined ? undefined : used / usableWindow,
    baseline,
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
