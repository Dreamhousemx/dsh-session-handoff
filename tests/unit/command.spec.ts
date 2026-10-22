/**
 * The `/handoff status` report and the `/handoff` command family.
 *
 * These are the two things a human actually reads when something goes wrong, and
 * neither had a test: the command table was covered only through `parseCommandArgs`,
 * and `renderStatus` was covered nowhere. That left the exact wording in the
 * acceptance checklist resting on a hand-read of the source, which is precisely
 * the kind of claim that drifts once someone edits a line.
 *
 * The assertions below pin the parts a user acts on — which subcommands exist, the
 * three verdict labels, and whether a missing context window is admitted or
 * papered over — without freezing cosmetic whitespace.
 */
import { describe, expect, it, vi } from 'vitest'
import { parseCommandArgs, renderStatus, runCommand } from '@src/command'

const baseStatus = {
  phase: 'idle',
  busy: false,
  latched: false,
  waitingForStep: false,
  slowWarning: false,
  occupancy: { quality: 'exact', used: 70_049, window: 1_000_000, percent: 0.070049 },
  cumulative: { tokens: 3_504_998, source: 'projection' },
  thresholds: {
    handoffPercent: 40,
    compactPercent: 70,
    cumulative: 2_000_000,
    enabled: false,
    compactEnabled: false,
  },
  autoActions: 0,
  maxAutoActions: 3,
  warnings: [] as string[],
  persistence: 'durable' as const,
}

describe('parseCommandArgs', () => {
  it('treats a bare command as a handoff', () => {
    expect(parseCommandArgs(undefined)).toEqual({ kind: 'handoff' })
    expect(parseCommandArgs('   ')).toEqual({ kind: 'handoff' })
  })

  it('accepts the three subcommands case-insensitively', () => {
    expect(parseCommandArgs('status').kind).toBe('status')
    expect(parseCommandArgs('CANCEL').kind).toBe('cancel')
    expect(parseCommandArgs('Retry').kind).toBe('retry')
  })

  it('reports a typo together with the valid words', () => {
    const parsed = parseCommandArgs('bogus')
    expect(parsed.kind).toBe('help')
    if (parsed.kind !== 'help') throw new Error('unreachable')
    expect(parsed.reason).toContain('未知子命令「bogus」')
    expect(parsed.reason).toContain('/handoff status')
    expect(parsed.reason).toContain('/handoff cancel')
    expect(parsed.reason).toContain('/handoff retry')
  })

  it('only reads the first word, so trailing text is ignored', () => {
    expect(parseCommandArgs('status now please').kind).toBe('status')
  })
})

describe('renderStatus', () => {
  it('renders the six stable lines', () => {
    const text = renderStatus(baseStatus)
    const lines = text.split('\n')

    expect(lines[0]).toBe('## 会话交接状态')
    expect(text).toContain('- 阶段：idle')
    expect(text).toContain('- 上下文占用：70049 / 1000000 tokens · 7% · 精确')
    expect(text).toContain('- 累计消费：3504998 tokens（日志投影）')
    expect(text).toContain('- 自动交接阈值：未启用（仅手动）')
    expect(text).toContain('- 自动压缩阈值：未启用')
    expect(text).toContain('- 本会话自动动作：0 / 3')
    expect(lines).toHaveLength(7)
  })

  it('names the accessor so a disagreement is diagnosable', () => {
    const fromProjection = renderStatus({
      ...baseStatus,
      occupancy: {
        quality: 'exact',
        used: 274_086,
        window: 1_000_000,
        percent: 0.274086,
        source: 'contextPressure',
      },
    })
    expect(fromProjection).toContain('27%')
    expect(fromProjection).toContain('与输入框一致')

    const fallback = renderStatus({
      ...baseStatus,
      occupancy: {
        quality: 'estimated',
        used: 321_382,
        window: 1_000_000,
        percent: 0.321382,
        source: 'meter-surface',
      },
    })
    expect(fallback).toContain('32%')
    expect(fallback).toContain('回退：surface 估算')
  })

  it('admits a missing context window instead of printing 0%', () => {
    const text = renderStatus({
      ...baseStatus,
      occupancy: { quality: 'unavailable', used: 70_049, window: undefined, percent: undefined },
    })

    expect(text).toContain('未知（模型未上报上下文窗口）')
    expect(text).toContain('不可用')
    expect(text).not.toContain('0%')
    // With no window there is nothing to show after the used count.
    expect(text).toContain('- 上下文占用：70049 tokens')
  })

  it('shows the thresholds once automation is on', () => {
    const text = renderStatus({
      ...baseStatus,
      thresholds: {
        handoffPercent: 85,
        compactPercent: 70,
        cumulative: 2_000_000,
        enabled: true,
        compactEnabled: true,
      },
    })

    expect(text).toContain('- 自动交接阈值：占用率 85%、累计 2000000 tokens')
    expect(text).toContain('- 自动压缩阈值：占用率 70%')
  })

  it('explains a wait, a new session, and the last result together', () => {
    const text = renderStatus({
      ...baseStatus,
      waitingForStep: true,
      slowWarning: true,
      newSessionId: 'session-new',
      lastText: '交接完成。\n附带一行',
      lastFailure: '上一回超时\n细节',
    })

    expect(text).toContain('- 正在等待当前 Step 完成…（等待时间偏长）')
    expect(text).toContain('- 新会话：session-new')
    // Multi-line verdicts are collapsed so the report stays one line per fact.
    expect(text).toContain('- 最近结果：交接完成。 · 附带一行')
    expect(text).toContain('- 最近失败：上一回超时 · 细节')
  })

  it('marks the latch when one is held', () => {
    const text = renderStatus({ ...baseStatus, busy: true, latched: true })
    expect(text).toContain('- 阶段：idle（进行中） · 已设停止闩锁')
  })

  it('warns when settings are only kept in memory', () => {
    const text = renderStatus({
      ...baseStatus,
      persistence: 'memory',
      warnings: ['窗口未知'],
    })
    expect(text).toContain('- ⚠ 当前部署没有 settings 服务，设置只在本次进程内有效。')
    expect(text).toContain('- ⚠ 窗口未知')
  })
})

describe('runCommand', () => {
  const deps = {
    handoff: vi.fn(async () => ({ ok: true, phase: 'completed' as const, text: '交接完成' })),
    cancel: vi.fn(() => true),
    status: vi.fn(() => '状态文本'),
    retry: vi.fn(async () => ({ ok: false, phase: 'failed' as const, text: '重试失败' })),
  }

  it('routes each subcommand to its dependency', async () => {
    expect(await runCommand({ kind: 'status' }, 's1', deps)).toEqual({ ok: true, text: '状态文本' })
    expect(deps.status).toHaveBeenCalledWith('s1')

    expect((await runCommand({ kind: 'handoff' }, 's1', deps)).ok).toBe(true)
    expect(deps.handoff).toHaveBeenCalledWith('s1', '手动 /handoff')

    expect((await runCommand({ kind: 'retry' }, 's1', deps)).ok).toBe(false)
    expect(deps.retry).toHaveBeenCalledWith('s1')
  })

  it('reports a cancel that had nothing to cancel', async () => {
    const idle = { ...deps, cancel: vi.fn(() => false) }
    expect(await runCommand({ kind: 'cancel' }, 's1', idle)).toEqual({
      ok: true,
      text: '当前没有进行中的动作，无需取消。',
    })
  })

  it('marks a bad subcommand as a failure, not a silent success', async () => {
    const result = await runCommand(parseCommandArgs('bogus'), 's1', deps)
    expect(result.ok).toBe(false)
  })
})
