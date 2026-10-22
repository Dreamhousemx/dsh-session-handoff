import Schema from "@deepseek-ai/schemastery";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/services.ts
function readServices(host) {
	const get = (name) => {
		try {
			return host.get(name);
		} catch {
			return;
		}
	};
	return {
		sessions: get("sessions"),
		agents: get("agents"),
		sessionController: get("sessionController"),
		sessionProjections: get("sessionProjections"),
		tokenMeter: get("tokenMeter"),
		workspaceRegistry: get("workspaceRegistry"),
		permissionPresets: get("permissionPresets"),
		approval: get("approval"),
		agentPresets: get("agentPresets"),
		agentDefaultModel: get("agentDefaultModel"),
		compaction: get("compaction"),
		llm: get("llm"),
		commands: get("commands"),
		configEditor: get("configEditor")
	};
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
const INJECT = ["sessions"];
//#endregion
//#region src/settings.ts
/**
* Plugin configuration — the single settings surface.
*
* `cordis.patch.yml` seeds these defaults and the Configuration card writes
* through the host's settings form. Every limit here exists to bound a real
* failure mode (a runaway handoff loop, a summary that costs more than the
* session did); none is symmetry for its own sake.
*/
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
const Config = Schema.object({
	autoHandoffEnabled: Schema.boolean().default(false),
	autoHandoffTrigger: Schema.union([
		"context",
		"cumulative",
		"either"
	]).default("context"),
	autoHandoffAtContextPercent: Schema.number().min(1).max(100).step(1).default(85),
	autoHandoffThreshold: Schema.number().min(0).step(1).default(2e6),
	autoCompactEnabled: Schema.boolean().default(false),
	autoCompactAtContextPercent: Schema.number().min(1).max(99).step(1).default(70),
	evaluateIntervalMs: Schema.number().min(1e3).step(1).default(5e3),
	contextRearmDeltaPercent: Schema.number().min(0).max(50).step(1).default(10),
	rearmDeltaTokens: Schema.number().min(0).step(1).default(2e5),
	maxAutoActionsPerSession: Schema.number().min(1).max(10).step(1).default(3),
	summaryMaxTokens: Schema.number().min(256).step(1).default(4096),
	stepWaitTimeoutMs: Schema.number().min(1e3).step(1).default(9e5),
	actionDeadlineMs: Schema.number().min(1e3).step(1).default(18e5),
	openNewSessionOnHandoff: Schema.boolean().default(true),
	archiveSourceAfterHandoff: Schema.boolean().default(true)
});
/**
* The default value of every field, read from the schema itself.
*
* One source of truth: the Configuration page, the Loader's defaults, and this
* object all derive from the `Config` declaration above.
*/
const CONFIG_DEFAULTS = Object.fromEntries(Object.entries(Config.dict ?? {}).map(([name, field]) => [name, field.meta?.default]));
/**
* Fill a partial row config from the defaults.
*
* The Loader applies `default` for a well-formed row; this exists so a row that
* omits a field (an older patch, or a hand-written profile) still hands the
* plugin's own code a complete object.
*/
function withDefaults(config) {
	return {
		...CONFIG_DEFAULTS,
		...config ?? {}
	};
}
/**
* Cross-field validation.
*
* `blocking` stops a save; `warnings` are advisory and surface both in the
* Settings card and in `/handoff status`, so a configuration is never silently
* accepted while being obviously wrong.
*/
function validateSettings(config) {
	const warnings = [];
	if (config.autoHandoffEnabled && config.autoCompactEnabled && config.autoCompactAtContextPercent >= config.autoHandoffAtContextPercent) return {
		blocking: "压缩阈值必须低于交接阈值：否则上下文刚压缩完又会立刻触发交接，形成来回抖动。请调低压缩阈值或调高交接阈值。",
		warnings
	};
	if (config.autoCompactEnabled && !config.autoHandoffEnabled && config.autoHandoffAtContextPercent <= config.autoCompactAtContextPercent) warnings.push({
		field: "autoCompactAtContextPercent",
		message: "压缩阈值不低于交接阈值；开启自动交接后会立刻产生冲突。"
	});
	if (config.autoHandoffAtContextPercent < 20 && config.autoHandoffEnabled) warnings.push({
		field: "autoHandoffAtContextPercent",
		message: "阈值低于 20%：会话可能发几条消息就被交接，新会话的时间大多花在读简报上。"
	});
	if (config.evaluateIntervalMs > 6e4) warnings.push({
		field: "evaluateIntervalMs",
		message: "评估间隔超过 1 分钟，上下文可能在两次测量之间就撞满窗口。"
	});
	return {
		blocking: void 0,
		warnings
	};
}
/** True when the configured mode keys automatic handoff on context occupancy. */
function triggerUsesContext(mode) {
	return mode === "context" || mode === "either";
}
/** True when the configured mode keys automatic handoff on cumulative spend. */
function triggerUsesCumulative(mode) {
	return mode === "cumulative" || mode === "either";
}
//#endregion
//#region src/graceful-stop.ts
/**
* True when this batch of pre-step messages contains human input.
*
* `unknown` sources are treated as human: a message the plugin cannot classify
* might be something the user typed, and swallowing it is worse than letting a
* step run one more turn.
*/
function batchHasHumanInput(messages) {
	if (messages === void 0 || messages.length === 0) return false;
	for (const message of messages) {
		const kind = message?.source?.kind;
		if (kind === "user") return true;
		if (kind === void 0) return true;
	}
	return false;
}
/**
* Decide the pre-step outcome while a latch is held.
*
* Returns the decision to use, or `undefined` when the listener must call
* `next()` and leave the decision alone (another plugin may still rewrite it).
*/
function decidePreStep(latched, messages) {
	if (!latched) return void 0;
	if (batchHasHumanInput(messages)) return void 0;
	return { kind: "reject" };
}
/**
* Flatten the human text of one pre-step batch.
*
* The latch lets a human message through so the old session can act on it, but
* once the task has moved the message belongs to the NEW session. Carrying the
* text is what makes that possible; an empty result means the batch held only
* non-human or contentless messages, which are not worth rerouting.
*/
function humanTexts(messages) {
	if (messages === void 0 || messages.length === 0) return [];
	const texts = [];
	for (const message of messages) {
		const kind = message?.source?.kind;
		if (kind !== void 0 && kind !== "user") continue;
		const text = blocksToText$1(message?.content);
		if (text.length > 0) texts.push(text);
	}
	return texts;
}
/** Flatten a message's content blocks into text, ignoring non-text blocks. */
function blocksToText$1(content) {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.map((block) => {
		if (block === null || typeof block !== "object") return "";
		const record = block;
		return typeof record["text"] === "string" ? record["text"] : "";
	}).filter((part) => part.trim().length > 0).join("\n").trim();
}
/** Human input observed while an action was in flight, held for rerouting. */
var HumanInputBuffer = class {
	bySession = /* @__PURE__ */ new Map();
	/** Record texts for a session; returns how many were added. */
	capture(sessionId, texts) {
		if (texts.length === 0) return 0;
		const existing = this.bySession.get(sessionId) ?? [];
		existing.push(...texts);
		this.bySession.set(sessionId, existing);
		return texts.length;
	}
	/** Take and clear everything held for a session. */
	drain(sessionId) {
		const texts = this.bySession.get(sessionId) ?? [];
		this.bySession.delete(sessionId);
		return texts;
	}
	/** Drop a session's buffer (disposal, unload). */
	forget(sessionId) {
		this.bySession.delete(sessionId);
	}
	/** Sessions currently holding text; used by tests and diagnostics. */
	ids() {
		return [...this.bySession.keys()];
	}
};
/** Bookkeeping for every latch owned by this plugin instance. */
var LatchRegistry = class {
	latches = /* @__PURE__ */ new Map();
	nextToken = 1;
	/** Set (or replace) the latch for one session. */
	arm(sessionId, now = Date.now()) {
		this.release(sessionId, "cancel");
		let settle;
		const released = new Promise((resolve) => {
			settle = resolve;
		});
		const latch = {
			sessionId,
			token: this.nextToken++,
			requestedAt: now,
			released,
			settle,
			waited: false
		};
		this.latches.set(sessionId, latch);
		return latch;
	}
	/** The current latch for a session, when one is held. */
	get(sessionId) {
		return this.latches.get(sessionId);
	}
	/** True when the latch has been armed and not yet cleared. */
	isLatched(sessionId) {
		return this.latches.has(sessionId);
	}
	/**
	* Clear a session's latch.
	*
	* Passing a token makes the release conditional: a late callback from an
	* older attempt cannot clear a newer attempt's latch.
	*/
	release(sessionId, _reason, token) {
		const latch = this.latches.get(sessionId);
		if (latch === void 0) return false;
		if (token !== void 0 && latch.token !== token) return false;
		this.latches.delete(sessionId);
		latch.settle();
		return true;
	}
	/** Drop everything (plugin unload). */
	releaseAll(reason) {
		for (const [id, latch] of [...this.latches]) {
			this.latches.delete(id);
			latch.settle();
		}
	}
	/** Sessions currently latched; used by status and by unload diagnostics. */
	ids() {
		return [...this.latches.keys()];
	}
};
/**
* Wait for the agent to finish what it is doing.
*
* Two independent conditions end the wait, whichever comes first: the agent
* reporting idle, or the hard deadline. The idle path is preferred because it
* reflects the harness's own view; a deadline that fires first is reported as a
* failure so the caller can release the latch and leave the session running.
*/
async function waitForBoundary(agent, timeoutMs, signal, now = Date.now) {
	const startedAt = now();
	if (agent === void 0) return {
		reached: false,
		reason: "error",
		waitedMs: 0,
		error: "找不到活动 Agent"
	};
	const whenIdle = agent.whenIdle;
	if (typeof whenIdle !== "function") return {
		reached: false,
		reason: "error",
		waitedMs: 0,
		error: "该宿主未提供 agent.whenIdle()，无法确认 Step 边界"
	};
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
		if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref?.();
	});
	const idle = Promise.resolve(whenIdle.call(agent)).then(() => "boundary", (error) => {
		throw error;
	});
	const abort = new Promise((resolve) => {
		if (signal === void 0) return;
		if (signal.aborted) return resolve("error");
		signal.addEventListener("abort", () => resolve("error"), { once: true });
	});
	try {
		const winner = await Promise.race([
			idle,
			timeout,
			abort
		]);
		const waitedMs = now() - startedAt;
		if (winner === "boundary") return {
			reached: true,
			reason: "boundary",
			waitedMs
		};
		if (winner === "error") return {
			reached: false,
			reason: "error",
			waitedMs,
			error: "等待被取消"
		};
		return {
			reached: false,
			reason: "timeout",
			waitedMs
		};
	} catch (error) {
		return {
			reached: false,
			reason: "error",
			waitedMs: now() - startedAt,
			error: error instanceof Error ? error.message : String(error)
		};
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
//#endregion
//#region src/session-migration.ts
/**
* Producer-owned source kind for messages this plugin injects.
*
* Session format v4 requires the shape `plugin:<package>`; the bare `'plugin'`
* value is rejected outright, and the released V3 wrapper carrying it is
* rewritten to exactly this shape on load. Using the bare value delivered the
* message and then failed the turn with
* "format v4 message requires a producer-owned source kind".
*/
const PLUGIN_SOURCE_KIND = "plugin:dsh-session-handoff";
/**
* Read everything the migration will try to inherit, while the source agent is
* still alive. Reading after the agent is disposed loses the per-agent
* services (plan mode in particular).
*/
function snapshotSource(source) {
	const header = source.session?.header;
	const requestContext = safely$2(() => source.session?.requestContext?.());
	const headerConfig = safely$2(() => source.session?.requestHeader?.()?.config);
	const provider = requestContext?.provider ?? headerConfig?.provider;
	const model = requestContext?.model ?? headerConfig?.model;
	const modelSelection = provider !== void 0 && model !== void 0 ? {
		provider,
		model
	} : source.defaultModel;
	const permissionRead = readPermissionPreset(source.session, source.permissionPresets);
	const permissionPreset = permissionRead.value;
	const approvalPolicy = safely$2(() => source.approval?.overrideOf(source.session));
	const planMode = safely$2(() => planModeFor(source.agent, source.agentPresets));
	return {
		sessionId: source.sessionId,
		cwd: header?.cwd,
		agentPreset: header?.agentPreset,
		model: modelSelection,
		permissionPreset,
		...permissionRead.error === void 0 ? {} : { permissionPresetError: permissionRead.error },
		approvalPolicy,
		planMode
	};
}
/**
* Read the effective permission preset, keeping the failure reason.
*
* `permissionPresets.current` walks the session log (`snapshotEvents`), so it
* needs the host's own `Session` instance. When the plugin is handed a different
* object it throws a message about `snapshotEvents`, and collapsing that into
* "no preset" hides a real defect behind an innocent-looking fallback — which is
* exactly how this bug survived several handoffs reported as successful.
*/
function readPermissionPreset(session, presets) {
	if (presets === void 0) return {
		value: void 0,
		error: "部署未提供 permissionPresets 服务"
	};
	if (session === void 0) return {
		value: void 0,
		error: "找不到原会话对象"
	};
	if (typeof session.snapshotEvents !== "function") return {
		value: void 0,
		error: "传入的对象不是宿主 Session 实例（缺少 snapshotEvents）"
	};
	try {
		return { value: presets.current(session) };
	} catch (error) {
		return {
			value: void 0,
			error: error instanceof Error ? error.message : String(error)
		};
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
function planModeFor(agent, agentPresets) {
	if (agent === void 0) return void 0;
	const scoped = safely$2(() => agentPresets?.serviceFor?.({ ctx: agent.ctx }, "planMode"));
	const scopedState = safely$2(() => scoped?.get?.(agent));
	if (scopedState !== void 0) return { active: scopedState.active === true };
	const hostPlane = agent.ctx;
	const hostService = safely$2(() => hostPlane?.get?.("planMode"));
	const hostState = safely$2(() => hostService?.get?.(agent));
	if (hostState !== void 0) return { active: hostState.active === true };
}
function safely$2(read) {
	try {
		return read();
	} catch {
		return;
	}
}
/**
* Perform the migration.
*
* Every failure after session creation is recorded, not thrown: the caller needs
* the new session id regardless of how much of the configuration made it.
*/
async function migrateSession(request, deps) {
	const inherited = [];
	const { source } = request;
	const controller = deps.sessionController;
	if (controller === void 0) return {
		ok: false,
		inherited,
		delivered: false,
		error: "当前部署没有 sessionController，无法创建新会话"
	};
	let newSessionId;
	try {
		newSessionId = (await controller.create({
			...source.cwd === void 0 ? {} : { cwd: source.cwd },
			...source.agentPreset === void 0 ? {} : { agentPreset: source.agentPreset }
		})).sessionId;
		inherited.push({
			item: "cwd",
			status: source.cwd === void 0 ? "skipped" : "inherited",
			...source.cwd === void 0 ? { detail: "原会话没有工作目录" } : {}
		});
		inherited.push({
			item: "preset",
			status: source.agentPreset === void 0 ? "fallback" : "inherited",
			...source.agentPreset === void 0 ? { detail: "原会话未选 preset，沿用部署默认" } : {}
		});
	} catch (error) {
		return {
			ok: false,
			inherited,
			delivered: false,
			error: `创建新会话失败：${messageOf$1(error)}`
		};
	}
	inherited.push(await attachWorkspace(newSessionId, source.cwd, deps.workspaceRegistry));
	inherited.push(await inheritModel(newSessionId, source.model, controller));
	inherited.push(await inheritPermission(newSessionId, source, deps));
	inherited.push(await inheritPlanMode(newSessionId, source.planMode, deps));
	const delivery = await deliverBrief(newSessionId, request.brief, deps);
	inherited.push(delivery.outcome);
	const ok = delivery.delivered;
	return {
		ok,
		newSessionId,
		inherited,
		delivered: delivery.delivered,
		...ok ? {} : { error: delivery.error ?? "简报投递失败；新会话已创建但尚未开始工作" }
	};
}
async function attachWorkspace(newSessionId, cwd, registry) {
	if (cwd === void 0) return {
		item: "workspace",
		status: "skipped",
		detail: "没有工作目录"
	};
	if (registry === void 0) return {
		item: "workspace",
		status: "skipped",
		detail: "当前部署没有 workspaceRegistry"
	};
	try {
		const workspace = await registry.resolveByPath(cwd);
		if (workspace === void 0) return {
			item: "workspace",
			status: "fallback",
			detail: "该目录不是已注册的工作区；新会话会出现在未分组区域（不自动创建，避免改动侧栏顺序）"
		};
		if (typeof workspace.attachSession !== "function") return {
			item: "workspace",
			status: "fallback",
			detail: "工作区不支持附加会话"
		};
		await workspace.attachSession(newSessionId);
		return {
			item: "workspace",
			status: "inherited"
		};
	} catch (error) {
		return {
			item: "workspace",
			status: "fallback",
			detail: `附加工作区失败：${messageOf$1(error)}`
		};
	}
}
async function inheritModel(newSessionId, model, controller) {
	if (model === void 0) return {
		item: "model",
		status: "skipped",
		detail: "原会话与部署都没有上报模型"
	};
	try {
		const selected = await controller.selectModel({
			sessionId: newSessionId,
			provider: model.provider,
			model: model.model
		});
		return selected.selected.model === model.model ? {
			item: "model",
			status: "inherited",
			detail: `${model.provider}/${model.model}`
		} : {
			item: "model",
			status: "fallback",
			detail: `请求 ${model.model}，实际选中 ${selected.selected.model}`
		};
	} catch (error) {
		return {
			item: "model",
			status: "fallback",
			detail: `选择模型失败：${messageOf$1(error)}`
		};
	}
}
/**
* Resolve the new session's real `Session` object through its live agent.
*
* The migration is handed an id, but every permission-preset write needs the
* log handle itself. The agent's own `session` IS that instance; there is no
* second registry to consult, because `ctx.sessions.get(id)` returns the very
* same object (`get(id) { return this.store.get(id)?.session }`).
*
* Returning `undefined` is a reportable outcome, not a silent one: the caller
* distinguishes "new session not activated yet" from "the write failed".
*/
function targetSessionOf(newSessionId, deps) {
	return deps.resolveAgent(newSessionId)?.session;
}
async function inheritPermission(newSessionId, source, deps) {
	const presets = deps.permissionPresets;
	if (presets === void 0) return {
		item: "permission",
		status: "skipped",
		detail: "当前部署没有 permissionPresets"
	};
	if (source.permissionPreset === void 0 && source.permissionPresetError !== void 0) return {
		item: "permission",
		status: "skipped",
		detail: `无法读取原会话权限预设：${source.permissionPresetError}`
	};
	const target = targetSessionOf(newSessionId, deps);
	if (target === void 0) return {
		item: "permission",
		status: "skipped",
		detail: "无法解析新会话的 Session 对象（新会话尚未激活），权限未写入"
	};
	try {
		if (source.permissionPreset !== void 0) {
			await presets.set(target, source.permissionPreset);
			return {
				item: "permission",
				status: "inherited",
				detail: source.permissionPreset
			};
		}
		if (source.approvalPolicy !== void 0 && deps.approval !== void 0) {
			const newAgent = deps.resolveAgent(newSessionId);
			if (newAgent === void 0) return {
				item: "permission",
				status: "fallback",
				detail: "无法解析新会话 Agent，审批策略未继承"
			};
			deps.approval.setPolicy(newAgent, source.approvalPolicy);
			return {
				item: "permission",
				status: "fallback",
				detail: "原会话为自定义权限：已继承审批策略，sandbox 档位未继承（没有对应的预设名可重放）"
			};
		}
		return {
			item: "permission",
			status: "skipped",
			detail: "原会话没有可继承的权限预设"
		};
	} catch (error) {
		return {
			item: "permission",
			status: "fallback",
			detail: messageOf$1(error)
		};
	}
}
async function inheritPlanMode(newSessionId, sourceState, deps) {
	if (sourceState === void 0) return {
		item: "planMode",
		status: "skipped",
		detail: "当前部署没有 planMode 服务"
	};
	const newAgent = deps.resolveAgent(newSessionId);
	if (newAgent === void 0) return {
		item: "planMode",
		status: "fallback",
		detail: "无法解析新会话 Agent"
	};
	const scoped = safely$2(() => deps.agentPresets?.serviceFor?.({ ctx: newAgent.ctx }, "planMode"));
	if (scoped?.set !== void 0) try {
		scoped.set(newAgent, sourceState.active);
		return {
			item: "planMode",
			status: "inherited",
			detail: sourceState.active ? "开启" : "关闭"
		};
	} catch (error) {
		return {
			item: "planMode",
			status: "fallback",
			detail: messageOf$1(error)
		};
	}
	const hostPlane = newAgent.ctx;
	const hostService = safely$2(() => hostPlane?.get?.("planMode"));
	if (hostService?.set !== void 0) try {
		hostService.set(newAgent, sourceState.active);
		return {
			item: "planMode",
			status: "inherited",
			detail: sourceState.active ? "开启" : "关闭"
		};
	} catch (error) {
		return {
			item: "planMode",
			status: "fallback",
			detail: messageOf$1(error)
		};
	}
	return {
		item: "planMode",
		status: "fallback",
		detail: "新会话所在 realm 里没有 planMode 实例"
	};
}
/**
* Deliver the brief as the new session's first message.
*
* Uses `agent.followup` with a `plugin` source rather than the session API's
* prompt, because that path hard-codes the `user-rpc` source and would make the
* brief look like something the human typed.
*/
async function deliverBrief(newSessionId, brief, deps) {
	const agent = deps.resolveAgent(newSessionId);
	if (agent === void 0) return {
		delivered: false,
		outcome: {
			item: "brief",
			status: "skipped",
			detail: "新会话尚未激活，无法投递"
		},
		error: "新会话已创建但没有可用的 Agent，简报未投递"
	};
	if (typeof agent.followup !== "function") return {
		delivered: false,
		outcome: {
			item: "brief",
			status: "skipped",
			detail: "该宿主未提供 agent.followup"
		},
		error: "该宿主未提供 agent.followup，简报未投递"
	};
	try {
		await agent.followup({
			role: "user",
			source: { kind: PLUGIN_SOURCE_KIND },
			content: [{
				type: "text",
				text: brief
			}]
		}, { source: { kind: PLUGIN_SOURCE_KIND } });
		return {
			delivered: true,
			outcome: {
				item: "brief",
				status: "inherited",
				detail: "已投递"
			}
		};
	} catch (error) {
		return {
			delivered: false,
			outcome: {
				item: "brief",
				status: "skipped",
				detail: messageOf$1(error)
			},
			error: `简报投递失败：${messageOf$1(error)}`
		};
	}
}
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/coordinator.ts
/**
* Handoff phases in which new human input aborts the handoff.
*
* The boundary is the new session's creation. Before it exists, cancelling
* costs nothing and keeps the user's message in the session they typed into.
* From `transferring` onwards a session already exists, so the text is
* forwarded to it instead of cancelling.
*/
const ABORTABLE_BEFORE_NEW_SESSION = /* @__PURE__ */ new Set([
	"preparing",
	"waiting-for-step-boundary",
	"summarizing"
]);
var Coordinator = class {
	deps;
	runs = /* @__PURE__ */ new Map();
	lastResults = /* @__PURE__ */ new Map();
	lastFailures = /* @__PURE__ */ new Map();
	newSessions = /* @__PURE__ */ new Map();
	failureCounts = /* @__PURE__ */ new Map();
	slowWarned = /* @__PURE__ */ new Set();
	constructor(deps) {
		this.deps = deps;
	}
	/** True while this session has an action in flight. */
	isBusy(sessionId) {
		return this.runs.has(sessionId);
	}
	/** The phase a session is in, for the trigger engine's pending check. */
	phaseOf(sessionId) {
		return this.runs.get(sessionId)?.phase ?? "idle";
	}
	/** Ask a running action to stop at its next safe point. */
	requestCancel(sessionId) {
		const run = this.runs.get(sessionId);
		if (run === void 0) return false;
		run.cancelRequested = true;
		this.deps.log?.(`handoff: 已请求取消 ${sessionId}（在下一个安全检查点生效）`);
		return true;
	}
	/**
	* Abort a handoff because the human is talking to the old session again.
	*
	* Before the new session exists, a handoff is pure loss for the user: the
	* session they are typing into is about to be retired while its replacement
	* has none of what they just said. Those phases therefore abort, and the
	* message stays where it was typed. Once the new session EXISTS
	* (`transferring` onwards) the text is forwarded instead — see
	* `reroutePending` — because aborting then would strand a session that has
	* already been created.
	*
	* Returns whether this call cancelled anything, so the caller can log a
	* truthful reason rather than assuming one.
	*/
	abortForHumanInput(sessionId) {
		const run = this.runs.get(sessionId);
		if (run === void 0 || run.cancelRequested) return false;
		if (run.kind !== "handoff") return false;
		if (!ABORTABLE_BEFORE_NEW_SESSION.has(run.phase)) return false;
		run.cancelRequested = true;
		this.deps.log?.(`handoff: 收到人类输入，取消 ${sessionId} 的交接（阶段 ${run.phase}，原会话继续）`);
		return true;
	}
	/** The `newSessionId` a browser may jump to, once one exists. */
	newSessionOf(sessionId) {
		return this.newSessions.get(sessionId);
	}
	/** Drop every trace of a session that no longer exists. */
	forget(sessionId) {
		this.deps.latches.release(sessionId, "cancel");
		this.runs.delete(sessionId);
		this.lastResults.delete(sessionId);
		this.lastFailures.delete(sessionId);
		this.failureCounts.delete(sessionId);
		this.slowWarned.delete(sessionId);
	}
	/** Everything the status surface shows for one session. */
	statusOf(sessionId) {
		const run = this.runs.get(sessionId);
		const latch = this.deps.latches.get(sessionId);
		return {
			sessionId,
			phase: run?.phase ?? this.lastResults.get(sessionId)?.phase ?? "idle",
			busy: run !== void 0,
			latched: latch !== void 0,
			cancelRequested: run?.cancelRequested ?? false,
			kind: run?.kind,
			waitingForStep: run?.phase === "waiting-for-step-boundary",
			slowWarning: this.slowWarned.has(sessionId),
			newSessionId: this.newSessions.get(sessionId),
			lastResult: this.lastResults.get(sessionId),
			lastFailure: this.lastFailures.get(sessionId),
			failures: this.failureCounts.get(sessionId) ?? 0
		};
	}
	/**
	* Run one action to completion.
	*
	* Returns a verdict for every path; it does not throw for expected failures
	* (missing services, empty session, timeout). It does rethrow only if a
	* programming error escapes a dependency, after releasing the latch.
	*/
	async run(request) {
		const { sessionId } = request;
		if (this.runs.has(sessionId)) return this.finish(sessionId, {
			ok: false,
			phase: "idle",
			text: "当前会话已有正在进行的动作，请等待它结束或先取消。",
			error: "action-in-flight"
		});
		if (request.kind === "handoff" && !await this.hasActivity(sessionId)) return this.finish(sessionId, {
			ok: false,
			phase: "idle",
			text: "当前没有可迁移的活动会话（空白会话不会被交接）。",
			error: "session-blank"
		});
		const run = {
			kind: request.kind,
			phase: "preparing",
			cancelRequested: false,
			boundary: void 0
		};
		this.runs.set(sessionId, run);
		const deadline = withDeadline(this.actionDeadlineMs);
		try {
			if (request.kind === "handoff") return await this.runHandoff(request, run, deadline.signal);
			return await this.runCompact(request, run, deadline.signal);
		} catch (error) {
			return this.fail(sessionId, run, error instanceof Error ? error.message : String(error));
		} finally {
			deadline.dispose();
			this.deps.latches.release(sessionId, "boundary");
			this.runs.delete(sessionId);
			this.slowWarned.delete(sessionId);
		}
	}
	async runHandoff(request, run, deadlineSignal) {
		const { sessionId, agent } = request;
		run.phase = "preparing";
		this.deps.latches.arm(sessionId);
		this.deps.log?.(`handoff: ${request.detail ?? "手动触发"}，已设停止闩锁`);
		run.phase = "waiting-for-step-boundary";
		const boundary = await waitForBoundary(agent, this.stepWaitMs, deadlineSignal, this.deps.now);
		run.boundary = boundary;
		if (run.cancelRequested) return this.cancelled(sessionId, run, "已按请求取消交接。");
		if (boundary.reason === "timeout") return this.fail(sessionId, run, `等待 Step 边界超时（${Math.round(boundary.waitedMs / 1e3)} 秒）。已释放闩锁，原会话可继续工作。`);
		if (boundary.reason === "error") return this.fail(sessionId, run, `等待 Step 边界失败：${boundary.error ?? "未知原因"}`);
		run.phase = "summarizing";
		let brief;
		let redactions;
		try {
			const summary = await this.deps.summarize(agent);
			brief = summary.brief;
			redactions = summary.redactions;
		} catch (error) {
			return this.fail(sessionId, run, `生成交接简报失败，已放弃本次交接并保留原会话：${messageOf(error)}`);
		}
		if (run.cancelRequested) return this.cancelled(sessionId, run, "已按请求取消交接（简报未生成）。");
		run.phase = "creating-session";
		const migrated = await this.deps.migrate(brief);
		if (migrated.newSessionId !== void 0) this.newSessions.set(sessionId, migrated.newSessionId);
		if (run.cancelRequested) return this.cancelled(sessionId, run, migrated.newSessionId === void 0 ? "已按请求取消交接。" : `已取消，但新会话已创建：${migrated.newSessionId}`, migrated.newSessionId);
		if (!migrated.ok) return this.finish(sessionId, {
			ok: false,
			phase: "failed",
			text: [
				migrated.text,
				migrated.newSessionId === void 0 ? "" : `新会话 id：${migrated.newSessionId}（可手动继续）`,
				migrated.inherited === void 0 ? "" : describeInherited(migrated.inherited)
			].filter((line) => line.length > 0).join("\n"),
			...migrated.newSessionId === void 0 ? {} : { newSessionId: migrated.newSessionId },
			...migrated.inherited === void 0 ? {} : { inherited: migrated.inherited },
			...migrated.error === void 0 ? {} : { error: migrated.error }
		});
		run.phase = "transferring";
		const rerouted = await this.reroutePending(sessionId, migrated.newSessionId);
		const retired = await this.retire(sessionId, migrated.newSessionId);
		return this.finish(sessionId, {
			...migrated,
			phase: "completed",
			text: [
				`交接完成：新会话 ${migrated.newSessionId ?? "(未知)"} 已接手。`,
				rerouted,
				retired,
				redactions.length === 0 ? "" : `简报中有 ${redactions.length} 类敏感信息已替换为占位符。`,
				migrated.inherited === void 0 ? "" : describeInherited(migrated.inherited)
			].filter((line) => line.length > 0).join("\n")
		});
	}
	/**
	* Hand any buffered human input to the session that now owns the task.
	*
	* Returns a report line, or `''` when there was nothing to move. A failure is
	* reported rather than thrown: the brief is already delivered and the task is
	* safe, so a failed forward must not be presented as a failed handoff.
	*/
	async reroutePending(sessionId, newSessionId) {
		const reroute = this.deps.reroute;
		if (reroute === void 0 || newSessionId === void 0) return "";
		const drain = this.deps.drainHumanInput;
		if (drain === void 0) return "";
		const texts = drain(sessionId);
		if (texts.length === 0) return "";
		let moved = 0;
		for (const text of texts) try {
			if (await reroute(newSessionId, text)) moved += 1;
		} catch {}
		if (moved === 0) return `交接期间收到的 ${texts.length} 条消息未能转投新会话，请手动转发。`;
		return moved === texts.length ? `交接期间收到的 ${moved} 条消息已转投新会话。` : `交接期间收到的 ${texts.length} 条消息中，${moved} 条已转投新会话，其余请手动转发。`;
	}
	/**
	* Stand the old session down after its work moved.
	*
	* This is *not* a cancel: the latch is already held, the step boundary was
	* already observed, and nothing is in flight. Retiring means the session stops
	* accepting new turns and is reported as handed over; the log stays intact and
	* readable, so the user can still scroll back.
	*
	* A failure here is reported but does not fail the handoff — the task is
	* already safe in the new session, and claiming otherwise would be wrong.
	*/
	async retire(sessionId, newSessionId) {
		const retire = this.deps.retire;
		if (retire === void 0) return "";
		try {
			await retire(sessionId, newSessionId);
			return "原会话处理完毕（日志保留，可回看）。";
		} catch (error) {
			return `原会话归档失败（不影响新会话）：${messageOf(error)}`;
		}
	}
	async runCompact(request, run, deadlineSignal) {
		const { sessionId, agent } = request;
		if (agent === void 0) return this.fail(sessionId, run, "找不到活动 Agent，无法压缩。");
		run.phase = "preparing";
		this.deps.latches.get(sessionId);
		this.deps.latches.arm(sessionId);
		run.phase = "waiting-for-step-boundary";
		const boundary = await waitForBoundary(agent, this.stepWaitMs, deadlineSignal, this.deps.now);
		run.boundary = boundary;
		if (run.cancelRequested) return this.cancelled(sessionId, run, "已按请求取消压缩。");
		if (!boundary.reached) return this.fail(sessionId, run, boundary.reason === "timeout" ? "等待 Step 边界超时，已放弃压缩并释放闩锁。" : `等待 Step 边界失败：${boundary.error ?? "未知原因"}`);
		run.phase = "waiting-for-compact";
		const outcome = await this.deps.compact(agent);
		if (run.cancelRequested) return this.cancelled(sessionId, run, "已按请求取消压缩。");
		if (outcome.kind === "failed") return this.finish(sessionId, {
			ok: false,
			phase: "failed",
			text: `压缩失败（${outcome.code}）：${outcome.message}。已释放闩锁，原会话可继续。`,
			error: outcome.code
		});
		if (outcome.kind === "nothing-to-do") return this.finish(sessionId, {
			ok: true,
			phase: "completed",
			text: "没有可安全压缩的内容，本次压缩未做改动。"
		});
		if (outcome.continuesTask && typeof agent.followup === "function") try {
			await agent.followup({
				role: "user",
				source: { kind: PLUGIN_SOURCE_KIND },
				content: [{
					type: "text",
					text: "继续完成刚才的任务。"
				}]
			}, { source: { kind: PLUGIN_SOURCE_KIND } });
		} catch {}
		return this.finish(sessionId, {
			ok: true,
			phase: "completed",
			text: outcome.continuesTask ? "压缩完成，已让会话继续原任务。" : "压缩完成（会话原本空闲，未额外发送消息）。"
		});
	}
	stepWaitMs = 9e5;
	actionDeadlineMs = 18e5;
	/** Apply the configured bounds. Called once at startup and on every settings change. */
	configure(bounds) {
		this.stepWaitMs = bounds.stepWaitMs;
		this.actionDeadlineMs = bounds.actionDeadlineMs;
	}
	/**
	* Whether a session has any human conversation to hand over.
	*
	* A brand-new session with no prompt has nothing to summarize, and creating a
	* second empty session from it would leave two sessions that both say
	* "nothing here". The host adapter answers this from the durable log; when no
	* check is installed the answer is permissive, because refusing a real
	* handoff is worse than allowing an empty one the user explicitly asked for.
	*/
	async hasActivity(sessionId) {
		if (this.activityCheck === void 0) return true;
		try {
			return await this.activityCheck(sessionId);
		} catch {
			return true;
		}
	}
	/** Host-supplied blank-session check. */
	activityCheck;
	cancelled(sessionId, run, text, newSessionId) {
		return this.finish(sessionId, {
			ok: false,
			phase: "cancelled",
			text,
			...newSessionId === void 0 ? {} : { newSessionId }
		});
	}
	fail(sessionId, run, text) {
		return this.finish(sessionId, {
			ok: false,
			phase: "failed",
			text,
			error: text
		});
	}
	finish(sessionId, result) {
		this.lastResults.set(sessionId, result);
		if (!result.ok && result.phase === "failed") {
			this.lastFailures.set(sessionId, {
				at: (this.deps.now ?? Date.now)(),
				phase: result.phase,
				message: result.text
			});
			this.failureCounts.set(sessionId, (this.failureCounts.get(sessionId) ?? 0) + 1);
		}
		this.deps.log?.(`handoff: ${sessionId} → ${result.phase}`);
		return result;
	}
};
/**
* A deadline that aborts the in-flight await without touching the session.
*
* Expiry only settles the wait: the caller's `finally` releases the latch and
* the session continues with whatever it was doing. Nothing is cancelled.
*/
function withDeadline(ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref?.();
	return {
		signal: controller.signal,
		dispose: () => clearTimeout(timer)
	};
}
function describeInherited(items) {
	const label = {
		inherited: "已继承",
		fallback: "回退",
		skipped: "未继承"
	};
	return items.map((item) => `- ${item.item}：${label[item.status] ?? item.status}${item.detail === void 0 ? "" : `（${item.detail}）`}`).join("\n");
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Run one compaction, with a bounded retry only for `busy`.
*
* `null` from `compactNow` is a result, not a failure: the harness found no
* safe region worth compacting. Reporting it as an error would make a healthy
* no-op look broken in the UI.
*/
async function compact(agent, deps) {
	const { compaction } = deps;
	if (compaction === void 0) return {
		kind: "failed",
		code: "unavailable",
		message: "当前会话没有可用的 compaction 服务",
		retryable: false
	};
	if (agent === void 0) return {
		kind: "failed",
		code: "no-agent",
		message: "找不到活动 Agent",
		retryable: false
	};
	const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	let lastCode = "busy";
	let lastMessage = "压缩服务繁忙";
	for (let attempt = 0; attempt <= 3; attempt += 1) try {
		if (await compaction.compactNow(agent, deps.signal) === null) return { kind: "nothing-to-do" };
		return {
			kind: "compacted",
			continuesTask: deps.interruptedRunningTurn
		};
	} catch (error) {
		const code = errorCodeOf(error);
		const message = error instanceof Error ? error.message : String(error);
		lastCode = code;
		lastMessage = message;
		if (code !== "busy") return {
			kind: "failed",
			code,
			message,
			retryable: false
		};
		if (attempt === 3) break;
		await sleep(250 * (attempt + 1));
		try {
			await deps.waitIdle(agent);
		} catch {
			return {
				kind: "failed",
				code: "busy",
				message: lastMessage,
				retryable: true
			};
		}
	}
	return {
		kind: "failed",
		code: lastCode,
		message: lastMessage,
		retryable: true
	};
}
function errorCodeOf(error) {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = error.code;
		if (typeof code === "string") return code;
	}
	return "unknown";
}
//#endregion
//#region src/contracts.ts
/**
* The durable events of one session, whichever accessor this host build has.
*
* Kept in one place so "how do I read the log" has a single answer rather than
* three subtly different guesses.
*/
function sessionEvents(session) {
	if (session === void 0) return [];
	try {
		if (typeof session.ownEvents === "function") {
			const events = session.ownEvents();
			if (Array.isArray(events)) return events;
		}
		if (typeof session.snapshotEvents === "function") {
			const events = session.snapshotEvents();
			if (Array.isArray(events)) return events;
		}
	} catch {}
	return [];
}
//#endregion
//#region src/measure.ts
/**
* The two measurements this plugin acts on.
*
* An earlier design keyed only on cumulative spend, which answers "how much has
* this cost". Users actually watch the other number: "how full is the context
* right now". They are different quantities, and a session can be cheap but
* nearly full (a long tool-output-heavy turn) or expensive but half empty
* (frequent compaction). Both are measured here, and the trigger decides which
* one the user asked for.
*
* Neither function throws: measurement happens on the event hot path, and a
* service that misbehaves must degrade the trigger, not the session.
*/
const EMPTY_CONTEXT = {
	quality: "unavailable",
	used: 0,
	window: void 0,
	percent: void 0,
	baseline: "none"
};
/**
* Read context occupancy for one session.
*
* `surfaceTokens` is the size of the model-visible surface. `contextWindow`
* comes from the session's current request context, so switching to a model
* with a smaller window changes the denominator immediately — which is the
* behaviour a user expects: the new model really is closer to full.
*/
function readContextOccupancy(session, tokenMeter) {
	if (session === void 0 || tokenMeter === void 0) return EMPTY_CONTEXT;
	let measured;
	try {
		measured = tokenMeter.measure(session);
	} catch (error) {
		return {
			...EMPTY_CONTEXT,
			quality: "unavailable",
			error: error instanceof Error ? error.message : String(error)
		};
	}
	const used = typeof measured.surfaceTokens === "number" ? measured.surfaceTokens : 0;
	const baselineKind = measured.baseline?.kind ?? "none";
	const baseline = baselineKind === "usage" || baselineKind === "estimated" || baselineKind === "none" ? baselineKind : "none";
	let window;
	try {
		window = session.requestContext?.()?.contextWindow;
	} catch {
		window = void 0;
	}
	if (window === void 0) window = windowFromEvents(sessionEvents(session));
	const usableWindow = typeof window === "number" && Number.isFinite(window) && window > 0 ? window : void 0;
	if (used <= 0) return {
		...EMPTY_CONTEXT,
		quality: "unavailable",
		window: usableWindow,
		baseline
	};
	return {
		quality: baseline === "usage" ? "exact" : "estimated",
		used,
		window: usableWindow,
		percent: usableWindow === void 0 ? void 0 : used / usableWindow,
		baseline
	};
}
/**
* Read cumulative spend.
*
* Prefers the `tokenUsage` projection because it folds the durable log, so the
* number is reconstructable after a restart. Falls back to the meter's total,
* which re-prices the surface heuristically. A failed projection read is
* *not* fatal: the meter still answers.
*/
function readCumulativeUsage(session, projections, tokenMeter) {
	if (session === void 0) return {
		quality: "unavailable",
		tokens: 0,
		source: "none"
	};
	if (projections !== void 0) try {
		const totals = projections.stateOf(session, "tokenUsage")?.totals;
		if (totals !== void 0) {
			const sum = (totals.uncachedInputTokens ?? 0) + (totals.outputTokens ?? 0) + (totals.cacheReadTokens ?? totals.readTokens ?? 0) + (totals.cacheWriteTokens ?? totals.writeTokens ?? 0);
			if (sum > 0) return {
				quality: "exact",
				tokens: sum,
				source: "projection"
			};
		}
	} catch {}
	if (tokenMeter !== void 0) try {
		const measured = tokenMeter.measure(session);
		if (measured.totalTokens > 0) return {
			quality: "estimated",
			tokens: measured.totalTokens,
			source: "meter"
		};
	} catch (error) {
		return {
			quality: "unavailable",
			tokens: 0,
			source: "none",
			error: error instanceof Error ? error.message : String(error)
		};
	}
	return {
		quality: "unavailable",
		tokens: 0,
		source: "none"
	};
}
/** Render an occupancy ratio as whole percent, or `undefined` when unknown. */
function percentOf(occupancy) {
	if (occupancy.percent === void 0) return void 0;
	return Math.round(occupancy.percent * 100);
}
/**
* The last context window the log recorded for this session.
*
* Scans backwards because the newest `request/context` wins: switching models
* changes both the provider and the window, and an older event describes a model
* the session is no longer on.
*/
function windowFromEvents(events) {
	if (events === void 0) return void 0;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type !== "request/context") continue;
		const value = event.data?.["contextWindow"];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
}
//#endregion
//#region src/trigger.ts
/**
* The trigger engine: when an automatic action is allowed to fire.
*
* This module is deliberately pure. It owns no timers, subscribes to nothing,
* and never touches a service beyond the measurement functions passed in. The
* caller (`monitor.ts`) feeds it session events and executes the decisions it
* returns. That split is what makes the loop-prevention rules unit-testable
* without a running harness.
*
* ## Why each guard exists
*
* - **Watermark.** `session/event` fires per committed event; without a
*   watermark the same log position is judged repeatedly and one threshold
*   crossing becomes N handoffs.
* - **Debounce.** `tokenMeter.measure()` is O(surface). Judging every event of
*   a long turn would make the plugin a measurable tax on the session.
* - **Rearm.** A successful compaction drops occupancy, but a handoff might not
*   happen immediately; without an accumulator-style guard the same argument
*   (`cumulative >= threshold`) stays true forever and fires on every event.
* - **Hysteresis.** A compaction that buys ten points must not immediately
*   re-trigger at the same threshold. Requiring occupancy to drop below
*   `threshold - delta` before re-arming separates "still full" from "full
*   again".
* - **Baseline on first sight.** A plugin loaded into a session that is already
*   at 90% must not yank it out from under the user. The first observation
*   only records numbers.
* - **Per-session cap.** The only remaining backstop if all the above disagree.
*
* ## Priority
*
* Handoff beats compaction. Compaction is a stay of execution; a handoff is the
* end state. Checking compaction first would produce the worst sequence: fill,
* compact, refill, compact again, never finish the task.
*/
function createTriggerState() {
	return {
		lastEvaluatedSeq: -1,
		lastEvaluatedAt: 0,
		autoActions: 0,
		baselineEstablished: false,
		pending: false,
		contextRearmBelow: void 0,
		cumulativeRearmAt: void 0,
		compactRearmBelow: void 0,
		lastOccupancy: void 0,
		lastCumulative: void 0
	};
}
/**
* Judge one event for one session.
*
* Returns `undefined` when the event must not cause an action: not a surface
* event, debounced, already judged, already pending, capped, or below every
* threshold.
*/
function evaluate(session, seq, state, deps) {
	const { config } = deps;
	if (!config.autoHandoffEnabled && !config.autoCompactEnabled) return void 0;
	if (session === void 0) return void 0;
	if (state.pending) return void 0;
	if (seq <= state.lastEvaluatedSeq) return void 0;
	const now = deps.now();
	if (now - state.lastEvaluatedAt < config.evaluateIntervalMs) return void 0;
	const occupancy = readContextOccupancy(session, deps.tokenMeter);
	const cumulative = readCumulativeUsage(session, deps.projections, deps.tokenMeter);
	state.lastEvaluatedSeq = seq;
	state.lastEvaluatedAt = now;
	state.lastOccupancy = occupancy;
	state.lastCumulative = cumulative;
	if (!state.baselineEstablished) {
		state.baselineEstablished = true;
		return;
	}
	if (state.autoActions >= config.maxAutoActionsPerSession) return void 0;
	const percent = occupancy.percent === void 0 ? void 0 : occupancy.percent * 100;
	if (config.autoHandoffEnabled && triggerUsesContext(config.autoHandoffTrigger) && percent !== void 0) {
		if (state.contextRearmBelow !== void 0 && percent < state.contextRearmBelow) state.contextRearmBelow = void 0;
		if (state.contextRearmBelow === void 0 && percent >= config.autoHandoffAtContextPercent) return {
			kind: "handoff",
			reason: "context",
			occupancy,
			cumulative,
			detail: `上下文占用 ${Math.round(percent)}%（${occupancy.used} / ${occupancy.window}）达到交接阈值 ${config.autoHandoffAtContextPercent}%`
		};
	}
	if (config.autoHandoffEnabled && triggerUsesCumulative(config.autoHandoffTrigger)) {
		if (state.cumulativeRearmAt !== void 0 && cumulative.tokens >= state.cumulativeRearmAt) state.cumulativeRearmAt = void 0;
		if (state.cumulativeRearmAt === void 0 && cumulative.tokens >= config.autoHandoffThreshold) return {
			kind: "handoff",
			reason: "cumulative",
			occupancy,
			cumulative,
			detail: `累计消费 ${cumulative.tokens} tokens 达到交接阈值 ${config.autoHandoffThreshold}`
		};
	}
	if (config.autoCompactEnabled && percent !== void 0) {
		if (state.compactRearmBelow !== void 0 && percent < state.compactRearmBelow) state.compactRearmBelow = void 0;
		if (state.compactRearmBelow === void 0 && percent >= config.autoCompactAtContextPercent) return {
			kind: "compact",
			reason: "context",
			occupancy,
			cumulative,
			detail: `上下文占用 ${Math.round(percent)}% 达到压缩阈值 ${config.autoCompactAtContextPercent}%`
		};
	}
}
/**
* Record that an automatic action finished, and set the next rearm gate.
*
* Called for successes only. A failed action leaves the gates untouched so the
* next window can retry, while the per-session cap still bounds it.
*/
function noteActionSucceeded(state, kind, occupancy, cumulative, config) {
	state.autoActions += 1;
	state.pending = false;
	if (kind === "handoff") {
		state.contextRearmBelow = config.autoHandoffAtContextPercent - config.contextRearmDeltaPercent;
		state.cumulativeRearmAt = cumulative.tokens + config.rearmDeltaTokens;
		return;
	}
	state.compactRearmBelow = config.autoCompactAtContextPercent - config.contextRearmDeltaPercent;
	if (occupancy.percent !== void 0) state.lastOccupancy = occupancy;
}
/**
* Record that an action failed or was cancelled.
*
* `consumed` says whether the attempt counts against the per-session cap: a
* compaction that exhausted its retries does, so a broken compaction cannot
* spin forever, but the rearm gates stay open for a later window.
*/
function noteActionFinished(state, consumed) {
	state.pending = false;
	if (consumed) state.autoActions += 1;
}
//#endregion
//#region src/monitor.ts
/** The events whose arrival can change the model-visible surface size. */
const SURFACE_EVENTS = /* @__PURE__ */ new Set([
	"user/message",
	"assistant/message",
	"tool/result"
]);
var Monitor = class {
	deps;
	rows = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
	}
	/** Access or create one session's row. */
	rowFor(sessionId) {
		let row = this.rows.get(sessionId);
		if (row === void 0) {
			row = {
				state: createTriggerState(),
				occupancy: void 0,
				cumulative: void 0
			};
			this.rows.set(sessionId, row);
		}
		return row;
	}
	/** Forget one session entirely. */
	forget(sessionId) {
		this.rows.delete(sessionId);
		this.deps.coordinator.forget(sessionId);
	}
	/** Drop every row (plugin unload). */
	dispose() {
		this.deps.latches.releaseAll("cancel");
		for (const sessionId of [...this.rows.keys()]) this.rows.delete(sessionId);
	}
	/** The last occupancy this monitor measured for a session. */
	occupancyOf(sessionId) {
		const row = this.rows.get(sessionId);
		if (row?.occupancy !== void 0) return row.occupancy;
		return readContextOccupancy(this.deps.sessionOf(sessionId), this.deps.services().tokenMeter);
	}
	/** The last cumulative reading, or a fresh one. */
	cumulativeOf(sessionId) {
		const row = this.rows.get(sessionId);
		if (row?.cumulative !== void 0) return row.cumulative;
		const services = this.deps.services();
		return readCumulativeUsage(this.deps.sessionOf(sessionId), services.sessionProjections, services.tokenMeter);
	}
	/** How many automatic actions this session has consumed. */
	autoActionsOf(sessionId) {
		return this.rows.get(sessionId)?.state.autoActions ?? 0;
	}
	/**
	* Record an automatic action as in flight, so the engine stops proposing more.
	*
	* The coordinator has its own in-flight guard, but marking here keeps the
	* trigger's `pending` flag honest and lets `note...` bookkeeping decide when
	* it clears.
	*/
	markPending(sessionId) {
		this.rowFor(sessionId).state.pending = true;
	}
	/**
	* Clear the in-flight flag without touching counters or rearm gates.
	*
	* Every entry point sets `pending` so the engine stops proposing decisions,
	* but only the AUTOMATIC path used to clear it — `settle()` runs from
	* `execute()` and nowhere else. A manual `/handoff` (or a manual call that
	* bounced off the "already in flight" / "blank session" guards) therefore
	* left `pending` true forever, and `evaluate()` returns early on `pending`
	* (trigger.ts). With `archiveSourceAfterHandoff: false` the old session keeps
	* running, so one manual handoff silently disabled automatic handoff for that
	* session with no visible cause.
	*
	* A manual action deliberately does not run the automatic bookkeeping: it
	* must not consume the per-session cap, and it must not move rearm gates that
	* describe threshold crossings.
	*/
	releasePending(sessionId) {
		const row = this.rows.get(sessionId);
		if (row !== void 0) row.state.pending = false;
	}
	/** Apply an action's outcome to the trigger's rearm gates and counters. */
	settle(sessionId, kind, succeeded, consumedFailure = false) {
		const row = this.rowFor(sessionId);
		if (!succeeded) {
			noteActionFinished(row.state, consumedFailure);
			return;
		}
		noteActionSucceeded(row.state, kind, row.occupancy ?? this.occupancyOf(sessionId), row.cumulative ?? this.cumulativeOf(sessionId), this.deps.config());
	}
	/**
	* Feed one committed event.
	*
	* Returns the decision that was taken, if any, so callers (and tests) can
	* assert on it. The action itself runs detached: a trigger must never block
	* the event dispatch that delivered it.
	*/
	onSessionEvent(sessionId, event) {
		if (!SURFACE_EVENTS.has(event.type)) return;
		const row = this.rowFor(sessionId);
		const config = this.deps.config();
		const services = this.deps.services();
		const decision = evaluate(this.deps.sessionOf(sessionId), event.seq, row.state, {
			config,
			tokenMeter: services.tokenMeter,
			projections: services.sessionProjections,
			now: this.deps.now
		});
		row.occupancy = row.state.lastOccupancy;
		row.cumulative = row.state.lastCumulative;
		if (decision === void 0) return;
		row.state.pending = true;
		this.deps.log(`handoff: 自动动作 ${decision.kind}（${decision.reason}）触发 —— ${decision.detail}`);
		const reason = decision.reason === "manual" ? "context" : decision.reason;
		this.execute(sessionId, decision.kind, reason);
	}
	/** Run one automatic action and reconcile the trigger bookkeeping. */
	async execute(sessionId, kind, reason) {
		const request = {
			sessionId,
			agent: this.deps.agentOf(sessionId),
			kind,
			reason,
			automatic: true
		};
		const succeeded = (await this.deps.runAction(request)).phase === "completed";
		this.settle(sessionId, kind, succeeded);
		this.deps.onAutoAction?.(sessionId, kind, succeeded);
		if (kind === "compact" && succeeded) this.rejudgeAfterCompact(sessionId);
	}
	/**
	* Re-evaluate right after a compaction.
	*
	* The next surface event would do this anyway, but a compaction can take long
	* enough that the pause is visible in the composer. Judging here keeps the
	* decision tied to the moment the room was actually freed.
	*/
	rejudgeAfterCompact(sessionId) {
		const row = this.rows.get(sessionId);
		if (row === void 0) return;
		const config = this.deps.config();
		if (!config.autoHandoffEnabled) return;
		const services = this.deps.services();
		const occupancy = readContextOccupancy(this.deps.sessionOf(sessionId), services.tokenMeter);
		row.occupancy = occupancy;
		const percent = occupancy.percent === void 0 ? void 0 : occupancy.percent * 100;
		if (percent === void 0) return;
		if (percent >= config.autoHandoffAtContextPercent && row.state.contextRearmBelow === void 0) {
			row.state.pending = true;
			this.deps.log(`handoff: 压缩后占用仍为 ${Math.round(percent)}%，改为交接`);
			this.execute(sessionId, "handoff", "context");
		}
	}
	/** Expose the coordinator's status for commands and the HTTP channel. */
	statusOf(sessionId) {
		return this.deps.coordinator.statusOf(sessionId);
	}
};
/**
* Build the compaction runner for the coordinator.
*
* Kept next to the monitor because it needs the same two facts: the service and
* the loop latch.
*/
function compactRunner(deps) {
	return (agent) => compact(agent, {
		compaction: deps.services().compaction,
		waitIdle: deps.waitIdle,
		signal: deps.signal,
		interruptedRunningTurn: deps.latches.isLatched(agent.id),
		...deps.sleep === void 0 ? {} : { sleep: deps.sleep }
	});
}
//#endregion
//#region src/command.ts
/** Parse the argument text after the command name. */
function parseCommandArgs(raw) {
	const text = (raw ?? "").trim();
	if (text.length === 0) return { kind: "handoff" };
	const word = text.split(/\s+/)[0].toLowerCase();
	if (word === "status") return { kind: "status" };
	if (word === "cancel") return { kind: "cancel" };
	if (word === "retry") return { kind: "retry" };
	return {
		kind: "help",
		reason: `未知子命令「${word}」。可用：/handoff、/handoff status、/handoff cancel、/handoff retry。`
	};
}
/** Run one parsed command against the plugin. */
async function runCommand(parsed, sessionId, deps) {
	switch (parsed.kind) {
		case "help": return {
			ok: false,
			text: parsed.reason
		};
		case "status": return {
			ok: true,
			text: deps.status(sessionId)
		};
		case "cancel": return {
			ok: true,
			text: deps.cancel(sessionId) ? "已请求取消：当前动作会在下一个安全检查点停止。" : "当前没有进行中的动作，无需取消。"
		};
		case "retry": {
			const result = await deps.retry(sessionId);
			return {
				ok: result.ok,
				text: result.text
			};
		}
		case "handoff": {
			const result = await deps.handoff(sessionId, "手动 /handoff");
			return {
				ok: result.ok,
				text: result.text
			};
		}
	}
}
/** The human-readable `status` report. */
function renderStatus(input) {
	const { occupancy, cumulative, thresholds } = input;
	const percent = occupancy.percent === void 0 ? "未知（模型未上报上下文窗口）" : `${Math.round(occupancy.percent * 100)}%`;
	const window = occupancy.window === void 0 ? "" : ` / ${occupancy.window}`;
	const quality = occupancy.quality === "exact" ? "精确" : occupancy.quality === "estimated" ? "估算" : "不可用";
	const thresholdText = thresholds.enabled ? `占用率 ${thresholds.handoffPercent}%、累计 ${thresholds.cumulative} tokens` : "未启用（仅手动）";
	const compactText = thresholds.compactEnabled ? `占用率 ${thresholds.compactPercent}%` : "未启用";
	const lines = [
		"## 会话交接状态",
		`- 阶段：${input.phase}${input.busy ? "（进行中）" : ""}${input.latched ? " · 已设停止闩锁" : ""}`,
		`- 上下文占用：${occupancy.used}${window} tokens · ${percent} · ${quality}`,
		`- 累计消费：${cumulative.tokens} tokens（${cumulative.source === "projection" ? "日志投影" : cumulative.source === "meter" ? "估算" : "不可用"}）`,
		`- 自动交接阈值：${thresholdText}`,
		`- 自动压缩阈值：${compactText}`,
		`- 本会话自动动作：${input.autoActions} / ${input.maxAutoActions}`
	];
	if (input.waitingForStep) lines.push(`- 正在等待当前 Step 完成…${input.slowWarning ? "（等待时间偏长）" : ""}`);
	if (input.newSessionId !== void 0) lines.push(`- 新会话：${input.newSessionId}`);
	if (input.lastText !== void 0) lines.push(`- 最近结果：${oneLine(input.lastText)}`);
	if (input.lastFailure !== void 0) lines.push(`- 最近失败：${oneLine(input.lastFailure)}`);
	if (input.persistence === "memory") lines.push("- ⚠ 当前部署没有 settings 服务，设置只在本次进程内有效。");
	for (const warning of input.warnings) lines.push(`- ⚠ ${warning}`);
	return lines.join("\n");
}
/** Collapse a multi-line verdict into a single status line. */
function oneLine(text) {
	return text.split("\n").filter((ln) => ln.trim().length > 0).join(" · ");
}
//#endregion
//#region src/redaction.ts
/**
* Rules run in this order. Specific patterns come before generic ones so a rule
* never partially consumes text another rule uses as a marker: an env
* assignment such as `OPENAI_API_KEY=sk-...` must be removed as a whole before
* the provider-token rule could leave a stray suffix behind.
*/
const RULES = [
	{
		name: "private-key-block",
		pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
		replacement: "[redacted: private key]"
	},
	{
		name: "env-assignment",
		pattern: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*("[^"]{4,}"|'[^']{4,}'|(?!\[redacted\b)[^\s"'\]]{8,})/g,
		replacement: "$1=[redacted]"
	},
	{
		name: "known-token-prefix",
		pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpa]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,})\b/g,
		replacement: "[redacted: token]"
	},
	{
		name: "authorization-header",
		pattern: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{16,})/g,
		replacement: "$1 [redacted]"
	},
	{
		name: "connection-string-password",
		pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]{3,})@/gi,
		replacement: "$1:[redacted]@"
	},
	{
		name: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
		replacement: "[redacted: jwt]"
	},
	{
		name: "long-hex-secret",
		pattern: /\b[0-9a-fA-F]{32,}\b/g,
		replacement: "[redacted: hex]"
	},
	{
		name: "long-base64-secret",
		pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
		replacement: "[redacted: base64]"
	}
];
/** Apply every rule and report which ones fired. */
function redactWithReport(text) {
	let current = text;
	const applied = [];
	for (const rule of RULES) {
		rule.pattern.lastIndex = 0;
		if (rule.pattern.test(current)) {
			rule.pattern.lastIndex = 0;
			current = current.replace(rule.pattern, rule.replacement);
			applied.push(rule.name);
		}
	}
	return {
		text: current,
		applied
	};
}
//#endregion
//#region src/session-summary.ts
/**
* The nine-section handoff brief.
*
* The structure is fixed so the receiving session always knows where to look,
* and so the host can verify a model actually answered the question instead of
* prose-dumping. Sections are rendered with explicit headings the new session is
* told to treat as fact.
*
* Two kinds of content go in:
*
* - **Facts**, read by this process from the session itself (cwd, preset, model,
*   permission, plan mode, spend, occupancy). The model never gets to restate
*   these, because a model summarizing its own configuration is a model
*   guessing.
* - **Narrative**, written by the outgoing session's model: goals, decisions,
*   what is left. This is the part no program can derive, and the reason a
*   handoff beats starting cold.
*
* The model call is bounded (`summaryMaxTokens`) and its failure is fatal to the
* handoff: a new session started without a brief would lose the whole point and
* duplicate work the old session already did.
*/
/** The nine sections, in order, with the prompt wording for each. */
const BRIEF_SECTIONS = [
	{
		key: "goal",
		title: "总体目标"
	},
	{
		key: "constraints",
		title: "约束"
	},
	{
		key: "done",
		title: "已完成"
	},
	{
		key: "progress",
		title: "当前进度"
	},
	{
		key: "files",
		title: "已改文件"
	},
	{
		key: "decisions",
		title: "关键决策"
	},
	{
		key: "problems",
		title: "已知问题"
	},
	{
		key: "remaining",
		title: "未完成"
	},
	{
		key: "next",
		title: "下一步"
	}
];
/** Read the facts this process can observe directly. */
function readSessionFacts(input) {
	const header = input.session?.header;
	let requestContext;
	try {
		requestContext = input.session?.requestContext?.();
	} catch {
		requestContext = void 0;
	}
	const headerConfig = safely$1(() => input.session?.requestHeader?.()?.config);
	const turnCount = (input.events ?? []).filter((event) => event.type === "turn/start").length;
	return {
		cwd: header?.cwd,
		agentPreset: header?.agentPreset,
		provider: requestContext?.provider ?? headerConfig?.provider,
		model: requestContext?.model ?? headerConfig?.model,
		contextWindow: requestContext?.contextWindow,
		permissionPreset: void 0,
		planMode: "unknown",
		occupancy: input.occupancy,
		cumulative: input.cumulative,
		turnCount
	};
}
function safely$1(read) {
	try {
		return read();
	} catch {
		return;
	}
}
/** The prompt sent to the outgoing model. Every section name is explicit. */
/**
* Render the conversation itself into the prompt.
*
* Without this the model only sees configuration facts and a list of headings,
* so every section comes back "未知" — and the brief is worthless precisely when
* it matters. The first real handoff produced exactly that: nine sections of
* "unknown" because the transcript was never sent.
*
* The transcript is bounded by characters, keeping the most recent turns, since
* what the session is doing now matters more than how it started. Tool traffic
* is collapsed: arguments and results are truncated, because the brief needs to
* know *what* was done, not the full output of every command.
*/
function renderTranscript(events, budgetChars = 24e3) {
	if (events === void 0 || events.length === 0) return "（没有可读的对话记录）";
	const lines = [];
	for (const event of events) {
		const line = renderEvent(event);
		if (line !== void 0) lines.push(line);
	}
	let total = 0;
	let start = lines.length;
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const next = total + lines[i].length + 1;
		if (next > budgetChars) break;
		total = next;
		start = i;
	}
	const kept = lines.slice(start);
	const omitted = start;
	return (omitted > 0 ? `（省略较早的 ${omitted} 条记录）\n` : "") + kept.join("\n");
}
/** One compact line per meaningful event; everything else is dropped. */
function renderEvent(event) {
	const data = event.data ?? {};
	if (event.type === "user/message") {
		const text = blocksToText(data["message"] ?? data);
		return text.length === 0 ? void 0 : `[用户] ${truncate(text, 600)}`;
	}
	if (event.type === "assistant/message") {
		const message = data["message"];
		const text = blocksToText(message);
		return text.length === 0 ? void 0 : `[助手] ${truncate(text, 900)}`;
	}
	if (event.type === "tool/call") return `[工具 ${typeof data["name"] === "string" ? data["name"] : "?"}] ${truncate(typeof data["arguments"] === "string" ? data["arguments"] : "", 240)}`;
	if (event.type === "tool/result") {
		const message = data["message"];
		return `[工具结果] ${truncate(blocksToText(message), 240)}`;
	}
}
/** Flatten a message's content blocks into plain text. */
function blocksToText(message) {
	if (message === null || typeof message !== "object") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => {
		if (block === null || typeof block !== "object") return "";
		const record = block;
		if (typeof record["text"] === "string") return record["text"];
		if (typeof record["arguments"] === "string") return record["arguments"];
		return "";
	}).filter((part) => part.length > 0).join("\n");
}
function truncate(text, max) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
function buildSummaryPrompt(facts, transcript) {
	return [
		"你要为「会话交接」写一份简报：当前会话即将停止，同一工作区会开一个新会话接着做。",
		"新会话看不到你现在的对话历史，只会收到这份简报。",
		"",
		"要求：",
		"- 严格按下面的小节输出，使用「## 小节名」作为标题，顺序固定。",
		"- 每节写具体的、可执行的内容；不要复述你已经说过的客套话，不要写「我理解了」之类的过渡语。",
		"- 「已改文件」列真实路径；「下一步」列具体的下一条动作。",
		"- 优先依据下面提供的对话记录来写，不要写「未知」除非记录里确实没有线索。",
		"- 不要编造未发生的事。",
		"- 不要包含任何密钥、令牌、密码或连接串的值；需要引用时只写键名。",
		"",
		`会话事实（由程序读取，请勿改写）：cwd=${facts.cwd ?? "未知"}，preset=${facts.agentPreset ?? "默认"}，模型=${facts.provider ?? "?"}/${facts.model ?? "?"}，已完成 turn 数=${facts.turnCount}。`,
		"",
		"对话记录（从旧到新，工具输出已截断）：",
		transcript === void 0 ? "（未提供）" : transcript,
		"",
		...BRIEF_SECTIONS.map((section) => `## ${section.title}`)
	].join("\n");
}
/**
* Split model output into sections.
*
* Accepts the `## 标题` form the prompt asks for, tolerates `**标题**`, `###`,
* and a trailing colon, and assigns text before the first heading to the goal
* section so a model that forgot the headings still produces something usable.
*/
function parseNarrative(raw) {
	const text = raw.replace(/\r\n/g, "\n");
	const titleToKey = new Map(BRIEF_SECTIONS.map((section) => [section.title, section.key]));
	const found = /* @__PURE__ */ new Map();
	let current;
	for (const line of text.split("\n")) {
		const heading = matchHeading(line);
		if (heading !== void 0) {
			const key = titleToKey.get(heading.title);
			if (key !== void 0) {
				current = key;
				if (!found.has(key)) found.set(key, []);
				if (heading.remainder.length > 0) found.get(key).push(heading.remainder);
				continue;
			}
		}
		if (current !== void 0) found.get(current).push(line);
	}
	const narrative = {};
	let seenHeading = false;
	for (const section of BRIEF_SECTIONS) {
		const body = found.get(section.key);
		if (body !== void 0) seenHeading = true;
		const value = (body ?? []).join("\n").trim();
		if (value.length > 0) narrative[section.key] = value;
	}
	if (!seenHeading) {
		const whole = text.trim();
		if (whole.length > 0) narrative.goal = whole;
	}
	return narrative;
}
/** Recognise `## 标题`, `### **标题**`, and `**标题**：正文`, returning the trailing content. */
function matchHeading(line) {
	const trimmed = line.trim();
	if (trimmed.length === 0) return void 0;
	const withoutHashes = /^#{1,6}\s+(.+)$/.exec(trimmed)?.[1] ?? trimmed;
	const bold = /^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/.exec(withoutHashes.trim());
	if (bold !== null) {
		const title = bold[1].trim();
		return title.length > 0 ? {
			title,
			remainder: (bold[2] ?? "").trim()
		} : void 0;
	}
	const plain = withoutHashes.replace(/[:：]\s*$/, "").replace(/^\*\*|\*\*$/g, "").trim();
	return plain.length > 0 ? {
		title: plain,
		remainder: ""
	} : void 0;
}
/** Count how many of the nine sections carry content. */
function sectionCoverage(narrative) {
	return BRIEF_SECTIONS.filter((section) => {
		const value = narrative[section.key];
		return typeof value === "string" && value.trim().length > 0;
	}).length;
}
function narrativeIsUsable(narrative) {
	return sectionCoverage(narrative) >= 3;
}
/**
* Describe the permission preset, distinguishing "unknown" from "failed".
*
* Three outcomes, three sentences. A read that threw is reported with its
* reason, because "未知" alone reads as "this session simply has none" — that
* ambiguity is exactly what kept the preset-inheritance bug invisible.
*/
function permissionLine(facts) {
	if (facts.permissionPreset !== void 0) return facts.permissionPreset;
	if (facts.permissionError !== void 0) return `读取失败（${facts.permissionError}）`;
	return "未知";
}
/** Render the final brief, including the redaction report. */
function renderBrief(input) {
	const { facts, narrative } = input;
	const occupancyPercent = percentOf(facts.occupancy);
	const applied = /* @__PURE__ */ new Set();
	const section = (title, body) => {
		const result = body === void 0 ? void 0 : redactWithReport(body);
		if (result !== void 0) for (const rule of result.applied) applied.add(rule);
		return `## ${title}\n${result !== void 0 && result.text.trim().length > 0 ? result.text.trim() : "（未提供）"}`;
	};
	return {
		text: [
			"# 会话交接简报",
			"",
			"> 你接手的是同一工作区里另一个会话的中途任务。下面是上一段会话留下的交接简报，",
			"> 「会话事实」由程序读取，「总体目标」到「下一步」由上一段会话的模型撰写。",
			"> 请先读完整份简报，再从「下一步」继续；不要重复「已完成」里已经做完的事。",
			"",
			"**开工前先做两件事，把结果原样报告给用户：**",
			"1. 把本简报的「总体目标」「已完成」「下一步」三节原文打印出来，让用户确认交接内容没有丢失。",
			"2. 复查本插件（`dsh-session-handoff/`）：重点看交接链路——度量、触发、软终止、简报、",
			"   会话迁移与配置继承、归档——有没有与宿主 API 不符、静默降级或逻辑缺口。",
			"   有发现就列出来并说明证据；没有发现就说「未发现问题」，不要编造。",
			"",
			"## 会话事实",
			[
				`- 工作目录：${facts.cwd ?? "未知"}`,
				`- Agent preset：${facts.agentPreset ?? "默认"}`,
				`- 模型：${facts.provider ?? "?"} / ${facts.model ?? "?"}${facts.contextWindow === void 0 ? "" : `（上下文窗口 ${facts.contextWindow} tokens）`}`,
				`- 权限预设：${permissionLine(facts)}`,
				`- Plan 模式：${facts.planMode === "unknown" ? "未知" : facts.planMode === "on" ? "开启" : "关闭"}`,
				`- 上下文占用：${occupancyPercent === void 0 ? "模型未上报窗口" : `${occupancyPercent}%（${facts.occupancy.used} / ${facts.occupancy.window} tokens，${facts.occupancy.quality === "exact" ? "精确" : "估算"}）`}`,
				`- 累计消费：${facts.cumulative.tokens} tokens（${facts.cumulative.source === "projection" ? "日志投影" : facts.cumulative.source === "meter" ? "估算" : "不可用"}）`,
				`- 已完成 turn：${facts.turnCount}`,
				`- 原会话：${input.sourceSessionId}`,
				`- 生成时间：${new Date(input.createdAt).toISOString()}`
			].join("\n"),
			"",
			...BRIEF_SECTIONS.map((entry) => section(entry.title, narrative[entry.key])),
			"",
			"## 交接附注",
			applied.size > 0 ? `简报中有 ${applied.size} 类敏感信息已被替换为占位符（${[...applied].join("、")}）。如需原始值，请在当前会话重新读取来源文件。` : "未发现需要脱敏的内容。"
		].join("\n"),
		redactions: [...applied]
	};
}
//#endregion
//#region src/routes.ts
/** Build the status snapshot. */
function statePayload(sessionId, deps) {
	const status = deps.statusOf(sessionId);
	const occupancy = deps.occupancyOf(sessionId);
	const cumulative = deps.cumulativeOf(sessionId);
	const settings = deps.settings;
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
			percent: occupancy.percent
		},
		cumulative: {
			tokens: cumulative.tokens,
			source: cumulative.source,
			quality: cumulative.quality
		},
		thresholds: {
			handoffPercent: settings.autoHandoffAtContextPercent,
			compactPercent: settings.autoCompactAtContextPercent,
			cumulative: settings.autoHandoffThreshold,
			enabled: settings.autoHandoffEnabled,
			compactEnabled: settings.autoCompactEnabled
		},
		autoActions: deps.autoActionsOf(sessionId),
		maxAutoActions: settings.maxAutoActionsPerSession,
		openNewSession: settings.openNewSessionOnHandoff,
		persistence: deps.persistence,
		lastText: status.lastResult?.text,
		lastFailure: status.lastFailure?.message,
		warnings: deps.warnings()
	};
}
/** Reject requests that did not come from this machine. */
function isLoopbackRequest(remoteAddress) {
	if (remoteAddress === void 0) return false;
	const address = remoteAddress.replace(/^::ffff:/, "");
	return address === "127.0.0.1" || address === "::1" || address === "localhost";
}
/** A JSON response helper that never leaks a live object. */
function sendJson(res, status, body) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(body));
}
/** Read a small JSON body, refusing anything unexpectedly large. */
async function readJsonBody(req, maxBytes = 65536) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.byteLength;
		if (size > maxBytes) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("请求体不是合法 JSON");
	}
}
/** The session id a request refers to, defaulting to nothing. */
function sessionIdFromUrl(requestUrl) {
	if (requestUrl === void 0) return void 0;
	const queryStart = requestUrl.indexOf("?");
	if (queryStart < 0) return void 0;
	const value = new URLSearchParams(requestUrl.slice(queryStart + 1)).get("sessionId");
	return value !== null && value.length > 0 ? value : void 0;
}
//#endregion
//#region src/index.ts
/**
* The session a handoff belongs to, for the duration of one action.
*
* The coordinator hands the `migrate` callback only a brief, so the source id
* has to travel beside it. A shared mutable field would be wrong: automatic
* triggers and manual commands can interleave, and a stale value would migrate
* the wrong session. `AsyncLocalStorage` carries the id across every `await` of
* one action without leaking into a concurrent one.
*/
const sourceScope = new AsyncLocalStorage();
/** Stable plugin name; must match the row inserted by `cordis.patch.yml`. */
const name = "dsh-session-handoff";
/** Optional host services; see `services.ts` for why these are declared. */
const inject = INJECT;
/** Route prefix for the status/action channel used by the settings card. */
const ROUTE_PREFIX = "/dsh-session-handoff";
/** Entry id under which the settings card writes; equals the patch row id. */
const SETTINGS_ENTRY = "dsh-session-handoff";
function apply(ctx, config) {
	const host = ctx;
	const log = (message) => {
		try {
			host.logger?.info?.(message);
		} catch {}
	};
	let live = config;
	const latches = new LatchRegistry();
	/**
	* Human text observed while an action was in flight.
	*
	* The latch lets human messages through rather than rejecting the step (a
	* rejected step claims the messages but never persists or re-queues them, so
	* the user's words would vanish). Once the task moves, those words belong to
	* the successor session, and this buffer is what carries them there.
	*/
	const humanInput = new HumanInputBuffer();
	/** Resolve the session log for an id, without waking an agent. */
	/**
	* The session log for one id.
	*
	* `ctx.sessions` stores Session objects; the agent is a separate registry.
	*
	* Prefers the live agent's own `session` when an agent exists: that object is
	* guaranteed to be the host's Session instance, whereas the store lookup can
	* return a different handle depending on the composition. `permissionPresets.
	* current` walks the log through `snapshotEvents`, and only a real Session
	* instance has it — the mismatch is what made every handoff report
	* "权限：回退" with no explanation.
	*/
	const sessionOf = (sessionId) => {
		try {
			const services = readServices(host);
			const fromAgent = services.agents?.get?.(sessionId)?.session;
			if (fromAgent !== void 0) return fromAgent;
			return services.sessions?.get?.(sessionId);
		} catch {
			return;
		}
	};
	/**
	* The live agent for one id.
	*
	* `ctx.agents` is the agent registry. A session with no live agent (restored
	* but not resumed) has no `whenIdle`/`followup`; callers must cope.
	*/
	const agentOf = (sessionId) => {
		try {
			return readServices(host).agents?.get?.(sessionId);
		} catch {
			return;
		}
	};
	/** Ask the outgoing model to write the nine sections. */
	const summarize = async (agent) => {
		const services = readServices(host);
		const session = agent.session;
		const events = sessionEvents(session);
		let facts = readSessionFacts({
			session,
			occupancy: readContextOccupancy(session, services.tokenMeter),
			cumulative: readCumulativeUsage(session, services.sessionProjections, services.tokenMeter),
			events
		});
		facts = withObservedServices(facts, services, agent);
		if (services.llm === void 0) throw new Error("当前部署没有 llm 服务，无法生成交接简报");
		const route = summaryRoute(facts, services);
		if (route === void 0) throw new Error("原会话没有记录模型路由，也没有部署默认模型，无法生成交接简报");
		const narrative = await requestNarrative(services.llm, buildSummaryPrompt(facts, renderTranscript(events)), live.summaryMaxTokens, route);
		if (!narrativeIsUsable(narrative)) throw new Error("模型返回的简报内容不足（可用小节少于 3 段），已放弃本次交接");
		const rendered = renderBrief({
			facts,
			narrative,
			sourceSessionId: agent.id,
			createdAt: Date.now()
		});
		return {
			brief: rendered.text,
			redactions: rendered.redactions
		};
	};
	/** Fill the fields that live on services rather than on the session. */
	const withObservedServices = (facts, services, agent) => {
		const permissionRead = readPermissionPreset(agent.session, services.permissionPresets);
		const plan = planModeFor(agent, services.agentPresets);
		return {
			...facts,
			permissionPreset: permissionRead.value,
			...permissionRead.error === void 0 ? {} : { permissionError: permissionRead.error },
			planMode: plan === void 0 ? "unknown" : plan.active ? "on" : "off"
		};
	};
	const coordinator = new Coordinator({
		latches,
		summarize,
		compact: compactRunner({
			services: () => readServices(host),
			latches,
			waitIdle: async (agent) => {
				if (typeof agent.whenIdle === "function") await agent.whenIdle();
			},
			signal: new AbortController().signal
		}),
		migrate: async (brief) => migrateFor(brief, host, agentOf, sessionOf),
		drainHumanInput: (sessionId) => humanInput.drain(sessionId),
		reroute: async (newSessionId, text) => {
			const target = agentOf(newSessionId);
			if (target === void 0 || typeof target.followup !== "function") return false;
			try {
				await target.followup({
					role: "user",
					source: { kind: PLUGIN_SOURCE_KIND },
					content: [{
						type: "text",
						text
					}]
				}, { source: { kind: PLUGIN_SOURCE_KIND } });
				return true;
			} catch {
				return false;
			}
		},
		waitIdle: async (agent) => {
			if (typeof agent.whenIdle === "function") await agent.whenIdle();
		},
		retire: async (sessionId, newSessionId) => {
			if (!live.archiveSourceAfterHandoff) {
				log(`dsh-session-handoff: 旧会话 ${sessionId} 保持运行（设置要求不归档）`);
				return;
			}
			const registry = readServices(host).workspaceRegistry;
			if (registry === void 0) throw new Error("当前部署没有 workspaceRegistry，无法归档旧会话");
			if (typeof registry.archiveSession !== "function") throw new Error("当前部署的 workspaceRegistry 不支持归档会话");
			await registry.archiveSession(sessionId, { stopActivity: true });
			log(`dsh-session-handoff: 旧会话 ${sessionId} 已归档${newSessionId === void 0 ? "" : `（接手：${newSessionId}）`}`);
		},
		now: () => Date.now(),
		log
	});
	coordinator.activityCheck = (sessionId) => {
		return sessionEvents(sessionOf(sessionId)).some((event) => event.type === "user/message" || event.type === "turn/start");
	};
	const applyBounds = (next) => {
		coordinator.configure({
			stepWaitMs: next.stepWaitTimeoutMs,
			actionDeadlineMs: next.actionDeadlineMs
		});
	};
	applyBounds(live);
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
		log
	});
	/**
	* Run one MANUAL action, clearing the in-flight flag however it ends.
	*
	* The flag is what stops the trigger engine from proposing a second action
	* while one runs, so every manual entry point sets it. Clearing it is the
	* other half, and only the automatic path had that: `settle()` is called from
	* `Monitor.execute()` alone, so a manual handoff left `pending` true for the
	* rest of the session's life — and `evaluate()` bails out on `pending`. With
	* `archiveSourceAfterHandoff: false` (which keeps the old session alive) that
	* meant one manual `/handoff` silently disabled automatic handoff forever.
	*
	* Automatic bookkeeping is deliberately NOT run here: a manual action must
	* not consume the per-session cap or move rearm gates, which describe
	* threshold crossings rather than user intent.
	*/
	const runManual = async (sessionId, request) => {
		monitor.markPending(sessionId);
		try {
			return await sourceScope.run(sessionId, () => coordinator.run({
				sessionId,
				agent: agentOf(sessionId),
				kind: request.kind,
				reason: request.reason ?? "manual",
				automatic: false,
				...request.detail === void 0 ? {} : { detail: request.detail }
			}));
		} finally {
			monitor.releasePending(sessionId);
		}
	};
	const statusText = (sessionId) => {
		const services = readServices(host);
		const status = coordinator.statusOf(sessionId);
		const session = sessionOf(sessionId);
		const validation = validateSettings(live);
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
				compactEnabled: live.autoCompactEnabled
			},
			autoActions: monitor.autoActionsOf(sessionId),
			maxAutoActions: live.maxAutoActionsPerSession,
			lastText: status.lastResult?.text,
			lastFailure: status.lastFailure?.message,
			warnings: validation.warnings.map((warning) => warning.message),
			persistence: readServices(host) === void 0 ? "memory" : "durable"
		});
	};
	host.effect(() => {
		log("dsh-session-handoff: 已挂载（自动动作默认关闭）");
		const offPreStep = host.on("agent/pre-step", (...args) => {
			const payload = args[0];
			const next = args[args.length - 1];
			const agentId = payload?.agent?.id;
			if (agentId === void 0 || typeof next !== "function") return next?.();
			if (!latches.isLatched(agentId)) return next();
			const decision = decidePreStep(true, payload?.messages);
			if (decision === void 0) {
				humanInput.capture(agentId, humanTexts(payload?.messages));
				if (coordinator.abortForHumanInput(agentId)) log(`dsh-session-handoff: 收到人类输入，已取消 ${agentId} 的交接，原会话继续`);
				return next();
			}
			log(`dsh-session-handoff: 拒绝启动下一个 Step（${agentId}），等待交接`);
			return decision;
		});
		const offEvent = host.on("session/event", (...args) => {
			const sessionId = args[0]?.id;
			const event = args[1];
			if (sessionId === void 0 || event?.type === void 0 || event.seq === void 0) return;
			try {
				monitor.onSessionEvent(sessionId, event);
			} catch (error) {
				host.logger?.error?.(error);
			}
		});
		const offDisposed = host.on("session/disposed", (...args) => {
			const sessionId = args[0]?.id;
			if (sessionId !== void 0) monitor.forget(sessionId);
		});
		const registerLater = (services, label, run) => {
			try {
				const injector = ctx.inject;
				if (typeof injector === "function") {
					injector.call(ctx, services, () => {
						try {
							const disposer = run();
							if (disposer !== void 0) ctx.effect(() => disposer, label);
						} catch (error) {
							host.logger?.error?.(error);
						}
					});
					return;
				}
			} catch (error) {
				host.logger?.error?.(error);
			}
			const disposer = run();
			if (disposer !== void 0) ctx.effect(() => disposer, label);
		};
		registerLater(["commands"], "dsh-session-handoff: /handoff", () => {
			const commands = readServices(host).commands;
			if (commands === void 0) {
				log("dsh-session-handoff: 没有 commands 服务，/handoff 命令不可用");
				return;
			}
			return commands.register({
				name: "handoff",
				description: "把当前会话交接到同工作区的新会话（status / cancel / retry）",
				input: { hint: "status | cancel | retry" },
				handler: async (invocation) => {
					const sessionId = invocation.agent?.id;
					const raw = invocation.rawInput ?? "";
					if (sessionId === void 0) return {
						kind: "error",
						text: "无法确定当前会话，/handoff 不可用。"
					};
					try {
						const outcome = await runCommand(parseCommandArgs(raw), sessionId, {
							handoff: async (id, detail) => runManual(id, {
								kind: "handoff",
								...detail === void 0 ? {} : { detail }
							}),
							cancel: (id) => coordinator.requestCancel(id),
							status: statusText,
							retry: async (id) => runManual(id, {
								kind: "handoff",
								detail: "手动 retry"
							})
						});
						return outcome.ok ? {
							kind: "success",
							text: outcome.text
						} : {
							kind: "error",
							text: outcome.text
						};
					} catch (error) {
						return {
							kind: "error",
							text: error instanceof Error ? error.message : String(error)
						};
					}
				}
			});
		});
		registerLater(["webServer"], "dsh-session-handoff: routes", () => {
			const webServer = host.get("webServer");
			if (webServer === void 0) {
				log("dsh-session-handoff: 没有 webServer 服务，设置页的状态通道不可用");
				return;
			}
			const handler = async (req, res) => {
				const action = ((req.url ?? "").split("?")[0] ?? "").slice(20).replace(/^\/+/, "");
				const loopback = isLoopbackRequest(req.socket?.remoteAddress);
				try {
					if (action === "config" && (req.method ?? "GET") === "GET") {
						sendJson(res, 200, {
							ok: true,
							settings: live
						});
						return;
					}
					if (action === "state" && (req.method ?? "GET") === "GET") {
						const sessionId = sessionIdFromUrl(req.url);
						if (sessionId === void 0) {
							sendJson(res, 400, {
								ok: false,
								error: "缺少 sessionId"
							});
							return;
						}
						const services = readServices(host);
						const validation = validateSettings(live);
						sendJson(res, 200, statePayload(sessionId, {
							statusOf: (id) => coordinator.statusOf(id),
							occupancyOf: (id) => monitor.occupancyOf(id),
							cumulativeOf: (id) => monitor.cumulativeOf(id),
							autoActionsOf: (id) => monitor.autoActionsOf(id),
							settings: live,
							warnings: () => {
								const warnings = validation.warnings.map((w) => w.message);
								if (live.autoHandoffEnabled && services.tokenMeter === void 0) warnings.push("当前部署没有 tokenMeter，无法测量上下文占用率");
								return warnings;
							},
							persistence: "durable"
						}));
						return;
					}
					if ((req.method ?? "GET") !== "POST") {
						sendJson(res, 405, {
							ok: false,
							error: "方法不允许"
						});
						return;
					}
					if (!loopback) {
						sendJson(res, 403, {
							ok: false,
							error: "仅允许本机访问"
						});
						return;
					}
					if (action === "settings") {
						const next = (await readJsonBody(req)).settings;
						if (next === null || typeof next !== "object") {
							sendJson(res, 400, {
								ok: false,
								error: "缺少 settings 对象"
							});
							return;
						}
						const editor = readServices(host).configEditor;
						if (editor?.edit === void 0 || editor.configuration === void 0) {
							sendJson(res, 400, {
								ok: false,
								error: "当前部署没有 configEditor，无法保存设置"
							});
							return;
						}
						try {
							const row = editor.configuration().find((entry) => entry.entry?.id === "include:dsh-session-handoff" || entry.entry?.id === "dsh-session-handoff");
							if (row?.entry === void 0) {
								sendJson(res, 404, {
									ok: false,
									error: "找不到本插件的配置行"
								});
								return;
							}
							const desired = next;
							await editor.edit(row.entry, (current) => ({
								...current,
								...desired
							}));
							sendJson(res, 200, {
								ok: true,
								text: "设置已保存，立即生效。"
							});
						} catch (error) {
							sendJson(res, 500, {
								ok: false,
								error: `保存失败：${error instanceof Error ? error.message : String(error)}`
							});
						}
						return;
					}
					const body = await readJsonBody(req);
					const sessionId = typeof body.sessionId === "string" ? body.sessionId : void 0;
					if (sessionId === void 0) {
						sendJson(res, 400, {
							ok: false,
							error: "缺少 sessionId"
						});
						return;
					}
					if (action === "handoff" || action === "retry") {
						sendJson(res, 200, await runManual(sessionId, {
							kind: "handoff",
							detail: action === "retry" ? "手动 retry" : "手动 handoff"
						}));
						return;
					}
					if (action === "cancel") {
						const accepted = coordinator.requestCancel(sessionId);
						sendJson(res, 200, {
							ok: accepted,
							phase: coordinator.statusOf(sessionId).phase,
							text: accepted ? "已请求取消，将在下一个安全检查点停止。" : "当前没有进行中的动作。"
						});
						return;
					}
					sendJson(res, 404, {
						ok: false,
						error: "未知操作"
					});
				} catch (error) {
					sendJson(res, 500, {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			};
			return webServer.register({
				kind: "prefix",
				path: ROUTE_PREFIX,
				handler
			});
		});
		return () => {
			log("dsh-session-handoff: 卸载");
			offPreStep?.();
			offEvent?.();
			offDisposed?.();
			monitor.dispose();
		};
	}, "dsh-session-handoff");
	/** Keep the live config in step with the loader when the row is re-applied. */
	Object.assign(live, config);
}
/**
* Run the migration.
*
* The snapshot is read first, while the source agent is still alive: Plan mode
* and the permission preset live on per-agent services that disappear with the
* agent. Everything after the create is best-effort and reported item by item.
*/
async function migrateFor(brief, host, agentOf, sessionOf) {
	const sourceSessionId = sourceScope.getStore();
	if (sourceSessionId === void 0) return {
		ok: false,
		phase: "failed",
		text: "内部错误：交接动作缺少来源会话 id，已放弃且未创建任何会话。",
		error: "missing-source"
	};
	const sourceSession = sessionOf(sourceSessionId);
	const services = readServices(host);
	const sourceAgent = agentOf(sourceSessionId);
	const defaultModel = safely(() => services.agentDefaultModel?.currentSelection());
	const result = await migrateSession({
		source: snapshotSource({
			session: sourceSession,
			sessionId: sourceSessionId,
			agent: sourceAgent,
			permissionPresets: services.permissionPresets,
			approval: services.approval,
			agentPresets: services.agentPresets,
			defaultModel
		}),
		brief
	}, {
		sessionController: services.sessionController,
		workspaceRegistry: services.workspaceRegistry,
		permissionPresets: services.permissionPresets,
		approval: services.approval,
		agentPresets: services.agentPresets,
		defaultModel,
		resolveAgent: agentOf
	});
	return {
		ok: result.ok,
		phase: result.ok ? "completed" : "failed",
		text: result.ok ? `已创建新会话 ${result.newSessionId ?? ""} 并投递简报。` : `交接未完成：${result.error ?? "未知原因"}`,
		...result.newSessionId === void 0 ? {} : { newSessionId: result.newSessionId },
		inherited: result.inherited,
		...result.error === void 0 ? {} : { error: result.error }
	};
}
function safely(read) {
	try {
		return read();
	} catch {
		return;
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
async function requestNarrative(llm, prompt, maxTokens, route) {
	const stream = llm.stream;
	if (typeof stream !== "function") throw new Error("当前 llm 服务没有 stream 方法，无法生成交接简报");
	const chunks = stream.call(llm, {
		provider: route.provider,
		model: route.model,
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: prompt
			}]
		}],
		maxTokens
	});
	let text = "";
	let failure;
	for await (const chunk of chunks) {
		if (chunk.type === "text-delta" && typeof chunk.text === "string") {
			text += chunk.text;
			continue;
		}
		if (chunk.type === "finish") {
			const reason = chunk.reason;
			if (reason?.kind === "error" || reason?.kind === "aborted") failure = reason.failure?.message ?? reason.kind;
		}
	}
	if (failure !== void 0) throw new Error(`模型调用失败：${failure}`);
	return parseNarrative(text);
}
/**
* The route used to summarize.
*
* Prefers the session's own provider/model — the model that did the work is the
* one that can describe it — and falls back to the deployment default when the
* session never recorded a request.
*/
function summaryRoute(facts, services) {
	if (facts.provider !== void 0 && facts.model !== void 0) return {
		provider: facts.provider,
		model: facts.model
	};
	try {
		const fallback = services.agentDefaultModel?.currentSelection();
		return fallback === void 0 ? void 0 : {
			provider: fallback.provider,
			model: fallback.model
		};
	} catch {
		return;
	}
}
//#endregion
export { CONFIG_DEFAULTS, Config, ROUTE_PREFIX, SETTINGS_ENTRY, apply, inject, name, requestNarrative, withDefaults };
