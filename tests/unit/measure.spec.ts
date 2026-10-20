import { describe, expect, it } from 'vitest'
import {
  foldUsageFromEvents,
  percentOf,
  readContextOccupancy,
  readCumulativeUsage,
  windowFromEvents,
} from '@src/measure.ts'
import { sessionEvents, type SessionEventLike, type SessionLike, type TokenMeterLike } from '@src/contracts.ts'

function session(overrides: Partial<SessionLike> = {}): SessionLike {
  return { id: 's1', ...overrides }
}

function meter(measured: unknown): TokenMeterLike {
  return { measure: () => measured as never }
}

describe('readContextOccupancy', () => {
  it('divides surface tokens by the routed window', () => {
    const s = session({ requestContext: () => ({ contextWindow: 200_000 }) })
    const result = readContextOccupancy(s, meter({ surfaceTokens: 170_000, totalTokens: 9 }))
    expect(result.used).toBe(170_000)
    expect(result.window).toBe(200_000)
    expect(result.percent).toBeCloseTo(0.85)
    expect(percentOf(result)).toBe(85)
  })

  it('labels usage-anchored numbers exact and unanchored ones estimated', () => {
    const s = session({ requestContext: () => ({ contextWindow: 1000 }) })
    expect(
      readContextOccupancy(s, meter({ surfaceTokens: 10, baseline: { kind: 'usage' } })).quality,
    ).toBe('exact')
    expect(
      readContextOccupancy(s, meter({ surfaceTokens: 10, baseline: { kind: 'estimated' } }))
        .quality,
    ).toBe('estimated')
    expect(
      readContextOccupancy(s, meter({ surfaceTokens: 10, baseline: { kind: 'none' } })).quality,
    ).toBe('estimated')
  })

  it('reports an unavailable ratio when the model declares no window', () => {
    const s = session({ requestContext: () => ({}) })
    const result = readContextOccupancy(s, meter({ surfaceTokens: 10 }))
    expect(result.percent).toBeUndefined()
    expect(result.window).toBeUndefined()
    expect(result.used).toBe(10)
  })

  it('treats a zero or negative window as unknown rather than infinitely full', () => {
    const s = session({ requestContext: () => ({ contextWindow: 0 }) })
    expect(readContextOccupancy(s, meter({ surfaceTokens: 10 })).window).toBeUndefined()
    const negative = session({ requestContext: () => ({ contextWindow: -5 }) })
    expect(readContextOccupancy(negative, meter({ surfaceTokens: 10 })).percent).toBeUndefined()
  })

  it('degrades instead of throwing when the meter throws', () => {
    const s = session({ requestContext: () => ({ contextWindow: 1000 }) })
    const throwing: TokenMeterLike = {
      measure: () => {
        throw new Error('boom')
      },
    }
    const result = readContextOccupancy(s, throwing)
    expect(result.quality).toBe('unavailable')
    expect(result.error).toBe('boom')
  })

  it('degrades when the service or the session is absent', () => {
    expect(readContextOccupancy(undefined, meter({ surfaceTokens: 1 })).quality).toBe('unavailable')
    expect(readContextOccupancy(session(), undefined).quality).toBe('unavailable')
  })

  it('survives a requestContext that throws', () => {
    const s = session({
      requestContext: () => {
        throw new Error('nope')
      },
    })
    expect(readContextOccupancy(s, meter({ surfaceTokens: 10 })).window).toBeUndefined()
  })
})

