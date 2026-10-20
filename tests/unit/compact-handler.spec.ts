import { describe, expect, it, vi } from 'vitest'
import { COMPACT_BACKOFF_MS, COMPACT_MAX_RETRIES, compact } from '@src/compact-handler.ts'
import type { AgentLike, CompactionLike } from '@src/contracts.ts'

const agent: AgentLike = { id: 's1' }

function compaction(behave: () => Promise<unknown>): CompactionLike {
  return { compactNow: behave as CompactionLike['compactNow'] }
}

function busy(): Error {
  const error = new Error('compaction is busy')
  ;(error as { code?: string }).code = 'busy'
  return error
}

function deps(overrides: Partial<Parameters<typeof compact>[1]> = {}) {
  return {
    compaction: compaction(async () => ({ kind: 'ok' })),
    waitIdle: async () => {},
    sleep: async () => {},
    signal: new AbortController().signal,
    interruptedRunningTurn: true,
    ...overrides,
  }
}

describe('compact', () => {
  it('reports a completed compaction and whether it must be followed by "continue"', async () => {
    const outcome = await compact(agent, deps())
    expect(outcome).toEqual({ kind: 'compacted', continuesTask: true })
  })

  it('does not ask an idle session to continue', async () => {
    const outcome = await compact(agent, deps({ interruptedRunningTurn: false }))
    expect(outcome).toEqual({ kind: 'compacted', continuesTask: false })
  })

  it('treats a null result as "nothing to do", not a failure', async () => {
    const outcome = await compact(
      agent,
      deps({ compaction: compaction(async () => null) }),
    )
    expect(outcome.kind).toBe('nothing-to-do')
  })

  it(`retries busy at most ${COMPACT_MAX_RETRIES} times with backoff`, async () => {
    const sleep = vi.fn(async () => {})
    const waitIdle = vi.fn(async () => {})
    let calls = 0
    const outcome = await compact(
      agent,
      deps({
        compaction: compaction(async () => {
          calls += 1
          throw busy()
        }),
        sleep,
        waitIdle,
      }),
    )

    expect(outcome).toMatchObject({ kind: 'failed', code: 'busy' })
    expect(calls).toBe(COMPACT_MAX_RETRIES + 1)
    expect(sleep).toHaveBeenCalledTimes(COMPACT_MAX_RETRIES)
    expect(sleep).toHaveBeenCalledWith(COMPACT_BACKOFF_MS)
    // Each retry re-acquires a safe point first.
    expect(waitIdle).toHaveBeenCalledTimes(COMPACT_MAX_RETRIES)
  })

  it('succeeds when a busy retry eventually lands', async () => {
    let calls = 0
    const outcome = await compact(
      agent,
      deps({
        compaction: compaction(async () => {
          calls += 1
          if (calls < 3) throw busy()
          return { kind: 'ok' }
        }),
      }),
    )
    expect(outcome.kind).toBe('compacted')
    expect(calls).toBe(3)
  })

  it('does not retry a non-busy failure', async () => {
    let calls = 0
    const outcome = await compact(
      agent,
      deps({
        compaction: compaction(async () => {
          calls += 1
          const error = new Error('summary failed')
          ;(error as { code?: string }).code = 'summary'
          throw error
        }),
      }),
    )
    expect(outcome).toMatchObject({ kind: 'failed', code: 'summary', retryable: false })
    expect(calls).toBe(1)
  })

  it('stops retrying when the session cannot report idle', async () => {
    let calls = 0
    const outcome = await compact(
      agent,
      deps({
        compaction: compaction(async () => {
          calls += 1
          throw busy()
        }),
        waitIdle: async () => {
          throw new Error('no idle')
        },
      }),
    )
    expect(outcome).toMatchObject({ kind: 'failed', code: 'busy' })
    expect(calls).toBe(1)
  })

  it('fails clearly when the deployment has no compaction service', async () => {
    const outcome = await compact(agent, deps({ compaction: undefined }))
    expect(outcome).toMatchObject({ kind: 'failed', code: 'unavailable' })
  })

  it('fails clearly without an agent', async () => {
    const outcome = await compact(undefined, deps())
    expect(outcome).toMatchObject({ kind: 'failed', code: 'no-agent' })
  })
})
