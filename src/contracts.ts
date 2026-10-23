/**
 * Structural contracts for the host services this plugin consumes.
 *
 * None of these packages are installed as dependencies of this bundle: the DSH
 * runtime resolves them from the profile, and a plugin that hard-depended on
 * `@deepseek-ai/dsh-agent-loop` would break on every host that ships a
 * different patch version. Each interface below therefore restates *only the
 * members this plugin calls*, discovered from the live installation through
 * `cordis_inspect` (see docs/plugin-development-plan.md §6).
 *
 * The rule for every one of them: a wrong shape here is a runtime `undefined`,
 * never a startup crash. Call sites must check for absence and degrade.
 */

/** Branded id types are structurally strings at runtime; naming them keeps intent clear. */
export type SessionId = string

/** One model-visible message as it arrives in `agent/pre-step`. */
export interface AgentMessageLike {
  readonly role?: string
  /** Set by the runtime: `user` for human input, `plugin`, `goal`, or a model source. */
  readonly source?: { readonly kind?: string } | undefined
  readonly content?: unknown
}

/** The `PreStepDecision` union the waterfall resolves to. */
export type PreStepDecisionLike =
  | { kind: 'reject' }
  | {
      kind: 'enter'
      messages: readonly AgentMessageLike[]
      startsRequestSeries?: true
    }

/**
 * The agent handle. `cancel` is deliberately NOT declared: this plugin never
 * cancels a running turn, and leaving the method off the type makes an
 * accidental call a compile error rather than a design drift.
 */
export interface AgentLike {
  readonly id: SessionId
  readonly ctx?: unknown
  readonly session?: SessionLike
  /** Resolves once the agent has no in-flight step. */
  whenIdle?(): Promise<void>
  /** Deliver a message without claiming it through `sessionController.prompt`. */
  followup?(content: unknown, options?: { source?: { kind: string } }): Promise<unknown> | unknown
  /** Queue context for the next admitted step (does not wake the agent). */
  inject?(content: unknown, options?: { source?: { kind: string } }): Promise<unknown> | unknown
  /** Live status, when the host exposes it. */
  readonly status?: string
}

/** The session log handle: the only source of truth this plugin reads. */
export interface SessionLike {
  readonly id: SessionId
  readonly header?: SessionHeaderLike
  /** The current request envelope, including the routed model and its window. */
  requestContext?(): RequestContextLike | undefined
  /** The latest frozen call configuration. */
  requestHeader?(): { config?: { provider?: string; model?: string } } | undefined
  /**
   * The session's own committed events, oldest first.
   *
   * `Session` does NOT expose an `events` property — an earlier version of this
   * plugin assumed one, read `undefined`, and therefore judged every session to
   * be blank, refusing every handoff with "当前没有可迁移的活动会话". The real
   * accessors are `ownEvents()` and `snapshotEvents(from, to)`.
   */
  ownEvents?(): readonly SessionEventLike[]
  /** A slice of the log; used when `ownEvents` is unavailable. */
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly SessionEventLike[]
  /** The current model-visible surface (a list of seq numbers). */
  readonly surface?: { readonly nodes?: readonly number[] }
}

/*
 * ## Both event accessors are deprecated on the host, and this plugin still uses them
 *
 * `dsh-session/lib/index.js` marks `snapshotEvents` (line 1446) and `ownEvents`
 * (line 1461) `@deprecated`: "new calls are prohibited", citing the Agent Note
 * on deprecating synchronous session-event reads. They remain the only
 * synchronous way to answer "what did this conversation contain", which is what
 * every question in this plugin starts from, so they stay — deliberately, not
 * by oversight.
 *
 * The migration target is not usable from a plugin yet. The host's guidance is
 * to observe `session/event` and fold projections, which cannot answer for a
 * session that already exists: a fork from another month, a session restored
 * from disk, or the outgoing session at handoff time. Recorded here so the next
 * reader does not find the deprecation and assume this file missed it.
 *
 * Consequence to watch: if a future host removes these, `sessionEvents` falls
 * through to `[]`, `activityCheck` calls every session blank, and `/handoff`
 * refuses all of them. That failure is loud and lands in the two functions
 * below, which is the best available mitigation.
 */

/**
 * The COMPLETE durable log of one session, inherited history included.
 *
 * ## Why `snapshotEvents` comes first, and `ownEvents` is not the default
 *
 * The host's two accessors differ in what they cover:
 *
 *     ownEvents()      { return this.snapshotEvents(this.inheritedEventCount) }
 *     snapshotEvents() { return the whole log }
 *
 * (`dsh-session/lib/index.js`.) A session forked from another therefore has
 * `inheritedEventCount > 0`, and `ownEvents()` reports only what it did itself —
 * the inherited prefix is invisible.
 *
 * Reading `ownEvents` first made every question about the conversation answer
 * for a fragment:
 *
 * - `activityCheck` saw no `user/message` or `turn/start` in a fork whose whole
 *   history was inherited, called it blank, and refused the handoff with
 *   "当前没有可迁移的活动会话" — a rejection that looks like a bug.
 * - The brief was written from the fragment, so inherited work vanished from it.
 * - `windowFromEvents` could not find the `request/context` that established
 *   the model, so occupancy was reported as unmeasurable.
 *
 * Everything this plugin does is about "the conversation", so the default is
 * the whole log. `ownSessionEvents` exists for the one case that genuinely wants
 * the session's own share.
 */
