/**
 * The browser-facing status and action channel.
 *
 * A static plugin has no private RPC to its own client half, so the settings
 * card reaches the host over ordinary HTTP under a prefix route. Two rules keep
 * that channel boring:
 *
 * - **Loopback only** for the mutating verbs. GET is read-only; POST can create
 *   sessions, so it must not be callable from a page on another origin.
 * - **Scalar JSON only.** No live Cordis or Session object is ever serialized;
 *   the shape is a plain snapshot the client can render.
 */
import type { SessionStatus } from './coordinator.ts'
import type { ContextOccupancy, CumulativeUsage } from './measure.ts'

/** The JSON the card polls. Every field is a primitive or a plain object. */
export interface StatePayload {
  readonly ok: true
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
  /**
   * Whether the browser should jump to the new session on completion.
   *
   * Carried here because the follower is the only component that acts on it,
   * and the follower never reads the settings card.
   */
  readonly openNewSession: boolean
  readonly autoActions: number
  readonly maxAutoActions: number
  readonly persistence: 'durable' | 'memory'
  readonly lastText: string | undefined
  readonly lastFailure: string | undefined
  readonly warnings: readonly string[]
}

export interface StateDeps {
  readonly statusOf: (sessionId: string) => SessionStatus
  readonly occupancyOf: (sessionId: string) => ContextOccupancy
  readonly cumulativeOf: (sessionId: string) => CumulativeUsage
  readonly autoActionsOf: (sessionId: string) => number
  readonly settings: {
    readonly autoHandoffEnabled: boolean
    readonly autoHandoffAtContextPercent: number
    readonly autoCompactEnabled: boolean
    readonly autoCompactAtContextPercent: number
    readonly autoHandoffThreshold: number
    readonly maxAutoActionsPerSession: number
    /** Whether to switch the browser to the new session once a handoff lands. */
    readonly openNewSessionOnHandoff: boolean
  }
  readonly warnings: () => readonly string[]
  readonly persistence: 'durable' | 'memory'
}

/** Build the status snapshot. */
export function statePayload(sessionId: string, deps: StateDeps): StatePayload {
  const status = deps.statusOf(sessionId)
  const occupancy = deps.occupancyOf(sessionId)
  const cumulative = deps.cumulativeOf(sessionId)
  const settings = deps.settings

  return {
    ok: true,
    sessionId,
    phase: status.phase,
    busy: status.busy,
    latched: status.latched,
    waitingForStep: status.waitingForStep,
    slowWarning: status.slowWarning,
    cancelRequested: status.cancelRequested,
    kind: status.kind,
    newSessionId: status.newSessionId,
    occupancy: {
      quality: occupancy.quality,
      used: occupancy.used,
      window: occupancy.window,
      percent: occupancy.percent,
    },
    cumulative: {
      tokens: cumulative.tokens,
      source: cumulative.source,
      quality: cumulative.quality,
    },
    thresholds: {
      handoffPercent: settings.autoHandoffAtContextPercent,
      compactPercent: settings.autoCompactAtContextPercent,
      cumulative: settings.autoHandoffThreshold,
      enabled: settings.autoHandoffEnabled,
      compactEnabled: settings.autoCompactEnabled,
    },
    autoActions: deps.autoActionsOf(sessionId),
    maxAutoActions: settings.maxAutoActionsPerSession,
    openNewSession: settings.openNewSessionOnHandoff,
    persistence: deps.persistence,
    lastText: status.lastResult?.text,
    lastFailure: status.lastFailure?.message,
    warnings: deps.warnings(),
  }
}

/** Reject requests that did not come from this machine. */
export function isLoopbackRequest(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false
  const address = remoteAddress.replace(/^::ffff:/, '')
  return address === '127.0.0.1' || address === '::1' || address === 'localhost'
}

/** A JSON response helper that never leaks a live object. */
export function sendJson(
  res: {
    statusCode: number
    setHeader(name: string, value: string): void
    end(body?: string): void
  },
  status: number,
  body: unknown,
): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Read a small JSON body, refusing anything unexpectedly large. */
export async function readJsonBody(
  req: AsyncIterable<Uint8Array> & { headers?: Record<string, string | string[] | undefined> },
  maxBytes = 64 * 1024,
): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > maxBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** The session id a request refers to, defaulting to nothing. */
export function sessionIdFromUrl(requestUrl: string | undefined): string | undefined {
  if (requestUrl === undefined) return undefined
  const queryStart = requestUrl.indexOf('?')
  if (queryStart < 0) return undefined
  const params = new URLSearchParams(requestUrl.slice(queryStart + 1))
  const value = params.get('sessionId')
  return value !== null && value.length > 0 ? value : undefined
}
