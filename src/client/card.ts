/**
 * The settings card, rendered in the Settings → Plugins slot.
 *
 * Two design constraints come from the host:
 *
 * 1. **Only theme tokens.** Every colour is a `--dsw-alias-*` variable, with a
 *    literal fallback so an older host still renders rather than disappearing.
 *    There is no `[data-theme]` branch: the host owns light/dark switching.
 * 2. **No host UI primitives.** The bundle is plain React created with
 *    `createElement`; importing a client package would tie this card to one
 *    host build, and a throwing component blanks the whole slot entry. The
 *    controls below are deliberately small and local.
 *
 * ## What it shows
 *
 * The card answers three questions in order: what will happen automatically,
 * what is happening right now, and what can I do. Numbers are labelled with
 * their provenance (`精确` / `估算`) because a heuristic percentage that looks
 * authoritative is worse than one that admits itself.
 */
import { createElement as rawCreate, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DEFAULT_SETTINGS,
  blockingReason,
  localWarnings,
  routeUrl,
  type HandoffSettings,
  type HandoffState,
} from './protocol'

/**
 * `createElement`, typed as producing a node.
 *
 * React's overloads return `ReactElement`, while the small helpers below build
 * subtrees and pass them as children before returning `unknown`. A single
 * widened wrapper keeps those helpers composable without a cast at every call
 * site, and it is still plain React — no host primitives are imported.
 */
const h = rawCreate as unknown as (
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
) => ReactNode

/** Props the host passes for the settings slot. */
export interface CardProps {
  /**
   * What the page is asking for.
   *
   * `summary` renders the one-line description the row shows without opening
   * the page; `page` renders the full form with its save control.
   */
  readonly view?: 'summary' | 'page' | undefined
  /** Session the card reports on; absent when no conversation is open. */
  readonly sessionId?: string | undefined
  /** Read the current form values from the host settings scope. */
  readonly getSettings?: (() => HandoffSettings | undefined) | undefined
  /** Persist a complete form value set. */
  readonly saveSettings?: ((next: HandoffSettings) => Promise<void> | void) | undefined
  /** Base origin for the status routes; defaults to the current origin. */
  readonly origin?: string | undefined
}

/** The one-line description shown by the row's summary view. */
export const CARD_SUMMARY =
  '上下文占用率或累计消费达到阈值时，把长会话交接到同工作区的新会话，并迁移 preset、模型、权限与 Plan 模式。'


const TOKENS = {
  text: 'var(--dsw-alias-text-primary, rgba(28,28,30,1))',
  muted: 'var(--dsw-alias-text-secondary, rgba(128,128,128,1))',
  border: 'var(--dsw-alias-border-subtle, rgba(128,128,128,0.26))',
  panel: 'var(--dsw-alias-bg-section, rgba(128,128,128,0.06))',
  accent: 'var(--dsw-alias-brand-primary, rgba(31,110,255,1))',
  warn: 'var(--dsw-alias-status-warning, rgba(214,140,0,1))',
  danger: 'var(--dsw-alias-status-danger, rgba(214,48,49,1))',
  mono: 'var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
} as const

