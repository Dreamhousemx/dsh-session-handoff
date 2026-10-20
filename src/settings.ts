/**
 * Plugin configuration — the single settings surface.
 *
 * `cordis.patch.yml` seeds these defaults and the Configuration card writes
 * through the host's settings form. Every limit here exists to bound a real
 * failure mode (a runaway handoff loop, a summary that costs more than the
 * session did); none is symmetry for its own sake.
 */
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Master switch for threshold-driven handoff. Off means manual only. */
  autoHandoffEnabled: boolean
  /** Which metric triggers automatic handoff. */
  autoHandoffTrigger: 'context' | 'cumulative' | 'either'
  /** Context occupancy (surface tokens ÷ window) that requests a handoff, in percent. */
  autoHandoffAtContextPercent: number
  /** Cumulative spend that requests a handoff, in tokens. Only used by `cumulative`/`either`. */
  autoHandoffThreshold: number
  /** Enable in-place compaction before the context is full. */
  autoCompactEnabled: boolean
  /** Context occupancy that requests a compaction, in percent. Must sit below the handoff threshold. */
  autoCompactAtContextPercent: number
  /** Minimum gap between two measurements of the same session, in milliseconds. */
  evaluateIntervalMs: number
  /** Hysteresis band: occupancy must fall this far below a threshold before it re-arms. */
  contextRearmDeltaPercent: number
  /** Cumulative tokens that must accrue after an action before it re-arms. */
  rearmDeltaTokens: number
  /** Automatic actions allowed per session, handoff and compaction shared. */
  maxAutoActionsPerSession: number
  /** Output budget for the model that writes the brief. */
  summaryMaxTokens: number
  /** How long waiting for the step boundary is considered slow. Advisory only: it never interrupts. */
  stepWaitTimeoutMs: number
  /** Hard deadline for one action. Expiry releases the latch and marks a failure; it never cancels work. */
  actionDeadlineMs: number
  /** Scroll the browser to the new session once a handoff completes. */
  openNewSessionOnHandoff: boolean
}

/**
 * The configuration contract.
 *
 * Three facts drove this shape, each measured rather than assumed:
 *
 * 1. **Cordis validates through Standard Schema.** `resolveConfig` calls
 *    `Config['~standard'].validate(raw)` and requires a *synchronous* result of
 *    `{ value }` or `{ issues }`. A bare JSON Schema object fails with
 *    `Cannot read properties of undefined (reading 'validate')`.
 * 2. **The settings page needs a schemastery instance, not a JSON object.**
 *    `dsh-settings` reads `schema.meta`, walks `schema.dict`, and calls
 *    `schema.toJSON()` to project the form. A plain object yields
 *    `status: "unsupported"`: the row exists, but its Configuration page never
 *    appears.
 * 3. **`schemastery` must be a real dependency.** It is not in a minimal
 *    composition, and in a full profile it is only *hoisted* by some other
 *    plugin — relying on that would break the day that plugin is uninstalled.
 *    It supplies `~standard` itself, so one declaration satisfies all three.
 */
export const Config: Schema<Config> = Schema.object({
  autoHandoffEnabled: Schema.boolean().default(false),
  autoHandoffTrigger: Schema.union(['context', 'cumulative', 'either']).default('context'),
  autoHandoffAtContextPercent: Schema.number().min(1).max(100).step(1).default(85),
  autoHandoffThreshold: Schema.number().min(0).step(1).default(2_000_000),
  autoCompactEnabled: Schema.boolean().default(false),
  autoCompactAtContextPercent: Schema.number().min(1).max(99).step(1).default(70),
  evaluateIntervalMs: Schema.number().min(1000).step(1).default(5_000),
  contextRearmDeltaPercent: Schema.number().min(0).max(50).step(1).default(10),
  rearmDeltaTokens: Schema.number().min(0).step(1).default(200_000),
  maxAutoActionsPerSession: Schema.number().min(1).max(10).step(1).default(3),
  summaryMaxTokens: Schema.number().min(256).step(1).default(4_096),
  stepWaitTimeoutMs: Schema.number().min(1000).step(1).default(900_000),
  actionDeadlineMs: Schema.number().min(1000).step(1).default(1_800_000),
  openNewSessionOnHandoff: Schema.boolean().default(true),
})

/**
 * The default value of every field, read from the schema itself.
 *
 * One source of truth: the Configuration page, the Loader's defaults, and this
 * object all derive from the `Config` declaration above.
 */
export const CONFIG_DEFAULTS: Config = Object.fromEntries(
  Object.entries(Config.dict ?? {}).map(([name, field]) => [
    name,
    (field as { meta?: { default?: unknown } }).meta?.default,
  ]),
) as unknown as Config

/**
 * Fill a partial row config from the defaults.
 *
 * The Loader applies `default` for a well-formed row; this exists so a row that
 * omits a field (an older patch, or a hand-written profile) still hands the
 * plugin's own code a complete object.
 */
export function withDefaults(config: Partial<Config> | undefined): Config {
  return { ...CONFIG_DEFAULTS, ...(config ?? {}) }
}

/** A warning that does not block saving, with the field it concerns. */
export interface SettingWarning {
  readonly field: keyof Config
  readonly message: string
}

/**
 * Cross-field validation.
 *
 * `blocking` stops a save; `warnings` are advisory and surface both in the
 * Settings card and in `/handoff status`, so a configuration is never silently
 * accepted while being obviously wrong.
 */
export function validateSettings(config: Config): {
  blocking: string | undefined
  warnings: readonly SettingWarning[]
} {
  const warnings: SettingWarning[] = []

  if (
    config.autoHandoffEnabled &&
    config.autoCompactEnabled &&
    config.autoCompactAtContextPercent >= config.autoHandoffAtContextPercent
  ) {
    return {
      blocking:
        '压缩阈值必须低于交接阈值：否则上下文刚压缩完又会立刻触发交接，形成来回抖动。请调低压缩阈值或调高交接阈值。',
      warnings,
    }
  }

  if (
    config.autoCompactEnabled &&
    !config.autoHandoffEnabled &&
    config.autoHandoffAtContextPercent <= config.autoCompactAtContextPercent
  ) {
    warnings.push({
      field: 'autoCompactAtContextPercent',
      message: '压缩阈值不低于交接阈值；开启自动交接后会立刻产生冲突。',
    })
  }

  if (config.autoHandoffAtContextPercent < 50) {
    warnings.push({
      field: 'autoHandoffAtContextPercent',
      message: '交接阈值偏小，会话可能很早就被交出去，产生大量短会话。',
    })
  }

  if (config.evaluateIntervalMs > 60_000) {
    warnings.push({
      field: 'evaluateIntervalMs',
      message: '评估间隔超过 1 分钟，上下文可能在两次测量之间就撞满窗口。',
    })
  }

  return { blocking: undefined, warnings }
}

/** True when the configured mode keys automatic handoff on context occupancy. */
export function triggerUsesContext(mode: Config['autoHandoffTrigger']): boolean {
  return mode === 'context' || mode === 'either'
}

/** True when the configured mode keys automatic handoff on cumulative spend. */
export function triggerUsesCumulative(mode: Config['autoHandoffTrigger']): boolean {
  return mode === 'cumulative' || mode === 'either'
}
