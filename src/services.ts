/**
 * Resolving host services without snapshotting them.
 *
 * The loader assembles same-layer entries concurrently, and a row that injects
 * services stays pending until its dependencies exist. `sessionController`
 * injects ten services of its own, so it frequently becomes available *after*
 * this plugin's `apply()` has run. Reading once inside `apply()` would therefore
 * report a healthy deployment as "no sessionController".
 *
 * Every read goes through this accessor instead: cheap `ctx.get` per use, no
 * caching of the service object across calls.
 */
import type {
  AgentsLike,
  AgentPresetsLike,
  AgentDefaultModelLike,
  ApprovalLike,
  CommandsLike,
  ConfigEditorLike,
  CompactionLike,
  HostServices,
  LlmLike,
  PermissionPresetsLike,
  SessionControllerLike,
  SessionProjectionsLike,
  SessionsStoreLike,
  TokenMeterLike,
  WorkspaceRegistryLike,
} from './contracts.ts'

/** The slice of Cordis' Context this plugin touches; keeping it narrow keeps tests simple. */
export interface ServiceHost {
  get(name: string): unknown
}

export function readServices(host: ServiceHost): HostServices {
  const get = <T>(name: string): T | undefined => {
    try {
      return host.get(name) as T | undefined
    } catch {
      return undefined
    }
  }

  return {
    sessions: get<SessionsStoreLike>('sessions'),
    agents: get<AgentsLike>('agents'),
    sessionController: get<SessionControllerLike>('sessionController'),
    sessionProjections: get<SessionProjectionsLike>('sessionProjections'),
    tokenMeter: get<TokenMeterLike>('tokenMeter'),
    workspaceRegistry: get<WorkspaceRegistryLike>('workspaceRegistry'),
    permissionPresets: get<PermissionPresetsLike>('permissionPresets'),
    approval: get<ApprovalLike>('approval'),
    agentPresets: get<AgentPresetsLike>('agentPresets'),
    agentDefaultModel: get<AgentDefaultModelLike>('agentDefaultModel'),
    compaction: get<CompactionLike>('compaction'),
    llm: get<LlmLike>('llm'),
    commands: get<CommandsLike>('commands'),
    configEditor: get<ConfigEditorLike>('configEditor'),
  }
}

/**
 * The services this plugin declares in `inject`.
 *
 * Only `sessions` is guaranteed in every composition that can host a plugin
 * row. Everything else is read lazily, because declaring a service that may be
 * absent keeps the whole row `pending` forever — the plugin never activates and
 * the command and configuration card silently disappear.
 *
 * This was measured, not assumed: a composition built from the shipped base
 * bundle reports `pending (waiting for service: sessionController)` for the
 * whole row when `sessionController` is injected, even though the session
 * controller row is present in a full profile. `compaction` and `planMode` are
 * additionally mounted per agent preset inside an isolated realm on the Web
 * surface, and `llm` is absent on a profile with no model configured.
 *
 * The cost of lazy reads is that a missing service surfaces where it is needed
 * (`ctx.get(...) === undefined`) instead of blocking activation, which is the
 * right trade: `/handoff status` and the settings card must work even when a
 * handoff itself cannot complete.
 */
export const INJECT = ['sessions'] as const
