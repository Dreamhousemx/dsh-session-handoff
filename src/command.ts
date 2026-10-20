/**
 * The `/handoff` command family.
 *
 * Commands are the manual path: whatever the thresholds say, a user typing
 * `/handoff` gets a handoff. They are registered through the host's command
 * registry, whose execution path is deliberately outside the model-visible
 * history — the command and its output never appear as conversation.
 *
 * Subcommands use the second word (`/handoff status`) rather than flags, because
 * the composer sends the whole line to one handler and a typo is then reported
 * with the list of valid words.
 */
import type { ActionResult } from './types.ts'

/** What a command handler needs from the plugin. */
export interface CommandDeps {
  readonly handoff: (sessionId: string, detail?: string) => Promise<ActionResult>
  readonly cancel: (sessionId: string) => boolean
  readonly status: (sessionId: string) => string
  readonly retry: (sessionId: string) => Promise<ActionResult>
}

/** A parsed `/handoff` invocation. */
export type ParsedCommand =
  | { readonly kind: 'handoff' }
  | { readonly kind: 'status' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'help'; readonly reason: string }

const SUBCOMMANDS = new Set(['status', 'cancel', 'retry'])

/** Parse the argument text after the command name. */
export function parseCommandArgs(raw: string | undefined): ParsedCommand {
  const text = (raw ?? '').trim()
  if (text.length === 0) return { kind: 'handoff' }
  const word = text.split(/\s+/)[0]!.toLowerCase()
  if (word === 'status') return { kind: 'status' }
  if (word === 'cancel') return { kind: 'cancel' }
  if (word === 'retry') return { kind: 'retry' }
  return {
    kind: 'help',
    reason: `未知子命令「${word}」。可用：/handoff、/handoff status、/handoff cancel、/handoff retry。`,
  }
}

/** Run one parsed command against the plugin. */
export async function runCommand(
  parsed: ParsedCommand,
  sessionId: string,
  deps: CommandDeps,
): Promise<{ readonly ok: boolean; readonly text: string }> {
  switch (parsed.kind) {
    case 'help':
      // A bad subcommand is a user error, not a successful handoff report.
      return { ok: false, text: parsed.reason }
    case 'status':
      return { ok: true, text: deps.status(sessionId) }
    case 'cancel':
      return {
        ok: true,
        text: deps.cancel(sessionId)
          ? '已请求取消：当前动作会在下一个安全检查点停止。'
          : '当前没有进行中的动作，无需取消。',
      }
    case 'retry': {
      const result = await deps.retry(sessionId)
      return { ok: result.ok, text: result.text }
    }
    case 'handoff': {
      const result = await deps.handoff(sessionId, '手动 /handoff')
      return { ok: result.ok, text: result.text }
    }
  }
}

/** The human-readable `status` report. */
export function renderStatus(input: {
  phase: string
  busy: boolean
  latched: boolean
  waitingForStep: boolean
  slowWarning: boolean
  newSessionId?: string | undefined
  occupancy: {
    quality: string
    used: number
    window?: number | undefined
    percent?: number | undefined
  }
  cumulative: { tokens: number; source: string }
  thresholds: { handoffPercent: number; compactPercent: number; cumulative: number; enabled: boolean; compactEnabled: boolean }
  autoActions: number
  maxAutoActions: number
  lastText?: string | undefined
  lastFailure?: string | undefined
  warnings: readonly string[]
  persistence: 'durable' | 'memory'
}): string {
  const { occupancy, cumulative, thresholds } = input

  const percent =
    occupancy.percent === undefined ? '未知（模型未上报上下文窗口）' : `${Math.round(occupancy.percent * 100)}%`
  const window = occupancy.window === undefined ? '' : ` / ${occupancy.window}`
  const quality =
    occupancy.quality === 'exact' ? '精确' : occupancy.quality === 'estimated' ? '估算' : '不可用'

  const thresholdText = thresholds.enabled
    ? `占用率 ${thresholds.handoffPercent}%、累计 ${thresholds.cumulative} tokens`
    : '未启用（仅手动）'
  const compactText = thresholds.compactEnabled ? `占用率 ${thresholds.compactPercent}%` : '未启用'

  const lines = [
    '## 会话交接状态',
    `- 阶段：${input.phase}${input.busy ? '（进行中）' : ''}${input.latched ? ' · 已设停止闩锁' : ''}`,
    `- 上下文占用：${occupancy.used}${window} tokens · ${percent} · ${quality}`,
    `- 累计消费：${cumulative.tokens} tokens（${cumulative.source === 'projection' ? '日志投影' : cumulative.source === 'meter' ? '估算' : '不可用'}）`,
    `- 自动交接阈值：${thresholdText}`,
    `- 自动压缩阈值：${compactText}`,
    `- 本会话自动动作：${input.autoActions} / ${input.maxAutoActions}`,
  ]

  if (input.waitingForStep) {
    lines.push(`- 正在等待当前 Step 完成…${input.slowWarning ? '（等待时间偏长）' : ''}`)
  }
  if (input.newSessionId !== undefined) {
    lines.push(`- 新会话：${input.newSessionId}`)
  }
  if (input.lastText !== undefined) {
    lines.push(`- 最近结果：${oneLine(input.lastText)}`)
  }
  if (input.lastFailure !== undefined) {
    lines.push(`- 最近失败：${oneLine(input.lastFailure)}`)
  }
  if (input.persistence === 'memory') {
    lines.push('- ⚠ 当前部署没有 settings 服务，设置只在本次进程内有效。')
  }
  for (const warning of input.warnings) lines.push(`- ⚠ ${warning}`)

  return lines.join('\n')
}

/** Collapse a multi-line verdict into a single status line. */
function oneLine(text: string): string {
  return text.split('\n').filter((ln) => ln.trim().length > 0).join(' · ')
}
