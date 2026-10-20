import { describe, expect, it, vi } from 'vitest'
import { apply, Config, CONFIG_DEFAULTS, name, ROUTE_PREFIX, SETTINGS_ENTRY, withDefaults } from '@src/index'
import { validateSettings } from '@src/settings'

/**
 * A minimal Cordis-like context.
 *
 * This is not a Cordis stand-in for correctness testing — it is a wiring probe:
 * it proves the plugin registers everything through `ctx.effect`, reads services
 * lazily, and survives a composition where the optional services are missing.
 */
function fakeContext(services: Record<string, unknown> = {}) {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const disposers: Array<() => void> = []
  const effects: Array<() => () => void> = []

  const ctx = {
    get: vi.fn((serviceName: string) => services[serviceName]),
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      const disposer = () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((l) => l !== listener))
      }
      disposers.push(disposer)
      return disposer
    },
    effect: (callback: () => () => void) => {
      effects.push(callback)
      return callback()
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }

  return {
    ctx,
    listeners,
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    disposeAll() {
      for (const disposer of disposers.reverse()) disposer()
    },
    effectCount: () => effects.length,
  }
}

const baseConfig = {
  autoHandoffEnabled: false,
  autoHandoffTrigger: 'context' as const,
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
}

describe('plugin identity', () => {
  it('uses one stable id across the row, the route and the settings entry', () => {
    expect(name).toBe('dsh-session-handoff')
    expect(SETTINGS_ENTRY).toBe('dsh-session-handoff')
    expect(ROUTE_PREFIX).toBe('/dsh-session-handoff')
  })
})

describe('apply — minimal deployment', () => {
  it('mounts with no optional services and registers cleanly', () => {
    const fake = fakeContext({})
    expect(() => apply(fake.ctx as never, baseConfig)).not.toThrow()
    expect(fake.effectCount()).toBe(1)
    // The step veto is always installed, even when nothing else is available.
    expect(fake.listeners.get('agent/pre-step')?.length).toBe(1)
  })

  it('does not fail when commands and webServer are absent', () => {
    const fake = fakeContext({})
    apply(fake.ctx as never, baseConfig)
    expect(fake.ctx.logger.warn).not.toHaveBeenCalled()
    expect(fake.ctx.logger.info).toHaveBeenCalled()
  })

  it('tears down everything on unload', () => {
    const fake = fakeContext({})
    apply(fake.ctx as never, baseConfig)
    fake.disposeAll()
    expect(fake.listeners.get('agent/pre-step')?.length).toBe(0)
    expect(fake.listeners.get('session/event')?.length).toBe(0)
  })
})

describe('apply — with services', () => {
  it('registers the route and the command', () => {
    const register = vi.fn((_route: unknown) => () => {})
    const fake = fakeContext({
      webServer: { register },
      commands: { register: vi.fn(() => () => {}) },
    })
    apply(fake.ctx as never, baseConfig)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[0]).toMatchObject({ kind: 'prefix', path: ROUTE_PREFIX })
  })

  it('reads services lazily, so a late sessionController is still found', () => {
    const services: Record<string, unknown> = {}
    const fake = fakeContext(services)
    apply(fake.ctx as never, baseConfig)

    // Nothing published at apply time.
    expect(fake.ctx.get).toHaveBeenCalled()
    services['sessions'] = { get: () => undefined }

    // The plugin asks again on each use rather than holding a snapshot.
    const before = fake.ctx.get.mock.calls.length
    fake.emit('session/event', { id: 's1' }, { type: 'user/message', seq: 1, data: {} })
    expect(fake.ctx.get.mock.calls.length).toBeGreaterThan(before)
  })

  it('ignores malformed session events instead of throwing into the bus', () => {
    const fake = fakeContext({})
    apply(fake.ctx as never, baseConfig)
    expect(() => fake.emit('session/event', undefined, undefined)).not.toThrow()
    expect(() => fake.emit('session/event', { id: 's1' }, { type: 'turn/start' })).not.toThrow()
  })
})

describe('apply — step veto', () => {
  it('passes the decision through when no latch is held', async () => {
    const fake = fakeContext({})
    apply(fake.ctx as never, baseConfig)
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    const decision = await (
      fake.listeners.get('agent/pre-step')![0] as (
        payload: unknown,
        next: () => Promise<unknown>,
      ) => Promise<unknown>
    )({ agent: { id: 's1' }, messages: [] }, next)

    expect(next).toHaveBeenCalled()
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })
})

