/**
 * Shared, React-free contract between the two halves of this plugin.
 *
 * Restating it here (rather than importing host types) keeps the browser bundle
 * free of Node imports and lets a client test build the same objects a host
 * test asserts on.
 */

/** Route prefix; must equal `ROUTE_PREFIX` in the host entry. */
export const ROUTE_PREFIX = '/dsh-session-handoff'

/** The status snapshot the card polls. Mirrors `StatePayload` on the host. */
export interface HandoffState {
  readonly ok: boolean
  readonly sessionId: string
  readonly phase: string
  readonly busy: boolean
  readonly latched: boolean
  readonly waitingForStep: boolean
  readonly slowWarning: boolean
  readonly cancelRequested: boolean
  readonly kind: string | undefined
  readonly newSessionId: string | undefined
  readonly occupancy: {
    readonly quality: string
    readonly used: number
    readonly window: number | undefined
    readonly percent: number | undefined
  }
  readonly cumulative: { readonly tokens: number; readonly source: string; readonly quality: string }
  readonly thresholds: {
    readonly handoffPercent: number
    readonly compactPercent: number
    readonly cumulative: number
    readonly enabled: boolean
    readonly compactEnabled: boolean
  }
  readonly autoActions: number
  readonly maxAutoActions: number
  readonly persistence: 'durable' | 'memory'
  readonly lastText: string | undefined
  readonly lastFailure: string | undefined
  readonly warnings: readonly string[]
}

/** The settings card's form values; a subset of the plugin Config. */
export interface HandoffSettings {
  autoHandoffEnabled: boolean
  autoHandoffTrigger: 'context' | 'cumulative' | 'either'
  autoHandoffAtContextPercent: number
  autoHandoffThreshold: number
  autoCompactEnabled: boolean
  autoCompactAtContextPercent: number
  evaluateIntervalMs: number
  contextRearmDeltaPercent: number
  rearmDeltaTokens: number
  maxAutoActionsPerSession: number
  summaryMaxTokens: number
  stepWaitTimeoutMs: number
  actionDeadlineMs: number
  openNewSessionOnHandoff: boolean
}

/** Defaults shown before the host answers. */
export const DEFAULT_SETTINGS: HandoffSettings = {
  autoHandoffEnabled: false,
  autoHandoffTrigger: 'context',
  autoHandoffAtContextPercent: 85,
  autoHandoffThreshold: 2_000_000,
  autoCompactEnabled: false,
  autoCompactAtContextPercent: 70,
  evaluateIntervalMs: 5000,
  contextRearmDeltaPercent: 10,
  rearmDeltaTokens: 200_000,
  maxAutoActionsPerSession: 3,
  summaryMaxTokens: 4096,
  stepWaitTimeoutMs: 900_000,
  actionDeadlineMs: 1_800_000,
  openNewSessionOnHandoff: true,
}

/**
 * The cross-field rule, restated for the browser.
 *
 * The host enforces it on save; the card mirrors it so the reason appears next
 * to the Save button instead of as a rejected write after the fact.
 */
export function blockingReason(settings: HandoffSettings): string | undefined {
  if (
    settings.autoHandoffEnabled &&
    settings.autoCompactEnabled &&
    settings.autoCompactAtContextPercent >= settings.autoHandoffAtContextPercent
  ) {
    return '压缩阈值必须低于交接阈值，否则压缩刚结束就会立刻触发交接。'
  }
  return undefined
}

/** Warnings the card can raise without the host. */
export function localWarnings(settings: HandoffSettings): readonly string[] {
  const warnings: string[] = []
  if (settings.autoHandoffAtContextPercent < 50) {
    warnings.push('交接阈值偏小，会话可能很早就被交出去。')
  }
  if (settings.evaluateIntervalMs > 60_000) {
    warnings.push('评估间隔超过 1 分钟，上下文可能在这期间撞满窗口。')
  }
  return warnings
}

/** Build a URL for one host route. */
export function routeUrl(base: string, action: string): string {
  return `${base}${ROUTE_PREFIX}/${action}`
}