export function HandoffCard(props: CardProps): unknown {
  const [settings, setSettings] = useState<HandoffSettings>(DEFAULT_SETTINGS)
  const [state, setState] = useState<HandoffState | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [busyAction, setBusyAction] = useState<string | undefined>(undefined)

  const getSettings = props.getSettings
  const saveSettingsProp = props.saveSettings

  // The row's summary view is a single line; it has no state to manage.
  if (props.view === 'summary') {
    return h('span', { style: { color: TOKENS.muted, fontSize: '12.5px' } }, CARD_SUMMARY)
  }

  // Load persisted values once. The host's settings scope is a snapshot, so
  // this runs synchronously; the async shape is kept for older scopes.
  useEffect(() => {
    let alive = true
    void Promise.resolve()
      .then(() => getSettings?.())
      .then((value) => {
        if (alive && value !== undefined) setSettings({ ...DEFAULT_SETTINGS, ...value })
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [getSettings])

  // Poll the status channel while the card is mounted.
  useEffect(() => {
    const sessionId = props.sessionId
    if (sessionId === undefined) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (): Promise<void> => {
      try {
        const base = props.origin ?? ''
        const response = await fetch(
          `${routeUrl(base, 'state')}?sessionId=${encodeURIComponent(sessionId)}`,
          { headers: { accept: 'application/json' } },
        )
        if (response.ok) {
          const payload = (await response.json()) as HandoffState
          if (alive) setState(payload)
        }
      } catch {
        // The host may be restarting; the next tick tries again.
      } finally {
        if (alive) timer = setTimeout(() => void poll(), 2000)
      }
    }

    void poll()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [props.sessionId, props.origin])

  const patch = useCallback((next: Partial<HandoffSettings>) => {
    setSettings((current) => ({ ...current, ...next }))
    setSaveError(undefined)
  }, [])

  const blocking = useMemo(() => blockingReason(settings), [settings])
  const warnings = useMemo(() => {
    const all = [...localWarnings(settings), ...(state?.warnings ?? [])]
    return [...new Set(all)]
  }, [settings, state])

  const save = useCallback(async () => {
    if (blocking !== undefined) {
      setSaveError(blocking)
      return
    }
    setSaving(true)
    setSaveError(undefined)
    try {
      await saveSettingsProp?.(settings)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [blocking, saveSettingsProp, settings])

  const act = useCallback(
    async (action: 'handoff' | 'cancel' | 'retry') => {
      const sessionId = props.sessionId
      if (sessionId === undefined) return
      setBusyAction(action)
      try {
        const base = props.origin ?? ''
        const response = await fetch(routeUrl(base, action), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // `cancel` and `handoff` take a session id; the host validates it.
          body: JSON.stringify({ sessionId }),
        })
        const payload = (await response.json()) as { ok?: boolean; error?: string }
        if (payload.ok !== true) {
          setSaveError(payload.error ?? '操作未成功')
        }
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error))
      } finally {
        setBusyAction(undefined)
      }
    },
    [props.origin, props.sessionId],
  )

  const percent = settings.autoHandoffAtContextPercent
  const disabled = !loaded || saving

  return h(
    'div',
    {
      'data-dsh-plugin': 'dsh-session-handoff',
      'data-dsh-surface': 'settings-modal',
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        color: TOKENS.text,
        fontSize: '13px',
      },
    },

    // ---- master switch -----------------------------------------------------
    row(
      '自动交接',
      h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
        h('input', {
          key: 'toggle',
          type: 'checkbox',
          role: 'switch',
          'aria-checked': settings.autoHandoffEnabled ? 'true' : 'false',
          'data-dsh-field': 'autoHandoffEnabled',
          checked: settings.autoHandoffEnabled,
          disabled,
          onChange: (event: { target: { checked: boolean } }) =>
            patch({ autoHandoffEnabled: event.target.checked }),
        }),
        h('span', { key: 'label', style: { color: TOKENS.muted } }, settings.autoHandoffEnabled ? '已开启' : '仅手动 /handoff'),
      ]),
      '关闭时不会自动做任何事；/handoff 命令始终可用。',
    ),

    // ---- trigger mode ------------------------------------------------------
    row(
      '触发方式',
      h(
        'div',
        { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
        (
          [
            ['context', '上下文占用率'],
            ['cumulative', '累计消费'],
            ['either', '两者任一'],
          ] as const
        ).map(([value, label]) =>
          h(
            'label',
            { key: value, style: { display: 'flex', alignItems: 'center', gap: '4px' } },
            h('input', {
              type: 'radio',
              name: 'handoff-trigger',
              value,
              'data-dsh-field': 'autoHandoffTrigger',
              checked: settings.autoHandoffTrigger === value,
              disabled,
              onChange: () => patch({ autoHandoffTrigger: value }),
            }),
            h('span', { key: 't' }, label),
          ),
        ),
      ),
      '占用率 = 当前上下文 token ÷ 模型上下文窗口。',
    ),

    // ---- thresholds --------------------------------------------------------
    row(
      '上下文占用达到',
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        h('input', {
          type: 'range',
          min: 1,
          max: 100,
          step: 1,
          value: percent,
          disabled: disabled || !triggerUses(settings, 'context'),
          'data-dsh-field': 'autoHandoffAtContextPercent',
          style: { flex: '1', accentColor: TOKENS.accent },
          onChange: (event: { target: { value: string } }) =>
            patch({ autoHandoffAtContextPercent: clamp(Number(event.target.value), 1, 100) }),
        }),
        h(
          'span',
          { key: 'value', style: { fontFamily: TOKENS.mono, minWidth: '46px', textAlign: 'right' } },
          `${percent}%`,
        ),
      ),
      '交接触发点。默认 85%，留出余量给当前步骤收尾。',
    ),

    row(
      '累计消费达到',
      h('input', {
        type: 'number',
        min: 0,
        step: 10000,
        value: settings.autoHandoffThreshold,
        disabled: disabled || !triggerUses(settings, 'cumulative'),
        'data-dsh-field': 'autoHandoffThreshold',
        style: inputStyle(),
        onChange: (event: { target: { value: string } }) =>
          patch({ autoHandoffThreshold: clamp(Number(event.target.value), 0, Number.MAX_SAFE_INTEGER) }),
      }),
      '以 token 计；只在触发方式包含「累计消费」时生效。',
    ),

    // ---- compaction --------------------------------------------------------
    row(
      '自动压缩',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
        h('input', {
          key: 'switch',
          type: 'checkbox',
          role: 'switch',
          'aria-checked': settings.autoCompactEnabled ? 'true' : 'false',
          'data-dsh-field': 'autoCompactEnabled',
          checked: settings.autoCompactEnabled,
          disabled,
          onChange: (event: { target: { checked: boolean } }) =>
            patch({ autoCompactEnabled: event.target.checked }),
        }),
        h('span', { key: 'label' }, '达到'),
        h('input', {
          key: 'percent',
          type: 'number',
          min: 1,
          max: 99,
          value: settings.autoCompactAtContextPercent,
          disabled: disabled || !settings.autoCompactEnabled,
          'data-dsh-field': 'autoCompactAtContextPercent',
          style: { ...inputStyle(), width: '72px' },
          onChange: (event: { target: { value: string } }) =>
            patch({ autoCompactAtContextPercent: clamp(Number(event.target.value), 1, 99) }),
        }),
        h('span', { key: 'pct' }, '% 时原地压缩'),
      ]),
      '压缩先把上下文腾出来继续在原会话做；必须低于交接阈值。',
    ),

    // ---- advanced ----------------------------------------------------------
    h(Advanced, { settings, patch, disabled }),

    // ---- status ------------------------------------------------------------
    h(StatusPanel, { state, settings }),

    // ---- actions -----------------------------------------------------------
    h(
      'div',
      { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
      [
        button('立即迁移', () => void act('handoff'), busyAction === 'handoff' || props.sessionId === undefined),
        button('取消', () => void act('cancel'), busyAction === 'cancel' || props.sessionId === undefined),
        button('重试', () => void act('retry'), busyAction === 'retry' || props.sessionId === undefined),
        h('span', { key: 'spacer', style: { flex: '1' } }),
        button('保存设置', () => void save(), disabled || blocking !== undefined, true),
      ],
    ),

    // ---- messages ----------------------------------------------------------
    blocking === undefined ? null : notice(blocking, 'danger'),
    saveError === undefined ? null : notice(saveError, 'danger'),
    ...warnings.map((warning) => notice(warning, 'warn')),
    settings.autoHandoffTrigger !== 'cumulative' && state?.occupancy.window === undefined
      ? notice('当前模型没有上报上下文窗口，占用率触发不会生效；仍可用累计消费或手动 /handoff。', 'warn')
      : null,
  )
}

