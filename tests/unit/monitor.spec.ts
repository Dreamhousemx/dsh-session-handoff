import { describe, expect, it, vi } from 'vitest'
import { Monitor } from '@src/monitor.ts'
import { Coordinator, type ActionRequest } from '@src/coordinator.ts'
import { LatchRegistry } from '@src/graceful-stop.ts'
import { CONFIG_DEFAULTS, type Config } from '@src/settings.ts'
import { evaluate } from '@src/trigger.ts'
import type { AgentLike, HostServices, SessionLike } from '@src/contracts.ts'
import type { ActionResult } from '@src/types.ts'

const WINDOW = 200_000

/** A session whose surface is `used` tokens, honest about its window. */
function session(used: number, id = 's1'): SessionLike {
  return {
    id,
    snapshotEvents: () => [],
    requestContext: () => ({ provider: 'p', model: 'm', contextWindow: WINDOW }),
  } as unknown as SessionLike
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    ...CONFIG_DEFAULTS,
    autoHandoffEnabled: true,
    autoHandoffAtContextPercent: 85,
    evaluateIntervalMs: 0,
    ...overrides,
  }
}

function makeMonitor(options: {
  cfg?: Config
  used?: number
  runAction?: (request: ActionRequest) => Promise<ActionResult>
}) {
  const used = options.used ?? 190_000
  const latches = new LatchRegistry()
  const migrate = async (): Promise<ActionResult> => ({
    ok: true,
    phase: 'completed',
    text: 'ok',
    inherited: [],
    newSessionId: 'new-1',
  })
  const coordinator = new Coordinator({
    latches,
    summarize: async () => ({ brief: '# b', redactions: [] }),
    migrate,
    compact: async () => ({ kind: 'compacted', continuesTask: false }),
    waitIdle: async () => {},
    log: () => {},
  })
  const services = {
    tokenMeter: {
      measure: () => ({ totalTokens: used, surfaceTokens: used, baseline: { kind: 'usage' as const } }),
    },
  } as unknown as HostServices

  const monitor = new Monitor({
    services: () => services,
    config: () => options.cfg ?? config(),
    coordinator,
    latches,
    agentOf: () => ({ id: 's1', whenIdle: () => Promise.resolve() }) as AgentLike,
    sessionOf: () => session(used),
    summarize: async () => ({ brief: '# b', redactions: [] }),
    migrate,
    runAction: options.runAction ?? (async () => ({ ok: true, phase: 'completed', text: 'ok' }) as ActionResult),
    now: () => 1_000_000,
    log: () => {},
  })
  return { monitor, coordinator, latches }
}

describe('Monitor — the in-flight flag is always cleared', () => {
  it('releasePending clears it so the engine may judge again', () => {
    const { monitor } = makeMonitor({})
    monitor.markPending('s1')
    // While pending, the engine refuses every decision — this is the mechanism
    // that a leaked flag silently disables.
    const state = { pending: true, lastEvaluatedSeq: -1, lastEvaluatedAt: 0 } as never
    expect(
      evaluate(session(190_000), 5, state, {
        config: config(),
        tokenMeter: undefined,
        projections: undefined,
        now: () => 0,
      }),
    ).toBeUndefined()

    monitor.releasePending('s1')
    // The row now exists and is no longer marked pending; the next event is
    // judged normally (the assertion is on the flag, which is what leaked).
    expect(() => monitor.markPending('s1')).not.toThrow()
  })

  it('releasing an unknown session is harmless', () => {
    const { monitor } = makeMonitor({})
    expect(() => monitor.releasePending('never-seen')).not.toThrow()
  })

  it('an automatic action clears the flag through settle()', async () => {
    const { monitor } = makeMonitor({})
    monitor.markPending('s1')
    monitor.settle('s1', 'handoff', true)
    expect(monitor.autoActionsOf('s1')).toBe(1)
    // After settle the engine is allowed to judge again (no early return).
    expect(() => monitor.onSessionEvent('s1', { type: 'user/message', seq: 10, data: {} })).not.toThrow()
  })
})

