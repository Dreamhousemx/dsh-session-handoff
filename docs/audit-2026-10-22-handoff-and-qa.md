# dsh-session-handoff 缺陷清单与交接行为答疑

> 生成时间：2026-10-22T14:20+08:00
> 复查基线：仓库 `D:\Workspace\DeepSeek Harness\dsh-session-handoff`，HEAD = `f0927f8`
> 工作树状态：干净（`git status --porcelain` 无输出）
> 测试状态：`npx vitest run` → 12 个文件 / 209 个用例 **全部通过**
> 宿主源码依据：`D:\Dev Tools\DeepSeek Harness\resources\app.asar\dsh\`（解包镜像 `D:\Workspace\DeepSeek Harness\.dsh-src\dsh\node_modules\@deepseek-ai\`）

## 状态标记约定

| 标记 | 含义 |
| --- | --- |
| ✅ 已修复 | 当前 HEAD 已改正，并附提交号与改动位置 |
| ❌ 未修复 | 代码仍是缺陷状态，附证据行号 |
| ⚠️ 部分修复 | 主路径已改，仍有残留分支 |
| ℹ️ 设计取舍 | 行为符合当前设计，但代价需要知情 |

---

## 一、三个问题的答复

### Q1. 像截图那样「需要我改吗？」的 AI 回复，需要用户批准吗？

**结论：那一条不需要——它已经改完了。**

截图描述的内容（「插件用 `surfaceTokens` 却标注 `estimated`，界面用真实 usage 反而更准」「正确改法是优先取 `contextPressure` 投影的 `projectedTokens ?? pressureTokens`」「这样 `/handoff status` 会显示 27%」）对应的正是提交 `f0927f8`：

```
fix: read context occupancy from the same projection the composer uses
```

落地位置：

- `src/measure.ts` 新增 `readPressureProjection()`，先读 `contextPressure` 投影；`pressureTokens` 单独存在时标 `usage`（→ `exact`），叠加 `projectedTokens` 后降级为 `estimated`。
- `ContextOccupancy` 新增 `source?: 'contextPressure' | 'meter-surface' | 'none'`；旧的 `tokenMeter.measure().surfaceTokens` 降级为回退路径。
- 三个调用点均传入 `sessionProjections`：`src/index.ts:179`、`src/index.ts:418`、`src/monitor.ts:112`、`src/monitor.ts:264`、`src/trigger.ts:130`。
- 补充 113 行 `tests/unit/measure.spec.ts`，把 27-vs-32 的分歧钉成回归用例。

所以：**这类「需要我改吗」是 AI 在等你点头，不是你必须动手。** 判断标准是看它是否已经在代码里落地——用一条 `git log --oneline -1` 就能确认。若未落地，你回复「改」即可；若已落地（如本项），回复「已知悉」就够了。本次复查中，除 D 项外其余缺陷都**尚未**得到「是否要改」的授权，仍等你决定。

### Q2. 这种内容传递到新会话是什么内容？

**传过去的不是对话原文，而是一份「九段式简报」。** 新会话看不到旧会话的任何原始聊天记录，它只收到一条 `plugin:dsh-session-handoff` 来源的消息，结构固定（`src/session-summary.ts`）：

```
# 会话交接简报
> 你接手的是同一工作区里另一个会话的中途任务……
**开工前先做两件事，把结果原样报告给用户：**
1. 把本简报的「总体目标」「已完成」「下一步」三节原文打印出来……
2. 复查本插件（`dsh-session-handoff/`）……

## 会话事实          ← 程序读取，模型不得改写
- 工作目录 / Agent preset / 模型 / 权限预设 / Plan 模式
- 上下文占用 / 累计消费 / 已完成 turn / 原会话 / 生成时间

## 总体目标   ## 约束     ## 已完成
## 当前进度   ## 已改文件 ## 关键决策
## 已知问题   ## 未完成   ## 下一步

