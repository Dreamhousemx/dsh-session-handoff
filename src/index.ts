/**
 * dsh-session-handoff — host half.
 *
 * A long session is handed to a fresh session in the same workspace once the
 * context is nearly full (or the spend passes a threshold, if the user prefers
 * that metric). The switch happens at a step boundary: this half never
 * interrupts a running step, a tool call, or a shell command.
 *
 * ## Layering
 *
 * - `measure.ts`   — the two numbers the trigger acts on
 * - `trigger.ts`   — when an automatic action may fire (pure, unit-tested)
 * - `graceful-stop.ts` — the latch and the `agent/pre-step` veto
 * - `session-summary.ts` / `redaction.ts` — the brief
 * - `session-migration.ts` — create, inherit, deliver
 * - `compact-handler.ts` — the in-place alternative
 * - `coordinator.ts` — one action at a time, the phase machine
 * - `monitor.ts` — the event bridge
 * - `command.ts` / `routes.ts` — the two ways a human reaches any of it
 *
 * ## Startup rules
 *
 * 1. **Services are read lazily.** The loader assembles sibling rows
 *    concurrently and `sessionController` owns ten dependencies, so it often
 *    appears after this row does. Reading it once here would report a healthy
 *    deployment as broken.
 * 2. **Nothing is registered outside `ctx.effect`.** An unload must leave no
 *    listener, timer, route, or latch behind.
 * 3. **The plugin must be harmless by default.** Automatic actions are off in
 *    the shipped patch; installing this row adds a command and a card.
 */

import type { Context } from '@deepseek-ai/cordis'
import { readServices, INJECT } from './services.ts'
import { Config, CONFIG_DEFAULTS, validateSettings, withDefaults, type Config as ConfigShape } from './settings.ts'
import { LatchRegistry, decidePreStep, waitForBoundary } from './graceful-stop.ts'
import { Coordinator } from './coordinator.ts'
import { Monitor, compactRunner } from './monitor.ts'
import { renderStatus, parseCommandArgs, runCommand } from './command.ts'
import {
  factsFromLog,
  buildSummaryPrompt,
  narrativeIsUsable,
  parseNarrative,
  readSessionFacts,
  renderBrief,
  type BriefNarrative,
  type SessionFacts,
} from './session-summary.ts'
import {
  deliverBrief,
  migrateSession,
  planModeFor,
  snapshotSource,
  type MigrationResult,
} from './session-migration.ts'
import { readContextOccupancy, readCumulativeUsage } from './measure.ts'
import {
  isLoopbackRequest,
  readJsonBody,
  sendJson,
  sessionIdFromUrl,
  statePayload,
} from './routes.ts'
import { sessionEvents, type AgentLike, type LlmLike, type SessionLike } from './contracts.ts'
import type { ActionResult } from './types.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The session a handoff belongs to, for the duration of one action.
 *
 * The coordinator hands the `migrate` callback only a brief, so the source id
 * has to travel beside it. A shared mutable field would be wrong: automatic
 * triggers and manual commands can interleave, and a stale value would migrate
 * the wrong session. `AsyncLocalStorage` carries the id across every `await` of
 * one action without leaking into a concurrent one.
 */
const sourceScope = new AsyncLocalStorage<string>()


/** Stable plugin name; must match the row inserted by `cordis.patch.yml`. */
export const name = 'dsh-session-handoff'

/** Optional host services; see `services.ts` for why these are declared. */
export const inject = INJECT

/** Route prefix for the status/action channel used by the settings card. */
export const ROUTE_PREFIX = '/dsh-session-handoff'

/** Entry id under which the settings card writes; equals the patch row id. */
export const SETTINGS_ENTRY = 'dsh-session-handoff'

export { Config, CONFIG_DEFAULTS, withDefaults }

