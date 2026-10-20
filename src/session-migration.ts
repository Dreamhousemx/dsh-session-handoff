/**
 * Moving a task from one session to another.
 *
 * ## Order of operations, and why
 *
 * 1. **Create by `cwd`**, never by `workspaceId`. The session's directory is the
 *    real fact to preserve; a workspace is a sidebar grouping that may or may
 *    not exist yet. Passing both is a bad request on hosts where they are
 *    mutually exclusive, and a failure to attach must not be reported as a
 *    failure to create — the new session exists and must not be orphaned.
 * 2. **Attach to the workspace** as a best-effort step. A missing attachment
 *    means "ungrouped in the sidebar", which is reported, not fatal.
 * 3. **Inherit one item at a time**, recording an outcome for each. A model or
 *    permission that cannot be reproduced is far less important than the new
 *    session existing and starting on the task.
 * 4. **Deliver the brief last.** Until it lands, the new session is empty. If
 *    delivery fails, the caller keeps the session id and reports it: an
 *    unstarted session the user can type into is better than a silent loss.
 *
 * ## What is never inherited
 *
 * Browser state (scroll position, drafts, collapsed panels) and unsaved UI
 * selections are private to one tab and meaningless to another. A `custom`
 * permission preset has no name to replay, so only its approval policy is
 * carried, and the report says the sandbox tier was not.
 */
import type {
  AgentLike,
  AgentPresetsLike,
  ApprovalLike,
  PermissionPresetsLike,
  SessionControllerLike,
  SessionLike,
  WorkspaceRegistryLike,
} from './contracts.ts'
import type { InheritOutcome } from './types.ts'

/** Everything the migration needs, all of it optional except `create`. */
export interface MigrationDeps {
  readonly sessionController: SessionControllerLike | undefined
  readonly workspaceRegistry: WorkspaceRegistryLike | undefined
  readonly permissionPresets: PermissionPresetsLike | undefined
  readonly approval: ApprovalLike | undefined
  readonly agentPresets: AgentPresetsLike | undefined
  readonly defaultModel: { provider: string; model: string } | undefined
  /** Resolve a live agent for a session id, for the delivery step. */
  readonly resolveAgent: (sessionId: string) => AgentLike | undefined
  readonly log?: (message: string) => void
}

/** What the source session asks to carry across. */
export interface SourceSnapshot {
  readonly sessionId: string
  readonly cwd: string | undefined
  readonly agentPreset: string | undefined
  readonly model: { provider: string; model: string } | undefined
  readonly permissionPreset: string | undefined
  readonly approvalPolicy: unknown
  readonly planMode: { readonly active: boolean } | undefined
}

export interface MigrationRequest {
  readonly source: SourceSnapshot
  /** The rendered brief, delivered as the new session's first message. */
  readonly brief: string
}

export interface MigrationResult {
  readonly ok: boolean
  readonly newSessionId?: string
  readonly inherited: readonly InheritOutcome[]
  readonly delivered: boolean
  readonly error?: string
}

/**
 * Read everything the migration will try to inherit, while the source agent is
 * still alive. Reading after the agent is disposed loses the per-agent
 * services (plan mode in particular).
 */
export function snapshotSource(source: {
  session: SessionLike | undefined
  sessionId: string
  agent: AgentLike | undefined
  permissionPresets: PermissionPresetsLike | undefined
  approval: ApprovalLike | undefined
  agentPresets: AgentPresetsLike | undefined
  defaultModel: { provider: string; model: string } | undefined
}): SourceSnapshot {
  const header = source.session?.header
  const requestContext = safely(() => source.session?.requestContext?.())
  const headerConfig = safely(() => source.session?.requestHeader?.()?.config)

  const provider = requestContext?.provider ?? headerConfig?.provider
  const model = requestContext?.model ?? headerConfig?.model

  const modelSelection =
    provider !== undefined && model !== undefined
      ? { provider, model }
      : source.defaultModel

  const permissionPreset = safely(() => source.permissionPresets?.current(source.session!))
  const approvalPolicy = safely(() => source.approval?.overrideOf(source.session!))

  const planMode = safely(() => planModeFor(source.agent, source.agentPresets))

  return {
    sessionId: source.sessionId,
    cwd: header?.cwd,
    agentPreset: header?.agentPreset,
    model: modelSelection,
    permissionPreset,
    approvalPolicy,
    planMode,
  }
}

/**
 * Resolve Plan mode for one agent.
 *
 * On the Web surface `planMode` lives inside each agent preset's isolated
 * realm, so the host-plane lookup returns nothing for a session that really has
 * the service. The preset-aware lookup is tried first, the host plane second,
 * which keeps TUI deployments working.
 */
