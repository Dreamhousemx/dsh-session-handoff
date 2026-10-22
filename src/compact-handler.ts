/**
 * Compaction: the stay of execution that runs before a handoff would.
 *
 * Compaction rewrites the current surface, so it is the cheaper answer when the
 * context is filling but the task is still worth continuing in place. It runs
 * through the official `compaction.compactNow` entry point, which already
 * schedules itself into the harness's maintenance phase — this plugin
 * contributes no compaction logic of its own.
 *
 * ## Retry policy
 *
 * A `busy` failure means the harness is mid-operation and the request was
 * refused, not that compaction is broken. Those get a short bounded backoff
 * (250ms, 3 tries), and each retry first waits for the agent to reach idle
 * again, because a compaction that re-enters a running step is the situation
 * `busy` reported. Every other code is a real failure and is reported once.
 *
 * ## The "continue" boundary
 *
 * Compaction is often triggered while a turn is running. Because the trigger
 * path stops that turn at the step boundary, the session would otherwise sit
 * idle afterwards with the original instruction unanswered. In that one case the
 * plugin sends "continue". When the session was already idle, it sends nothing:
 * waking an idle session starts a turn nobody asked for, and that turn is what
 * would turn `compact → continue → handoff → compact` into an endless loop.
 */
import type { AgentLike, CompactionLike } from './contracts.ts'

/** What a compaction attempt produced. */
export type CompactOutcome =
  | { readonly kind: 'compacted'; readonly continuesTask: boolean }
  | { readonly kind: 'nothing-to-do' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string; readonly retryable: boolean }

/** Retry policy for `busy`; exported so tests and docs can cite the bound. */
export const COMPACT_MAX_RETRIES = 3
export const COMPACT_BACKOFF_MS = 250

export interface CompactDeps {
  readonly compaction: CompactionLike | undefined
  /** Wait for the agent to go idle before a retry; the harness owns the timing. */
  readonly waitIdle: (agent: AgentLike) => Promise<void>
  readonly sleep?: (ms: number) => Promise<void>
  readonly signal: AbortSignal
  /** True when this compaction was requested while a turn was running. */
  readonly interruptedRunningTurn: boolean
}

/**
 * Run one compaction, with a bounded retry only for `busy`.
 *
 * `null` from `compactNow` is a result, not a failure: the harness found no
 * safe region worth compacting. Reporting it as an error would make a healthy
 * no-op look broken in the UI.
 */
export async function compact(
  agent: AgentLike | undefined,
  deps: CompactDeps,
): Promise<CompactOutcome> {
  const { compaction } = deps
  if (compaction === undefined) {
    return {
      kind: 'failed',
      code: 'unavailable',
      message: '当前会话没有可用的 compaction 服务',
      retryable: false,
    }
  }
  if (agent === undefined) {
    return { kind: 'failed', code: 'no-agent', message: '找不到活动 Agent', retryable: false }
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let lastCode = 'busy'
  let lastMessage = '压缩服务繁忙'

  for (let attempt = 0; attempt <= COMPACT_MAX_RETRIES; attempt += 1) {
    try {
      const result = await compaction.compactNow(agent, deps.signal)
      if (result === null) return { kind: 'nothing-to-do' }
      return { kind: 'compacted', continuesTask: deps.interruptedRunningTurn }
    } catch (error) {
      const code = errorCodeOf(error)
      const message = error instanceof Error ? error.message : String(error)
      lastCode = code
      lastMessage = message

      if (code !== 'busy') {
        return { kind: 'failed', code, message, retryable: false }
      }
      if (attempt === COMPACT_MAX_RETRIES) break

      // Back off, then re-acquire a safe point before retrying.
      await sleep(COMPACT_BACKOFF_MS * (attempt + 1))
      try {
        await deps.waitIdle(agent)
      } catch {
        // A session that cannot report idle is not retried further.
        return { kind: 'failed', code: 'busy', message: lastMessage, retryable: true }
      }
    }
  }

  return { kind: 'failed', code: lastCode, message: lastMessage, retryable: true }
}

/**
 * The stable failure class of one thrown compaction error.
 *
 * `ManualCompactionError` carries `code` — but the host's `compactNow` wraps
 * EVERY failure in `new ManualCompactionError('busy', …)` with the real cause
 * attached as `{ cause }` (`dsh-compaction-basic` `compactNow`). A summarization
 * that genuinely broke was therefore reported as "压缩服务繁忙", retried three
 * times for nothing, and its real reason never reached the user.
 *
 * So a `busy` is treated as a claim to verify rather than a fact: when a cause
 * classifies as something else, that classification wins. `busy` still retries
 * when the cause says nothing — the "idle agent required" case really is
 * transient.
 *
 * Walked one level deep on purpose: the host attaches the original error
 * directly, and chasing an arbitrary cause chain risks surfacing a code from
 * an unrelated layer.
 */
function errorCodeOf(error: unknown): string {
  const code = codeOf(error)
  if (code !== undefined && code !== 'busy') return code
  const cause = typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : undefined
  const causeCode = codeOf(cause)
  if (causeCode !== undefined && causeCode !== 'busy') return causeCode
  return code ?? 'unknown'
}

/** The `code` field of one value, when it is a non-empty string. */
function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('code' in value)) return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}