/** The collapsible advanced block. */
function Advanced(input: {
  settings: HandoffSettings
  patch: (next: Partial<HandoffSettings>) => void
  disabled: boolean
}): unknown {
  const [open, setOpen] = useState(false)
  const rows: Array<[keyof HandoffSettings, string, string, number, number]> = [
    ['evaluateIntervalMs', '评估间隔（毫秒）', '两次测量之间的最短间隔', 1000, 60_000],
    ['contextRearmDeltaPercent', '占用率滞回（百分点）', '动作后需回落这么多才重新武装', 0, 50],
    ['rearmDeltaTokens', '累计重臂（token）', '累计触发后需再增长这么多', 0, 10_000_000],
    ['maxAutoActionsPerSession', '单会话动作上限', '交接与压缩共享计数', 1, 10],
    ['summaryMaxTokens', '简报输出上限', '摘要模型单次输出预算', 256, 32_768],
    ['stepWaitTimeoutMs', '等待边界超时（毫秒）', '只提示，不中断', 1000, 3_600_000],
    ['actionDeadlineMs', '动作总时限（毫秒）', '到期释放闩锁并标记失败', 1000, 7_200_000],
  ]

  return h(
    'div',
    null,
    h(
      'button',
      {
        type: 'button',
        onClick: () => setOpen((value) => !value),
        style: linkButtonStyle(),
        'data-dsh-part': 'advanced-toggle',
      },
      open ? '▾ 高级设置' : '▸ 高级设置',
    ),
    open
      ? h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' } },
          ...rows.map(([field, label, hint, min, max]) =>
            row(
              label,
              h('input', {
                type: 'number',
                min,
                max,
                value: input.settings[field] as number,
                disabled: input.disabled,
                'data-dsh-field': field,
                style: inputStyle(),
                onChange: (event: { target: { value: string } }) =>
                  input.patch({ [field]: clamp(Number(event.target.value), min, max) } as Partial<HandoffSettings>),
              }),
              hint,
            ),
          ),
          row(
            '迁移后自动跳转',
            h('input', {
              type: 'checkbox',
              role: 'switch',
              'aria-checked': input.settings.openNewSessionOnHandoff ? 'true' : 'false',
              'data-dsh-field': 'openNewSessionOnHandoff',
              checked: input.settings.openNewSessionOnHandoff,
              disabled: input.disabled,
              onChange: (event: { target: { checked: boolean } }) =>
                input.patch({ openNewSessionOnHandoff: event.target.checked }),
            }),
            '交接完成后浏览器切到新会话。',
          ),
        )
      : null,
  )
}

