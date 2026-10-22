import { describe, expect, it } from 'vitest'
import { redact, redactWithReport } from '@src/redaction.ts'
import {
  BRIEF_SECTIONS,
  MIN_SECTION_COVERAGE,
  buildSummaryPrompt,
  factsFromLog,
  narrativeIsUsable,
  parseNarrative,
  renderBrief,
  renderTranscript,
  sectionCoverage,
  type SessionFacts,
} from '@src/session-summary.ts'
import { requestNarrative } from '@src/index.ts'

describe('redact', () => {
  it('removes provider tokens', () => {
    expect(redact('key is sk-abcdefghijklmnopqrstuvwx now')).toBe('key is [redacted: token] now')
    expect(redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toBe('[redacted: token]')
    expect(redact('glpat-abcdefghijklmnopqrst')).toBe('[redacted: token]')
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toBe('[redacted: token]')
  })

  it('removes a private key block as one unit', () => {
    const text = [
      'before',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA...',
      '-----END RSA PRIVATE KEY-----',
      'after',
    ].join('\n')
    const out = redact(text)
    expect(out).not.toContain('MIIEowIBAAKCAQEA')
    expect(out).toContain('[redacted: private key]')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('keeps the scheme and masks the password in a connection string', () => {
    expect(redact('postgres://admin:hunter2secret@db.local:5432/app')).toBe(
      'postgres://admin:[redacted]@db.local:5432/app',
    )
  })

  it('masks secret-looking environment assignments', () => {
    expect(redact('OPENAI_API_KEY=sk-live-verysecretvalue')).toBe('OPENAI_API_KEY=[redacted]')
    expect(redact('DB_PASSWORD: "correct horse battery"')).toBe('DB_PASSWORD=[redacted]')
    expect(redact('GITHUB_TOKEN=gh_whatever_long_enough')).toBe('GITHUB_TOKEN=[redacted]')
  })

  it('leaves ordinary prose, paths and code alone', () => {
    const text =
      'Next I will add src/session-handoff/trigger.ts and run npm test. The token counter is in measure.ts, key idea: watermark.'
    expect(redact(text)).toBe(text)
  })

  it('masks authorization headers but keeps the scheme', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwx')).toBe(
      'Authorization: Bearer [redacted]',
    )
  })

  it('masks jwts and long hex/base64 blobs', () => {
    expect(redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop')).toBe(
      '[redacted: jwt]',
    )
    expect(redact('a'.repeat(32) + '0f'.repeat(16))).toContain('[redacted')
  })

  it('reports which rules fired', () => {
    const report = redactWithReport('sk-abcdefghijklmnopqrstuvwx and plain text')
    expect(report.applied).toContain('known-token-prefix')
    expect(report.text).not.toContain('sk-abcdef')
  })

  it('is idempotent enough to re-run without corrupting output', () => {
    const once = redact('token: sk-abcdefghijklmnopqrstuvwx')
    expect(redact(once)).toBe(once)
  })
})

describe('parseNarrative', () => {
  it('splits the nine sections the prompt asks for', () => {
    const raw = BRIEF_SECTIONS.map((section) => `## ${section.title}\n内容-${section.key}`).join('\n\n')
    const narrative = parseNarrative(raw)
    expect(sectionCoverage(narrative)).toBe(9)
    expect(narrative.goal).toBe('内容-goal')
    expect(narrative.next).toBe('内容-next')
  })

  it('tolerates bold headings, hashes and trailing colons', () => {
    const raw = '**总体目标**：做一个插件\n\n### 下一步\n先读文档'
    const narrative = parseNarrative(raw)
    expect(narrative.goal).toBe('做一个插件')
    expect(narrative.next).toBe('先读文档')
  })

  it('puts unstructured prose in the goal section rather than dropping it', () => {
    expect(parseNarrative('这个会话在做一个交接插件。').goal).toBe('这个会话在做一个交接插件。')
  })

  it('ignores text before the first heading', () => {
    const narrative = parseNarrative('前言不该出现\n## 总体目标\n真正的目标')
    expect(narrative.goal).toBe('真正的目标')
  })

  it('leaves empty sections out', () => {
    expect(parseNarrative('## 总体目标\n\n## 下一步\n做事').constraints).toBeUndefined()
  })
})

describe('narrativeIsUsable', () => {
  it('rejects a brief that only has headings', () => {
    expect(narrativeIsUsable({})).toBe(false)
    expect(narrativeIsUsable({ goal: '  ' })).toBe(false)
  })

  it('accepts a brief with the minimum number of filled sections', () => {
    const narrative = { goal: 'g', done: 'd', next: 'n' }
    expect(sectionCoverage(narrative)).toBe(MIN_SECTION_COVERAGE)
    expect(narrativeIsUsable(narrative)).toBe(true)
  })
})

describe('buildSummaryPrompt', () => {
  it('names every section and forbids carrying secrets', () => {
    const prompt = buildSummaryPrompt({
      cwd: 'D:/work',
      agentPreset: undefined,
      provider: 'deepseek',
      model: 'deepseek-chat',
      contextWindow: 128_000,
      permissionPreset: undefined,
      planMode: 'unknown',
      occupancy: { quality: 'unavailable', used: 0, window: undefined, percent: undefined, baseline: 'none' },
      cumulative: { quality: 'unavailable', tokens: 0, source: 'none' },
      turnCount: 0,
    })
    for (const section of BRIEF_SECTIONS) expect(prompt).toContain(`## ${section.title}`)
    expect(prompt).toContain('不要包含任何密钥')
  })
})

describe('renderBrief', () => {
  function facts(overrides: Partial<SessionFacts> = {}): SessionFacts {
    return {
      cwd: 'D:/work/project',
      agentPreset: 'coder',
      provider: 'deepseek',
      model: 'deepseek-chat',
      contextWindow: 200_000,
      permissionPreset: 'standard',
      planMode: 'off',
      occupancy: { quality: 'exact', used: 170_000, window: 200_000, percent: 0.85, baseline: 'usage' },
      cumulative: { quality: 'exact', tokens: 1234, source: 'projection' },
      turnCount: 12,
      ...overrides,
    }
  }

  it('renders facts, all nine sections, and the receiving instruction', () => {
    const brief = renderBrief({
      facts: facts(),
      narrative: { goal: '做完插件', next: '跑测试' },
      sourceSessionId: 's-old',
      createdAt: 0,
    }).text

    expect(brief).toContain('# 会话交接简报')
    expect(brief).toContain('你接手的是同一工作区里另一个会话的中途任务')
    expect(brief).toContain('85%（170000 / 200000')
    expect(brief).toContain('## 总体目标\n做完插件')
    expect(brief).toContain('## 下一步\n跑测试')
    expect(brief).toContain('（未提供）')
    expect(brief).toContain('s-old')
  })

  it('redacts the narrative and says so in the footnote', () => {
    const { text, redactions } = renderBrief({
      facts: facts(),
      narrative: { goal: '用 sk-abcdefghijklmnopqrstuvwx 登录', next: '继续' },
      sourceSessionId: 's',
      createdAt: 0,
    })
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(redactions.length).toBeGreaterThan(0)
    expect(text).toContain('已被替换为占位符')
  })

  it('reports a failed permission read with its reason, not a bare unknown', () => {
    // "未知" alone reads as "this session simply has none", which is exactly
    // how a broken read passed for a healthy default across several handoffs.
    const brief = renderBrief({
      facts: facts({ permissionPreset: undefined, permissionError: 'snapshotEvents is not a function' }),
      narrative: { goal: 'g', done: 'd', next: 'n' },
      sourceSessionId: 's',
      createdAt: 0,
    }).text
    expect(brief).toContain('权限预设：读取失败（snapshotEvents is not a function）')
  })

  it('still prints a plain unknown when nothing was read at all', () => {
    const brief = renderBrief({
      facts: facts({ permissionPreset: undefined }),
      narrative: { goal: 'g', done: 'd', next: 'n' },
      sourceSessionId: 's',
      createdAt: 0,
    }).text
    expect(brief).toContain('权限预设：未知')
  })

  it('says a missing window is unknown instead of claiming zero percent', () => {    const brief = renderBrief({
      facts: facts({ occupancy: { quality: 'unavailable', used: 0, window: undefined, percent: undefined, baseline: 'none' } }),
      narrative: { goal: 'g', done: 'd', next: 'n' },
      sourceSessionId: 's',
      createdAt: 0,
    }).text
    expect(brief).toContain('模型未上报窗口')
  })
})

describe('factsFromLog', () => {
  it('derives what the durable log can still answer', () => {
    const facts = factsFromLog(
      { id: 's', header: { cwd: '/w', agentPreset: 'p' } },
      [
        { type: 'turn/start', data: {} },
        { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5 } } },
      ],
    )
    expect(facts.cwd).toBe('/w')
    expect(facts.agentPreset).toBe('p')
    expect(facts.cumulative.tokens).toBe(15)
    expect(facts.turnCount).toBe(1)
    expect(facts.occupancy.percent).toBeUndefined()
  })
})

