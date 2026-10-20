import { beforeEach, describe, expect, it } from 'vitest'
import {
  createTriggerState,
  evaluate,
  noteActionFinished,
  noteActionSucceeded,
  shouldContinueAfterCompact,
  type EvaluateDeps,
  type SessionTriggerState,
} from '@src/trigger.ts'
import type { SessionLike, TokenMeterLike } from '@src/contracts.ts'
import type { Config } from '@src/settings.ts'

/** Build a config from defaults plus overrides, bypassing schemastery. */
function cfg(overrides: Partial<Config> = {}): Config {
  return {
    autoHandoffEnabled: false,
    autoHandoffTrigger: 'context',
    autoHandoffAtContextPercent: 85,
    autoHandoffThreshold: 2_000_000,
    autoCompactEnabled: false,
    autoCompactAtContextPercent: 70,
    evaluateIntervalMs: 5000,
    contextRearmDeltaPercent: 10,
    rearmDeltaTokens: 200_000,
    maxAutoActionsPerSession: 3,
    summaryMaxTokens: 4096,
    stepWaitTimeoutMs: 900_000,
    actionDeadlineMs: 1_800_000,
    openNewSessionOnHandoff: true,
    archiveSourceAfterHandoff: true,
    ...overrides,
  }
}

/** A session whose routed model declares `window` tokens. */
function sessionWithWindow(window: number | undefined): SessionLike {
  return {
    id: 's1',
    requestContext: () => (window === undefined ? {} : { contextWindow: window }),
  }
}

/** The layout under test: 200k window, and a meter reporting `surface`. */
const WINDOW = 200_000

/**
 * A clock far from zero.
 *
 * `SessionTriggerState.lastEvaluatedAt` starts at `0`; a test clock near zero
 * would be swallowed by the debounce on its first evaluation.
 */
const T0 = 1_000_000

/** Build the engine's inputs for one measurement. */
function deps(
  config: Config,
  meter: TokenMeterLike,
  clock: { at: number },
): EvaluateDeps {
  return { config, tokenMeter: meter, projections: undefined, now: () => clock.at }
}

/** A meter that reports the same surface every time. */
function meterAt(surface: number, total = 0): TokenMeterLike {
  return { measure: () => ({ surfaceTokens: surface, totalTokens: total }) }
}

/** Advance the clock past the debounce window. */
function advance(clock: { at: number }): void {
  clock.at += 10_000
}

let clock: { at: number }

beforeEach(() => {
  clock = { at: T0 }
})

/**
 * A state that has already recorded its baseline, as a running session would.
 *
 * `lastEvaluatedAt` is left at its initial value so the first call in a test is
 * eligible: the established-baseline guard is about *having seen the session
 * once*, not about being inside a debounce window.
 */
function established(): SessionTriggerState {
  const state = createTriggerState()
  state.baselineEstablished = true
  return state
}