export function planModeFor(
  agent: AgentLike | undefined,
  agentPresets: AgentPresetsLike | undefined,
): { active: boolean } | undefined {
  if (agent === undefined) return undefined

  const scoped = safely(() => agentPresets?.serviceFor?.({ ctx: agent.ctx }, 'planMode')) as
    | { get?: (a: AgentLike) => { active?: boolean } | undefined }
    | undefined
  const scopedState = safely(() => scoped?.get?.(agent))
  if (scopedState !== undefined) return { active: scopedState.active === true }

  const hostPlane = agent.ctx as
    | { get?: (name: string) => { get?: (a: AgentLike) => { active?: boolean } | undefined } | undefined }
    | undefined
  const hostService = safely(() => hostPlane?.get?.('planMode'))
  const hostState = safely(() => hostService?.get?.(agent))
  if (hostState !== undefined) return { active: hostState.active === true }

  return undefined
}

function safely<T>(read: () => T | undefined): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Perform the migration.
 *
 * Every failure after session creation is recorded, not thrown: the caller needs
 * the new session id regardless of how much of the configuration made it.
 */
export async function migrateSession(
  request: MigrationRequest,
  deps: MigrationDeps,
): Promise<MigrationResult> {
  const inherited: InheritOutcome[] = []
  const { source } = request

  const controller = deps.sessionController
  if (controller === undefined) {
    return {
      ok: false,
      inherited,
      delivered: false,
      error: '当前部署没有 sessionController，无法创建新会话',
    }
  }

  // 1. Create.
  let newSessionId: string
  try {
    const created = await controller.create({
      ...(source.cwd === undefined ? {} : { cwd: source.cwd }),
      ...(source.agentPreset === undefined ? {} : { agentPreset: source.agentPreset }),
    })
    newSessionId = created.sessionId
    inherited.push({
      item: 'cwd',
      status: source.cwd === undefined ? 'skipped' : 'inherited',
      ...(source.cwd === undefined ? { detail: '原会话没有工作目录' } : {}),
    })
    inherited.push({
      item: 'preset',
      status: source.agentPreset === undefined ? 'fallback' : 'inherited',
      ...(source.agentPreset === undefined
        ? { detail: '原会话未选 preset，沿用部署默认' }
        : {}),
    })
  } catch (error) {
    return {
      ok: false,
      inherited,
      delivered: false,
      error: `创建新会话失败：${messageOf(error)}`,
    }
  }

  // 2. Workspace attachment, best effort.
  inherited.push(await attachWorkspace(newSessionId, source.cwd, deps.workspaceRegistry))

  // 3. Model.
  inherited.push(await inheritModel(newSessionId, source.model, controller))

  // 4. Permission preset, or the raw policy for a custom preset.
  inherited.push(
    await inheritPermission(newSessionId, source, deps),
  )

  // 5. Plan mode, applied on the new session's own agent.
  inherited.push(await inheritPlanMode(newSessionId, source.planMode, deps))

  // 6. Deliver the brief.
  const delivery = await deliverBrief(newSessionId, request.brief, deps)
  inherited.push(delivery.outcome)

  const ok = delivery.delivered
  return {
    ok,
    newSessionId,
    inherited,
    delivered: delivery.delivered,
    ...(ok ? {} : { error: delivery.error ?? '简报投递失败；新会话已创建但尚未开始工作' }),
  }
}

async function attachWorkspace(
  newSessionId: string,
  cwd: string | undefined,
  registry: WorkspaceRegistryLike | undefined,
): Promise<InheritOutcome> {
  if (cwd === undefined) {
    return { item: 'workspace', status: 'skipped', detail: '没有工作目录' }
  }
  if (registry === undefined) {
    return { item: 'workspace', status: 'skipped', detail: '当前部署没有 workspaceRegistry' }
  }
  try {
    const workspace = await registry.resolveByPath(cwd)
    if (workspace === undefined) {
      return {
        item: 'workspace',
        status: 'fallback',
        detail: '该目录不是已注册的工作区；新会话会出现在未分组区域（不自动创建，避免改动侧栏顺序）',
      }
    }
    if (typeof workspace.attachSession !== 'function') {
      return { item: 'workspace', status: 'fallback', detail: '工作区不支持附加会话' }
    }
    await workspace.attachSession(newSessionId)
    return { item: 'workspace', status: 'inherited' }
  } catch (error) {
    return { item: 'workspace', status: 'fallback', detail: `附加工作区失败：${messageOf(error)}` }
  }
}

async function inheritModel(
  newSessionId: string,
  model: { provider: string; model: string } | undefined,
  controller: SessionControllerLike,
): Promise<InheritOutcome> {
  if (model === undefined) {
    return { item: 'model', status: 'skipped', detail: '原会话与部署都没有上报模型' }
  }
  try {
    const selected = await controller.selectModel({
      sessionId: newSessionId,
      provider: model.provider,
      model: model.model,
    })
    const ok = selected.selected.model === model.model
    return ok
      ? { item: 'model', status: 'inherited', detail: `${model.provider}/${model.model}` }
      : {
          item: 'model',
          status: 'fallback',
          detail: `请求 ${model.model}，实际选中 ${selected.selected.model}`,
        }
  } catch (error) {
    return { item: 'model', status: 'fallback', detail: `选择模型失败：${messageOf(error)}` }
  }
}

