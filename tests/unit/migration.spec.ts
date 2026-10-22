import { describe, expect, it, vi } from 'vitest'
import {
  inheritPermissionForTest,
  readPermissionPreset,
  snapshotSource,
  type MigrationDeps,
  type SourceSnapshot,
} from '@src/session-migration.ts'
import type { AgentLike, PermissionPresetsLike, SessionLike } from '@src/contracts.ts'

/** A session object shaped like the host's own: it can answer `snapshotEvents`. */
function realSession(id = 's1'): SessionLike & { snapshotEvents(): readonly never[] } {
  return {
    id,
    snapshotEvents: () => [],
    header: { id, cwd: 'D:/w' },
  }
}

/**
 * A permission-presets service that behaves like the host's.
 *
 * The host's `set()` folds the target's log through the `permissions`
 * projection and then APPENDS events to it, so anything without
 * `snapshotEvents` throws before a single write happens. This fake enforces the
 * same contract, which is what makes the regression test meaningful: a `{ id }`
 * lookalike fails here exactly as it failed in production.
 */
function hostLikePresets(): PermissionPresetsLike & { setCalls: unknown[] } {
  const setCalls: unknown[] = []
  return {
    setCalls,
    current(session) {
      if (typeof session?.snapshotEvents !== 'function') {
        throw new Error('session.snapshotEvents is not a function')
      }
      return 'danger-full-access'
    },
    set(session, name) {
      if (typeof session?.snapshotEvents !== 'function') {
        throw new Error('session.snapshotEvents is not a function')
      }
      setCalls.push([session, name])
    },
  }
}

function snapshot(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    sessionId: 's1',
    cwd: 'D:/w',
    agentPreset: 'standard',
    model: { provider: 'p', model: 'm' },
    permissionPreset: 'danger-full-access',
    approvalPolicy: undefined,
    planMode: { active: false },
    ...overrides,
  }
}

function depsFor(options: {
  presets?: PermissionPresetsLike
  targetAgent?: AgentLike | undefined
}): MigrationDeps {
  return {
    sessionController: undefined,
    workspaceRegistry: undefined,
    permissionPresets: options.presets,
    approval: undefined,
    agentPresets: undefined,
    defaultModel: undefined,
    resolveAgent: () => options.targetAgent,
  }
}

describe('readPermissionPreset — a failure is reported, never smoothed over', () => {
  it('reads through a real session', () => {
    const read = readPermissionPreset(realSession(), hostLikePresets())
    expect(read).toEqual({ value: 'danger-full-access' })
  })

  it('keeps the reason when the object is not a host Session', () => {
    const read = readPermissionPreset({ id: 's1' } as { snapshotEvents?: unknown }, hostLikePresets())
    expect(read.value).toBeUndefined()
    expect(read.error).toContain('snapshotEvents')
  })

  it('distinguishes "no service" from "read failed"', () => {
    expect(readPermissionPreset(realSession(), undefined).error).toContain('permissionPresets')
    expect(readPermissionPreset(undefined, hostLikePresets()).error).toContain('找不到原会话')
  })

  it('surfaces the service throwing instead of returning undefined', () => {
    const throwing: PermissionPresetsLike = {
      current() {
        throw new Error('projection not registered')
      },
      set() {},
    }
    const read = readPermissionPreset(realSession(), throwing)
    expect(read.error).toBe('projection not registered')
  })
})