describe('evaluate — guards', () => {
  it('does nothing while both automatic switches are off', () => {
    const decision = evaluate(
      sessionWithWindow(WINDOW),
      1,
      createTriggerState(),
      deps(cfg(), meterAt(170_000), clock),
    )
    expect(decision).toBeUndefined()
  })

  it('records a baseline on first sight instead of yanking an already-full session', () => {
    const state = createTriggerState()
    const config = cfg({ autoHandoffEnabled: true })
    const session = sessionWithWindow(WINDOW)

    expect(evaluate(session, 1, state, deps(config, meterAt(190_000), clock))).toBeUndefined()
    expect(state.baselineEstablished).toBe(true)
    expect(state.lastOccupancy?.percent).toBeCloseTo(0.95)

    // The next event, past the debounce, is allowed to fire.
    advance(clock)
    const decision = evaluate(session, 2, state, deps(config, meterAt(190_000), clock))
    expect(decision?.kind).toBe('handoff')
    expect(decision?.reason).toBe('context')
  })

  it('debounces repeated measurements of the same session', () => {
    const state = established()
    // A measurement just happened at T0; the next one is 1s later.
    state.lastEvaluatedAt = T0
    const config = cfg({ autoHandoffEnabled: true })
    const session = sessionWithWindow(WINDOW)

    clock.at += 1000 // under the 5s debounce
    expect(evaluate(session, 2, state, deps(config, meterAt(190_000), clock))).toBeUndefined()
  })

  it('human input in the water-marked position is judged once, not per event', () => {
    const state = established()
    const config = cfg({ autoHandoffEnabled: true })
    const session = sessionWithWindow(WINDOW)

    // Position 5 is judged (and fires), so 5 is never judged again.
    const first = evaluate(session, 5, state, deps(config, meterAt(190_000), clock))
    expect(first?.kind).toBe('handoff')
    advance(clock)
    expect(evaluate(session, 5, state, deps(config, meterAt(190_000), clock))).toBeUndefined()
    expect(evaluate(session, 4, state, deps(config, meterAt(190_000), clock))).toBeUndefined()
  })

  it('refuses new decisions while an action is pending', () => {
    const state = established()
    state.pending = true
    expect(
      evaluate(sessionWithWindow(WINDOW), 2, state, deps(cfg({ autoHandoffEnabled: true }), meterAt(190_000), clock)),
    ).toBeUndefined()
  })

  it('stops after the per-session action cap', () => {
    const state = established()
    state.autoActions = 3
    expect(
      evaluate(sessionWithWindow(WINDOW), 2, state, deps(cfg({ autoHandoffEnabled: true }), meterAt(190_000), clock)),
    ).toBeUndefined()
  })
})

describe('evaluate — priority', () => {
  it('prefers a handoff over a compaction when both thresholds are crossed', () => {
    const state = established()
    const config = cfg({ autoHandoffEnabled: true, autoCompactEnabled: true })
    const decision = evaluate(sessionWithWindow(WINDOW), 2, state, deps(config, meterAt(180_000), clock))
    expect(decision?.kind).toBe('handoff')
  })

  it('only compacts when the handoff trigger is off', () => {
    const state = established()
    const config = cfg({ autoCompactEnabled: true })
    const decision = evaluate(sessionWithWindow(WINDOW), 2, state, deps(config, meterAt(150_000), clock))
    expect(decision?.kind).toBe('compact')
  })

  it('does not compact below the compaction threshold', () => {
    const state = established()
    expect(
      evaluate(
        sessionWithWindow(WINDOW),
        2,
        state,
        deps(cfg({ autoCompactEnabled: true }), meterAt(100_000), clock),
      ),
    ).toBeUndefined()
  })
})

describe('evaluate — cumulative trigger', () => {
  it('fires on spend only when the mode includes it', () => {
    const state = established()
    const contextOnly = cfg({ autoHandoffEnabled: true, autoHandoffTrigger: 'context' })
    expect(
      evaluate(sessionWithWindow(WINDOW), 2, state, deps(contextOnly, meterAt(10, 3_000_000), clock)),
    ).toBeUndefined()

    advance(clock)
    const cumulative = cfg({ autoHandoffEnabled: true, autoHandoffTrigger: 'cumulative' })
    const decision = evaluate(
      sessionWithWindow(WINDOW),
      3,
      state,
      deps(cumulative, meterAt(10, 3_000_000), clock),
    )
    expect(decision?.reason).toBe('cumulative')
  })

  it('still fires on spend when the model declares no window', () => {
    const state = established()
    const config = cfg({ autoHandoffEnabled: true, autoHandoffTrigger: 'either' })
    const decision = evaluate(
      sessionWithWindow(undefined),
      2,
      state,
      deps(config, meterAt(10, 9_000_000), clock),
    )
    expect(decision?.reason).toBe('cumulative')
  })

  it('never fires the context trigger without a window', () => {
    const state = established()
    const config = cfg({ autoHandoffEnabled: true, autoHandoffTrigger: 'context' })
    expect(
      evaluate(sessionWithWindow(undefined), 2, state, deps(config, meterAt(10, 9_000_000), clock)),
    ).toBeUndefined()
  })
})