## 交接附注          ← 脱敏报告
```

两点关键：

1. **截图里那句「需要我改吗？」本身不会原样出现。** 它只可能以两种形式残留：模型自己写进「当前进度 / 下一步」的摘要（例如「下一步：等用户确认是否调整 measure.ts」），或者经 `renderTranscript()` 截断后作为 `[用户] …` 行出现在简报的一小段上下文里（尾部 24000 字符，工具输出压到 240 字符）。
2. **会话事实块由程序写入，模型无法篡改**；九段正文才是模型写的。

### Q3. 新会话会接着执行修改吗？

**会倾向接着做，默认不会等你。** 这是当前设计的固有行为，也是最需要注意的一点：

- 简报开头是固定指令：「请先读完整份简报，再从「下一步」继续；不要重复「已完成」里已经做完的事。」
- 交付走 `agent.followup(...)`（`src/session-migration.ts:549`），这是一条**会唤醒新会话**的消息，新会话收到后立刻开局并照「下一步」行动。
- 因此如果「下一步」写的是「改 `measure.ts`」，新会话**可能直接改**；如果写的是「等用户确认」，它会先问你。

也就是说：**交接是否等你确认，完全取决于简报「下一步」那一段怎么写，而不是取决于机制。** 想让新会话先确认，就得在旧会话里把这一步写成显式待确认项（例如在「下一步」里加「★ 需用户确认后再落盘」）。这一点建议纳入使用规范；是否要在固定模板里强制加一条「不改动用户未授权的文件」属于设计决策，见清单 I-1。

### Q4. 阈值 40%，对话前 38%，AI 回答后超过 40% 会自动交接吗？

**会触发，但不是「立刻切换」；而且在你当前的 profile 里它根本不会触发，因为自动交接是关着的。**

先说配置现状（`$DSH_PROFILE_DIR/cordis.patch.yml:805-822`）：

```yaml
- id: dsh-session-handoff
  config:
    autoHandoffEnabled: false          # ← 关着
    autoHandoffTrigger: context
    autoHandoffAtContextPercent: 40    # ← 阈值确实是 40
    archiveSourceAfterHandoff: false