/** The live status block: two meters plus the phase line. */
function StatusPanel(input: { state: HandoffState | undefined; settings: HandoffSettings }): unknown {
  const state = input.state
  if (state === undefined) {
    return h(
      'div',
      { style: { color: TOKENS.muted, fontSize: '12px' } },
      '状态通道不可用（未能读取会话状态）。表单仍可编辑与保存。',
    )
  }

  const percent = state.occupancy.percent === undefined ? undefined : Math.round(state.occupancy.percent * 100)
  const quality =
    state.occupancy.quality === 'exact' ? '精确' : state.occupancy.quality === 'estimated' ? '估算' : '不可用'

  const meterColor =
    percent === undefined
      ? TOKENS.muted
      : percent >= state.thresholds.handoffPercent
        ? TOKENS.danger
        : percent >= Math.max(50, state.thresholds.handoffPercent - 15)
          ? TOKENS.warn
          : TOKENS.accent

  const cumulativeRatio =
    state.thresholds.cumulative > 0 ? Math.min(1, state.cumulative.tokens / state.thresholds.cumulative) : 0

  return h(
    'div',
    {
      'data-dsh-part': 'status',
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px',
        borderRadius: '8px',
        background: TOKENS.panel,
        border: `1px solid ${TOKENS.border}`,
      },
    },
    h(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' } },
      h('span', { key: 'title', style: { fontWeight: 600 } }, '状态'),
      h(
        'span',
        { key: 'phase', style: { color: TOKENS.muted, fontFamily: TOKENS.mono } },
        `${state.phase}${state.busy ? ' · 进行中' : ''}${state.latched ? ' · 已设闩锁' : ''}`,
      ),
    ),
    meter(
      '上下文占用',
      percent === undefined ? '窗口未知' : `${percent}%`,
      `${formatTokens(state.occupancy.used)}${state.occupancy.window === undefined ? '' : ` / ${formatTokens(state.occupancy.window)}`} · ${quality}`,
      percent === undefined ? 0 : Math.min(100, percent),
      meterColor,
    ),
    meter(
      '累计消费',
      formatTokens(state.cumulative.tokens),
      state.thresholds.enabled ? `阈值 ${formatTokens(state.thresholds.cumulative)}` : '阈值未启用',
      cumulativeRatio * 100,
      TOKENS.accent,
    ),
    h(
      'div',
      { style: { fontSize: '12px', color: TOKENS.muted } },
      `自动动作 ${state.autoActions}/${state.maxAutoActions}${state.lastText === undefined ? '' : ` · 最近：${firstLine(state.lastText)}`}`,
    ),
    state.lastFailure === undefined
      ? null
      : h('div', { style: { fontSize: '12px', color: TOKENS.danger } }, `最近失败：${firstLine(state.lastFailure)}`),
    state.persistence === 'memory'
      ? h('div', { style: { fontSize: '12px', color: TOKENS.warn } }, '设置只在本次进程内有效。')
      : null,
  )
}