describe('evaluate — rearm and hysteresis', () => {
  it('re-arms the context trigger only after occupancy drops below threshold minus delta', () => {
    const state = established()
    const config = cfg({ autoHandoffEnabled: true })
    const session = sessionWithWindow(WINDOW)

    const first = evaluate(session, 2, state, deps(config, meterAt(190_000), clock))
    expect(first?.kind).toBe('handoff')
    noteActionSucceeded(state, 'handoff', first!.occupancy, first!.cumulative, config)

    // Still above the rearm band (85 - 10 = 75%): stays disarmed.
    advance(clock)
    expect(evaluate(session, 3, state, deps(config, meterAt(190_000), clock))).toBeUndefined()

    // A compaction drops it to 70%, below the band: re-arms.
    advance(clock)
    expect(evaluate(session, 4, state, deps(config, meterAt(140_000), clock))).toBeUndefined()
    expect(state.contextRearmBelow).toBeUndefined()

    // Rising back over the threshold now fires again, up to the cap.
    advance(clock)
    const second = evaluate(session, 5, state, deps(config, meterAt(190_000), clock))
    expect(second?.kind).toBe('handoff')
  })

  it('re-arms the cumulative trigger only after the configured delta accrues', () => {
    const state = established()
    const config = cfg({ autoHandoffEnabled: true, autoHandoffTrigger: 'cumulative' })
    const session = sessionWithWindow(WINDOW)

    const first = evaluate(session, 2, state, deps(config, meterAt(10, 2_100_000), clock))
    expect(first?.kind).toBe('handoff')
    noteActionSucceeded(state, 'handoff', first!.occupancy, first!.cumulative, config)
    expect(state.cumulativeRearmAt).toBe(2_300_000)

    advance(clock)
    expect(evaluate(session, 3, state, deps(config, meterAt(10, 2_200_000), clock))).toBeUndefined()

    advance(clock)
    const second = evaluate(session, 4, state, deps(config, meterAt(10, 2_400_000), clock))
    expect(second?.reason).toBe('cumulative')
  })

  it('leaves the rearm gates open after a failure so a later window can retry', () => {
    const state = established()
    state.lastEvaluatedSeq = 1
    noteActionFinished(state, false)

    expect(state.autoActions).toBe(0)
    expect(state.contextRearmBelow).toBeUndefined()

    const decision = evaluate(
      sessionWithWindow(WINDOW),
      2,
      state,
      deps(cfg({ autoHandoffEnabled: true }), meterAt(190_000), clock),
    )
    expect(decision?.kind).toBe('handoff')
  })

  it('counts a consumed failure against the cap', () => {
    const state = createTriggerState()
    noteActionFinished(state, true)
    expect(state.autoActions).toBe(1)
    expect(state.pending).toBe(false)
  })

  it('sets the compaction rearm band below the compaction threshold', () => {
    const state = createTriggerState()
    const config = cfg({ autoCompactEnabled: true })
    const occupancy = {
      quality: 'exact' as const,
      used: 150_000,
      window: WINDOW,
      percent: 0.75,
      baseline: 'usage' as const,
    }
    noteActionSucceeded(
      state,
      'compact',
      occupancy,
      { quality: 'exact', tokens: 0, source: 'none' },
      config,
    )
    expect(state.compactRearmBelow).toBe(60)
    expect(state.autoActions).toBe(1)
  })
})

describe('shouldContinueAfterCompact', () => {
  it('only asks an interrupted session to continue', () => {
    expect(shouldContinueAfterCompact(true)).toBe(true)
    expect(shouldContinueAfterCompact(false)).toBe(false)
  })
})