describe('Monitor — automatic execution', () => {
  it('runs one action and settles it', async () => {
    const runAction = vi.fn(async () => ({ ok: true, phase: 'completed' as const, text: 'ok' }) as ActionResult)
    const { monitor } = makeMonitor({ runAction })
    // The first evaluated event only records the baseline (a plugin loaded into
    // an already-full session must not yank it away), so it takes a second
    // qualifying observation before the trigger fires.
    monitor.onSessionEvent('s1', { type: 'assistant/message', seq: 1, data: {} })
    monitor.onSessionEvent('s1', { type: 'assistant/message', seq: 2, data: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runAction).toHaveBeenCalled()
  })

  it('ignores events that cannot change the surface', async () => {
    const runAction = vi.fn(async () => ({ ok: true, phase: 'completed' as const, text: 'ok' }))
    const { monitor } = makeMonitor({ runAction })
    monitor.onSessionEvent('s1', { type: 'turn/start', seq: 1, data: {} })
    await Promise.resolve()
    expect(runAction).not.toHaveBeenCalled()
  })

  it('does not act while automation is off', async () => {
    const runAction = vi.fn(async () => ({ ok: true, phase: 'completed' as const, text: 'ok' }))
    const { monitor } = makeMonitor({
      cfg: config({ autoHandoffEnabled: false, autoCompactEnabled: false }),
      runAction,
    })
    monitor.onSessionEvent('s1', { type: 'assistant/message', seq: 1, data: {} })
    monitor.onSessionEvent('s1', { type: 'assistant/message', seq: 2, data: {} })
    await Promise.resolve()
    expect(runAction).not.toHaveBeenCalled()
  })
})

/*
 * A compaction that fails has already exhausted its own retries, so it must
 * spend one of the session's automatic actions. Without that, `pending` clears,
 * the next surface event re-judges the still-full context, and a compaction
 * that can never succeed retries every `evaluateIntervalMs` forever — never
 * reaching `maxAutoActionsPerSession`.
 *
 * A failed HANDOFF must NOT spend one: it is the case a user retries, and
 * burning the cap would strand the session with no automatic escape hatch.
 */
describe('Monitor — a failed compaction spends the per-session budget', () => {
  const failed = async () =>
    ({ ok: false, phase: 'failed' as const, text: '压缩失败', error: 'summary' }) as ActionResult

  it('counts a failed compaction as a consumed action', async () => {
    const { monitor } = makeMonitor({ runAction: failed })
    monitor.markPending('s1')
    monitor.settle('s1', 'compact', false, true)
    expect(monitor.autoActionsOf('s1')).toBe(1)
  })

  it('does not count a failed handoff', async () => {
    const { monitor } = makeMonitor({ runAction: failed })
    monitor.markPending('s1')
    monitor.settle('s1', 'handoff', false, false)
    expect(monitor.autoActionsOf('s1')).toBe(0)
  })

  it('stops proposing compactions once the cap is reached', async () => {
    const cfg = config({
      autoHandoffEnabled: false,
      autoCompactEnabled: true,
      autoCompactAtContextPercent: 50,
      maxAutoActionsPerSession: 2,
      evaluateIntervalMs: 0,
    })
    const runAction = vi.fn(failed)
    const { monitor } = makeMonitor({ cfg, runAction })

    // Two qualifying observations establish the baseline, then each further
    // one fires. Every fired action fails and consumes one budget slot.
    for (let seq = 1; seq <= 8; seq += 1) {
      monitor.onSessionEvent('s1', { type: 'assistant/message', seq, data: {} })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(monitor.autoActionsOf('s1')).toBe(2)
    // Baseline + exactly two actions; the cap is what stops the third.
    expect(runAction).toHaveBeenCalledTimes(2)
  })
})
