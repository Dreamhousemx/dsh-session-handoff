/**
 * The nine-section handoff brief.
 *
 * The structure is fixed so the receiving session always knows where to look,
 * and so the host can verify a model actually answered the question instead of
 * prose-dumping. Sections are rendered with explicit headings the new session is
 * told to treat as fact.
 *
 * Two kinds of content go in:
 *
 * - **Facts**, read by this process from the session itself (cwd, preset, model,
 *   permission, plan mode, spend, occupancy). The model never gets to restate
 *   these, because a model summarizing its own configuration is a model
 *   guessing.
 * - **Narrative**, written by the outgoing session's model: goals, decisions,
 *   what is left. This is the part no program can derive, and the reason a
 *   handoff beats starting cold.
 *
 * The model call is bounded (`summaryMaxTokens`) and its failure is fatal to the
 * handoff: a new session started without a brief would lose the whole point and
 * duplicate work the old session already did.
 */
import { foldUsageFromEvents, percentOf, type ContextOccupancy, type CumulativeUsage } from './measure.ts'
import { redactWithReport } from './redaction.ts'
import type { SessionEventLike, SessionLike } from './contracts.ts'

/** The nine sections, in order, with the prompt wording for each. */
export const BRIEF_SECTIONS = [
  { key: 'goal', title: '总体目标' },
  { key: 'constraints', title: '约束' },
  { key: 'done', title: '已完成' },
  { key: 'progress', title: '当前进度' },
  { key: 'files', title: '已改文件' },
  { key: 'decisions', title: '关键决策' },
  { key: 'problems', title: '已知问题' },
  { key: 'remaining', title: '未完成' },
  { key: 'next', title: '下一步' },
] as const

export type BriefSectionKey = (typeof BRIEF_SECTIONS)[number]['key']

/** Facts about the outgoing session, read by the plugin rather than the model. */
export interface SessionFacts {
  readonly cwd: string | undefined
  readonly agentPreset: string | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly contextWindow: number | undefined
  readonly permissionPreset: string | undefined
  readonly planMode: 'on' | 'off' | 'unknown'
  readonly occupancy: ContextOccupancy
  readonly cumulative: CumulativeUsage
  readonly turnCount: number
}

/** Narrative the model produced, already split by section. */
export interface BriefNarrative {
  readonly goal?: string
  readonly constraints?: string
  readonly done?: string
  readonly progress?: string
  readonly files?: string
  readonly decisions?: string
  readonly problems?: string
  readonly remaining?: string
  readonly next?: string
}

/** Read the facts this process can observe directly. */
export function readSessionFacts(input: {
  session: SessionLike | undefined
  occupancy: ContextOccupancy
  cumulative: CumulativeUsage
  events?: readonly { type: string }[] | undefined
}): SessionFacts {
  const header = input.session?.header
  let requestContext: { provider?: string; model?: string; contextWindow?: number } | undefined
  try {
    requestContext = input.session?.requestContext?.()
  } catch {
    requestContext = undefined
  }
  const headerConfig = safely(() => input.session?.requestHeader?.()?.config)

  const turnCount = (input.events ?? []).filter((event) => event.type === 'turn/start').length

  return {
    cwd: header?.cwd,
    agentPreset: header?.agentPreset,
    provider: requestContext?.provider ?? headerConfig?.provider,
    model: requestContext?.model ?? headerConfig?.model,
    contextWindow: requestContext?.contextWindow,
    permissionPreset: undefined, // filled by the caller, which owns the services
    planMode: 'unknown',
    occupancy: input.occupancy,
    cumulative: input.cumulative,
    turnCount,
  }
}

function safely<T>(read: () => T | undefined): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** The prompt sent to the outgoing model. Every section name is explicit. */
/**
 * Render the conversation itself into the prompt.
 *
 * Without this the model only sees configuration facts and a list of headings,
 * so every section comes back "未知" — and the brief is worthless precisely when
 * it matters. The first real handoff produced exactly that: nine sections of
 * "unknown" because the transcript was never sent.
 *
 * The transcript is bounded by characters, keeping the most recent turns, since
 * what the session is doing now matters more than how it started. Tool traffic
 * is collapsed: arguments and results are truncated, because the brief needs to
 * know *what* was done, not the full output of every command.
 */
export function renderTranscript(
  events: readonly SessionEventLike[] | undefined,
  budgetChars = 24_000,
): string {
  if (events === undefined || events.length === 0) return '（没有可读的对话记录）'

  const lines: string[] = []
  for (const event of events) {
    const line = renderEvent(event)
    if (line !== undefined) lines.push(line)
  }

  // Keep the tail: recent activity is what the successor must continue.
  let total = 0
  let start = lines.length
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const next = total + lines[i]!.length + 1
    if (next > budgetChars) break
    total = next
    start = i
  }

  const kept = lines.slice(start)
  const omitted = start
  return (omitted > 0 ? `（省略较早的 ${omitted} 条记录）\n` : '') + kept.join('\n')
}