describe('Config schema', () => {
  it('ships defaults that keep every automatic action off', () => {
    expect(CONFIG_DEFAULTS.autoHandoffEnabled).toBe(false)
    expect(CONFIG_DEFAULTS.autoCompactEnabled).toBe(false)
  })

  it('fills a missing field with its default rather than failing', () => {
    const parsed = withDefaults({ autoHandoffEnabled: true })
    expect(parsed.autoHandoffAtContextPercent).toBe(85)
    expect(parsed.evaluateIntervalMs).toBe(5000)
    expect(parsed.autoHandoffEnabled).toBe(true)
  })

  it('exposes a schemastery instance, which the Configuration page requires', () => {
    // `dsh-settings` reads `schema.meta`, walks `schema.dict`, and calls
    // `schema.toJSON()`. A plain object yields `status: "unsupported"`.
    expect(typeof Config.toJSON).toBe('function')
    expect(Config.type).toBe('object')
    expect(Object.keys((Config as unknown as { dict: object }).dict)).toContain(
      'autoHandoffAtContextPercent',
    )
  })

  it('exposes a synchronous Standard Schema validator for the Loader', () => {
    const result = (Config as unknown as {
      '~standard': { validate(v: unknown): { value?: unknown; issues?: unknown } }
    })['~standard'].validate({ autoHandoffAtContextPercent: 70 })
    expect('then' in (result as object)).toBe(false)
    expect(result.issues).toBeUndefined()
    expect((result.value as { autoHandoffAtContextPercent: number }).autoHandoffAtContextPercent).toBe(70)
  })

  it('rejects an out-of-range value through the schema itself', () => {
    const result = (Config as unknown as {
      '~standard': { validate(v: unknown): { value?: unknown; issues?: unknown } }
    })['~standard'].validate({ autoHandoffAtContextPercent: 0 })
    expect(result.issues).toBeDefined()
  })

  it('blocks a compaction threshold at or above the handoff threshold', () => {
    const result = validateSettings({
      ...baseConfig,
      autoHandoffEnabled: true,
      autoCompactEnabled: true,
      autoCompactAtContextPercent: 85,
    })
    expect(result.blocking).toContain('压缩阈值必须低于交接阈值')
  })

  it('warns, rather than blocks, when only one is enabled and order looks odd', () => {
    const result = validateSettings({
      ...baseConfig,
      autoCompactEnabled: true,
      autoHandoffAtContextPercent: 60,
      autoCompactAtContextPercent: 70,
    })
    expect(result.blocking).toBeUndefined()
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('accepts 30% without complaint: a low threshold is a legitimate choice', () => {
    const result = validateSettings({
      ...baseConfig,
      autoHandoffEnabled: true,
      autoHandoffAtContextPercent: 30,
    })
    expect(result.warnings.some((w) => w.field === 'autoHandoffAtContextPercent')).toBe(false)
  })

  it('warns below 20%, where handoffs get pathological', () => {
    const result = validateSettings({
      ...baseConfig,
      autoHandoffEnabled: true,
      autoHandoffAtContextPercent: 10,
    })
    expect(result.warnings.some((w) => w.field === 'autoHandoffAtContextPercent')).toBe(true)
  })

  it('stays quiet about the threshold while automation is off', () => {
    const result = validateSettings({ ...baseConfig, autoHandoffAtContextPercent: 10 })
    expect(result.warnings.some((w) => w.field === 'autoHandoffAtContextPercent')).toBe(false)
  })
})

describe('host contract shapes (0.2.1)', () => {
  it('registers the command with a handler returning a CommandResult', async () => {
    let definition: Record<string, unknown> | undefined
    const fake = fakeContext({
      commands: {
        register: (d: Record<string, unknown>) => {
          definition = d
          return () => {}
        },
      },
    })
    apply(fake.ctx as never, baseConfig)

    expect(definition).toBeDefined()
    expect(typeof definition!['handler']).toBe('function')
    // The old shape must not be used: the host calls `handler`, never `run`.
    expect(definition!['run']).toBeUndefined()

    const result = await (definition!['handler'] as (inv: unknown) => Promise<unknown>)({
      agent: { id: 's1' },
      rawInput: 'bogus',
    })
    expect(result).toMatchObject({ kind: 'error' })
    expect(String((result as { text?: string }).text)).toContain('未知子命令')
  })

  it('reads sessions and agents from their separate registries', () => {
    const sessionsGet = vi.fn(() => undefined)
    const agentsGet = vi.fn(() => undefined)
    const fake = fakeContext({
      sessions: { get: sessionsGet },
      agents: { get: agentsGet },
      commands: { register: () => () => {} },
    })
    apply(fake.ctx as never, baseConfig)

    fake.emit('session/event', { id: 's1' }, { type: 'assistant/message', seq: 2, data: {} })
    // Session lookups go to `sessions`; agent lookups go to `agents`.
    expect(sessionsGet).toHaveBeenCalled()
    expect(agentsGet).not.toHaveBeenCalled()
  })
})

describe('services that arrive after apply()', () => {
  it('registers /handoff through ctx.inject when commands is not ready yet', async () => {
    // The real failure: apply() runs as soon as `sessions` exists, so
    // `commands` and `webServer` were undefined and both registrations were
    // silently skipped. The row showed as running while /handoff did nothing.
    const services: Record<string, unknown> = {}
    const deferred: Array<() => void> = []
    const fake = fakeContext(services)
    ;(fake.ctx as unknown as { inject: (deps: readonly string[], cb: () => void) => void }).inject = (
      deps,
      callback,
    ) => {
      deferred.push(() => {
        for (const dep of deps) expect(services[dep]).toBeDefined()
        callback()
      })
    }

    apply(fake.ctx as never, baseConfig)

    // Nothing registered eagerly, and nothing threw.
    expect(deferred.length).toBe(2)

    // The services publish later, then the deferred bodies run.
    const register = vi.fn((_definition: { name?: string }) => () => {})
    services['commands'] = { register }
    services['webServer'] = { register: vi.fn(() => () => {}) }
    for (const run of deferred) run()

    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[0]?.name).toBe('handoff')
  })

  it('never throws when a deferred dependency never arrives', () => {
    const fake = fakeContext({})
    ;(fake.ctx as unknown as { inject: (deps: readonly string[], cb: () => void) => void }).inject = () => {}
    expect(() => apply(fake.ctx as never, baseConfig)).not.toThrow()
  })
})