describe('inheritPermission — the write must use the new session REAL Session', () => {
  it('writes through the new agent session, not an {id} lookalike', async () => {
    // The regression: the old code passed `{ id: newSessionId }`, which threw
    // "session.snapshotEvents is not a function" and was reported as an
    // innocent "回退" on every handoff.
    const presets = hostLikePresets()
    const targetSession = realSession('new-1')
    const outcome = await inheritPermissionForTest(
      'new-1',
      snapshot(),
      depsFor({ presets, targetAgent: { id: 'new-1', session: targetSession } }),
    )

    expect(outcome.status).toBe('inherited')
    expect(outcome.detail).toBe('danger-full-access')
    expect(presets.setCalls).toHaveLength(1)
    expect(presets.setCalls[0]).toEqual([targetSession, 'danger-full-access'])
    // The exact value handed to the host must be the Session instance itself.
    expect((presets.setCalls[0] as [unknown])[0]).toBe(targetSession)
  })

  it('says so when the new session has no Session object yet', async () => {
    const outcome = await inheritPermissionForTest(
      'new-1',
      snapshot(),
      depsFor({ presets: hostLikePresets(), targetAgent: undefined }),
    )
    expect(outcome.status).toBe('skipped')
    expect(outcome.detail).toContain('Session')
  })

  it('an agent without a session does not produce a fake write', async () => {
    const presets = hostLikePresets()
    const outcome = await inheritPermissionForTest(
      'new-1',
      snapshot(),
      depsFor({ presets, targetAgent: { id: 'new-1' } }),
    )
    expect(outcome.status).toBe('skipped')
    expect(presets.setCalls).toHaveLength(0)
  })

  it('reports a read failure with its reason instead of "回退"', async () => {
    const outcome = await inheritPermissionForTest(
      'new-1',
      snapshot({ permissionPreset: undefined, permissionPresetError: 'snapshotEvents is not a function' }),
      depsFor({ presets: hostLikePresets(), targetAgent: { id: 'new-1', session: realSession('new-1') } }),
    )
    expect(outcome.status).toBe('skipped')
    expect(outcome.detail).toContain('无法读取原会话权限预设')
    expect(outcome.detail).toContain('snapshotEvents')
  })
})

describe('snapshotSource — carries the permission failure reason', () => {
  it('records why the preset could not be read', () => {
    const snap = snapshotSource({
      session: { id: 's1' },
      sessionId: 's1',
      agent: undefined,
      permissionPresets: hostLikePresets(),
      approval: undefined,
      agentPresets: undefined,
      defaultModel: undefined,
    })
    expect(snap.permissionPreset).toBeUndefined()
    expect(snap.permissionPresetError).toContain('snapshotEvents')
  })

  it('omits the error field when the read succeeded', () => {
    const snap = snapshotSource({
      session: realSession(),
      sessionId: 's1',
      agent: undefined,
      permissionPresets: hostLikePresets(),
      approval: undefined,
      agentPresets: undefined,
      defaultModel: undefined,
    })
    expect(snap.permissionPreset).toBe('danger-full-access')
    expect('permissionPresetError' in snap).toBe(false)
  })
})

describe('snapshotSource — model and header facts', () => {
  it('prefers the live request context over the stored header', () => {
    const session: SessionLike = {
      id: 's1',
      header: { id: 's1', cwd: 'D:/work', agentPreset: 'standard' },
      requestContext: () => ({ provider: 'live', model: 'live-model' }),
      requestHeader: () => ({ config: { provider: 'stored', model: 'stored-model' } }),
    }
    const snap = snapshotSource({
      session,
      sessionId: 's1',
      agent: undefined,
      permissionPresets: undefined,
      approval: undefined,
      agentPresets: undefined,
      defaultModel: { provider: 'default', model: 'default-model' },
    })
    expect(snap.model).toEqual({ provider: 'live', model: 'live-model' })
    expect(snap.cwd).toBe('D:/work')
    expect(snap.agentPreset).toBe('standard')
  })

  it('falls back to the deployment model when the session recorded none', () => {
    const snap = snapshotSource({
      session: { id: 's1' },
      sessionId: 's1',
      agent: undefined,
      permissionPresets: undefined,
      approval: undefined,
      agentPresets: undefined,
      defaultModel: { provider: 'default', model: 'default-model' },
    })
    expect(snap.model).toEqual({ provider: 'default', model: 'default-model' })
  })

  it('survives a session whose accessors throw', () => {
    const session: SessionLike = {
      id: 's1',
      requestContext: () => {
        throw new Error('boom')
      },
      requestHeader: () => {
        throw new Error('boom')
      },
    }
    const snap = snapshotSource({
      session,
      sessionId: 's1',
      agent: undefined,
      permissionPresets: undefined,
      approval: undefined,
      agentPresets: undefined,
      defaultModel: undefined,
    })
    expect(snap.model).toBeUndefined()
  })
})

void vi