export function apply(ctx: Context, config: ConfigShape): void {
  const host = ctx as unknown as {
    get(name: string): unknown
    on(event: string, listener: (...args: unknown[]) => unknown): () => void
    effect(callback: () => () => void, label?: string): void
    logger?: { info?(message: string): void; warn?(message: string): void; error?(message: unknown): void }
  }

  const log = (message: string): void => {
    try {
      host.logger?.info?.(message)
    } catch {
      // Logging must never break an action.
    }
  }

  // Live configuration: the settings card rewrites the plugin row, and the
  // loader re-applies `config`. Holding the current value lets a long-running
  // action see the newest thresholds without re-registration.
  let live = config

  const latches = new LatchRegistry()

  /** Resolve the session log for an id, without waking an agent. */
  /**
   * The session log for one id.
   *
   * `ctx.sessions` stores Session objects; the agent is a separate registry.
   */
  const sessionOf = (sessionId: string): SessionLike | undefined => {
    try {
      return readServices(host).sessions?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * The live agent for one id.
   *
   * `ctx.agents` is the agent registry. A session with no live agent (restored
   * but not resumed) has no `whenIdle`/`followup`; callers must cope.
   */
  const agentOf = (sessionId: string): AgentLike | undefined => {
    try {
      return readServices(host).agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /** Ask the outgoing model to write the nine sections. */
  const summarize = async (
    agent: AgentLike,
  ): Promise<{ brief: string; redactions: readonly string[] }> => {
    const services = readServices(host)
    const session = agent.session
    const events = sessionEvents(session)

    let facts: SessionFacts = readSessionFacts({
      session,
      occupancy: readContextOccupancy(session, services.tokenMeter),
      cumulative: readCumulativeUsage(session, services.sessionProjections, services.tokenMeter),
      events,
    })
    facts = withObservedServices(facts, services, agent)

    if (services.llm === undefined) {
      throw new Error('当前部署没有 llm 服务，无法生成交接简报')
    }

    /*
     * The summarising call must name a route.
     *
     * `llm.stream` does not choose a default provider or model; they are
     * required fields. The outgoing session's own route is the right one — the
     * model that did the work is the one that can describe it — and it is read
     * from the same facts the brief reports, with the deployment default as a
     * fallback when the session never recorded a request.
     */
    const route = summaryRoute(facts, services)
    if (route === undefined) {
      throw new Error('原会话没有记录模型路由，也没有部署默认模型，无法生成交接简报')
    }

    const narrative = await requestNarrative(
      services.llm,
      buildSummaryPrompt(facts),
      live.summaryMaxTokens,
      route,
    )

    if (!narrativeIsUsable(narrative)) {
      throw new Error('模型返回的简报内容不足（可用小节少于 3 段），已放弃本次交接')
    }

    const rendered = renderBrief({
      facts,
      narrative,
      sourceSessionId: agent.id,
      createdAt: Date.now(),
    })
    return { brief: rendered.text, redactions: rendered.redactions }
  }

  /** Fill the fields that live on services rather than on the session. */
  const withObservedServices = (
    facts: SessionFacts,
    services: ReturnType<typeof readServices>,
    agent: AgentLike,
  ): SessionFacts => {
    let permissionPreset: string | undefined
    try {
      permissionPreset = services.permissionPresets?.current(agent.session as never)
    } catch {
      permissionPreset = undefined
    }
    const plan = planModeFor(agent, services.agentPresets)
    return {
      ...facts,
      permissionPreset,
      planMode: plan === undefined ? 'unknown' : plan.active ? 'on' : 'off',
    }
  }

  const coordinator = new Coordinator({
    latches,
    summarize,
    compact: compactRunner({
      services: () => readServices(host),
      latches,
      waitIdle: async (agent) => {
        if (typeof agent.whenIdle === 'function') await agent.whenIdle()
      },
      signal: new AbortController().signal,
    }),
    migrate: async (brief) => migrateFor(brief, host, agentOf, sessionOf),
    waitIdle: async (agent) => {
      if (typeof agent.whenIdle === 'function') await agent.whenIdle()
    },
    /*
     * Retire the source session after its work has moved.
     *
     * `archiveSession({ stopActivity: true })` is the host's own "stop this
     * session's work" path: it writes the durable archive first, and only then
     * asks the stop providers, whose `agent/pre-step` gate reads that archive
     * set — so every wake the stops induce is already blocked. That ordering is
     * exactly the "start the new session, then stop the old one" sequence, and
     * it uses the host's mechanism instead of inventing one.
     *
     * The log is retained: archiving hides a session from the active list, it
     * does not delete history.
     */
    retire: async (sessionId, newSessionId) => {
      /*
       * Archiving the source is a preference, not a law.
       *
       * It defaults on because a session whose task moved otherwise sits in the
       * sidebar as if it were still the one to continue in. Turning it off keeps
       * the old session visible and running, which is what you want when
       * comparing the two or when the brief needs a second look.
       */
      if (!live.archiveSourceAfterHandoff) {
        log(`dsh-session-handoff: 旧会话 ${sessionId} 保持运行（设置要求不归档）`)
        return
      }
      const registry = readServices(host).workspaceRegistry
      if (registry === undefined) {
        throw new Error('当前部署没有 workspaceRegistry，无法归档旧会话')
      }
      if (typeof registry.archiveSession !== 'function') {
        throw new Error('当前部署的 workspaceRegistry 不支持归档会话')
      }
      await registry.archiveSession(sessionId, { stopActivity: true })
      log(
        `dsh-session-handoff: 旧会话 ${sessionId} 已归档${newSessionId === undefined ? '' : `（接手：${newSessionId}）`}`,
      )
    },
    now: () => Date.now(),
    log,
  })

  coordinator.activityCheck = (sessionId: string) => {
    const session = sessionOf(sessionId)
    const events = sessionEvents(session)
    // A session is worth handing over once it has either a human message or a
    // completed turn; an untouched new session has neither.
    return events.some((event) => event.type === 'user/message' || event.type === 'turn/start')
  }

  const applyBounds = (next: ConfigShape): void => {
    coordinator.configure({
      stepWaitMs: next.stepWaitTimeoutMs,
      actionDeadlineMs: next.actionDeadlineMs,
    })
  }
  applyBounds(live)

  const monitor = new Monitor({
    services: () => readServices(host),
    config: () => live,
    coordinator,
    latches,
    agentOf,
    sessionOf,
    summarize,
    migrate: async (brief) => migrateFor(brief, host, agentOf, sessionOf),
    runAction: (request) => sourceScope.run(request.sessionId, () => coordinator.run(request)),
    now: () => Date.now(),
    log,
  })

  const statusText = (sessionId: string): string => {
    const services = readServices(host)
    const status = coordinator.statusOf(sessionId)
    const session = sessionOf(sessionId)
    const validation = validateSettings(live)
    return renderStatus({
      phase: status.phase,
      busy: status.busy,
      latched: status.latched,
      waitingForStep: status.waitingForStep,
      slowWarning: status.slowWarning,
      newSessionId: status.newSessionId,
      occupancy: readContextOccupancy(session, services.tokenMeter),
      cumulative: readCumulativeUsage(session, services.sessionProjections, services.tokenMeter),
      thresholds: {
        handoffPercent: live.autoHandoffAtContextPercent,
        compactPercent: live.autoCompactAtContextPercent,
        cumulative: live.autoHandoffThreshold,
        enabled: live.autoHandoffEnabled,
        compactEnabled: live.autoCompactEnabled,
      },
      autoActions: monitor.autoActionsOf(sessionId),
      maxAutoActions: live.maxAutoActionsPerSession,
      lastText: status.lastResult?.text,
      lastFailure: status.lastFailure?.message,
      warnings: validation.warnings.map((warning) => warning.message),
      persistence: readServices(host) === undefined ? 'memory' : 'durable',
    })
  }

  host.effect(() => {
    log('dsh-session-handoff: 已挂载（自动动作默认关闭）')

    // ---- step veto --------------------------------------------------------
    const offPreStep = host.on('agent/pre-step', (...args: unknown[]) => {
      const payload = args[0] as
        | { agent?: AgentLike; messages?: readonly { source?: { kind?: string } }[] }
        | undefined
      const next = args[args.length - 1] as (() => Promise<unknown>) | undefined
      const agentId = payload?.agent?.id
      if (agentId === undefined || typeof next !== 'function') return next?.()
      if (!latches.isLatched(agentId)) return next()

      const decision = decidePreStep(true, payload?.messages as never)
      if (decision === undefined) return next()
      log(`dsh-session-handoff: 拒绝启动下一个 Step（${agentId}），等待交接`)
      return decision
    })

    // ---- session events ---------------------------------------------------
    const offEvent = host.on('session/event', (...args: unknown[]) => {
      const sessionId = (args[0] as { id?: string } | undefined)?.id
      const event = args[1] as { type?: string; seq?: number } | undefined
      if (sessionId === undefined || event?.type === undefined || event.seq === undefined) return
      try {
        monitor.onSessionEvent(sessionId, event as never)
      } catch (error) {
        host.logger?.error?.(error)
      }
    })

    const offDisposed = host.on('session/disposed', (...args: unknown[]) => {
      const sessionId = (args[0] as { id?: string } | undefined)?.id
      if (sessionId !== undefined) monitor.forget(sessionId)
    })

    /*
     * The command and the HTTP channel are registered only once their services
     * exist.
     *
     * `apply()` is called as soon as the services in `inject` are ready — which
     * for this plugin means `sessions` only. `commands` and `webServer` are
     * owned by other bundles that activate later, so reading them here returns
     * `undefined` and the registrations are silently skipped: the plugin is
     * "running", the row is "enabled", and `/handoff` does nothing and the
     * status route 404s.
     *
     * `ctx.inject` starts a child fiber that waits for exactly those services.
     * When they arrive the callback runs and its registrations ride that
     * fiber's lifetime, so unloading still cleans up.
     */
    const registerLater = (services: readonly string[], label: string, run: () => (() => void) | undefined): void => {
      try {
        const injector = (ctx as unknown as { inject?: (deps: readonly string[], cb: () => void) => unknown }).inject
        if (typeof injector === 'function') {
          injector.call(ctx, services, () => {
            try {
              const disposer = run()
              if (disposer !== undefined) ctx.effect(() => disposer, label)
            } catch (error) {
              host.logger?.error?.(error)
            }
          })
          return
        }
      } catch (error) {
        host.logger?.error?.(error)
      }
      // A context without `inject` (tests, or an older Cordis): run eagerly and
      // degrade exactly as before.
      const disposer = run()
      if (disposer !== undefined) ctx.effect(() => disposer, label)
    }

    // ---- command ----------------------------------------------------------
    registerLater(['commands'], 'dsh-session-handoff: /handoff', () => {
      const commands = readServices(host).commands
      if (commands === undefined) {
        log('dsh-session-handoff: 没有 commands 服务，/handoff 命令不可用')
        return undefined
      }
      return commands.register({
        name: 'handoff',
        description: '把当前会话交接到同工作区的新会话（status / cancel / retry）',
        input: { hint: 'status | cancel | retry' },
        handler: async (invocation) => {
          const agent = invocation.agent
          const sessionId = agent?.id
          const raw = invocation.rawInput ?? ''

          if (sessionId === undefined) {
            return { kind: 'error', text: '无法确定当前会话，/handoff 不可用。' }
          }

          try {
            const outcome = await runCommand(parseCommandArgs(raw), sessionId, {
              handoff: async (id, detail) => {
                monitor.markPending(id)
                // Scoped to this action: a concurrent automatic handoff for
                // another session keeps its own id.
                return sourceScope.run(id, () =>
                  coordinator.run({
                    sessionId: id,
                    agent: agentOf(id),
                    kind: 'handoff',
                    reason: 'manual',
                    automatic: false,
                    ...(detail === undefined ? {} : { detail }),
                  }),
                )
              },
              cancel: (id) => coordinator.requestCancel(id),
              status: statusText,
              retry: async (id) => {
                monitor.markPending(id)
                return sourceScope.run(id, () =>
                  coordinator.run({
                    sessionId: id,
                    agent: agentOf(id),
                    kind: 'handoff',
                    reason: 'manual',
                    automatic: false,
                    detail: '手动 retry',
                  }),
                )
              },
            })
            return outcome.ok
              ? { kind: 'success', text: outcome.text }
              : { kind: 'error', text: outcome.text }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      })
    })

    // ---- HTTP channel -----------------------------------------------------
    registerLater(['webServer'], 'dsh-session-handoff: routes', () => {
      const webServer = host.get('webServer') as
        | { register(route: { kind: 'prefix'; path: string; handler: unknown }): () => void }
        | undefined
      if (webServer === undefined) {
        log('dsh-session-handoff: 没有 webServer 服务，设置页的状态通道不可用')
        return undefined
      }
      const handler = async (
        req: {
          url?: string
          method?: string
          socket?: { remoteAddress?: string }
          headers?: Record<string, string | string[] | undefined>
        } & AsyncIterable<Uint8Array>,
        res: Parameters<typeof sendJson>[0],
      ): Promise<void> => {
        const path = (req.url ?? '').split('?')[0] ?? ''
        const action = path.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
        const loopback = isLoopbackRequest(req.socket?.remoteAddress)

        try {
          /*
           * Read the row's current configuration.
           *
           * The Configuration page needs the persisted values, not the
           * defaults: the browser mirror is unavailable to this bundle, so
           * reading through it silently produced defaults and the page kept
           * showing 85% after the user had saved 40%. This is the read half of
           * the save route below, and both use `live`, which is the value the
           * Loader actually applied.
           */
          if (action === 'config' && (req.method ?? 'GET') === 'GET') {
            sendJson(res, 200, { ok: true, settings: live })
            return
          }

          if (action === 'state' && (req.method ?? 'GET') === 'GET') {
            const sessionId = sessionIdFromUrl(req.url)
            if (sessionId === undefined) {
              sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
              return
            }
            const services = readServices(host)
            const validation = validateSettings(live)
            sendJson(
              res,
              200,
              statePayload(sessionId, {
                statusOf: (id) => coordinator.statusOf(id),
                occupancyOf: (id) => monitor.occupancyOf(id),
                cumulativeOf: (id) => monitor.cumulativeOf(id),
                autoActionsOf: (id) => monitor.autoActionsOf(id),
                settings: live,
                warnings: () => {
                  const warnings = validation.warnings.map((w) => w.message)
                  if (live.autoHandoffEnabled && services.tokenMeter === undefined) {
                    warnings.push('当前部署没有 tokenMeter，无法测量上下文占用率')
                  }
                  return warnings
                },
                persistence: 'durable',
              }),
            )
            return
          }

          if ((req.method ?? 'GET') !== 'POST') {
            sendJson(res, 405, { ok: false, error: '方法不允许' })
            return
          }

          // Mutating verbs are loopback-only: they can create sessions.
          if (!loopback) {
            sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
            return
          }

          /*
           * Persist settings through the host's own config editor.
           *
           * The Configuration page cannot write through the browser mirror on
           * this build, so the card posts here instead. `configEditor.edit`
           * applies the change through the normal Loader path, which means the
           * schema still validates it and the row is re-applied — the same two
           * things a hand-edited profile file would go through.
           *
           * Handled before the `sessionId` check because settings are global to
           * the plugin, not to a conversation.
           */
          if (action === 'settings') {
            const patch = (await readJsonBody(req)) as { settings?: unknown }
            const next = patch.settings
            if (next === null || typeof next !== 'object') {
              sendJson(res, 400, { ok: false, error: '缺少 settings 对象' })
              return
            }
            const editor = readServices(host).configEditor
            if (editor?.edit === undefined || editor.configuration === undefined) {
              sendJson(res, 400, { ok: false, error: '当前部署没有 configEditor，无法保存设置' })
              return
            }
            try {
              const entries = editor.configuration()
              const row = entries.find(
                (entry) =>
                  entry.entry?.id === 'include:dsh-session-handoff' ||
                  entry.entry?.id === 'dsh-session-handoff',
              )
              if (row?.entry === undefined) {
                sendJson(res, 404, { ok: false, error: '找不到本插件的配置行' })
                return
              }
              const desired = next as Record<string, unknown>
              await editor.edit(row.entry, (current) => ({ ...current, ...desired }))
              sendJson(res, 200, { ok: true, text: '设置已保存，立即生效。' })
            } catch (error) {
              sendJson(res, 500, {
                ok: false,
                error: `保存失败：${error instanceof Error ? error.message : String(error)}`,
              })
            }
            return
          }

          const body = (await readJsonBody(req)) as { sessionId?: unknown }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
          if (sessionId === undefined) {
            sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
            return
          }

          if (action === 'handoff' || action === 'retry') {
            monitor.markPending(sessionId)
            const result = await sourceScope.run(sessionId, () =>
              coordinator.run({
                sessionId,
                agent: agentOf(sessionId),
                kind: 'handoff',
                reason: 'manual',
                automatic: false,
                detail: action === 'retry' ? '手动 retry' : '手动 handoff',
              }),
            )
            sendJson(res, 200, result)
            return
          }

          if (action === 'cancel') {
            const accepted = coordinator.requestCancel(sessionId)
            sendJson(res, 200, {
              ok: accepted,
              phase: coordinator.statusOf(sessionId).phase,
              text: accepted ? '已请求取消，将在下一个安全检查点停止。' : '当前没有进行中的动作。',
            })
            return
          }

          sendJson(res, 404, { ok: false, error: '未知操作' })
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
    })

    // ---- teardown ---------------------------------------------------------
    return () => {
      log('dsh-session-handoff: 卸载')
      offPreStep?.()
      offEvent?.()
      offDisposed?.()
      monitor.dispose()
    }
  }, 'dsh-session-handoff')

  /** Keep the live config in step with the loader when the row is re-applied. */
  Object.assign(live, config)
}

/**
 * Run the migration.
 *
 * The snapshot is read first, while the source agent is still alive: Plan mode
 * and the permission preset live on per-agent services that disappear with the
 * agent. Everything after the create is best-effort and reported item by item.
 */
async function migrateFor(
  brief: string,
  host: { get(name: string): unknown },
  agentOf: (id: string) => AgentLike | undefined,
  sessionOf: (id: string) => SessionLike | undefined,
): Promise<ActionResult> {
  // The source id travels with the action, not in shared mutable state.
  const sourceSessionId = sourceScope.getStore()
  if (sourceSessionId === undefined) {
    return {
      ok: false,
      phase: 'failed',
      text: '内部错误：交接动作缺少来源会话 id，已放弃且未创建任何会话。',
      error: 'missing-source',
    }
  }
  const sourceSession = sessionOf(sourceSessionId)
  const services = readServices(host)
  const sourceAgent = agentOf(sourceSessionId)

  const defaultModel = safely(() => services.agentDefaultModel?.currentSelection())

  const source = snapshotSource({
    session: sourceSession,
    sessionId: sourceSessionId,
    agent: sourceAgent,
    permissionPresets: services.permissionPresets,
    approval: services.approval,
    agentPresets: services.agentPresets,
    defaultModel,
  })

  const result = await migrateSession(
    { source, brief },
    {
      sessionController: services.sessionController,
      workspaceRegistry: services.workspaceRegistry,
      permissionPresets: services.permissionPresets,
      approval: services.approval,
      agentPresets: services.agentPresets,
      defaultModel,
      resolveAgent: agentOf,
    },
  )

  return {
    ok: result.ok,
    phase: result.ok ? 'completed' : 'failed',
    text: result.ok
      ? `已创建新会话 ${result.newSessionId ?? ''} 并投递简报。`
      : `交接未完成：${result.error ?? '未知原因'}`,
    ...(result.newSessionId === undefined ? {} : { newSessionId: result.newSessionId }),
    inherited: result.inherited,
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

function safely<T>(read: () => T | undefined): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Ask the model for the nine sections.
 *
 * `llm.stream` rather than a `generate` helper: the service exposes only the
 * streaming API, and it requires an explicit provider/model route. The prompt
 * carries the section structure, and no `purpose` is passed — that union is
 * closed on this build and only accepts the harness' own two values.
 */
export async function requestNarrative(
  llm: LlmLike,
  prompt: string,
  maxTokens: number,
  route: { provider: string; model: string },
): Promise<BriefNarrative> {
  const stream = llm.stream
  if (typeof stream !== 'function') {
    throw new Error('当前 llm 服务没有 stream 方法，无法生成交接简报')
  }

  const chunks = stream.call(llm, {
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
  })

  let text = ''
  let failure: string | undefined
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    if (chunk.type === 'finish') {
      const reason = (chunk as { reason?: { kind?: string; failure?: { message?: string } } }).reason
      if (reason?.kind === 'error' || reason?.kind === 'aborted') {
        failure = reason.failure?.message ?? reason.kind
      }
    }
  }

  if (failure !== undefined) throw new Error(`模型调用失败：${failure}`)
  return parseNarrative(text)
}

/**
 * The route used to summarize.
 *
 * Prefers the session's own provider/model — the model that did the work is the
 * one that can describe it — and falls back to the deployment default when the
 * session never recorded a request.
 */
function summaryRoute(
  facts: SessionFacts,
  services: ReturnType<typeof readServices>,
): { provider: string; model: string } | undefined {
  if (facts.provider !== undefined && facts.model !== undefined) {
    return { provider: facts.provider, model: facts.model }
  }
  try {
    const fallback = services.agentDefaultModel?.currentSelection()
    return fallback === undefined ? undefined : { provider: fallback.provider, model: fallback.model }
  } catch {
    return undefined
  }
}

void factsFromLog
void deliverBrief
void waitForBoundary