/** One compact line per meaningful event; everything else is dropped. */
function renderEvent(event: SessionEventLike): string | undefined {
  const data = event.data ?? {}
  if (event.type === 'user/message') {
    const text = blocksToText(data['message'] ?? data)
    return text.length === 0 ? undefined : `[用户] ${truncate(text, 600)}`
  }
  if (event.type === 'assistant/message') {
    const message = data['message'] as { content?: unknown } | undefined
    const text = blocksToText(message)
    return text.length === 0 ? undefined : `[助手] ${truncate(text, 900)}`
  }
  if (event.type === 'tool/call') {
    const name = typeof data['name'] === 'string' ? data['name'] : '?'
    const args = typeof data['arguments'] === 'string' ? data['arguments'] : ''
    return `[工具 ${name}] ${truncate(args, 240)}`
  }
  if (event.type === 'tool/result') {
    const message = data['message'] as { content?: unknown } | undefined
    const text = blocksToText(message)
    return `[工具结果] ${truncate(text, 240)}`
  }
  return undefined
}

/** Flatten a message's content blocks into plain text. */
function blocksToText(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      if (typeof record['text'] === 'string') return record['text']
      if (typeof record['arguments'] === 'string') return record['arguments']
      return ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

export function buildSummaryPrompt(facts: SessionFacts, transcript?: string): string {
  const lines: string[] = [
    '你要为「会话交接」写一份简报：当前会话即将停止，同一工作区会开一个新会话接着做。',
    '新会话看不到你现在的对话历史，只会收到这份简报。',
    '',
    '要求：',
    '- 严格按下面的小节输出，使用「## 小节名」作为标题，顺序固定。',
    '- 每节写具体的、可执行的内容；不要复述你已经说过的客套话，不要写「我理解了」之类的过渡语。',
    '- 「已改文件」列真实路径；「下一步」列具体的下一条动作。',
    '- 优先依据下面提供的对话记录来写，不要写「未知」除非记录里确实没有线索。',
    '- 不要编造未发生的事。',
    '- 不要包含任何密钥、令牌、密码或连接串的值；需要引用时只写键名。',
    '',
    `会话事实（由程序读取，请勿改写）：cwd=${facts.cwd ?? '未知'}，preset=${facts.agentPreset ?? '默认'}，模型=${facts.provider ?? '?'}/${facts.model ?? '?'}，已完成 turn 数=${facts.turnCount}。`,
    '',
    '对话记录（从旧到新，工具输出已截断）：',
    transcript === undefined ? '（未提供）' : transcript,
    '',
    ...BRIEF_SECTIONS.map((section) => `## ${section.title}`),
  ]
  return lines.join('\n')
}

/**
 * Split model output into sections.
 *
 * Accepts the `## 标题` form the prompt asks for, tolerates `**标题**`, `###`,
 * and a trailing colon, and assigns text before the first heading to the goal
 * section so a model that forgot the headings still produces something usable.
 */
export function parseNarrative(raw: string): BriefNarrative {
  const text = raw.replace(/\r\n/g, '\n')
  const titleToKey = new Map<string, BriefSectionKey>(
    BRIEF_SECTIONS.map((section) => [section.title, section.key]),
  )

  const found = new Map<BriefSectionKey, string[]>()
  let current: BriefSectionKey | undefined

  for (const line of text.split('\n')) {
    const heading = matchHeading(line)
    if (heading !== undefined) {
      const key = titleToKey.get(heading.title)
      if (key !== undefined) {
        current = key
        if (!found.has(key)) found.set(key, [])
        // `**标题**：正文` puts the first line of content on the heading line.
        if (heading.remainder.length > 0) found.get(key)!.push(heading.remainder)
        continue
      }
    }
    if (current !== undefined) {
      found.get(current)!.push(line)
    }
  }

  const narrative: { -readonly [K in keyof BriefNarrative]: string } = {}
  let seenHeading = false
  for (const section of BRIEF_SECTIONS) {
    const body = found.get(section.key)
    if (body !== undefined) seenHeading = true
    const value = (body ?? []).join('\n').trim()
    if (value.length > 0) narrative[section.key] = value
  }

  if (!seenHeading) {
    const whole = text.trim()
    if (whole.length > 0) narrative.goal = whole
  }

  return narrative
}

/** Recognise `## 标题`, `### **标题**`, and `**标题**：正文`, returning the trailing content. */
function matchHeading(line: string): { title: string; remainder: string } | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined

  const hashes = /^#{1,6}\s+(.+)$/.exec(trimmed)
  const withoutHashes = hashes?.[1] ?? trimmed

  // `**标题**` optionally followed by `:` / `：` and the first line of content.
  const bold = /^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/.exec(withoutHashes.trim())
  if (bold !== null) {
    const title = bold[1]!.trim()
    return title.length > 0 ? { title, remainder: (bold[2] ?? '').trim() } : undefined
  }

  const plain = withoutHashes.replace(/[:：]\s*$/, '').replace(/^\*\*|\*\*$/g, '').trim()
  return plain.length > 0 ? { title: plain, remainder: '' } : undefined
}

/** Count how many of the nine sections carry content. */
export function sectionCoverage(narrative: BriefNarrative): number {
  return BRIEF_SECTIONS.filter((section) => {
    const value = narrative[section.key]
    return typeof value === 'string' && value.trim().length > 0
  }).length
}

