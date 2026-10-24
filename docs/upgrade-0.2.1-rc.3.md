# 适配宿主 0.2.1-rc.3（2026-10-24）

宿主从旧版升到 `0.2.1-rc.3`（`app.asar` 时间 2026-10-23 16:00）。本文件记录核对过的接口、实测结果、唯一一处真实不兼容的修复，以及两次被我自己推翻的错误结论。

## 一、结论

**插件在新版上可用，只有一处需要改。** 已改并推送。其余全部逐项核对为兼容。

## 二、逐项核对（宿主 0.2.1-rc.3 实际代码）

| 插件依赖 | 新版状态 | 证据 |
| --- | --- | --- |
| `Session.snapshotEvents()` / `ownEvents()` | 存在，签名未变，仍标 `@deprecated` | `dsh-session/lib/index.js:1453`、`:1466` |
| `Session.requestContext()` | 存在，返回 `contextWindow` | 实测 `{"provider":"workbuddy-global","model":"deepseek-v4.1-flash-sg","contextWindow":1000000}` |
| `Session.append` 消息校验 | 未变（要求 `id`/`role`/`source.kind`/`content`） | `dsh-session/lib/index.js:1201` |
| `contextPressure` 原始状态 | 字段与 `.strict()` 约束未变 | `dsh-token-meter/lib/index.js:376-386` |
| `projectedTokens` wire 公式 | 未变 | `dsh-token-meter/lib/index.js:493` |
| `agent/pre-step` 载荷 | 仍是 `{messages, ...position, signal}`，且 `agent` 由 `agentEvents.fused` 注入 | `dsh-agent-loop/lib/index.js:910`、`dsh-agent/lib/index.js:244` |
| `{kind:'reject'}` 决策 | 未变 | `dsh-agent-loop/lib/index.js:923` |
| `session/event` 回调参数 | 仍是 `[session, event]` | `dsh-session/lib/index.js:1585` |
| `agent.followup(input)` | 单参数，未变（插件多传的第二参数被忽略，无副作用） | `dsh-agent-loop/lib/index.js:807` |
| `llm/stream` waterfall | 未变 | `dsh-llm/lib/index.js:2398` |
| `workspaceRegistry.archiveSession(id, {stopActivity})` | 未变 | `dsh-workspace/lib/index.js:527` |
| `commands.register({name, description, input.hint, handler})` | 结构未变 | `dsh-commands` `normalizeDefinition` |
| `webServer.register({kind, path, handler})` | 未变 | `dsh-host-webserver` `register` |
| 会话格式版本 | 仍是 4，旧日志无需迁移 | `SESSION_FORMAT_VERSION = 4`，磁盘日志 `version: 4` |
| 客户端 `slots` 服务 | 仍可用；`register(options, component)` 双参数保留 | shell 种子模块表 `"@deepseek-ai/dsh-client-ui-slots": jI` |
| `settings.section` slot | `kind: "list"`，插件用 `id` 注册，与内置 `settings-plugins` 同形 | `dsh-client-ui-settings-general/lib/client.js` |
| `plugins.row.config` slot | `kind: "keyed"`，插件用 `key` 注册，匹配 | `dsh-client-ui-plugin-manager/lib/client.js` |
| loader `insert` patch 语义 | 未变（无 `id` 时顶层插入） | `cordis-plugin-include` `applyPatches` |

## 三、唯一一处真实不兼容：空错误文本

`dsh-commands` 的 `normalizeResult`（`lib/index.js:198`）要求 `error` 结果的 `text` **非空且非纯空白**：

```js
if (typeof result.text !== "string" || result.text.trim().length === 0)
  throw new TypeError(`command "${command}" error text must be a non-empty string`)
```

而插件原来直接返回 `error.message`。`new Error()` 无参数时 `message === ''`，于是：

- 抛错发生在 `commands` 注册表内部，**在 handler 返回之后**；
- 用户看到的是内部命令失败，而不是真实原因。

修复：`src/index.ts` 增加 `errorText()`，空/纯空白时回退为「命令执行失败（未提供原因）」，真实消息原样保留。

**回归用例**：`tests/unit/plugin.spec.ts` 的 `never returns a blank error text, which the host rejects`。
**变异验证**：把 `errorText` 改回直接返回 `message`，该用例立即失败（`expected 0 to be greater than 0`）；还原后 261 项全绿。

## 四、两处被我自己推翻的错误结论（留档，避免重犯）

**① 「`dsh-client-ui-slots` 包被删除，插件客户端会挂」——错误。**

该包确实不在新版 asar 中（`ls` 为 0 项，profile 也无法 `require.resolve`）。但它由**前端 shell 的种子模块表直接提供**：

```js
{"@deepseek-ai/dsh-client-ui-slots": jI, ...}
```

`dsh-web-frontend/dist/assets/index-*.js` 的 `OZ()` 里明确注册。客户端 `require` 只能解析已注册模块，而它已注册，所以插件声明 `inject: ['slots']` 是安全的，无需改动。
`dsh-client-ui-renderer` 里的 `require("@deepseek-ai/dsh-client-ui-slots")` 也是同一机制，不是缺失依赖。

**② 「313/351 个 package.json 损坏，宿主安装包不完整」——错误。**

那是我手写 asar 偏移解析的 bug（尾部对齐算错），把正常文件截断了。用官方 `@electron/asar` 重新解压后：**307 个 package.json 全部可解析，0 个损坏**。
教训：涉及 asar 内容判断时直接用官方工具，不要自己解析头表。

## 五、验证基线

```
npx vitest run                              12 files / 261 tests 全绿（260 → 261）
npx tsc -p tsconfig.json --noEmit           clean
npx tsc -p tsconfig.client.json --noEmit    clean
npm run build                               lib/index.js 117.00 kB / lib/client.js 36.59 kB
node verify.mjs（gate-guard）                ALL CHECKS PASSED（13 项）
```

**端到端实测**（用新版宿主真实 `Session` 还原本机 2201 条事件的会话）：

```
new host Session: session-891322e6-99c1-4abc-92a0-bc23655e6d6a
  snapshotEvents = 2201 | ownEvents = 2201
  requestContext = {"provider":"workbuddy-global","model":"deepseek-v4.1-flash-sg","contextWindow":1000000}
  window from log = 1000000
  occupancy = {"quality":"estimated","used":310000,"window":1000000,"percent":0.31,
               "baseline":"estimated","source":"contextPressure"}

## 会话交接状态
- 阶段：idle
- 上下文占用：310000 / 1000000 tokens · 31% · 估算 · 与输入框一致
- 累计消费：0 tokens（不可用）
- 自动交接阈值：未启用（仅手动）
```

**运行时冒烟**（当前宿主，GUI 9352）：`/dsh-session-handoff/config` 与 `/state` 均返回正常；`/state` 给出真实占用 `315459 / 1000000`（31.5%）、累计 `26881379`（日志投影）。

## 六、升级后插件行的位置变了（不是缺陷）

升级前插件由 `cordis.patch.yml` 的 `- id: dsh-session-handoff` 行加载；升级后该行已不在 patch 里，改由 profile `package.json` 的 `dsh.profile.bundles` 列出：

```
"dsh-session-handoff": "link:D:/Workspace/DeepSeek Harness/dsh-session-handoff"
```

所以 `/config` 返回的是插件自带 `cordis.patch.yml` 的默认值（`autoHandoffEnabled: false`、阈值 85%）。这是升级带来的加载方式变化，插件的配置链路本身正常。