// ---------------------------------------------------------------- helpers

function triggerUses(settings: HandoffSettings, mode: 'context' | 'cumulative'): boolean {
  if (mode === 'context') return settings.autoHandoffTrigger !== 'cumulative'
  return settings.autoHandoffTrigger !== 'context'
}

function row(label: string, control: unknown, hint?: string): unknown {
  return h(
    'div',
    { 'data-dsh-part': 'field', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
      h('span', { key: 'label', style: { minWidth: '132px', color: TOKENS.text } }, label),
      control,
    ),
    hint === undefined ? null : h('div', { style: { fontSize: '11.5px', color: TOKENS.muted } }, hint),
  )
}

function meter(label: string, value: string, detail: string, percent: number, color: string): unknown {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
    h(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' } },
      h('span', { key: 'l', style: { color: TOKENS.muted } }, label),
      h('span', { key: 'v', style: { fontFamily: TOKENS.mono } }, value),
    ),
    h(
      'div',
      {
        style: {
          height: '6px',
          borderRadius: '999px',
          background: TOKENS.border,
          overflow: 'hidden',
        },
      },
      h('div', {
        style: {
          width: `${Math.max(0, Math.min(100, percent))}%`,
          height: '100%',
          background: color,
          transition: 'width 200ms ease',
        },
      }),
    ),
    h('div', { style: { fontSize: '11.5px', color: TOKENS.muted } }, detail),
  )
}

function button(label: string, onClick: () => void, disabled: boolean, primary = false): unknown {
  return h(
    'button',
    {
      type: 'button',
      key: label,
      onClick,
      disabled,
      style: {
        padding: '5px 12px',
        borderRadius: '6px',
        border: `1px solid ${primary ? TOKENS.accent : TOKENS.border}`,
        background: primary ? TOKENS.accent : 'transparent',
        color: primary ? '#fff' : TOKENS.text,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: '12.5px',
      },
    },
    label,
  )
}

function notice(text: string, tone: 'warn' | 'danger'): unknown {
  return h(
    'div',
    {
      style: {
        fontSize: '12px',
        color: tone === 'danger' ? TOKENS.danger : TOKENS.warn,
        lineHeight: 1.45,
      },
    },
    `${tone === 'danger' ? '✕' : '⚠'} ${text}`,
  )
}

function inputStyle(): Record<string, string> {
  return {
    padding: '4px 8px',
    borderRadius: '6px',
    border: `1px solid ${TOKENS.border}`,
    background: 'transparent',
    color: TOKENS.text,
    fontFamily: TOKENS.mono,
    fontSize: '12.5px',
    width: '140px',
  }
}

function linkButtonStyle(): Record<string, string> {
  return {
    border: 'none',
    background: 'transparent',
    color: TOKENS.accent,
    cursor: 'pointer',
    padding: '0',
    fontSize: '12.5px',
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? ''
  return line.length > 90 ? `${line.slice(0, 90)}…` : line
}
