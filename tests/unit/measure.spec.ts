import { describe, expect, it } from 'vitest'
import {
  foldUsageFromEvents,
  percentOf,
  readContextOccupancy,
  readCumulativeUsage,
  windowFromEvents,
} from '@src/measure.ts'
import {
  ownSessionEvents,
  sessionEvents,
  type SessionEventLike,
  type SessionLike,
  type TokenMeterLike,
} from '@src/contracts.ts'
import { readPendingInput } from '@src/session-summary.ts'

function session(overrides: Partial<SessionLike> = {}): SessionLike {
  return { id: 's1', ...overrides }
}

function meter(measured: unknown): TokenMeterLike {
  return { measure: () => measured as never }
}

/**
 * A projections registry whose `contextPressure` unit answers one RAW state.
 *
 * The state must have the shape `stateOf()` returns, not the client-visible
 * wire view: `dsh-session-projection/lib/index.js` `stateOf()` returns
 * `cellFor(...).state`, and only `snapshot()`/`viewCell()` run `wire.view()`.
 * The raw `contextPressure` state schema (`dsh-token-meter/lib/index.js`) is
 * `.strict()` over `contextWindow`, `pressureTokens`, `surfaceTokens`,
 * `sampledSurfaceTokens`, and `claim` — it does NOT contain `projectedTokens`.
 *
 * An earlier version of this helper accepted a hand-built state carrying
 * `projectedTokens`, so every test passed while the production path read an
 * always-undefined field. `pressureState()` exists to make that impossible:
 * it takes the three raw inputs and never a pre-computed projection.
 */
function pressureState(state: unknown): { stateOf: (s: unknown, key: string) => unknown } {
  return { stateOf: (_s, key) => (key === 'contextPressure' ? state : undefined) }
}

/** Raw `contextPressure` state from the host's own three inputs. */
function rawPressure(input: {
  pressureTokens?: number
  surfaceTokens?: number
  sampledSurfaceTokens?: number
  contextWindow?: number
}): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  if (input.pressureTokens !== undefined) state.pressureTokens = input.pressureTokens
  /* `surfaceTokens` is REQUIRED by the host schema; default it to 0 so a state
   * built from pressure alone still validates as the host would produce. */
  state.surfaceTokens = input.surfaceTokens ?? 0
  if (input.sampledSurfaceTokens !== undefined) state.sampledSurfaceTokens = input.sampledSurfaceTokens
  if (input.contextWindow !== undefined) state.contextWindow = input.contextWindow
  return state
}