export function sessionEvents(session: SessionLike | undefined): readonly SessionEventLike[] {
  if (session === undefined) return []
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    }
    if (typeof session.ownEvents === 'function') {
      const events = session.ownEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    // A log that cannot be read is treated as empty, which the callers report
    // as "blank session" rather than as a crash.
  }
  return []
}

/**
 * Only the events this session itself appended, excluding inherited history.
 *
 * Prefers `ownEvents()`; when the host has no such accessor the whole log is
 * returned, because a superset is a safer answer than none — a caller using
 * this to count "what this session did" would over-count after a fork, which
 * the callers here accept.
 */
export function ownSessionEvents(session: SessionLike | undefined): readonly SessionEventLike[] {
  if (session === undefined) return []
  try {
    if (typeof session.ownEvents === 'function') {
      const events = session.ownEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    // Fall through to the whole log rather than reporting nothing.
  }
  return sessionEvents(session)
}

/** Immutable session metadata inherited across a handoff. */
export interface SessionHeaderLike {
  readonly id?: SessionId
  readonly cwd?: string
  readonly agentPreset?: string
  readonly parentSession?: SessionId
  readonly origin?: string
}

/** What the routed model is and how much window it has. */
export interface RequestContextLike {
  readonly provider?: string
  readonly model?: string
  /** Total context window in tokens; absent when the model does not report one. */
  readonly contextWindow?: number
}

/** One committed session event. Only the fields this plugin folds are typed. */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly data?: Record<string, unknown>
}

/** The token-usage projection state, when that projection is registered. */
export interface TokenUsageProjectionState {
  readonly totals?: {
    readonly uncachedInputTokens?: number
    readonly outputTokens?: number
    readonly readTokens?: number
    readonly writeTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
  }
}

/**
 * The measurement `ctx.tokenMeter.measure()` returns.
 *
 * `surfaceTokens` is the size of the current model-visible surface: that is the
 * numerator of the context-occupancy ratio. `baseline.kind` says whether the
 * number is anchored on real provider usage.
 */
export interface TokenMeasurementLike {
  readonly totalTokens: number
  readonly surfaceTokens: number
  readonly baseline?: { readonly kind?: 'none' | 'estimated' | 'usage'; readonly tokens?: number }
}

export interface TokenMeterLike {
  measure(session: SessionLike, requestHeader?: unknown): TokenMeasurementLike
}

export interface SessionProjectionsLike {
  stateOf(session: SessionLike, key: string): unknown
}

/** `ctx.sessionController` — the only service that may create a session. */
export interface SessionControllerLike {
  create(request: {
    cwd?: string
    workspaceId?: string
    sessionId?: string
    agentPreset?: string
  }): Promise<{ sessionId: SessionId; agentPreset?: string }>
  selectModel(request: {
    sessionId: SessionId
    provider: string
    model: string
  }): Promise<{ selected: { provider: string; model: string } }>
}

/** `ctx.workspaceRegistry` — durable workspace ownership. */
export interface WorkspaceLike {
  attachSession?(sessionId: SessionId): Promise<void> | void
}

export interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<WorkspaceLike | undefined> | WorkspaceLike | undefined
  /**
   * Archive one session, optionally stopping its work.
   *
   * With `stopActivity` the durable archive is written first and the stop
   * providers are asked afterwards, so a wake induced by the stop is already
   * blocked by the archive set the `agent/pre-step` gate reads. This is the
   * host's own "stand this session down" primitive; the log is retained.
   */
  archiveSession?(
    sessionId: SessionId,
    options?: { readonly stopActivity?: boolean },
  ): Promise<void>
}

/**
 * `ctx.permissionPresets` — the named permission preset a session runs under.
 *
 * Both methods take the host's own `Session` instance, not an id and not a
 * `{ id }` lookalike. `set` folds the target's log through the `permissions`
 * projection (`stateOf` → `materializeCells` → `snapshotEvents`) and then
 * APPENDS `permission/preset`, `sandbox/mode` and `approval/policy` events to
 * it, so an object that merely carries an id throws
 * "session.snapshotEvents is not a function" before anything is written.
 *
 * Declaring the parameter as `{ id } | SessionId` is what let the write path
 * compile while failing on every real handoff, so the narrow type is the fix's
 * other half: passing anything but a Session is now a type error.
 */
export interface PermissionPresetsLike {
  current(session: SessionLike): string | undefined
  set(session: SessionLike, name: string): Promise<void> | void
}