describe('readCumulativeUsage', () => {
  it('sums the four buckets from the tokenUsage projection', () => {
    const projections = {
      stateOf: () => ({
        totals: {
          uncachedInputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 4,
        },
      }),
    }
    const result = readCumulativeUsage(session(), projections, undefined)
    expect(result).toEqual({ quality: 'exact', tokens: 154, source: 'projection' })
  })

  it('accepts the shorter readTokens/writeTokens spelling', () => {
    const projections = {
      stateOf: () => ({ totals: { uncachedInputTokens: 1, readTokens: 2, writeTokens: 3 } }),
    }
    expect(readCumulativeUsage(session(), projections, undefined).tokens).toBe(6)
  })

  it('falls back to the meter when the projection is unregistered', () => {
    const projections = {
      stateOf: () => undefined,
    }
    const result = readCumulativeUsage(
      session(),
      projections,
      meter({ surfaceTokens: 5, totalTokens: 700 }),
    )
    expect(result).toEqual({ quality: 'estimated', tokens: 700, source: 'meter' })
  })

  it('falls back to the meter when the projection throws', () => {
    const projections = {
      stateOf: () => {
        throw new Error('key not registered')
      },
    }
    expect(
      readCumulativeUsage(session(), projections, meter({ surfaceTokens: 1, totalTokens: 42 }))
        .tokens,
    ).toBe(42)
  })

  it('reports unavailable when nothing can price the session', () => {
    expect(readCumulativeUsage(session(), undefined, undefined)).toEqual({
      quality: 'unavailable',
      tokens: 0,
      source: 'none',
    })
  })

  it('does not treat a meter failure as a zero spend', () => {
    const throwing: TokenMeterLike = {
      measure: () => {
        throw new Error('meter down')
      },
    }
    const result = readCumulativeUsage(session(), undefined, throwing)
    expect(result.quality).toBe('unavailable')
    expect(result.error).toBe('meter down')
  })
})

describe('foldUsageFromEvents', () => {
  const events: SessionEventLike[] = [
    { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 10, outputTokens: 2 } } },
    { type: 'tool/call', seq: 2, data: {} },
    {
      type: 'assistant/message',
      seq: 3,
      data: { usage: { inputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1 } },
    },
    { type: 'assistant/message', seq: 4, data: {} },
  ]

  it('sums every usage bucket and skips messages without usage', () => {
    expect(foldUsageFromEvents(events)).toBe(21)
  })

  it('returns zero for an absent log', () => {
    expect(foldUsageFromEvents(undefined)).toBe(0)
  })
})

describe('percentOf', () => {
  it('rounds to whole percent and passes through an unknown ratio', () => {
    expect(percentOf({ quality: 'exact', used: 1, window: 3, percent: 1 / 3, baseline: 'usage' }))
      .toBe(33)
    expect(
      percentOf({ quality: 'unavailable', used: 0, window: undefined, percent: undefined, baseline: 'none' }),
    ).toBeUndefined()
  })
})

describe('windowFromEvents', () => {
  it('reads the window from the durable request/context event', () => {
    const events = [
      { type: 'request/context', seq: 1, data: { contextWindow: 200_000 } },
      { type: 'assistant/message', seq: 2, data: {} },
    ]
    expect(windowFromEvents(events)).toBe(200_000)
  })

  it('prefers the newest context event, because a model switch changes the window', () => {
    const events = [
      { type: 'request/context', seq: 1, data: { contextWindow: 200_000 } },
      { type: 'request/context', seq: 9, data: { contextWindow: 1_000_000 } },
    ]
    expect(windowFromEvents(events)).toBe(1_000_000)
  })

  it('ignores a zero or malformed window', () => {
    expect(windowFromEvents([{ type: 'request/context', seq: 1, data: { contextWindow: 0 } }])).toBeUndefined()
    expect(windowFromEvents([{ type: 'request/context', seq: 1, data: {} }])).toBeUndefined()
    expect(windowFromEvents(undefined)).toBeUndefined()
  })

  it('lets an idle session still report occupancy, which is what the UI needs', () => {
    // The composer shows a percentage while the session is idle; `requestContext()`
    // returns nothing then, so this fallback is the only thing keeping the two
    // numbers consistent.
    const idle = session({
      requestContext: () => ({}),
      ownEvents: () => [{ type: 'request/context', seq: 3, data: { contextWindow: 1_000_000 } }],
    })
    const result = readContextOccupancy(idle, meter({ surfaceTokens: 470_000 }))
    expect(result.window).toBe(1_000_000)
    expect(percentOf(result)).toBe(47)
  })

  it('judges a real session with events as non-blank', () => {
    // The bug this guards: `Session` has no `.events` property, so a session
    // full of history read as empty and every handoff was refused with
    // "当前没有可迁移的活动会话".
    const real = session({
      ownEvents: () => [
        { type: 'user/message', seq: 1, data: {} },
        { type: 'turn/start', seq: 2, data: {} },
      ],
    })
    expect(sessionEvents(real).length).toBe(2)
  })

  it('falls back to snapshotEvents on a host without ownEvents', () => {
    const host = session({
      snapshotEvents: () => [{ type: 'user/message', seq: 1, data: {} }],
    })
    expect(sessionEvents(host).length).toBe(1)
  })
})
