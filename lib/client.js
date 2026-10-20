window.__ModuleLoader__.load({
	id: "dsh-session-handoff",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/protocol.ts
		/**
		* Shared, React-free contract between the two halves of this plugin.
		*
		* Restating it here (rather than importing host types) keeps the browser bundle
		* free of Node imports and lets a client test build the same objects a host
		* test asserts on.
		*/
		/** Route prefix; must equal `ROUTE_PREFIX` in the host entry. */
		const ROUTE_PREFIX = "/dsh-session-handoff";
		/** Defaults shown before the host answers. */
		const DEFAULT_SETTINGS = {
			autoHandoffEnabled: false,
			autoHandoffTrigger: "context",
			autoHandoffAtContextPercent: 85,
			autoHandoffThreshold: 2e6,
			autoCompactEnabled: false,
			autoCompactAtContextPercent: 70,
			evaluateIntervalMs: 5e3,
			contextRearmDeltaPercent: 10,
			rearmDeltaTokens: 2e5,
			maxAutoActionsPerSession: 3,
			summaryMaxTokens: 4096,
			stepWaitTimeoutMs: 9e5,
			actionDeadlineMs: 18e5,
			openNewSessionOnHandoff: true
		};
		/**
		* The cross-field rule, restated for the browser.
		*
		* The host enforces it on save; the card mirrors it so the reason appears next
		* to the Save button instead of as a rejected write after the fact.
		*/
		function blockingReason(settings) {
			if (settings.autoHandoffEnabled && settings.autoCompactEnabled && settings.autoCompactAtContextPercent >= settings.autoHandoffAtContextPercent) return "压缩阈值必须低于交接阈值，否则压缩刚结束就会立刻触发交接。";
		}
		/** Warnings the card can raise without the host. */
		function localWarnings(settings) {
			const warnings = [];
			if (settings.autoHandoffAtContextPercent < 50) warnings.push("交接阈值偏小，会话可能很早就被交出去。");
			if (settings.evaluateIntervalMs > 6e4) warnings.push("评估间隔超过 1 分钟，上下文可能在这期间撞满窗口。");
			return warnings;
		}
		/** Build a URL for one host route. */
		function routeUrl(base, action) {
			return `${base}${ROUTE_PREFIX}/${action}`;
		}
		//#endregion
		//#region src/client/card.ts
		/**
		* The settings card, rendered in the Settings → Plugins slot.
		*
		* Two design constraints come from the host:
		*
		* 1. **Only theme tokens.** Every colour is a `--dsw-alias-*` variable, with a
		*    literal fallback so an older host still renders rather than disappearing.
		*    There is no `[data-theme]` branch: the host owns light/dark switching.
		* 2. **No host UI primitives.** The bundle is plain React created with
		*    `createElement`; importing a client package would tie this card to one
		*    host build, and a throwing component blanks the whole slot entry. The
		*    controls below are deliberately small and local.
		*
		* ## What it shows
		*
		* The card answers three questions in order: what will happen automatically,
		* what is happening right now, and what can I do. Numbers are labelled with
		* their provenance (`精确` / `估算`) because a heuristic percentage that looks
		* authoritative is worse than one that admits itself.
		*/
		/**
		* `createElement`, typed as producing a node.
		*
		* React's overloads return `ReactElement`, while the small helpers below build
		* subtrees and pass them as children before returning `unknown`. A single
		* widened wrapper keeps those helpers composable without a cast at every call
		* site, and it is still plain React — no host primitives are imported.
		*/
		const h = react.createElement;
		/** The one-line description shown by the row's summary view. */
		const CARD_SUMMARY = "上下文占用率或累计消费达到阈值时，把长会话交接到同工作区的新会话，并迁移 preset、模型、权限与 Plan 模式。";
		const TOKENS = {
			text: "var(--dsw-alias-text-primary, rgba(28,28,30,1))",
			muted: "var(--dsw-alias-text-secondary, rgba(128,128,128,1))",
			border: "var(--dsw-alias-border-subtle, rgba(128,128,128,0.26))",
			panel: "var(--dsw-alias-bg-section, rgba(128,128,128,0.06))",
			accent: "var(--dsw-alias-brand-primary, rgba(31,110,255,1))",
			warn: "var(--dsw-alias-status-warning, rgba(214,140,0,1))",
			danger: "var(--dsw-alias-status-danger, rgba(214,48,49,1))",
			mono: "var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)"
		};
		function HandoffCard(props) {
			const [settings, setSettings] = (0, react.useState)(DEFAULT_SETTINGS);
			const [state, setState] = (0, react.useState)(void 0);
			const [loaded, setLoaded] = (0, react.useState)(false);
			const [saving, setSaving] = (0, react.useState)(false);
			const [saveError, setSaveError] = (0, react.useState)(void 0);
			const [busyAction, setBusyAction] = (0, react.useState)(void 0);
			const getSettings = props.getSettings;
			const saveSettingsProp = props.saveSettings;
			if (props.view === "summary") return h("span", { style: {
				color: TOKENS.muted,
				fontSize: "12.5px"
			} }, CARD_SUMMARY);
			(0, react.useEffect)(() => {
				let alive = true;
				Promise.resolve().then(() => getSettings?.()).then((value) => {
					if (alive && value !== void 0) setSettings({
						...DEFAULT_SETTINGS,
						...value
					});
				}).catch(() => {}).finally(() => {
					if (alive) setLoaded(true);
				});
				return () => {
					alive = false;
				};
			}, [getSettings]);
			(0, react.useEffect)(() => {
				const sessionId = props.sessionId;
				if (sessionId === void 0) return;
				let alive = true;
				let timer;
				const poll = async () => {
					try {
						const base = props.origin ?? "";
						const response = await fetch(`${routeUrl(base, "state")}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: "application/json" } });
						if (response.ok) {
							const payload = await response.json();
							if (alive) setState(payload);
						}
					} catch {} finally {
						if (alive) timer = setTimeout(() => void poll(), 2e3);
					}
				};
				poll();
				return () => {
					alive = false;
					if (timer !== void 0) clearTimeout(timer);
				};
			}, [props.sessionId, props.origin]);
			const patch = (0, react.useCallback)((next) => {
				setSettings((current) => ({
					...current,
					...next
				}));
				setSaveError(void 0);
			}, []);
			const blocking = (0, react.useMemo)(() => blockingReason(settings), [settings]);
			const warnings = (0, react.useMemo)(() => {
				const all = [...localWarnings(settings), ...state?.warnings ?? []];
				return [...new Set(all)];
			}, [settings, state]);
			const save = (0, react.useCallback)(async () => {
				if (blocking !== void 0) {
					setSaveError(blocking);
					return;
				}
				setSaving(true);
				setSaveError(void 0);
				try {
					await saveSettingsProp?.(settings);
				} catch (error) {
					setSaveError(error instanceof Error ? error.message : String(error));
				} finally {
					setSaving(false);
				}
			}, [
				blocking,
				saveSettingsProp,
				settings
			]);
			const act = (0, react.useCallback)(async (action) => {
				const sessionId = props.sessionId;
				if (sessionId === void 0) return;
				setBusyAction(action);
				try {
					const base = props.origin ?? "";
					const payload = await (await fetch(routeUrl(base, action), {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId })
					})).json();
					if (payload.ok !== true) setSaveError(payload.error ?? "操作未成功");
				} catch (error) {
					setSaveError(error instanceof Error ? error.message : String(error));
				} finally {
					setBusyAction(void 0);
				}
			}, [props.origin, props.sessionId]);
			const percent = settings.autoHandoffAtContextPercent;
			const disabled = !loaded || saving;
			return h("div", {
				"data-dsh-plugin": "dsh-session-handoff",
				"data-dsh-surface": "settings-modal",
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "14px",
					color: TOKENS.text,
					fontSize: "13px"
				}
			}, row("自动交接", h("label", { style: {
				display: "flex",
				alignItems: "center",
				gap: "8px"
			} }, [h("input", {
				key: "toggle",
				type: "checkbox",
				role: "switch",
				"aria-checked": settings.autoHandoffEnabled ? "true" : "false",
				"data-dsh-field": "autoHandoffEnabled",
				checked: settings.autoHandoffEnabled,
				disabled,
				onChange: (event) => patch({ autoHandoffEnabled: event.target.checked })
			}), h("span", {
				key: "label",
				style: { color: TOKENS.muted }
			}, settings.autoHandoffEnabled ? "已开启" : "仅手动 /handoff")]), "关闭时不会自动做任何事；/handoff 命令始终可用。"), row("触发方式", h("div", { style: {
				display: "flex",
				gap: "12px",
				flexWrap: "wrap"
			} }, [
				["context", "上下文占用率"],
				["cumulative", "累计消费"],
				["either", "两者任一"]
			].map(([value, label]) => h("label", {
				key: value,
				style: {
					display: "flex",
					alignItems: "center",
					gap: "4px"
				}
			}, h("input", {
				type: "radio",
				name: "handoff-trigger",
				value,
				"data-dsh-field": "autoHandoffTrigger",
				checked: settings.autoHandoffTrigger === value,
				disabled,
				onChange: () => patch({ autoHandoffTrigger: value })
			}), h("span", { key: "t" }, label)))), "占用率 = 当前上下文 token ÷ 模型上下文窗口。"), row("上下文占用达到", h("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: "10px"
			} }, h("input", {
				type: "range",
				min: 1,
				max: 100,
				step: 1,
				value: percent,
				disabled: disabled || !triggerUses(settings, "context"),
				"data-dsh-field": "autoHandoffAtContextPercent",
				style: {
					flex: "1",
					accentColor: TOKENS.accent
				},
				onChange: (event) => patch({ autoHandoffAtContextPercent: clamp(Number(event.target.value), 1, 100) })
			}), h("span", {
				key: "value",
				style: {
					fontFamily: TOKENS.mono,
					minWidth: "46px",
					textAlign: "right"
				}
			}, `${percent}%`)), "交接触发点。默认 85%，留出余量给当前步骤收尾。"), row("累计消费达到", h("input", {
				type: "number",
				min: 0,
				step: 1e4,
				value: settings.autoHandoffThreshold,
				disabled: disabled || !triggerUses(settings, "cumulative"),
				"data-dsh-field": "autoHandoffThreshold",
				style: inputStyle(),
				onChange: (event) => patch({ autoHandoffThreshold: clamp(Number(event.target.value), 0, Number.MAX_SAFE_INTEGER) })
			}), "以 token 计；只在触发方式包含「累计消费」时生效。"), row("自动压缩", h("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: "10px"
			} }, [
				h("input", {
					key: "switch",
					type: "checkbox",
					role: "switch",
					"aria-checked": settings.autoCompactEnabled ? "true" : "false",
					"data-dsh-field": "autoCompactEnabled",
					checked: settings.autoCompactEnabled,
					disabled,
					onChange: (event) => patch({ autoCompactEnabled: event.target.checked })
				}),
				h("span", { key: "label" }, "达到"),
				h("input", {
					key: "percent",
					type: "number",
					min: 1,
					max: 99,
					value: settings.autoCompactAtContextPercent,
					disabled: disabled || !settings.autoCompactEnabled,
					"data-dsh-field": "autoCompactAtContextPercent",
					style: {
						...inputStyle(),
						width: "72px"
					},
					onChange: (event) => patch({ autoCompactAtContextPercent: clamp(Number(event.target.value), 1, 99) })
				}),
				h("span", { key: "pct" }, "% 时原地压缩")
			]), "压缩先把上下文腾出来继续在原会话做；必须低于交接阈值。"), h(Advanced, {
				settings,
				patch,
				disabled
			}), h(StatusPanel, {
				state,
				settings,
				hasSession: props.sessionId !== void 0
			}), h("div", { style: {
				display: "flex",
				gap: "8px",
				flexWrap: "wrap",
				alignItems: "center"
			} }, [
				button("立即迁移", () => void act("handoff"), busyAction === "handoff" || props.sessionId === void 0),
				button("取消", () => void act("cancel"), busyAction === "cancel" || props.sessionId === void 0),
				button("重试", () => void act("retry"), busyAction === "retry" || props.sessionId === void 0),
				h("span", {
					key: "spacer",
					style: { flex: "1" }
				}),
				button("保存设置", () => void save(), disabled || blocking !== void 0, true)
			]), blocking === void 0 ? null : notice(blocking, "danger"), saveError === void 0 ? null : notice(saveError, "danger"), ...warnings.map((warning) => notice(warning, "warn")), settings.autoHandoffTrigger !== "cumulative" && state?.occupancy.window === void 0 ? notice("当前模型没有上报上下文窗口，占用率触发不会生效；仍可用累计消费或手动 /handoff。", "warn") : null);
		}
		/** The collapsible advanced block. */
		function Advanced(input) {
			const [open, setOpen] = (0, react.useState)(false);
			return h("div", null, h("button", {
				type: "button",
				onClick: () => setOpen((value) => !value),
				style: linkButtonStyle(),
				"data-dsh-part": "advanced-toggle"
			}, open ? "▾ 高级设置" : "▸ 高级设置"), open ? h("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				marginTop: "8px"
			} }, ...[
				[
					"evaluateIntervalMs",
					"评估间隔（毫秒）",
					"两次测量之间的最短间隔",
					1e3,
					6e4
				],
				[
					"contextRearmDeltaPercent",
					"占用率滞回（百分点）",
					"动作后需回落这么多才重新武装",
					0,
					50
				],
				[
					"rearmDeltaTokens",
					"累计重臂（token）",
					"累计触发后需再增长这么多",
					0,
					1e7
				],
				[
					"maxAutoActionsPerSession",
					"单会话动作上限",
					"交接与压缩共享计数",
					1,
					10
				],
				[
					"summaryMaxTokens",
					"简报输出上限",
					"摘要模型单次输出预算",
					256,
					32768
				],
				[
					"stepWaitTimeoutMs",
					"等待边界超时（毫秒）",
					"只提示，不中断",
					1e3,
					36e5
				],
				[
					"actionDeadlineMs",
					"动作总时限（毫秒）",
					"到期释放闩锁并标记失败",
					1e3,
					72e5
				]
			].map(([field, label, hint, min, max]) => row(label, h("input", {
				type: "number",
				min,
				max,
				value: input.settings[field],
				disabled: input.disabled,
				"data-dsh-field": field,
				style: inputStyle(),
				onChange: (event) => input.patch({ [field]: clamp(Number(event.target.value), min, max) })
			}), hint)), row("迁移后自动跳转", h("input", {
				type: "checkbox",
				role: "switch",
				"aria-checked": input.settings.openNewSessionOnHandoff ? "true" : "false",
				"data-dsh-field": "openNewSessionOnHandoff",
				checked: input.settings.openNewSessionOnHandoff,
				disabled: input.disabled,
				onChange: (event) => input.patch({ openNewSessionOnHandoff: event.target.checked })
			}), "交接完成后浏览器切到新会话。")) : null);
		}
		/** The live status block: two meters plus the phase line. */
		function StatusPanel(input) {
			const state = input.state;
			if (state === void 0) return h("div", { style: {
				color: TOKENS.muted,
				fontSize: "12px",
				lineHeight: 1.5
			} }, input.hasSession ? "状态通道不可用（未能读取会话状态）。表单仍可编辑与保存。" : "当前没有打开中的会话，因此没有实时占用率可显示。设置以插件配置为准，保存后对所有会话生效。");
			const percent = state.occupancy.percent === void 0 ? void 0 : Math.round(state.occupancy.percent * 100);
			const quality = state.occupancy.quality === "exact" ? "精确" : state.occupancy.quality === "estimated" ? "估算" : "不可用";
			const meterColor = percent === void 0 ? TOKENS.muted : percent >= state.thresholds.handoffPercent ? TOKENS.danger : percent >= Math.max(50, state.thresholds.handoffPercent - 15) ? TOKENS.warn : TOKENS.accent;
			const cumulativeRatio = state.thresholds.cumulative > 0 ? Math.min(1, state.cumulative.tokens / state.thresholds.cumulative) : 0;
			return h("div", {
				"data-dsh-part": "status",
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "8px",
					padding: "10px",
					borderRadius: "8px",
					background: TOKENS.panel,
					border: `1px solid ${TOKENS.border}`
				}
			}, h("div", { style: {
				display: "flex",
				justifyContent: "space-between",
				fontSize: "12px"
			} }, h("span", {
				key: "title",
				style: { fontWeight: 600 }
			}, "状态"), h("span", {
				key: "phase",
				style: {
					color: TOKENS.muted,
					fontFamily: TOKENS.mono
				}
			}, `${state.phase}${state.busy ? " · 进行中" : ""}${state.latched ? " · 已设闩锁" : ""}`)), meter("上下文占用", percent === void 0 ? "窗口未知" : `${percent}%`, `${formatTokens(state.occupancy.used)}${state.occupancy.window === void 0 ? "" : ` / ${formatTokens(state.occupancy.window)}`} · ${quality}`, percent === void 0 ? 0 : Math.min(100, percent), meterColor), meter("累计消费", formatTokens(state.cumulative.tokens), state.thresholds.enabled ? `阈值 ${formatTokens(state.thresholds.cumulative)}` : "阈值未启用", cumulativeRatio * 100, TOKENS.accent), h("div", { style: {
				fontSize: "12px",
				color: TOKENS.muted
			} }, `自动动作 ${state.autoActions}/${state.maxAutoActions}${state.lastText === void 0 ? "" : ` · 最近：${firstLine(state.lastText)}`}`), state.lastFailure === void 0 ? null : h("div", { style: {
				fontSize: "12px",
				color: TOKENS.danger
			} }, `最近失败：${firstLine(state.lastFailure)}`), state.persistence === "memory" ? h("div", { style: {
				fontSize: "12px",
				color: TOKENS.warn
			} }, "设置只在本次进程内有效。") : null);
		}
		function triggerUses(settings, mode) {
			if (mode === "context") return settings.autoHandoffTrigger !== "cumulative";
			return settings.autoHandoffTrigger !== "context";
		}
		function row(label, control, hint) {
			return h("div", {
				"data-dsh-part": "field",
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "4px"
				}
			}, h("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: "10px",
				flexWrap: "wrap"
			} }, h("span", {
				key: "label",
				style: {
					minWidth: "132px",
					color: TOKENS.text
				}
			}, label), control), hint === void 0 ? null : h("div", { style: {
				fontSize: "11.5px",
				color: TOKENS.muted
			} }, hint));
		}
		function meter(label, value, detail, percent, color) {
			return h("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: "3px"
			} }, h("div", { style: {
				display: "flex",
				justifyContent: "space-between",
				fontSize: "12px"
			} }, h("span", {
				key: "l",
				style: { color: TOKENS.muted }
			}, label), h("span", {
				key: "v",
				style: { fontFamily: TOKENS.mono }
			}, value)), h("div", { style: {
				height: "6px",
				borderRadius: "999px",
				background: TOKENS.border,
				overflow: "hidden"
			} }, h("div", { style: {
				width: `${Math.max(0, Math.min(100, percent))}%`,
				height: "100%",
				background: color,
				transition: "width 200ms ease"
			} })), h("div", { style: {
				fontSize: "11.5px",
				color: TOKENS.muted
			} }, detail));
		}
		function button(label, onClick, disabled, primary = false) {
			return h("button", {
				type: "button",
				key: label,
				onClick,
				disabled,
				style: {
					padding: "5px 12px",
					borderRadius: "6px",
					border: `1px solid ${primary ? TOKENS.accent : TOKENS.border}`,
					background: primary ? TOKENS.accent : "transparent",
					color: primary ? "#fff" : TOKENS.text,
					cursor: disabled ? "not-allowed" : "pointer",
					opacity: disabled ? .5 : 1,
					fontSize: "12.5px"
				}
			}, label);
		}
		function notice(text, tone) {
			return h("div", { style: {
				fontSize: "12px",
				color: tone === "danger" ? TOKENS.danger : TOKENS.warn,
				lineHeight: 1.45
			} }, `${tone === "danger" ? "✕" : "⚠"} ${text}`);
		}
		function inputStyle() {
			return {
				padding: "4px 8px",
				borderRadius: "6px",
				border: `1px solid ${TOKENS.border}`,
				background: "transparent",
				color: TOKENS.text,
				fontFamily: TOKENS.mono,
				fontSize: "12.5px",
				width: "140px"
			};
		}
		function linkButtonStyle() {
			return {
				border: "none",
				background: "transparent",
				color: TOKENS.accent,
				cursor: "pointer",
				padding: "0",
				fontSize: "12.5px"
			};
		}
		function clamp(value, min, max) {
			if (!Number.isFinite(value)) return min;
			return Math.max(min, Math.min(max, Math.round(value)));
		}
		function formatTokens(value) {
			if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
			if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
			return String(value);
		}
		function firstLine(text) {
			const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
			return line.length > 90 ? `${line.slice(0, 90)}…` : line;
		}
		/** How often to poll, in milliseconds. */
		const FOLLOW_INTERVAL_MS = 2e3;
		/**
		* One follower per page.
		*
		* `start()` returns a disposer; the plugin's client `apply()` holds it so an
		* unload stops the polling.
		*/
		var HandoffFollower = class {
			deps;
			/** The last newSessionId seen per source session, for the baseline rule. */
			seen = /* @__PURE__ */ new Map();
			attempts = /* @__PURE__ */ new Map();
			switchedFor = /* @__PURE__ */ new Set();
			handle;
			disposed = false;
			constructor(deps) {
				this.deps = deps;
			}
			/** Begin polling. Returns the disposer. */
			start() {
				const interval = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
				this.handle = interval(() => {
					this.tick();
				}, FOLLOW_INTERVAL_MS);
				return () => this.stop();
			}
			/** Stop polling. */
			stop() {
				if (this.disposed) return;
				this.disposed = true;
				const clear = this.deps.clearInterval ?? ((h) => clearInterval(h));
				if (this.handle !== void 0) clear(this.handle);
			}
			/** One poll. Exposed so tests can drive it without timers. */
			async tick() {
				if (this.disposed) return;
				if (!this.deps.enabled()) return;
				const sessionId = this.deps.currentSessionId();
				if (sessionId === void 0) return;
				const state = await this.deps.fetchState(sessionId);
				const next = state?.newSessionId;
				if (!this.seen.has(sessionId)) {
					this.seen.set(sessionId, next);
					if (next !== void 0) this.deps.log?.(`handoff: 会话 ${sessionId} 已在 ${next}，只记录不跳转`);
					return;
				}
				const previous = this.seen.get(sessionId);
				this.seen.set(sessionId, next);
				if (previous !== void 0 || next === void 0) return;
				if (this.switchedFor.has(sessionId)) return;
				await this.switchTo(next, state);
			}
			async switchTo(newSessionId, state) {
				const sessionId = state?.sessionId ?? "<unknown>";
				const attempts = (this.attempts.get(sessionId) ?? 0) + 1;
				this.attempts.set(sessionId, attempts);
				if (attempts > 12) {
					this.deps.log?.(`handoff: 新会话 ${newSessionId} 在 12 次尝试后仍未就绪，停止跳转`);
					return;
				}
				const sessions = this.deps.sessions;
				if (sessions === void 0) return;
				try {
					await sessions.refresh?.();
				} catch {}
				const row = sessions.list?.getSnapshot?.().byId?.[newSessionId];
				if (row === void 0) {
					this.deps.log?.(`handoff: 新会话 ${newSessionId} 尚未出现在列表中（第 ${attempts} 次）`);
					return;
				}
				if (row.blank === true) {
					this.deps.log?.(`handoff: 新会话 ${newSessionId} 仍是空白行（第 ${attempts} 次）`);
					return;
				}
				sessions.open?.(newSessionId);
				this.switchedFor.add(sessionId);
				this.deps.log?.(`handoff: 已切换到新会话 ${newSessionId}`);
			}
			/** Drop bookkeeping for a session that no longer matters. */
			forget(sessionId) {
				this.seen.delete(sessionId);
				this.attempts.delete(sessionId);
				this.switchedFor.delete(sessionId);
			}
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name; equals the package name in package.json. */
		const name = "dsh-session-handoff-client";
		/**
		* Client services this half declares.
		*
		* Only `slots` is a hard requirement: without the slot registry there is no
		* card, and the follower alone is not worth activating for. Everything else is
		* read with `ctx.get(...)` instead, because a declared service that this
		* composition does not publish keeps the **whole bundle** dormant — the card
		* and the follower both silently disappear.
		*
		* The name is `configForms`, not `forms`: the Client service directory lists
		* `layout`, `locale`, `sessions`, `slots`, `theme`, `timer`, `uiWorkspace`,
		* `workspaces` — and `configForms` is the settings-mirror service the shipped
		* consumers reach through `ctx.get`. Assuming `forms` would have been a silent
		* total failure.
		*/
		const inject = ["slots"];
		/** Keyed slot that renders one plugin row's configuration page. */
		const CARD_SLOT = "plugins.row.config";
		/**
		* List slot that renders one page in the Settings navigation.
		*
		* This is the seat a user expects: Settings → 会话交接, next to General and
		* Models. The plugin-row cell above is only reachable through a plugin's own
		* detail page, which is not where someone adjusts a threshold.
		*/
		const SECTION_SLOT = "settings.section";
		/** Section id; must be unique across the Settings nav. */
		const SECTION_ID = "dsh-session-handoff";
		/** Position in the nav, after Plugins (15) and before the market (40). */
		const SECTION_ORDER = 18;
		/** Nav label. A thunk so a localized string can be swapped without re-registering. */
		const SECTION_LABEL = () => "会话交接";
		/**
		* Cell keys this card answers on.
		*
		* A bundle installed into a profile gets the entry id `include:<row id>`; a row
		* declared directly in a composition keeps `<row id>`. The slot is keyed by
		* `<package name>#<entry id>`, so both spellings are registered.
		*/
		const CARD_KEY = "dsh-session-handoff#dsh-session-handoff";
		/** Key used when the loader assigned the row the `include:`-prefixed id. */
		const BUNDLE_CARD_KEY = "dsh-session-handoff#include:dsh-session-handoff";
		/** Key used when the row id is the bare patch id. */
		const ROW_CARD_KEY = "dsh-session-handoff#dsh-session-handoff";
		/** Settings namespace: the profile entry id the row established. */
		const SETTINGS_ENTRY = "dsh-session-handoff";
		/**
		* Settings namespaces worth probing.
		*
		* The settings mirror is keyed by the same entry id as the row, so a bundle
		* install exposes BOTH `include:dsh-session-handoff` and the bare id depending
		* on the host build. Reading only one leaves the form permanently empty.
		*/
		const SETTINGS_ENTRIES = ["include:dsh-session-handoff", "dsh-session-handoff"];
		/**
		* Adapt the Client session service to the follower's needs.
		*
		* The follower only uses `list.getSnapshot()` for `current`/`byId`, plus
		* `refresh()` and `open()`. On a Client whose service exposes a different
		* surface those are absent, and the follower simply never finds a session to
		* follow — it degrades to "no jump" instead of throwing.
		*/
		function toFollowSessions(service) {
			if (service === void 0) return void 0;
			return {
				...service.list === void 0 ? {} : { list: service.list },
				...service.refresh === void 0 ? {} : { refresh: service.refresh },
				...service.open === void 0 ? {} : { open: service.open }
			};
		}
		/** Run a contribution, degrading to a console error instead of blanking the UI. */
		function guard(label, run) {
			try {
				return run();
			} catch (error) {
				console.error(`[dsh-session-handoff] ${label} 注册失败：`, error);
				return;
			}
		}
		/** The current session id from the live session list. */
		function currentSessionId(sessions) {
			try {
				return sessions?.list?.getSnapshot?.().current;
			} catch {
				return;
			}
		}
		/** Fetch one session's status snapshot; `undefined` on any failure. */
		async function fetchState(sessionId) {
			try {
				const response = await fetch(`/dsh-session-handoff/state?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: "application/json" } });
				if (!response.ok) return void 0;
				return await response.json();
			} catch {
				return;
			}
		}
		/** Wire the browser half. */
		function apply(ctx) {
			const runtime = ctx;
			/**
			* Read a Client service without declaring it.
			*
			* `ctx.get` never throws for an unpublished service; it returns `undefined`.
			* That is what keeps this bundle active on a composition that lacks the
			* settings mirror.
			*/
			function softGet(serviceName) {
				try {
					return ctx.get(serviceName);
				} catch {
					return;
				}
			}
			const configForms = softGet("configForms");
			softGet("sessions");
			/**
			* Bind the settings mirror.
			*
			* The mirror is keyed by the loader's entry id, and a profile-installed bundle
			* is keyed `include:<row id>`. Guessing the spelling is what produced
			* "宿主的设置表单未就绪，无法保存": the scope stayed `undefined`, so every save
			* threw.
			*
			* `whileServed` is the host's own idiom: its callback receives the set of
			* namespaces actually served, which is live data rather than a captured guess,
			* and it re-runs when the mirror arrives — so a binding made before the mirror
			* populated still ends up correct. Preferring the bare id keeps the same order
			* the shipped consumers use.
			*/
			const SETTINGS_CANDIDATES = ["dsh-session-handoff", "include:dsh-session-handoff"];
			let settingsScope;
			function resolveFrom(served) {
				const namespaces = served === void 0 ? SETTINGS_CANDIDATES : SETTINGS_CANDIDATES;
				for (const ns of namespaces) {
					if (served !== void 0 && !served.has(ns)) continue;
					try {
						const scope = configForms?.get?.(ns);
						if (scope !== void 0) return scope;
					} catch {}
				}
			}
			const bindMirror = () => {
				if (configForms?.whileServed === void 0) {
					settingsScope = resolveFrom(void 0);
					return;
				}
				try {
					configForms.whileServed([...SETTINGS_CANDIDATES], (served) => {
						settingsScope = resolveFrom(served);
						return () => {
							settingsScope = void 0;
						};
					});
				} catch (error) {
					console.error("[dsh-session-handoff] 设置镜像绑定失败：", error);
					settingsScope = resolveFrom(void 0);
				}
			};
			bindMirror();
			const sessionsForFollow = toFollowSessions(softGet("sessions"));
			const stopFollowing = new HandoffFollower({
				sessions: sessionsForFollow,
				fetchState,
				currentSessionId: () => currentSessionId(sessionsForFollow),
				enabled: () => true,
				log: (message) => console.info(`[dsh-session-handoff] ${message}`)
			}).start();
			const readSettings = () => {
				try {
					const value = (settingsScope?.getSnapshot?.())?.value;
					return value === void 0 ? void 0 : value;
				} catch {
					return;
				}
			};
			/**
			* Persist the form.
			*
			* Re-resolves the scope at call time: the mirror can populate after this half
			* activates, so a scope captured at startup may be stale by the time the user
			* presses Save. Failing that, the message names the namespaces tried, because
			* "表单未就绪" alone gives a user nothing to act on.
			*/
			const saveSettings = async (next) => {
				if (settingsScope?.set === void 0) settingsScope = resolveFrom(void 0);
				if (settingsScope?.set === void 0) throw new Error(`宿主的设置表单未就绪，无法保存（已尝试 ${SETTINGS_CANDIDATES.join(" / ")}）。若刚安装插件，请重启 dsh 后重试。`);
				await settingsScope.set(next);
			};
			const cardInject = () => ({
				getSettings: readSettings,
				saveSettings,
				sessionId: currentSessionId(sessionsForFollow)
			});
			const registerSection = () => {
				const slots = runtime.slots;
				if (slots?.register === void 0) return void 0;
				return slots.register({
					name: SECTION_SLOT,
					id: SECTION_ID,
					order: 18,
					label: SECTION_LABEL,
					inject: cardInject
				}, HandoffCard);
			};
			guard("slots/settings.section", () => {
				const slots = runtime.slots;
				if (slots?.inject === void 0) return registerSection();
				return slots.inject(SECTION_SLOT, () => registerSection());
			});
			const registerCard = (key) => {
				const slots = runtime.slots;
				if (slots?.register === void 0) return void 0;
				return slots.register({
					name: CARD_SLOT,
					key,
					priority: 30,
					inject: cardInject
				}, HandoffCard);
			};
			const CARD_KEYS = [BUNDLE_CARD_KEY, ROW_CARD_KEY];
			guard("slots/plugins.row.config", () => {
				const slots = runtime.slots;
				const registerAll = () => CARD_KEYS.map((key) => registerCard(key));
				if (slots?.inject === void 0) return registerAll();
				return slots.inject(CARD_SLOT, () => registerAll());
			});
			runtime.effect?.(() => () => {
				stopFollowing();
			});
		}
		//#endregion
		exports.BUNDLE_CARD_KEY = BUNDLE_CARD_KEY;
		exports.CARD_KEY = CARD_KEY;
		exports.CARD_SLOT = CARD_SLOT;
		exports.ROW_CARD_KEY = ROW_CARD_KEY;
		exports.SECTION_ID = SECTION_ID;
		exports.SECTION_LABEL = SECTION_LABEL;
		exports.SECTION_ORDER = SECTION_ORDER;
		exports.SECTION_SLOT = SECTION_SLOT;
		exports.SETTINGS_ENTRIES = SETTINGS_ENTRIES;
		exports.SETTINGS_ENTRY = SETTINGS_ENTRY;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