/** `ctx.approval` — the policy behind a `custom` permission preset. */
export interface ApprovalLike {
  overrideOf(session: SessionLike): unknown
  setPolicy(agent: AgentLike, policy: unknown): void
}

/** `ctx.planMode` — per-agent, and per agent realm. */
export interface PlanModeLike {
  get(agent: AgentLike): { active?: boolean } | undefined
  set(agent: AgentLike, active: boolean): void
}

/** `ctx.agentPresets` — preset identity and realm-aware service lookup. */
export interface AgentPresetsLike {
  composedPreset(ctx: unknown): string | undefined
  serviceFor?(agent: { ctx?: unknown }, name: string): unknown
}

/** `ctx.agentDefaultModel` — the deployment default model, the last fallback. */
export interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string } | undefined
}

/** `ctx.compaction` — the official compaction entry point. */
export interface CompactionLike {
  compactNow(
    agent: unknown,
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<{ kind?: string } | null>
}

/**
 * `ctx.llm` — the only way this plugin generates text.
 *
 * There is no `generate`: the service streams. A one-shot call is `stream()`
 * with a fully specified `GenerateOptions`, and `provider` + `model` are
 * REQUIRED — the service does not pick a default route for you.
 */
export interface LlmStreamOptionsLike {
  provider: string
  model: string
  messages: readonly unknown[]
  maxTokens?: number
  system?: string
  temperature?: number
  signal?: AbortSignal
  sessionId?: string
  /** Closed union on this build: only the harness' own two purposes. */
  purpose?: 'compaction' | 'session-title'
}

/** One raw stream chunk. Only the text-bearing shapes matter here. */
export interface LlmStreamChunkLike {
  readonly type?: string
  readonly text?: string
}

export interface LlmLike {
  stream?(options: LlmStreamOptionsLike): AsyncIterable<LlmStreamChunkLike>
  /** Validate a route and materialize adapter defaults; optional. */
  resolveCallConfig?(config: { provider: string; model: string; maxTokens?: number }): Promise<{
    provider: string
    model: string
  }>
}

/**
 * `CommandResult` — what a command handler returns.
 *
 * The host renders `text` in the conversation without involving the model, so a
 * command can report a long report and it still never enters the model-visible
 * history. Returning a bare string is not an accepted shape.
 */
export type CommandResultLike =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** The invocation the host passes to a command handler. */
export interface CommandInvocationLike {
  readonly agent?: AgentLike
  /** Everything the user typed after the command name. */
  readonly rawInput?: string
  readonly signal?: AbortSignal
}

export interface CommandDefinitionLike {
  name: string
  description: string
  /** Optional composer hint for the command's own argument line. */
  input?: { readonly hint: string; readonly attachments?: boolean }
  handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
}

export interface CommandsLike {
  register(definition: CommandDefinitionLike): () => void
  find?(agent: AgentLike, name: string): CommandDefinitionLike | undefined
}

/**
 * `ctx.configEditor` — the host's own "write this row's config" path.
 *
 * This is the supported way to persist a plugin's configuration from its own
 * code: it applies the change through the normal Loader path, so validation and
 * re-application both happen exactly as they do when the user edits the file.
 * Writing the profile YAML by hand would bypass both.
 */
export interface ConfigEditorLike {
  entries?(): readonly unknown[]
  /** Apply a change to one entry's raw config. */
  edit?(entry: unknown, change: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void>
  /** The current composed entry list, for locating this plugin's own row. */
  configuration?(): readonly {
    readonly entry?: { readonly id?: string }
    readonly inherited?: Record<string, unknown>
    readonly override?: Record<string, unknown>
  }[]
}

/**
 * `ctx.sessions` — the in-memory session store.
 *
 * It stores **Session** objects, not agents: `get()` returns the log handle.
 * The live agent for a session is obtained from `ctx.agents` (`get(id)`), a
 * separate service. Confusing the two silently yields objects without
 * `whenIdle`/`followup`, which is why both are declared apart.
 */
export interface SessionsStoreLike {
  get(id: SessionId): SessionLike | undefined
  list?(): readonly SessionLike[]
}

/** `ctx.agents` — the live agent registry keyed by session id. */
export interface AgentsLike {
  get(id: SessionId): AgentLike | undefined
}

/** Everything the plugin resolves lazily from `ctx.get(name)`. */
export interface HostServices {
  sessions: SessionsStoreLike | undefined
  agents: AgentsLike | undefined
  sessionController: SessionControllerLike | undefined
  sessionProjections: SessionProjectionsLike | undefined
  tokenMeter: TokenMeterLike | undefined
  workspaceRegistry: WorkspaceRegistryLike | undefined
  permissionPresets: PermissionPresetsLike | undefined
  approval: ApprovalLike | undefined
  agentPresets: AgentPresetsLike | undefined
  agentDefaultModel: AgentDefaultModelLike | undefined
  compaction: CompactionLike | undefined
  llm: LlmLike | undefined
  commands: CommandsLike | undefined
  configEditor: ConfigEditorLike | undefined
}