/**
 * A brief that carries almost nothing is a failed handoff in disguise.
 *
 * At least three sections must be non-empty. A model that answered with
 * headings and no content, or refused, produces a new session that knows less
 * than the old one did — and the old one is about to be retired.
 */
export const MIN_SECTION_COVERAGE = 3

export function narrativeIsUsable(narrative: BriefNarrative): boolean {
  return sectionCoverage(narrative) >= MIN_SECTION_COVERAGE
}

/** Render the final brief, including the redaction report. */
export function renderBrief(input: {
  facts: SessionFacts
  narrative: BriefNarrative
  sourceSessionId: string
  createdAt: number
}): { text: string; redactions: readonly string[] } {
  const { facts, narrative } = input
  const occupancyPercent = percentOf(facts.occupancy)
  const applied = new Set<string>()

  const section = (title: string, body: string | undefined): string => {
    const result = body === undefined ? undefined : redactWithReport(body)
    if (result !== undefined) for (const rule of result.applied) applied.add(rule)
    const content = result !== undefined && result.text.trim().length > 0 ? result.text.trim() : '（未提供）'
    return `## ${title}\n${content}`
  }

  const factsBlock = [
    `- 工作目录：${facts.cwd ?? '未知'}`,
    `- Agent preset：${facts.agentPreset ?? '默认'}`,
    `- 模型：${facts.provider ?? '?'} / ${facts.model ?? '?'}${
      facts.contextWindow === undefined ? '' : `（上下文窗口 ${facts.contextWindow} tokens）`
    }`,
    `- 权限预设：${facts.permissionPreset ?? '未知'}`,
    `- Plan 模式：${facts.planMode === 'unknown' ? '未知' : facts.planMode === 'on' ? '开启' : '关闭'}`,
    `- 上下文占用：${
      occupancyPercent === undefined
        ? '模型未上报窗口'
        : `${occupancyPercent}%（${facts.occupancy.used} / ${facts.occupancy.window} tokens，${facts.occupancy.quality === 'exact' ? '精确' : '估算'}）`
    }`,
    `- 累计消费：${facts.cumulative.tokens} tokens（${
      facts.cumulative.source === 'projection' ? '日志投影' : facts.cumulative.source === 'meter' ? '估算' : '不可用'
    }）`,
    `- 已完成 turn：${facts.turnCount}`,
    `- 原会话：${input.sourceSessionId}`,
    `- 生成时间：${new Date(input.createdAt).toISOString()}`,
  ].join('\n')

  const parts: string[] = [
    '# 会话交接简报',
    '',
    '> 你接手的是同一工作区里另一个会话的中途任务。下面是上一段会话留下的交接简报，',
    '> 「会话事实」由程序读取，「总体目标」到「下一步」由上一段会话的模型撰写。',
    '> 请先读完整份简报，再从「下一步」继续；不要重复「已完成」里已经做完的事。',
    '',
    '**开工前先做两件事，把结果原样报告给用户：**',
    '1. 把本简报的「总体目标」「已完成」「下一步」三节原文打印出来，让用户确认交接内容没有丢失。',
    '2. 复查本插件（`dsh-session-handoff/`）：重点看交接链路——度量、触发、软终止、简报、',
    '   会话迁移与配置继承、归档——有没有与宿主 API 不符、静默降级或逻辑缺口。',
    '   有发现就列出来并说明证据；没有发现就说「未发现问题」，不要编造。',
    '',
    '## 会话事实',
    factsBlock,
    '',
    ...BRIEF_SECTIONS.map((entry) => section(entry.title, narrative[entry.key])),
    '',
    '## 交接附注',
    applied.size > 0
      ? `简报中有 ${applied.size} 类敏感信息已被替换为占位符（${[...applied].join('、')}）。如需原始值，请在当前会话重新读取来源文件。`
      : '未发现需要脱敏的内容。',
  ]

  return { text: parts.join('\n'), redactions: [...applied] }
}

/**
 * Fallback facts for a session whose agent already went away.
 *
 * The brief must still be writable from the durable log alone: `cwd` and preset
 * come from the header, spend from folding the log. Occupancy cannot be
 * recomputed without the meter, and the brief says so instead of inventing it.
 */
export function factsFromLog(
  session: SessionLike | undefined,
  events: readonly { type: string; data?: Record<string, unknown> }[] | undefined,
): SessionFacts {
  const header = session?.header
  return {
    cwd: header?.cwd,
    agentPreset: header?.agentPreset,
    provider: undefined,
    model: undefined,
    contextWindow: undefined,
    permissionPreset: undefined,
    planMode: 'unknown',
    occupancy: {
      quality: 'unavailable',
      used: 0,
      window: undefined,
      percent: undefined,
      baseline: 'none',
    },
    cumulative: {
      quality: events === undefined ? 'unavailable' : 'estimated',
      tokens: foldUsageFromEvents(events as never),
      source: events === undefined ? 'none' : 'projection',
    },
    turnCount: (events ?? []).filter((event) => event.type === 'turn/start').length,
  }
}
