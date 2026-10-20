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
/** `ctx.llm` — the only way this plugin generates text. */
interface LlmLike {
  generate?(options: unknown): Promise<unknown> | AsyncIterable<unknown>;
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
 * Ask the model for the nine sections.
 *
 * The call passes no `purpose`: the host's option union is closed and adding a
 * value would be a type error against the installed declarations. The prompt
 * carries the structure instead.
 */
declare function requestNarrative(llm: LlmLike, prompt: string, maxTokens: number): Promise<BriefNarrative>;
//#endregion
export { CONFIG_DEFAULTS, Config, ROUTE_PREFIX, SETTINGS_ENTRY, apply, inject, name, requestNarrative, withDefaults };