async function inheritPermission(
  newSessionId: string,
  source: SourceSnapshot,
  deps: MigrationDeps,
): Promise<InheritOutcome> {
  const presets = deps.permissionPresets
  if (presets === undefined) {
    return { item: 'permission', status: 'skipped', detail: '当前部署没有 permissionPresets' }
  }

  const target = { id: newSessionId }
  try {
    if (source.permissionPreset !== undefined) {
      await presets.set(target as never, source.permissionPreset)
      return { item: 'permission', status: 'inherited', detail: source.permissionPreset }
    }

    // A `custom` preset has no name to replay; carry its policy instead.
    if (source.approvalPolicy !== undefined && deps.approval !== undefined) {
      const newAgent = deps.resolveAgent(newSessionId)
      if (newAgent === undefined) {
        return { item: 'permission', status: 'fallback', detail: '无法解析新会话 Agent，审批策略未继承' }
      }
      deps.approval.setPolicy(newAgent, source.approvalPolicy)
      return {
        item: 'permission',
        status: 'fallback',
        detail: '原会话为自定义权限：已继承审批策略，sandbox 档位未继承（没有对应的预设名可重放）',
      }
    }

    return { item: 'permission', status: 'skipped', detail: '原会话没有可继承的权限预设' }
  } catch (error) {
    return { item: 'permission', status: 'fallback', detail: messageOf(error) }
  }
}

async function inheritPlanMode(
  newSessionId: string,
  sourceState: { readonly active: boolean } | undefined,
  deps: MigrationDeps,
): Promise<InheritOutcome> {
  if (sourceState === undefined) {
    return { item: 'planMode', status: 'skipped', detail: '当前部署没有 planMode 服务' }
  }
  const newAgent = deps.resolveAgent(newSessionId)
  if (newAgent === undefined) {
    return { item: 'planMode', status: 'fallback', detail: '无法解析新会话 Agent' }
  }

  // Same realm rules as reading: prefer the preset-scoped instance.
  const scoped = safely(() => deps.agentPresets?.serviceFor?.({ ctx: newAgent.ctx }, 'planMode')) as
    | { set?: (a: AgentLike, active: boolean) => void }
    | undefined
  if (scoped?.set !== undefined) {
    try {
      scoped.set(newAgent, sourceState.active)
      return {
        item: 'planMode',
        status: 'inherited',
        detail: sourceState.active ? '开启' : '关闭',
      }
    } catch (error) {
      return { item: 'planMode', status: 'fallback', detail: messageOf(error) }
    }
  }

  const hostPlane = newAgent.ctx as
    | { get?: (name: string) => { set?: (a: AgentLike, active: boolean) => void } | undefined }
    | undefined
  const hostService = safely(() => hostPlane?.get?.('planMode'))
  if (hostService?.set !== undefined) {
    try {
      hostService.set(newAgent, sourceState.active)
      return {
        item: 'planMode',
        status: 'inherited',
        detail: sourceState.active ? '开启' : '关闭',
      }
    } catch (error) {
      return { item: 'planMode', status: 'fallback', detail: messageOf(error) }
    }
  }

  return { item: 'planMode', status: 'fallback', detail: '新会话所在 realm 里没有 planMode 实例' }
}

/**
 * Deliver the brief as the new session's first message.
 *
 * Uses `agent.followup` with a `plugin` source rather than the session API's
 * prompt, because that path hard-codes the `user-rpc` source and would make the
 * brief look like something the human typed.
 */
export async function deliverBrief(
  newSessionId: string,
  brief: string,
  deps: MigrationDeps,
): Promise<{ delivered: boolean; outcome: InheritOutcome; error?: string }> {
  const agent = deps.resolveAgent(newSessionId)
  if (agent === undefined) {
    return {
      delivered: false,
      outcome: { item: 'brief', status: 'skipped', detail: '新会话尚未激活，无法投递' },
      error: '新会话已创建但没有可用的 Agent，简报未投递',
    }
  }
  if (typeof agent.followup !== 'function') {
    return {
      delivered: false,
      outcome: { item: 'brief', status: 'skipped', detail: '该宿主未提供 agent.followup' },
      error: '该宿主未提供 agent.followup，简报未投递',
    }
  }

  try {
    await agent.followup(brief, { source: { kind: 'plugin' } })
    return { delivered: true, outcome: { item: 'brief', status: 'inherited', detail: '已投递' } }
  } catch (error) {
    return {
      delivered: false,
      outcome: { item: 'brief', status: 'skipped', detail: messageOf(error) },
      error: `简报投递失败：${messageOf(error)}`,
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Render the per-item inheritance report for humans. */
export function describeInheritance(items: readonly InheritOutcome[]): string {
  const label = { inherited: '已继承', fallback: '回退', skipped: '未继承' } as const
  return items
    .map((item) => {
      const detail = item.detail === undefined ? '' : `（${item.detail}）`
      return `- ${item.item}：${label[item.status]}${detail}`
    })
    .join('\n')
}