```

阈值 40 已设置，但 `autoHandoffEnabled: false`，所以**当前不会自动交接**，只能手动 `/handoff`。下面按「已经打开自动交接」来回答。

**判定链**（`src/trigger.ts` `evaluate()`，逐条）：

| 顺序 | 守卫 | 你的场景 |
| --- | --- | --- |
| 1 | `autoHandoffEnabled` 且 trigger 含 `context` | 需打开 |
| 2 | `state.pending === false` | 无进行中动作 |
| 3 | `seq > lastEvaluatedSeq` | 新事件才判定 |
| 4 | `now - lastEvaluatedAt >= evaluateIntervalMs`（默认 5000ms） | 5 秒防抖 |
| 5 | `baselineEstablished === true` | **首次观测只记录不动作** |
| 6 | `autoActions < maxAutoActionsPerSession`（默认 3） | 每会话最多 3 次 |
| 7 | `contextRearmBelow === undefined` | 上次交接后需跌破 阈值−10 才重新武装 |
| 8 | `percent >= 40` | 命中即返回 handoff 决策 |

**触发点是 `assistant/message`**（`src/monitor.ts:45` 的 `SURFACE_EVENTS` 含 `user/message`、`assistant/message`、`tool/result`）。所以 AI 的回答一落地，就会评估一次。

**38% → 超过 40% 会不会越过？** 会。判定读的是「下一次请求的预测量」：`projectedTokens = pressureTokens（上次请求的真实 prompt 大小）+ 之后的 surface 增量`，这次回答的 token 就在增量里。所以回答落地这一刻算出的百分比确实可能从 38% 跳到 40% 以上。

**但触发 ≠ 切换。** 真实时序是：

1. `latches.arm(sessionId)` —— 只是**拒绝下一个 step**，不打断当前 step。当前 step 里已经在跑的工具调用会跑完。
2. `waitForBoundary(agent, stepWaitMs)` —— 等 `agent.whenIdle()`，默认上限 `stepWaitTimeoutMs = 900s`。超时即判定失败，释放闩锁，原会话继续。
3. `summarize()` —— **额外一次模型调用**（`summaryMaxTokens = 4096`）写九段简报。
4. `migrateSession()` —— 建新会话、继承 cwd/preset/模型/权限/Plan 模式、投递简报。
5. `retire()` —— 按 `archiveSourceAfterHandoff` 决定是否归档旧会话（你当前是 `false`，即不归档）。
6. 默认 `openNewSessionOnHandoff: true`，浏览器跟到新会话。

**注意事项：**

- 若在 `preparing` / `waiting-for-step-boundary` / `summarizing` 阶段出现人类输入，交接会**中止**，旧会话继续（`ABORTABLE_BEFORE_NEW_SESSION`）。所以交接在等你输入时是安全的。
- 回答之后若还跟着工具调用（agentic loop），那些工具仍会执行，上下文可能继续上涨——判定发生在回答落地那一刻，用的是那一刻的值。
- 交接本身要花一次模型调用；若失败又撞上缺陷 B（见下），会反复重试。
- 差 1–2 个百分点就触发的场景，交接收益很低（简报成本可能大于省下的上下文），这也是 `settings.ts` 对阈值 < 20% 给警告、而对 40% 视为合理值的原因。

---

## 二、缺陷清单（逐条状态）

> 状态更新于 2026-10-22T18:45+08:00：A、B、C、D、E、F、G、H1、H2、I-1 **全部修复并提交**。
> 测试基线：209 → **248 passed**；两个 `tsc --noEmit` 通过；`npm run build` 已重出 `lib/`。
> **待办：需重启 DSH 使改动生效**（进程内是旧模块）。

| 编号 | 缺陷 | 严重度 | 状态 |
| --- | --- | --- | --- |
| A | 自动压缩后必定注入「继续」，与压缩器注释相反 | 高 | ✅ 已修复（`abead1c`） |
| B | 失败动作永不消耗每会话配额，失败会无限重试 | 高 | ✅ 已修复（`abead1c`） |
| C | 动作截止时间管不住压缩与摘要 | 高 | ✅ 已修复（`abead1c`） |
| D | 上下文占用分子与「精确」标签不匹配 | 中 | ✅ 已修复（`f0fba43`；`f0927f8` 是假阳性） |
| E | fork 会话的历史被看不见 | 中 | ✅ 已修复（`fbb946c`） |
| F | 人类输入缓冲只在成功时取走，取消/卸载后残留 | 中 | ✅ 已修复（`8cf16da`） |
| G | 压缩失败原因被宿主统一成 `busy`，插件照 `busy` 重试 | 低 | ✅ 已修复（`640c964`） |
| H1 | `persistence` 恒为 `durable`，「仅内存」告警不可达 | 低 | ✅ 已修复（`b546f4e`） |
| H2 | `abort` 监听未移除 | 低 | ✅ 已修复（`b546f4e`） |
| I-1 | 简报固定要求「从下一步继续」，可能越过用户授权 | 设计取舍 | ✅ 兜底 + 检测（`1d48306`） |

### 另一半：`/compact` 在旧会话失败（另一个仓库）

| 项 | 状态 |
| --- | --- |
| 根因 | 压缩重放会话已存 system 消息，绕过 `system-prompt/assemble`；gate-guard 只挂该一个钩子 |
| 修复 | ✅ `dsh-workbuddy-gate-guard` 新增 `llm/stream` 钩子（commit `f451039`），verify.mjs 6 → 12 项 |
| 验证前提 | **需重启 DSH**；重启后在 2026-10-21 20:06 前创建的会话上试 `/compact` |

### 本轮修复摘要（2026-10-22）

| 项 | 改动位置 | 一句话 |
| --- | --- | --- |
| A | `coordinator.ts` `runCompact` + `monitor.ts` `compactRunner` | 中断判定改用 `agent.status === 'running'`（latch 读在 `arm()` 之后必然为 true）；`compactRunner` 不再依赖 latch |
| B | `monitor.ts` `execute()` | 压缩失败传 `consumedFailure: true`，交接失败仍不计次 |
| C | `coordinator.ts` / `index.ts` / `monitor.ts` | `deadlineSignal` 贯通到 `summarize` 与 `compact`；**并在 caller 侧加 `boundedByDeadline`**，见下方说明 |
| D | `measure.ts` `readPressureProjection` | 不再读 state 里不存在的 `projectedTokens`，改按宿主 wire 公式自行推导 |
| I-1 | `session-summary.ts` | 元指令加「不要替用户做决定」+ 新增 `readPendingInput` 检测并写入事实块 |

### C 项的一个中途修正（值得记下来）

第一版只把 `deadlineSignal` 传给了 `summarize` / `compact`，端到端验证证明**不够**：

```
C-SUMMARIZE (仅传 signal)  → 1206ms 后仍挂住，latch held = true
C-COMPACT   (仅传 signal)  → 1203ms 后仍挂住，latch held = true
```

原因：signal 只能停下「肯听 signal 的代码」，而这两步末端都是第三方实现
（`llm.stream`、`compaction.compactNow`）。只要对方既不 settle 也不看 signal，
`await` 就永久挂起，`run()` 的 `finally` 永不执行，闩锁永久不释放。

补上 `boundedByDeadline()`（在 caller 自己的 promise 上 race 截止信号）之后：

```
C-SUMMARIZE  → 158ms 后 phase=failed，latch held = false
C-COMPACT    → 156ms 后 phase=failed，latch held = false
```

代价：被放弃的调用仍在后台跑（不可避免的泄漏），但会话被释放了。
用变异测试确认过这条守得住——摘掉 `boundedByDeadline` 后对应用例挂死 5010ms 并失败。

---

### A. 自动压缩后**必定**注入「继续」❌

**严重度：高。** 空闲会话会被凭空唤起一轮 turn，正是 `compact-handler.ts:18-25` 自己警告过的环路。

**证据：**

- `src/monitor.ts:304` —— 压缩器在调用时刻现读闩锁：
  ```ts
  interruptedRunningTurn: deps.latches.isLatched(agent.id),
  ```
- `src/coordinator.ts:458-459` —— 但协调器先取值、后**武装**闩锁：
  ```ts
  const interrupted = this.deps.latches.get(sessionId) !== undefined
  this.deps.latches.arm(sessionId)
  ```
- `src/coordinator.ts:476` —— 真正的压缩发生在 arm **之后**：`const outcome = await this.deps.compact(agent)`。

因此 `isLatched()` 此刻恒为 `true` → `continuesTask` 恒为 `true` → `src/coordinator.ts:498` 必然 `followup('继续完成刚才的任务。')`。

`const interrupted`（`coordinator.ts:458`）算出了正确值，却**从未被使用**（死变量），也没向下传递。

**为什么测试没拦住：** `tests/unit/coordinator.spec.ts:323`、`:475` 都以字面量 `{ kind: 'compacted', continuesTask: true }` 注入压缩结果，绕过了真实接线。

**建议修法：** 让 `compact` 依赖签名接收 `interrupted`，由 `runCompact` 传入已算好的值，删除 `monitor.ts:304` 的现读；补一条用真实 `latches.arm()` 顺序的集成用例。

---

### B. 失败动作永不消耗每会话配额，失败会无限重试 ❌

**严重度：高。** 与 G 叠加时，一个必然失败的压缩会持续发起请求。

**证据：**

- `src/monitor.ts:170` —— 默认值 `consumedFailure = false`。
- `src/monitor.ts:240` —— 唯一调用点只传三个参数：`this.settle(sessionId, kind, succeeded)`。
- `src/trigger.ts:255` —— `noteActionFinished(state, false)` 只清 `pending`，`autoActions` 与 rearm 门都不动。

后果：失败后 `pending` 清零 → 下一个 surface 事件在 `evaluateIntervalMs`（默认 5s）后重新判定 → 重试，**永不触及** `maxAutoActionsPerSession`。

与 `src/compact-handler.ts:12-14` 的书面承诺冲突：

> a compaction that exhausted its retries does [count against the cap], so a broken compaction cannot spin forever

**建议修法：** 由 `execute()` 判断失败是否应计次（压缩重试耗尽 → `consumedFailure: true`），或直接对 `outcome.kind === 'failed'` 计次。

---

### C. 动作截止时间管不住压缩与摘要 ❌

**严重度：高。** 设置项注释是「Hard deadline for one action」，实际只约束了等待边界；卡死时会话被闩锁永久挡住。

**证据：**

- `src/coordinator.ts:237` 建立 `withDeadline(this.actionDeadlineMs)`，但 `deadlineSignal` 只传给 `waitForBoundary`（`:274`、`:462`）。
- `src/coordinator.ts:294` —— `await this.deps.summarize(agent as AgentLike)`，无 signal。
- `src/coordinator.ts:476` —— `await this.deps.compact(agent)`，无 signal。
- `src/index.ts:265` —— 压缩器拿到的 signal 是构造时创建、**永不 abort** 的：`signal: new AbortController().signal`。

所以 `actionDeadlineMs`（默认 30 分钟）对一个卡死的压缩或摘要请求无效，`run()` 的 `finally`（释闩锁）也进不去。

**建议修法：** 把 `deadlineSignal` 传进 `summarize`/`compact`，`index.ts` 改为按动作创建 controller 并受 deadline 约束。

---

### D. 上下文占用分子与「精确」标签不匹配 ✅ 已修复

**修复提交：** `f0927f8`（2026-10-22 13:00:16 +0800）。

**修复前：** `readContextOccupancy` 取 `used = measured.surfaceTokens`（约 4 字符/token 的启发式回放），却用 `baseline.kind === 'usage'` 判 `quality: 'exact'`；而输入框读的是 `contextPressure` 投影的 `projectedTokens ?? pressureTokens`。同一会话两个数字（实测 32.14% vs 27.41%）。

**修复后：** 优先读投影、与输入框同源；`source` 字段在 `/handoff status` 里显式标 `与输入框一致` 或 `回退：surface 估算`。

**残留说明：** 当投影只带 `pressureTokens`（无 `projectedTokens`）时标 `exact`，带 `projectedTokens` 时降级 `estimated`——这与 UI 的区分一致，属正确取舍。仍有 `src/measure.ts:199/209` 的 `meter-surface` 回退路径存在，但仅在没有投影时启用，符合设计。

---

### E. fork 会话的历史被看不见 ❌

**严重度：中。** 有历史的 fork 会话会被判成空白会话而拒绝交接。

**证据：**

- `src/contracts.ts:86-88` —— `sessionEvents()` 优先 `ownEvents()`。
- 宿主实现 `dsh-session/lib/index.js:142`：
  ```js
  ownEvents() { return this.snapshotEvents(this.inheritedEventCount); }
  ```
  即**只含本会话自有事件**，fork 继承段不可见。
- `snapshotEvents` 仅作回退（`contracts.ts:90`），在真宿主上永远走不到。

受影响路径：`src/index.ts:338` 的 `activityCheck`（只看 `user/message` / `turn/start`）、`renderTranscript()`、`factsFromLog()`、`windowFromEvents()`。

**建议修法：** 为「读完整日志」与「读自有事件」拆两个访问器；`activityCheck` 与简报应使用完整日志。

---

### F. 人类输入缓冲只在成功时取走 ❌

**严重度：中。** 一次被取消/失败的交接会留下文本，下次交接成功时被误当作「交接期间收到的消息」转投。

**证据：**

- `src/index.ts:461` —— `humanInput.capture(agentId, humanTexts(...))`
- `src/index.ts:275` —— `drain` 只在 `reroutePending` 中调用，且仅交接**成功**后。
- `HumanInputBuffer.forget()` 存在（`src/graceful-stop.ts:144`）但 `index.ts` 从未调用；`monitor.forget()`（`index.ts:485`）只清 coordinator。

**建议修法：** 在 `session/disposed` 与动作进入 `failed`/`cancelled` 时调用 `humanInput.forget(sessionId)`。

---

### G. 压缩失败原因被宿主统一成 `busy` ❌

**严重度：低（成因在宿主，插件可缓解）。**

- 宿主 `dsh-compaction-basic/lib/index.js:1008-1010` 把所有异常包成 `ManualCompactionError("busy", "manual compaction requires an idle agent…")`，包括真正的摘要失败。
- 插件 `src/compact-handler.ts:107` 的 `errorCodeOf` 只读 `error.code`，于是 `summary` 类失败被当作可重试的 `busy`，退避重试 3 次，最终报「压缩服务繁忙」，真实原因被掩盖。

**建议修法：** 读取 `error.cause`（宿主用 `{ cause: error }` 包装）并据其归类；或对 `busy` 重试前先校验 agent 是否真的 busy。

---

### H1. `persistence` 恒为 `durable` ❌

**严重度：低（仅影响一处不可达分支）。**

- `src/index.ts:432`：`persistence: readServices(host) === undefined ? 'memory' : 'durable'` —— `readServices` 恒返回对象，故永远 `'durable'`。
- 因此 `src/command.ts:135` 的「设置只在本次进程内有效」告警不可达。
- `src/index.ts:627` 的 `/state` 路由同样写死 `'durable'`。

**建议修法：** 依据 `settings` 服务是否存在判断，而不是 `readServices` 是否为 undefined。

---

### H2. `abort` 监听未移除 ❌（低，健壮性）

- `src/graceful-stop.ts:279`：`signal.addEventListener('abort', () => resolve('error'), { once: true })`，`finally`（`:297`）只 `clearTimeout`，不移除监听。

**准确性说明：** 当前用法里 signal 来自 `withDeadline`（每动作新建），随动作结束被回收，**不构成实际泄漏**。仅在 signal 被复用或长期存活时会累积。作为健壮性建议保留，不建议列为必修项。

---

### I-1. 简报固定要求「从下一步继续」ℹ️ 待决策

- `src/session-summary.ts:378-382` 把「打印三节 + 复查本插件」写死进每份简报；`:376` 要求「从「下一步」继续」。
- 收益：接手会话自检，本次审计即由此触发。
- 代价：每个交接会话都要花一段上下文；且见 Q3——新会话可能越过用户授权直接执行。

**待决策：** 是否在固定模板中加入「未经用户确认不得修改文件」的硬约束。

---

## 三、已确认**无问题**的部分

以下均逐个对照宿主实现核对过服务名与方法签名，无偏差：

`sessions.get` / `agents.get` / `sessionController.create|selectModel` / `workspaceRegistry.resolveByPath|archiveSession({stopActivity})` / `WorkspaceEntity.attachSession` / `permissionPresets.current|set` / `approval.overrideOf|setPolicy` / `agentPresets.serviceFor` / `planMode.get|set` / `agentDefaultModel.currentSelection` / `compaction.compactNow` / `llm.stream` / `commands.register` / `configEditor.configuration|edit` / `webServer.register({kind:'prefix'})` / `tokenMeter.measure` / `sessionProjections.stateOf('tokenUsage')`。

同时确认：

- `agent/pre-step` 返回 `{ kind: 'reject' }` 的否决语义正确（宿主 `dsh-agent-loop/lib/index.js:911-925`）。
- `session/event` 与 `session/disposed` 的参数形状正确（`dsh-session/lib/index.js:1466`、`:1807`）。
- `plugin:<package>` 的 v4 source kind 规则正确（`dsh-session-format-v3-to-v4/lib/index.js:126`）。
- 源码中 `'\n'`、`/^\/+/`、`\s\S` 等转义**字节正确**（已 `od -An -tx1` 校验），先前看到的双反斜杠只是展示层。

---

## 四、建议修复顺序

1. **C**（截止时间）—— 最有可能把会话卡死；改动小，收益明确。
2. **A**（必定「继续」）—— 影响每次自动压缩，且与注释冲突。
3. **B**（失败不计数）—— 与 G 叠加会造成持续重试与持续计费。
4. **E**（fork 历史）—— 影响 fork 用户的可用性。
5. **F**（缓冲残留）—— 数据错投，场景较少但难察觉。
6. **G / H1 / H2** —— 清理项。
7. **I-1** —— 需产品决策后再说。

## 五、验证方法

- 改前改后各跑一次：`cd dsh-session-handoff && npx vitest run`（当前基线 209 passed）。
- A/B 的回归必须用**真实接线**：压缩用例要走 `latches.arm()` 之后调用 `compact`，不能用字面量 `continuesTask`。
- C 的验证：把 `actionDeadlineMs` 调到 1000ms，注入永不 resolve 的 `summarize`，断言 `run()` 在约 1s 后返回 `failed` 且闩锁已释放。
- 端到端：用一份已有历史的会话跑 `/handoff`，检查 `/state` 的 `occupancy.source` 是否为 `contextPressure`，并比对输入框百分比是否一致。

---

## 附：本次复查未改动任何文件

除本文档外，`dsh-session-handoff` 工作树保持干净，未修改源码、未修改 `$DSH_PROFILE_DIR` 配置。缺陷 A–C 的修复需你确认后再动手。
