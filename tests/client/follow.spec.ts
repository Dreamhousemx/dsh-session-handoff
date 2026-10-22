import { describe, expect, it, vi } from 'vitest'
import { FOLLOW_MAX_ATTEMPTS, HandoffFollower, type SessionsLike } from '@src/client/follow'
import type { HandoffState } from '@src/client/protocol'

function state(
  sessionId: string,
  newSessionId?: string,
  openNewSession = true,
): HandoffState {
  return {
    ok: true,
    sessionId,
    phase: 'idle',
    busy: false,
    latched: false,
    waitingForStep: false,
    slowWarning: false,
    cancelRequested: false,
    kind: undefined,
    newSessionId,
    occupancy: { quality: 'exact', used: 0, window: 200_000, percent: 0 },
    cumulative: { tokens: 0, source: 'projection', quality: 'exact' },
    thresholds: { handoffPercent: 85, compactPercent: 70, cumulative: 2_000_000, enabled: true, compactEnabled: false },
    openNewSession,
    autoActions: 0,
    maxAutoActions: 3,
    persistence: 'durable',
    lastText: undefined,
    lastFailure: undefined,
    warnings: [],
  }
}

function sessions(options: {
  current?: string | undefined
  rows?: Record<string, { blank?: boolean }>
}): SessionsLike {
  return {
    list: {
      getSnapshot: () => ({ current: options.current, byId: options.rows ?? {} }),
    },
    refresh: vi.fn(async () => {}),
    open: vi.fn(),
  }
}

function follower(overrides: Partial<Parameters<typeof makeDeps>[0]> = {}) {
  return new HandoffFollower(makeDeps(overrides))
}

function makeDeps(overrides: {
  sessions?: SessionsLike
  states?: HandoffState[]
  current?: string
  enabled?: boolean
  log?: (m: string) => void
}) {
  const states = overrides.states ?? []
  return {
    sessions: overrides.sessions,
    fetchState: async () => states.shift(),
    currentSessionId: () => overrides.current ?? 's1',
    enabled: () => overrides.enabled ?? true,
    log: overrides.log ?? (() => {}),
  }
}

describe('HandoffFollower — baseline rule', () => {
  it('records an existing newSessionId without jumping', async () => {
    const open = vi.fn()
    const f = follower({
      sessions: { ...sessions({ current: 's1', rows: { new1: {} } }), open },
      states: [state('s1', 'new1')],
    })
    await f.tick()
    expect(open).not.toHaveBeenCalled()
  })

  it('jumps only on an undefined → value transition', async () => {
    const open = vi.fn()
    const f = follower({
      sessions: { ...sessions({ current: 's1', rows: { new1: { blank: false } } }), open },
      states: [state('s1', undefined), state('s1', 'new1')],
    })
    await f.tick()
    expect(open).not.toHaveBeenCalled()
    await f.tick()
    expect(open).toHaveBeenCalledWith('new1')
  })

  it('does not jump twice for the same transition', async () => {
    const open = vi.fn()
    const f = follower({
      sessions: { ...sessions({ current: 's1', rows: { new1: { blank: false } } }), open },
      states: [state('s1'), state('s1', 'new1'), state('s1', 'new1')],
    })
    await f.tick()
    await f.tick()
    await f.tick()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('stays put when the user turned the jump off', async () => {
    // `openNewSessionOnHandoff: false` is a real preference (compare the two
    // sessions side by side). The follower used to jump regardless, which made
    // the checkbox do nothing at all.
    const open = vi.fn()
    const f = follower({
      sessions: { ...sessions({ current: 's1', rows: { new1: { blank: false } } }), open },
      states: [state('s1', undefined, false), state('s1', 'new1', false)],
    })
    await f.tick()
    await f.tick()
    expect(open).not.toHaveBeenCalled()
  })
})

describe('HandoffFollower — blank rows', () => {
  it('refreshes before opening so the host recomputes blank', async () => {
    const s = sessions({ current: 's1', rows: { new1: {} } })
    const f = follower({ sessions: s, states: [state('s1'), state('s1', 'new1')] })
    await f.tick()
    await f.tick()
    expect(s.refresh).toHaveBeenCalled()
    expect(s.open).toHaveBeenCalledWith('new1')
  })

  it('retries while the row is still blank, then gives up', async () => {
    const open = vi.fn()
    const s = { ...sessions({ current: 's1', rows: { new1: { blank: true } } }), open }
    const f = follower({ sessions: s, states: [state('s1'), ...Array.from({ length: FOLLOW_MAX_ATTEMPTS + 3 }, () => state('s1', 'new1'))] })

    await f.tick()
    for (let i = 0; i < FOLLOW_MAX_ATTEMPTS + 2; i += 1) await f.tick()
    expect(open).not.toHaveBeenCalled()
    // It stops refreshing once it has given up.
    const refreshes = (s.refresh as ReturnType<typeof vi.fn>).mock.calls.length
    await f.tick()
    expect((s.refresh as ReturnType<typeof vi.fn>).mock.calls.length).toBe(refreshes)
  })

  it('waits when the row has not appeared yet', async () => {
    const open = vi.fn()
    const f = follower({
      sessions: { ...sessions({ current: 's1', rows: {} }), open },
      states: [state('s1'), state('s1', 'new1'), state('s1', 'new1')],
    })
    await f.tick()
    await f.tick()
    expect(open).not.toHaveBeenCalled()
  })
})

describe('HandoffFollower — guards', () => {
  it('does nothing while the setting is off', async () => {
    const fetchState = vi.fn(async () => state('s1', 'new1'))
    const f = new HandoffFollower({ ...makeDeps({ enabled: false }), fetchState })
    await f.tick()
    expect(fetchState).not.toHaveBeenCalled()
  })

  it('survives a fetch failure', async () => {
    const f = new HandoffFollower({
      ...makeDeps({}),
      fetchState: async () => {
        throw new Error('network down')
      },
    })
    await expect(f.tick()).rejects.toThrow('network down')
  })

  it('survives a refresh failure and still tries to open', async () => {
    const open = vi.fn()
    const s: SessionsLike = {
      list: { getSnapshot: () => ({ current: 's1', byId: { new1: {} } }) },
      refresh: async () => {
        throw new Error('refresh failed')
      },
      open,
    }
    const f = follower({ sessions: s, states: [state('s1'), state('s1', 'new1')] })
    await f.tick()
    await f.tick()
    expect(open).toHaveBeenCalledWith('new1')
  })

  it('stops polling after dispose', async () => {
    const fetchState = vi.fn(async () => state('s1'))
    const f = new HandoffFollower({ ...makeDeps({}), fetchState })
    f.stop()
    await f.tick()
    expect(fetchState).not.toHaveBeenCalled()
  })
})