describe('readContextOccupancy — agreement with the composer meter', () => {
  // The composer's ContextMeter computes `projectedTokens ?? pressureTokens`
  // over `contextWindow`. The plugin used to price the surface itself, so the
  // same session read 27% in the composer and 32% in `/handoff status`. These
  // tests pin the projection-first rule that removes the disagreement.
  const s = session({ requestContext: () => ({ contextWindow: 1_000_000 }) })

  it('derives projectedTokens from the raw state and prefers it', () => {
    // pressure + surface - sampled = 274_086 + 6_000 - 0 = 280_086
    const result = readContextOccupancy(
      s,
      meter({ surfaceTokens: 999_999 }),
      pressureState(
        rawPressure({
          pressureTokens: 274_086,
          surfaceTokens: 6_000,
          sampledSurfaceTokens: 0,
          contextWindow: 1_000_000,
        }),
      ),
    )
    expect(result.used).toBe(280_086)
    expect(result.percent).toBeCloseTo(0.280086)
    expect(result.source).toBe('contextPressure')
  })

  it('uses pressureTokens alone when the sample cannot be projected forward', () => {
    const result = readContextOccupancy(
      s,
      meter({ surfaceTokens: 999_999 }),
      pressureState(rawPressure({ pressureTokens: 274_086, contextWindow: 1_000_000 })),
    )
    expect(result.used).toBe(274_086)
    // A provider-reported sample is exact, exactly as the UI treats it.
    expect(result.baseline).toBe('usage')
    expect(result.quality).toBe('exact')
  })

  it('marks a projected reading as estimated, not exact', () => {
    const result = readContextOccupancy(
      s,
      undefined,
      pressureState(
        rawPressure({
          pressureTokens: 274_086,
          surfaceTokens: 6_000,
          sampledSurfaceTokens: 0,
          contextWindow: 1_000_000,
        }),
      ),
    )
    expect(result.baseline).toBe('estimated')
    expect(result.quality).toBe('estimated')
  })

  /*
   * Shape guard: the host never puts `projectedTokens` in the raw state, and a
   * projection smuggled into it must not change the answer. If someone
   * reintroduces a read of that field, this case fails.
   */
  it('ignores a projectedTokens smuggled into the raw state', () => {
    const smuggled = {
      ...rawPressure({ pressureTokens: 274_086, contextWindow: 1_000_000 }),
      projectedTokens: 900_000,
    }
    const result = readContextOccupancy(s, undefined, pressureState(smuggled))
    expect(result.used).toBe(274_086)
    expect(result.quality).toBe('exact')
  })

  it('clamps a projection that would go negative to zero and falls back', () => {
    // surface shrank below the sample (e.g. after a compaction): max(0, …) = 0,
    // which is not a usable numerator, so the sample alone answers.
    const result = readContextOccupancy(
      s,
      undefined,
      pressureState(
        rawPressure({
          pressureTokens: 10_000,
          surfaceTokens: 0,
          sampledSurfaceTokens: 50_000,
          contextWindow: 1_000_000,
        }),
      ),
    )
    expect(result.used).toBe(0)
    expect(result.source).toBe('none')
  })

  it('takes the window from the projection when the session reports none', () => {
    const noWindow = session({})
    const result = readContextOccupancy(
      noWindow,
      undefined,
      pressureState(rawPressure({ pressureTokens: 250_000, contextWindow: 1_000_000 })),
    )
    expect(result.window).toBe(1_000_000)
    expect(result.percent).toBeCloseTo(0.25)
  })

  it('falls back to the meter when the unit is not registered', () => {
    const result = readContextOccupancy(s, meter({ surfaceTokens: 170_000 }), pressureState(undefined))
    expect(result.used).toBe(170_000)
    expect(result.source).toBe('meter-surface')
  })

  it('falls back to the meter when stateOf throws', () => {
    const throwing = {
      stateOf: () => {
        throw new Error('projection not registered')
      },
    }
    const result = readContextOccupancy(s, meter({ surfaceTokens: 170_000 }), throwing)
    expect(result.used).toBe(170_000)
    expect(result.source).toBe('meter-surface')
  })

  it('ignores a projection with no usable numerator', () => {
    const result = readContextOccupancy(s, meter({ surfaceTokens: 170_000 }), pressureState(rawPressure({ contextWindow: 1_000_000 })))
    expect(result.used).toBe(170_000)
    expect(result.source).toBe('meter-surface')
  })

  it('is unavailable when neither a projection nor a meter answers', () => {
    const result = readContextOccupancy(s, undefined, pressureState(undefined))
    expect(result.quality).toBe('unavailable')
    expect(result.source).toBe('none')
  })

  /*
   * The real numbers from the session where this was reported: the composer
   * showed 27% while `/handoff status` showed 32.14% for the SAME session.
   *
   * `pressureTokens` is the provider's reported prompt size (what the UI
   * divides); `surfaceTokens` is this plugin's ~4-chars-per-token replay of the
   * surface. Keeping this case makes the disagreement a fixed regression rather
   * than something someone has to rediscover by eye.
   */
  it('reproduces the 27% vs 32% disagreement and shows it is gone', () => {
    const live = session({ requestContext: () => ({ contextWindow: 1_000_000 }) })
    const surfaceMeter = meter({
      surfaceTokens: 321_382,
      totalTokens: 274_919,
      baseline: { kind: 'usage' },
    })
    const liveProjection = pressureState(rawPressure({ pressureTokens: 274_086, contextWindow: 1_000_000 }))

    const before = readContextOccupancy(live, surfaceMeter)
    expect(Math.round(before.percent! * 100)).toBe(32)
    expect(before.source).toBe('meter-surface')

    const after = readContextOccupancy(live, surfaceMeter, liveProjection)
    expect(Math.round(after.percent! * 100)).toBe(27)
    expect(after.source).toBe('contextPressure')
  })
})

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

  /*
   * `reason` exists so the status line can name the actual cause instead of
   * printing "模型未上报上下文窗口" for all five of them. These assertions pin
   * which cause each path reports; without them a later refactor could merge
   * two cases again and no test would notice.
   *
   * The live evidence for the two that used to be misreported:
   *   - an unloaded fork session (`05402558`) reported `used: 0`, and the
   *     status line called it a model problem;
   *   - a loaded session with `window: 1000000` and `used: 0` printed
   *     "0 / 1000000 tokens · 未知（模型未上报上下文窗口）".
   */
  it('names the cause of a missing percentage', () => {
    // No handle at all: the session is not loaded in this process.
    expect(readContextOccupancy(undefined, meter({ surfaceTokens: 1 })).reason).toBe('no-session')

    // Neither source exists on this deployment.
    expect(readContextOccupancy(session(), undefined).reason).toBe('no-source')

    // Sources answered, surface is empty -- the window is still reported.
    const empty = readContextOccupancy(
      session({ requestContext: () => ({ contextWindow: 1_000_000 }) }),
      meter({ surfaceTokens: 0, baseline: { kind: 'none' } }),
    )
    expect(empty.reason).toBe('empty-surface')
    expect(empty.window).toBe(1_000_000)

    // Tokens measured, but the model declares no window.
    const noWindow = readContextOccupancy(session({ requestContext: () => ({}) }), meter({ surfaceTokens: 10 }))
    expect(noWindow.reason).toBe('no-window')
    expect(noWindow.used).toBe(10)
  })

  it('marks a throwing meter as a measurement error, not a missing model window', () => {
    const throwing: TokenMeterLike = {
      measure: () => {
        throw new Error('boom')
      },
    }
    expect(readContextOccupancy(session(), throwing).reason).toBe('error')
  })

  it('reports no reason when a percentage is available', () => {
    const result = readContextOccupancy(
      session({ requestContext: () => ({ contextWindow: 1000 }) }),
      meter({ surfaceTokens: 250 }),
    )
    expect(result.percent).toBe(0.25)
    expect(result.reason).toBeUndefined()
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

/*
 * Fork sessions: the inherited prefix must be visible.
 *
 * The host's two accessors differ:  ownEvents()      = snapshotEvents(inheritedEventCount)
 *                                  snapshotEvents()  = the whole log
 * (`dsh-session/lib/index.js`), so for a fork `ownEvents` hides everything the
 * parent contributed. Reading it first made `activityCheck` judge a fork blank
 * and refuse the handoff, made the brief omit inherited work, and hid the
 * `request/context` event that carries the window.
 */
describe('sessionEvents — a fork is the whole conversation, not its own share', () => {
  const inherited = [
    { type: 'turn/start', seq: 0, data: {} },
    { type: 'user/message', seq: 1, data: {} },
    { type: 'request/context', seq: 2, data: { contextWindow: 500_000 } },
  ]
  const own = [
    { type: 'turn/start', seq: 3, data: {} },
    { type: 'assistant/message', seq: 4, data: {} },
  ]

  const fork = {
    id: 's-fork',
    // The host's real definitions, including the offset that hides the prefix.
    snapshotEvents: () => [...inherited, ...own],
    ownEvents: () => [...own],
  } as never

  it('reads the whole log, so inherited history is visible', () => {
    expect(sessionEvents(fork)).toHaveLength(5)
  })

  it('still offers the session-own slice when a caller wants it', () => {
    expect(ownSessionEvents(fork)).toEqual(own)
  })

  it('finds the window recorded before the fork', () => {
    expect(windowFromEvents(sessionEvents(fork))).toBe(500_000)
  })

  it('does not call a fork blank', () => {
    const hasActivity = sessionEvents(fork).some(
      (event) => event.type === 'user/message' || event.type === 'turn/start',
    )
    expect(hasActivity).toBe(true)
  })

  it('degrades to ownEvents when the host has no snapshotEvents', () => {
    const partial = { id: 's', ownEvents: () => [...own] } as never
    expect(sessionEvents(partial)).toEqual(own)
  })
})

/*
 * The same defect, measured on a REAL fork instead of a hand-written fixture.
 *
 * Source: `session-05402558-bae6-4444-b4e9-c3deeb37ba11`, a subagent side
 * thread forked from `session-b01f9f16-…` on 2026-09-30. Its whole log was
 * replayed through the host's own `Session.fromRestore`
 * (`dsh-session/lib/index.js`), which reported:
 *
 *     snapshotEvents().length = 112      ownEvents().length = 2
 *     inheritedEventCount     = 110      header.isSeeded   = true
 *     ownEvents() = [session/end-seed, session/title]
 *
 * Those two numbers are the fixture. They are not invented: on a fork of this
 * shape the session's entire conversation is inherited, so `ownEvents()` holds
 * no user message and no turn, and the pre-fix `activityCheck` refused the
 * handoff with "当前没有可迁移的活动会话". The synthetic fixture above covers
 * the shape; this one covers the shape the host actually produced.
 *
 * The structural constants below are the ones read off that log: one
 * `turn/start` (seq 12), three `user/message` (16, 17, 18), the only
 * `request/context` at seq 20 carrying `contextWindow: 1_000_000`, and a final
 * surface event of `tool/result` at seq 104 — which is why I-1's
 * "assistant spoke last" branch correctly stays silent for this session.
 */
describe('a real fork whose whole history is inherited', () => {
  const TOTAL = 112
  const INHERITED = 110

  /**
   * The real event types, in their real order, byte-for-byte from the log.
   *
   * Deliberately NOT collapsed into runs: the indices are the evidence. A
   * run-length summary asserted earlier put `step/start` at 14 and pushed the
   * three user messages to 15-17, which silently moved the inherited cut and
   * made the "exactly two own events" claim true for the wrong reason. The
   * literal list keeps every index meaningful.
   */
  const TYPES: readonly string[] = [
    'permission/preset', 'sandbox/mode', 'approval/policy', 'command/run',
    'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
    'command/done', 'agent/inbox/spliced', 'session/end-seed', 'agent/inbox/spliced',
    'turn/start', 'agent/inbox/spliced', 'step/start', 'system/message',
    'user/message', 'user/message', 'user/message', 'request/header',
    'request/context', 'session/title', 'session/title-llm-request', 'session/title',
    'assistant/message', 'tool/call', 'tool/result', 'tool/call',
    'tool/result', 'step/end', 'step/start', 'assistant/message',
    'tool/call', 'tool/result', 'tool/call', 'tool/result',
    'step/end', 'step/start', 'assistant/message', 'tool/call',
    'tool/result', 'tool/call', 'tool/result', 'step/end',
    'step/start', 'assistant/message', 'tool/call', 'tool/call',
    'tool/call', 'tool/call', 'tool/result', 'tool/result',
    'tool/result', 'tool/result', 'step/end', 'step/start',
    'assistant/message', 'tool/call', 'tool/result', 'tool/call',
    'tool/result', 'step/end', 'step/start', 'assistant/message',
    'tool/call', 'tool/result', 'step/end', 'step/start',
    'assistant/message', 'tool/call', 'tool/result', 'tool/call',
    'tool/result', 'step/end', 'step/start', 'assistant/message',
    'tool/call', 'tool/result', 'tool/call', 'tool/result',
    'step/end', 'step/start', 'assistant/message', 'tool/call',
    'tool/result', 'step/end', 'step/start', 'assistant/message',
    'tool/call', 'tool/result', 'step/end', 'step/start',
    'assistant/message', 'tool/call', 'tool/result', 'step/end',
    'step/start', 'assistant/message', 'tool/call', 'tool/result',
    'step/end', 'step/start', 'assistant/message', 'tool/call',
    'tool/result', 'step/end', 'step/start', 'step/end',
    'turn/end', 'subagent/descriptor', 'session/end-seed', 'session/title',
  ]

  const events = TYPES.map((type, seq) => ({
    type,
    seq,
    // The one inherited envelope: real seq, real window.
    ...(type === 'request/context' ? { data: { contextWindow: 1_000_000 } } : { data: {} }),
  }))

  it('is the real 112-event log, with its real cut point', () => {
    expect(events).toHaveLength(TOTAL)
    // The structural claims this fixture exists to make, each at its real index.
    expect(events[12]?.type).toBe('turn/start')
    expect(events.slice(16, 19).map((e) => e.type)).toEqual([
      'user/message', 'user/message', 'user/message',
    ])
    expect(events[20]?.type).toBe('request/context')
    expect(events[20]?.data['contextWindow']).toBe(1_000_000)
    // I-1's "assistant spoke last" branch must stay silent: this log ends on a
    // tool result, not an assistant message.
    expect(events[104]?.type).toBe('tool/result')
    expect(events.slice(INHERITED).map((e) => e.type)).toEqual([
      'session/end-seed', 'session/title',
    ])
  })

  it('reproduces the host structure that makes ownEvents empty', () => {
    const own = events.slice(INHERITED)
    expect(own.some((event) => event.type === 'user/message' || event.type === 'turn/start')).toBe(false)
  })

  const session = {
    id: 'session-05402558-bae6-4444-b4e9-c3deeb37ba11',
    snapshotEvents: () => [...events],
    ownEvents: () => events.slice(INHERITED),
  } as never

  it('passes the blank-session check that refused this handoff before the fix', () => {
    const whole = sessionEvents(session)
    expect(whole).toHaveLength(TOTAL)
    expect(whole.filter((e) => e.type === 'user/message')).toHaveLength(3)
    expect(whole.some((e) => e.type === 'turn/start')).toBe(true)
  })

  it('finds the inherited context window instead of reporting none', () => {
    expect(windowFromEvents(sessionEvents(session))).toBe(1_000_000)
    expect(windowFromEvents(ownSessionEvents(session))).toBeUndefined()
  })

  it('stays silent about a pending question, because this log ends on a tool result', () => {
    const surface = sessionEvents(session).filter((event) =>
      ['user/message', 'assistant/message', 'tool/result'].includes(event.type),
    )
    expect(surface.at(-1)?.type).toBe('tool/result')
    expect(readPendingInput(session, undefined, sessionEvents(session))).toBeUndefined()
  })
})

