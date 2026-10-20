import { describe, expect, it, vi } from 'vitest'
import { Coordinator, type ActionRequest, type CoordinatorDeps } from '@src/coordinator.ts'
import { LatchRegistry } from '@src/graceful-stop.ts'
import type { AgentLike } from '@src/contracts.ts'
import type { ActionResult } from '@src/types.ts'

/** An agent that reaches idle quickly. */
function idleAgent(): AgentLike {
  return { id: 's1', whenIdle: () => Promise.resolve() }
}

/** An agent that never reaches idle. */
function stuckAgent(): AgentLike {
  return { id: 's1', whenIdle: () => new Promise<void>(() => {}) }
}

function success(newSessionId = 'new-1'): ActionResult {
  return {
    ok: true,
    phase: 'completed',
    text: 'ok',
    newSessionId,
    inherited: [{ item: 'cwd', status: 'inherited' }],
  }
}

function deps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    latches: new LatchRegistry(),
    summarize: async () => ({ brief: '# 简报', redactions: [] }),
    migrate: async () => success(),
    compact: async () => ({ kind: 'compacted', continuesTask: false }),
    waitIdle: async () => {},
    log: () => {},
    ...overrides,
  }
}

function handoff(agent: AgentLike | undefined, overrides: Partial<ActionRequest> = {}): ActionRequest {
  return { sessionId: 's1', agent, kind: 'handoff', reason: 'manual', automatic: false, ...overrides }
}

describe('Coordinator — handoff happy path', () => {
  it('walks through the phases and reports the new session', async () => {
    const d = deps()
    const coordinator = new Coordinator(d)
    const result = await coordinator.run(handoff(idleAgent()))

    expect(result.ok).toBe(true)
    expect(result.phase).toBe('completed')
    expect(result.newSessionId).toBe('new-1')
    expect(result.text).toContain('交接完成')
    expect(coordinator.newSessionOf('s1')).toBe('new-1')
    // The latch is released no matter how the action ended.
    expect(d.latches.isLatched('s1')).toBe(false)
  })

  it('passes the rendered brief to the migration exactly once', async () => {
    const migrate = vi.fn(async () => success())
    const coordinator = new Coordinator(
      deps({ summarize: async () => ({ brief: '# 简报内容', redactions: ['token'] }), migrate }),
    )
    const result = await coordinator.run(handoff(idleAgent()))
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(migrate).toHaveBeenCalledWith('# 简报内容')
    expect(result.text).toContain('敏感信息已替换')
  })

  it('reports inherited items line by line', async () => {
    const coordinator = new Coordinator(
      deps({
        migrate: async () => ({
          ok: true,
          phase: 'completed',
          text: 'ok',
          newSessionId: 'new-2',
          inherited: [
            { item: 'cwd', status: 'inherited' },
            { item: 'permission', status: 'fallback', detail: '自定义权限' },
            { item: 'planMode', status: 'skipped', detail: '没有服务' },
          ],
        }),
      }),
    )
    const result = await coordinator.run(handoff(idleAgent()))
    expect(result.text).toContain('- cwd：已继承')
    expect(result.text).toContain('- permission：回退（自定义权限）')
    expect(result.text).toContain('- planMode：未继承（没有服务）')
  })
})

describe('Coordinator — refusals and failures', () => {
  it('refuses a second action while one is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const coordinator = new Coordinator(
      deps({
        summarize: async () => {
          await gate
          return { brief: 'b', redactions: [] }
        },
      }),
    )

    const first = coordinator.run(handoff(idleAgent()))
    // Let the first run reach the summary gate.
    await new Promise((r) => setTimeout(r, 10))
    const second = await coordinator.run(handoff(idleAgent()))
    expect(second.ok).toBe(false)
    expect(second.text).toContain('正在进行的动作')

    release()
    await expect(first).resolves.toMatchObject({ ok: true })
  })

  it('keeps the session intact when the summary fails', async () => {
    const d = deps({
      summarize: async () => {
        throw new Error('模型没有返回内容')
      },
    })
    const coordinator = new Coordinator(d)
    const result = await coordinator.run(handoff(idleAgent()))

    expect(result.ok).toBe(false)
    expect(result.phase).toBe('failed')
    expect(result.text).toContain('保留原会话')
    expect(result.text).toContain('模型没有返回内容')
    expect(d.latches.isLatched('s1')).toBe(false)
  })

  it('reports the created session id even when delivery failed', async () => {
    const coordinator = new Coordinator(
      deps({
        migrate: async () => ({
          ok: false,
          phase: 'failed',
          text: '简报投递失败',
          newSessionId: 'new-9',
          inherited: [{ item: 'cwd', status: 'inherited' }],
          error: 'delivery-failed',
        }),
      }),
    )
    const result = await coordinator.run(handoff(idleAgent()))
    expect(result.ok).toBe(false)
    expect(result.newSessionId).toBe('new-9')
    expect(result.text).toContain('可手动继续')
    // The browser can still follow this session id.
    expect(coordinator.newSessionOf('s1')).toBe('new-9')
  })

  it('fails honestly when the step boundary never arrives', async () => {
    const d = deps()
    const coordinator = new Coordinator(d)
    coordinator.configure({ stepWaitMs: 20, actionDeadlineMs: 5000 })
    const result = await coordinator.run(handoff(stuckAgent()))

    expect(result.ok).toBe(false)
    expect(result.text).toContain('超时')
    expect(result.text).toContain('原会话可继续')
    expect(d.latches.isLatched('s1')).toBe(false)
  })

  it('refuses a blank session', async () => {
    const coordinator = new Coordinator(deps())
    coordinator.activityCheck = async () => false
    const result = await coordinator.run(handoff(idleAgent()))
    expect(result.ok).toBe(false)
    expect(result.text).toContain('空白会话')
  })

  it('records a failure for the status surface', async () => {
    const coordinator = new Coordinator(
      deps({
        summarize: async () => {
          throw new Error('boom')
        },
      }),
    )
    await coordinator.run(handoff(idleAgent()))
    const status = coordinator.statusOf('s1')
    expect(status.lastFailure?.message).toContain('boom')
    expect(status.failures).toBe(1)
  })
})

