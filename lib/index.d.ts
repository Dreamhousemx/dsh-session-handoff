import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/settings.d.ts
interface Config {
  /** Master switch for threshold-driven handoff. Off means manual only. */
  autoHandoffEnabled: boolean;
  /** Which metric triggers automatic handoff. */
  autoHandoffTrigger: 'context' | 'cumulative' | 'either';
  /** Context occupancy (surface tokens ÷ window) that requests a handoff, in percent. */
  autoHandoffAtContextPercent: number;
  /** Cumulative spend that requests a handoff, in tokens. Only used by `cumulative`/`either`. */
  autoHandoffThreshold: number;
  /** Enable in-place compaction before the context is full. */
  autoCompactEnabled: boolean;
  /** Context occupancy that requests a compaction, in percent. Must sit below the handoff threshold. */
  autoCompactAtContextPercent: number;
  /** Minimum gap between two measurements of the same session, in milliseconds. */
  evaluateIntervalMs: number;
  /** Hysteresis band: occupancy must fall this far below a threshold before it re-arms. */
  contextRearmDeltaPercent: number;
  /** Cumulative tokens that must accrue after an action before it re-arms. */
  rearmDeltaTokens: number;
  /** Automatic actions allowed per session, handoff and compaction shared. */
  maxAutoActionsPerSession: number;
  /** Output budget for the model that writes the brief. */
  summaryMaxTokens: number;
  /** How long waiting for the step boundary is considered slow. Advisory only: it never interrupts. */
  stepWaitTimeoutMs: number;
  /** Hard deadline for one action. Expiry releases the latch and marks a failure; it never cancels work. */
  actionDeadlineMs: number;
  /** Scroll the browser to the new session once a handoff completes. */
  openNewSessionOnHandoff: boolean;
  /**
   * Archive (and stop) the source session once the brief has been delivered.
   *
   * On by default: a session whose task moved elsewhere otherwise keeps showing
   * in the sidebar as if it were still the active one. Turning it off leaves it
   * running and visible, which is what you want when comparing the two.
   */
  archiveSourceAfterHandoff: boolean;
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
declare const Config: Schema<Config>;
/**
 * The default value of every field, read from the schema itself.
 *
 * One source of truth: the Configuration page, the Loader's defaults, and this
 * object all derive from the `Config` declaration above.
 */
declare const CONFIG_DEFAULTS: Config;
/**
 * Fill a partial row config from the defaults.
 *
 * The Loader applies `default` for a well-formed row; this exists so a row that
 * omits a field (an older patch, or a hand-written profile) still hands the
 * plugin's own code a complete object.
 */
declare function withDefaults(config: Partial<Config> | undefined): Config;
//#endregion
//#region src/contracts.d.ts
/**
 * `ctx.llm` — the only way this plugin generates text.
 *
 * There is no `generate`: the service streams. A one-shot call is `stream()`
 * with a fully specified `GenerateOptions`, and `provider` + `model` are
 * REQUIRED — the service does not pick a default route for you.
 */
interface LlmStreamOptionsLike {
  provider: string;
  model: string;
  messages: readonly unknown[];
  maxTokens?: number;
  system?: string;
  temperature?: number;
  signal?: AbortSignal;
  sessionId?: string;
  /** Closed union on this build: only the harness' own two purposes. */
  purpose?: 'compaction' | 'session-title';
}
/** One raw stream chunk. Only the text-bearing shapes matter here. */
interface LlmStreamChunkLike {
  readonly type?: string;
  readonly text?: string;
}
interface LlmLike {
  stream?(options: LlmStreamOptionsLike): AsyncIterable<LlmStreamChunkLike>;
  /** Validate a route and materialize adapter defaults; optional. */
  resolveCallConfig?(config: {
    provider: string;
    model: string;
    maxTokens?: number;
  }): Promise<{
    provider: string;
    model: string;
  }>;
}
//#endregion
//#region src/session-summary.d.ts
/** Narrative the model produced, already split by section. */
interface BriefNarrative {
  readonly goal?: string;
  readonly constraints?: string;
  readonly done?: string;
  readonly progress?: string;
  readonly files?: string;
  readonly decisions?: string;
  readonly problems?: string;
  readonly remaining?: string;
  readonly next?: string;
}
//#endregion
//#region src/index.d.ts
/** Stable plugin name; must match the row inserted by `cordis.patch.yml`. */
declare const name = "dsh-session-handoff";
/** Optional host services; see `services.ts` for why these are declared. */
declare const inject: readonly ["sessions"];
/** Route prefix for the status/action channel used by the settings card. */
declare const ROUTE_PREFIX = "/dsh-session-handoff";
/** Entry id under which the settings card writes; equals the patch row id. */
declare const SETTINGS_ENTRY = "dsh-session-handoff";
declare function apply(ctx: Context, config: Config): void;
/**
 * A never-empty description of one thrown value.
 *
 * `dsh-commands` rejects a blank `CommandResult.text` with a `TypeError` raised
 * inside the registry, so returning `error.message` verbatim turns
 * `throw new Error()` into an internal command failure. The fallback names the
 * operation instead of the (absent) message.
 */
declare function errorText(error: unknown): string;
/**
 * Ask the model for the nine sections.
 *
 * `llm.stream` rather than a `generate` helper: the service exposes only the
 * streaming API, and it requires an explicit provider/model route. The prompt
 * carries the section structure, and no `purpose` is passed — that union is
 * closed on this build and only accepts the harness' own two values.
 */
declare function requestNarrative(llm: LlmLike, prompt: string, maxTokens: number, route: {
  provider: string;
  model: string;
}, signal?: AbortSignal): Promise<BriefNarrative>;
//#endregion
export { CONFIG_DEFAULTS, Config, ROUTE_PREFIX, SETTINGS_ENTRY, apply, errorText, inject, name, requestNarrative, withDefaults };