describe('requestNarrative (llm.stream)', () => {
  async function* chunks(items: unknown[]) {
    for (const item of items) yield item
  }

  it('concatenates text deltas into the nine sections', async () => {
    const llm = {
      stream: () =>
        chunks([
          { type: 'text-delta', text: '## 总体目标\n做插件\n' },
          { type: 'text-delta', text: '## 下一步\n跑测试' },
          { type: 'finish', reason: { kind: 'stop' } },
        ]),
    }
    const narrative = await requestNarrative(llm as never, 'p', 100, {
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    expect(narrative.goal).toBe('做插件')
    expect(narrative.next).toBe('跑测试')
  })

  it('requires an explicit provider and model on the request', async () => {
    let seen: Record<string, unknown> | undefined
    const llm = {
      stream: (options: Record<string, unknown>) => {
        seen = options
        return chunks([{ type: 'text-delta', text: 'x' }])
      },
    }
    await requestNarrative(llm as never, 'p', 777, { provider: 'p1', model: 'm1' })
    expect(seen).toMatchObject({ provider: 'p1', model: 'm1', maxTokens: 777 })
  })

  it('turns a failed finish chunk into a thrown error', async () => {
    const llm = {
      stream: () =>
        chunks([
          { type: 'text-delta', text: 'partial' },
          { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exceeded' } } },
        ]),
    }
    await expect(
      requestNarrative(llm as never, 'p', 100, { provider: 'a', model: 'b' }),
    ).rejects.toThrow('quota exceeded')
  })

  it('fails clearly when the service has no stream method', async () => {
    await expect(
      requestNarrative({} as never, 'p', 100, { provider: 'a', model: 'b' }),
    ).rejects.toThrow('没有 stream 方法')
  })
})

describe('renderTranscript', () => {
  const events = [
    {
      type: 'user/message',
      seq: 1,
      data: { message: { role: 'user', content: [{ type: 'text', text: '做一个交接插件' }] } },
    },
    {
      type: 'assistant/message',
      seq: 2,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '先看现状' }] } },
    },
    { type: 'tool/call', seq: 3, data: { name: 'bash', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 4, data: { message: { content: [{ type: 'text', text: 'a b c' }] } } },
    { type: 'turn/start', seq: 5, data: {} },
  ]

  it('renders the conversation, not just metadata', () => {
    const text = renderTranscript(events)
    expect(text).toContain('[用户] 做一个交接插件')
    expect(text).toContain('[助手] 先看现状')
    expect(text).toContain('[工具 bash]')
  })

  it('drops events that carry no readable content', () => {
    expect(renderTranscript(events)).not.toContain('turn/start')
  })

  it('keeps the most recent lines when over budget', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      type: 'user/message',
      seq: i + 1,
      data: { message: { role: 'user', content: [{ type: 'text', text: '消息' + i + 'x'.repeat(60) }] } },
    }))
    const text = renderTranscript(many, 800)
    expect(text).toContain('消息59')
    expect(text).toContain('省略较早的')
    expect(text).not.toContain('消息0x')
  })

  it('says so when there is nothing to render', () => {
    expect(renderTranscript(undefined)).toContain('没有可读的对话记录')
  })

  it('reaches the prompt so the model is not asked to guess', () => {
    const f = {
      cwd: '/w',
      agentPreset: 'p',
      provider: 'x',
      model: 'y',
      contextWindow: 1000,
      permissionPreset: null,
      planMode: 'off',
      occupancy: { quality: 'exact', used: 1, window: 1000, percent: 0.001, baseline: 'usage' },
      cumulative: { quality: 'exact', tokens: 1, source: 'projection' },
      turnCount: 1,
    } as never
    const prompt = buildSummaryPrompt(f, renderTranscript(events))
    expect(prompt).toContain('[用户] 做一个交接插件')
    expect(prompt).toContain('不要写「未知」除非记录里确实没有线索')
  })
})
