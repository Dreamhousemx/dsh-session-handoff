import { describe, expect, it, vi } from 'vitest'
import {
  LatchRegistry,
  batchHasHumanInput,
  decidePreStep,
  waitForBoundary,
} from '@src/graceful-stop.ts'
import type { AgentLike, AgentMessageLike } from '@src/contracts.ts'

const human: AgentMessageLike = { role: 'user', source: { kind: 'user' } }
const plugin: AgentMessageLike = { role: 'user', source: { kind: 'plugin' } }
const goal: AgentMessageLike = { role: 'user', source: { kind: 'goal' } }

describe('batchHasHumanInput', () => {
  it('finds human input among other messages', () => {
    expect(batchHasHumanInput([plugin, human])).toBe(true)
  })

  it('ignores plugin and goal injections', () => {
    expect(batchHasHumanInput([plugin, goal])).toBe(false)
  })

  it('treats an unclassified source as human, because swallowing it is worse', () => {
    expect(batchHasHumanInput([{ role: 'user' }])).toBe(true)
    expect(batchHasHumanInput([{ role: 'user', source: {} }])).toBe(true)
  })

  it('treats an empty or missing batch as no human input', () => {
    expect(batchHasHumanInput([])).toBe(false)
    expect(batchHasHumanInput(undefined)).toBe(false)
  })
})

describe('decidePreStep', () => {
  it('leaves the decision alone when no latch is held', () => {
    expect(decidePreStep(false, [plugin])).toBeUndefined()
  })

  it('rejects the next step when latched and no human input is present', () => {
    expect(decidePreStep(true, [plugin])).toEqual({ kind: 'reject' })
    expect(decidePreStep(true, [])).toEqual({ kind: 'reject' })
  })

  it('yields to human input so the message is never swallowed', () => {
    expect(decidePreStep(true, [human])).toBeUndefined()
  })
})

describe('LatchRegistry', () => {
  it('arms, reports, and releases a latch', async () => {
    const registry = new LatchRegistry()
    const latch = registry.arm('s1', 100)
    expect(registry.isLatched('s1')).toBe(true)
    expect(registry.get('s1')).toBe(latch)

    expect(registry.release('s1', 'boundary')).toBe(true)
    await expect(latch.released).resolves.toBeUndefined()
    expect(registry.isLatched('s1')).toBe(false)
  })

  it('re-arming releases the previous wait instead of orphaning it', async () => {
    const registry = new LatchRegistry()
    const first = registry.arm('s1', 100)
    const second = registry.arm('s1', 200)
    await expect(first.released).resolves.toBeUndefined()
    expect(registry.get('s1')?.token).toBe(second.token)
  })

  it('a stale token cannot clear a newer latch', () => {
    const registry = new LatchRegistry()
    const first = registry.arm('s1', 100)
    registry.arm('s1', 200)
    expect(registry.release('s1', 'error', first.token)).toBe(false)
    expect(registry.isLatched('s1')).toBe(true)
  })

  it('releases every latch on unload', async () => {
    const registry = new LatchRegistry()
    const a = registry.arm('s1', 1)
    const b = registry.arm('s2', 1)
    registry.releaseAll('cancel')
    await expect(a.released).resolves.toBeUndefined()
    await expect(b.released).resolves.toBeUndefined()
    expect(registry.ids()).toEqual([])
  })
})

describe('waitForBoundary', () => {
  it('reports reached when the agent goes idle', async () => {
    const agent: AgentLike = { id: 's1', whenIdle: () => Promise.resolve() }
    const outcome = await waitForBoundary(agent, 1000)
    expect(outcome).toMatchObject({ reached: true, reason: 'boundary' })
  })

  it('times out without cancelling anything', async () => {
    const cancel = vi.fn()
    const agent = {
      id: 's1',
      whenIdle: () => new Promise<void>(() => {}),
      // Not part of AgentLike; present only to prove this module never calls it.
      cancel,
    } as unknown as AgentLike

    const outcome = await waitForBoundary(agent, 20)
    expect(outcome.reached).toBe(false)
    expect(outcome.reason).toBe('timeout')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('fails honestly when the host exposes no idle signal', async () => {
    const agent: AgentLike = { id: 's1' }
    const outcome = await waitForBoundary(agent, 1000)
    expect(outcome.reached).toBe(false)
    expect(outcome.reason).toBe('error')
    expect(outcome.error).toContain('whenIdle')
  })

  it('fails when there is no agent at all', async () => {
    const outcome = await waitForBoundary(undefined, 1000)
    expect(outcome.reason).toBe('error')
  })

  it('turns a rejected idle promise into an error instead of an unhandled rejection', async () => {
    const agent: AgentLike = {
      id: 's1',
      whenIdle: () => Promise.reject(new Error('driver gone')),
    }
    const outcome = await waitForBoundary(agent, 1000)
    expect(outcome.reason).toBe('error')
    expect(outcome.error).toBe('driver gone')
  })

  it('reports cancellation through the abort signal', async () => {
    const controller = new AbortController()
    const agent: AgentLike = { id: 's1', whenIdle: () => new Promise<void>(() => {}) }
    const pending = waitForBoundary(agent, 1000, controller.signal)
    controller.abort()
    const outcome = await pending
    expect(outcome.reason).toBe('error')
    expect(outcome.error).toBe('等待被取消')
  })
})

/*
 * The abort listener must be removed when the wait ends some other way.
 *
 * `{ once: true }` only detaches after the listener FIRES, so a wait that
 * settled via `idle` or the timeout used to leave it attached for the life of
 * the signal. Today's signals are per-action, but that is an assumption, not a
 * guarantee — a reused or long-lived signal would accumulate one listener per
 * wait.
 */
describe('waitForBoundary — the abort listener does not outlive the wait', () => {
  /** Count listeners by wrapping the signal the function will subscribe to. */
  function countingSignal() {
    const controller = new AbortController()
    let attached = 0
    const add = controller.signal.addEventListener.bind(controller.signal)
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      if (args[0] === 'abort') attached += 1
      return add(...args)
    }) as typeof add
    controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      if (args[0] === 'abort') attached -= 1
      return remove(...args)
    }) as typeof remove
    return { controller, attached: () => attached }
  }

  it('removes it when the agent reaches idle first', async () => {
    const { controller, attached } = countingSignal()
    const agent: AgentLike = { id: 's1', whenIdle: () => Promise.resolve() }

    const outcome = await waitForBoundary(agent, 1000, controller.signal)
    expect(outcome.reason).toBe('boundary')
    expect(attached()).toBe(0)
  })

  it('removes it when the timeout wins', async () => {
    const { controller, attached } = countingSignal()
    const agent: AgentLike = { id: 's1', whenIdle: () => new Promise<void>(() => {}) }

    const outcome = await waitForBoundary(agent, 20, controller.signal)
    expect(outcome.reason).toBe('timeout')
    expect(attached()).toBe(0)
  })

  it('removes it when an already-aborted signal is passed', async () => {
    const { controller, attached } = countingSignal()
    controller.abort()
    const agent: AgentLike = { id: 's1', whenIdle: () => new Promise<void>(() => {}) }

    const outcome = await waitForBoundary(agent, 1000, controller.signal)
    expect(outcome.reason).toBe('error')
    expect(attached()).toBe(0)
  })
})