describe('Coordinator — cancellation', () => {
  it('stops at the boundary without creating anything', async () => {
    let releaseIdle!: () => void
    const agent: AgentLike = {
      id: 's1',
      whenIdle: () =>
        new Promise<void>((resolve) => {
          releaseIdle = resolve
        }),
    }
    const migrate = vi.fn(async () => success())
    const coordinator = new Coordinator(deps({ migrate }))

    const run = coordinator.run(handoff(agent))
    // Let the run arm the latch and begin waiting for the boundary.
    await new Promise((r) => setTimeout(r, 10))
    expect(coordinator.requestCancel('s1')).toBe(true)
    releaseIdle()
    const result = await run

    expect(result.phase).toBe('cancelled')
    expect(migrate).not.toHaveBeenCalled()
  })

  it('reports a cancel request for an idle session as a no-op', () => {
    const coordinator = new Coordinator(deps())
    expect(coordinator.requestCancel('s1')).toBe(false)
  })
})

describe('Coordinator — compaction', () => {
  it('runs a compaction and does not wake an idle session', async () => {
    const followup = vi.fn(async () => {})
    const agent: AgentLike = { id: 's1', whenIdle: () => Promise.resolve(), followup }
    const coordinator = new Coordinator(deps())

    const result = await coordinator.run({
      sessionId: 's1',
      agent,
      kind: 'compact',
      reason: 'context',
      automatic: true,
    })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('原本空闲')
    expect(followup).not.toHaveBeenCalled()
  })

  it('sends "continue" when the compaction interrupted a running turn', async () => {
    const followup = vi.fn(async () => {})
    const agent: AgentLike = { id: 's1', whenIdle: () => Promise.resolve(), followup }
    const coordinator = new Coordinator(
      deps({ compact: async () => ({ kind: 'compacted', continuesTask: true }) }),
    )

    const result = await coordinator.run({
      sessionId: 's1',
      agent,
      kind: 'compact',
      reason: 'context',
      automatic: true,
    })

    expect(result.ok).toBe(true)
    expect(followup).toHaveBeenCalledWith('继续完成刚才的任务。', { source: { kind: 'plugin' } })
  })

  it('treats "nothing to compact" as success', async () => {
    const coordinator = new Coordinator(deps({ compact: async () => ({ kind: 'nothing-to-do' }) }))
    const result = await coordinator.run({
      sessionId: 's1',
      agent: idleAgent(),
      kind: 'compact',
      reason: 'context',
      automatic: true,
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('没有可安全压缩')
  })

  it('reports a compaction failure with its error code', async () => {
    const coordinator = new Coordinator(
      deps({
        compact: async () => ({ kind: 'failed', code: 'summary', message: '摘要失败', retryable: false }),
      }),
    )
    const result = await coordinator.run({
      sessionId: 's1',
      agent: idleAgent(),
      kind: 'compact',
      reason: 'context',
      automatic: true,
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('summary')
    expect(result.text).toContain('原会话可继续')
  })
})

describe('Coordinator — cleanup', () => {
  it('forgets a session that was disposed but keeps its new-session pointer', async () => {
    const coordinator = new Coordinator(deps())
    await coordinator.run(handoff(idleAgent()))
    coordinator.forget('s1')
    expect(coordinator.newSessionOf('s1')).toBe('new-1')
    expect(coordinator.statusOf('s1').lastResult).toBeUndefined()
  })
})

describe('automatic action wiring', () => {
  it('routes automatic runs through the caller so the source id reaches migration', async () => {
    // Mirrors the entry point: `sourceScope.run(id, () => coordinator.run(...))`
    // is what makes the migration callback see a session id at all.
    const seen: string[] = []
    const fakeScope = {
      run: <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        seen.push(id)
        return fn()
      },
    }

    const coordinator = new Coordinator(deps())
    await fakeScope.run('s-auto', () =>
      coordinator.run({
        sessionId: 's-auto',
        agent: idleAgent(),
        kind: 'handoff',
        reason: 'context',
        automatic: true,
      }),
    )

    expect(seen).toEqual(['s-auto'])
  })
})
