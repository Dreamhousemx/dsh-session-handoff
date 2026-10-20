# DSH 会话交接插件（dsh-session-handoff）开发规划文档 · v2

> 本文档是开发蓝图：按此文档可以一步一步开发出完整插件。本文只做规划，不包含实现代码。
>
> 参考项目：[qingyou002/dsh-auto-handoff](https://github.com/qingyou002/dsh-auto-handoff)
> 事实基线：本机运行的 DeepSeek Harness（关键 API 已通过 `cordis_inspect` 实地核对，见 §6）
> 文档版本：v2（2026-10-19）

## 变更记录

| 版本 | 变更 |
| --- | --- |
| v1 | 首版：完整功能清单、机制设计、10 阶段步骤、测试与风险 |
| **v2** | ① **新增「上下文占用率」自动交接**（F2 触发引擎）——按当前上下文用了多少百分比触发，而非只看累计消费；② 修正设置契约：本机 `settings` 服务无 `installSection`，改为「插件 `Config` schema + `settings.update(entryId, patch)`」；③ 触发/度量拆成独立阶段，阶段总数 10 → 11；④ 全部阈值改为「百分比优先」；⑤ 增加 MVP 分层与决策记录（ADR） |

---

## 目录

- [0. 先读这三段](#0-先读这三段)
- [1. 目标与范围](#1-目标与范围)
- [2. 功能清单](#2-功能清单)
- [3. 触发引擎设计（核心）](#3-触发引擎设计核心)
- [4. 设置项全表](#4-设置项全表)
- [5. UI 设计](#5-ui-设计)
- [6. 依赖的运行时 API（已实测）](#6-依赖的运行时-api已实测)
- [7. 代码结构](#7-代码结构)
- [8. 分阶段开发步骤](#8-分阶段开发步骤)
- [9. 测试矩阵](#9-测试矩阵)
- [10. 风险与限制](#10-风险与限制)
- [11. 安装、验证与发布](#11-安装验证与发布)
- [附录 A：状态机](#附录-a状态机)
- [附录 B：失败矩阵](#附录-b失败矩阵)
- [附录 C：决策记录](#附录-c决策记录)

---

## 0. 先读这三段

1. **插件做什么**：长会话要交接给同工作区的新会话时，在安全的 Step 边界停下，由会话自己的模型写一份九段交接简报，新建会话继承 preset/模型/权限/Plan 模式，把简报作为第一条消息投递过去，旧会话退役。
2. **用户最关心的触发方式**：不是只按「一共花了多少 token」，而是按**「上下文已经用了多少百分比」**——`当前上下文 token 数 ÷ 模型上下文窗口`。本机运行时提供了这两个数值（§3.1、§6），所以这是真实可实现的。
3. **怎么读这份文档**：§2 看要做什么，§3 看触发逻辑怎么算，§8 按阶段开发，§9 按矩阵测试。所有 API 名都来自本机实测（§6），但**写代码前仍要用 `cordis_inspect_query` 逐个拉精确签名**——目录只证明存在。

---

## 1. 目标与范围

### 1.1 要解决的问题

长会话有三个独立问题，本插件的触发引擎分别对应：

| 问题 | 度量 | 后果 |
| --- | --- | --- |
| 上下文快塞满 | **占用率 = 当前上下文 token ÷ 模型窗口** | 截断、遗忘、质量下降 |
| 账单越来越贵 | 累计消费 token | 成本线性增长 |
| 历史太长注意力稀释 | 两者都会体现 | 模型抓不住重点 |

**交接**同时解决三者：新会话从零开始，只带一份结构化简报。

### 1.2 MVP 分层（建议按此排优先级）

| 层级 | 内容 | 价值 |
| --- | --- | --- |
| **MVP（必须）** | `/handoff` 手动交接 + 九段简报 + 配置继承 + 设置卡 + **上下文占用率自动交接** | 用户点名要的核心能力 |
| P1 | 自动跳转到新会话；`status/cancel/retry` 子命令；HTTP 状态通道 | 体验闭环 |
| P2 | 累计消费阈值触发；自动压缩（上下文续命） | 省钱与延寿 |
| P3 | 中英文案、图标、发布 | 分发 |

### 1.3 硬性设计原则（不可妥协）

1. **绝不中断正在执行的工作**——全库不出现任何 `agent.cancel()` 调用；
2. **原会话日志只追加不删除**——插件不写、不删会话日志；
3. **任何失败都不假装成功**——逐项报告继承结果，失败保留原会话；
4. **不创建空会话**——空白会话拒绝交接；
5. **可选服务全部惰性读取**——不在 `apply()` 里快照服务引用；
6. **不无限循环**——水位去重 + 重臂基线 + 滞回带 + 每会话次数上限；
7. **测量有成本意识**——`measure()` 是 O(surface)，必须防抖（§3.3）。

---

## 2. 功能清单

### 2.1 模块总览

```
┌──────────────────────────────────────────────────────────────────┐
│                         Host 半（Node 进程）                      │
│                                                                   │
│  M1  命令组         /handoff 及 status|cancel|retry               │
│  M2  度量层         上下文占用率 + 累计消费 + 精确/估算标注        │
│  M3  触发引擎       优先级、防抖、水位去重、重臂、滞回、次数上限    │
│  M4  软终止闩锁     pre-step reject + whenIdle 边界等待            │
│  M5  交接简报       九段结构、事实读取、脱敏、模型撰写             │
│  M6  会话迁移       建新会话 + 配置逐项继承 + 简报投递             │
│  M7  自动压缩       compactNow + 有界重试 +「继续任务」边界        │
│  M8  协调器         单会话单动作、阶段机、取消/重试/幂等           │
│  M9  设置           Config schema + settings.update 持久化         │
│  M10 HTTP 通道      /dsh-session-handoff/* 状态与操作路由          │
│  M11 展示资源       meta.title/description、icon、locale           │
├──────────────────────────────────────────────────────────────────┤
│                        Client 半（浏览器）                         │
│                                                                   │
│  M12 设置卡         设置 Slot 内的卡片：开关、阈值、状态、操作     │
│  M13 常驻切换器     迁移成功后自动跳转到新会话                     │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 F1 命令组（M1）

| 命令 | 行为 |
| --- | --- |
| `/handoff` | 立即把当前会话迁移到同工作区的新会话（**不受任何阈值与重臂限制**） |
| `/handoff status` | 阶段、上下文占用率（已用/窗口/百分比/精确或估算）、累计消费、阈值、自动动作次数、最近结果、失败与警告 |
| `/handoff cancel` | 请求取消进行中的迁移或压缩，在下一个安全检查点生效 |
| `/handoff retry` | 重试最近一次失败的迁移（不受重臂基线阻挡） |

- 命令不进模型可见历史（走 `commands` 服务的 log-only 路径）；
- 空白会话（无人类提示且无任何 turn）拒绝并提示「当前没有可迁移的活动会话」。

### 2.3 F2 触发引擎（M2 + M3）——本插件核心

支持**三种自动触发**，可按开关独立启用，也可同时开启：

| 触发 | 度量 | 默认阈值 | 含义 |
| --- | --- | --- | --- |
| **A. 上下文占用率** | `surfaceTokens ÷ contextWindow` | **85%** | 「上下文快满了，换人干」← 用户点名要的 |
| B. 累计消费 | 四个 bucket 之和 | 200 万 token | 「太贵了，换人省历史」 |
| C. 自动压缩 | 上下文占用率 | 70% | 「先原地压缩续命，别急着交接」 |

**优先级**：A（占用率交接）> B（累计交接）> C（压缩）。

理由：交接是终局动作、压缩是续命动作；先判交接，避免「刚压缩完压力又满 → 立刻又压缩」的抖动。压缩完成后若占用率仍 ≥ A 的阈值，**立即排一次交接**（§3.6）。

**三种标注**（UI 与 `status` 都显示）：

| 标注 | 判定 | 影响 |
| --- | --- | --- |
| `exact` | 测量基线来自提供方真实 usage | 正常 |
| `estimated` | 无 usage，纯启发式估算 | 正常，但 UI 标「估算」 |
| `window-unavailable` | 模型未上报 `contextWindow` | **A/C 停用**，UI 明示；B 照常 |

**详细算法见 §3。**

### 2.4 F3 软终止（M4）

状态流转：

```
IDLE
 → PREPARING                    已受理
 → WAITING_FOR_STEP_BOUNDARY    已设停止闩锁，等待当前 Step 自然结束
 → SUMMARIZING                  生成并脱敏摘要
 → CREATING_SESSION             创建新会话 + 逐项继承
 → TRANSFERRING                 投递简报
 → COMPLETED | FAILED | CANCELLED
```

实现要点：

- 监听 `agent/pre-step`（waterfall），闩锁已设且本批消息**没有新的人类提示**时返回 `{ kind: 'reject' }`；该步不启动，turn 以 `blocked` 关闭；
- **人类提示守卫**：被 reject 的 step 中已 claim 的消息既不入库也不重发，因此本批消息存在 `source.kind === 'user'`（含浏览器 `user-rpc`）时**绝不 reject**；插件注入（`plugin`）与 goal 轮次（`goal`）不在此列；
- reject 后 `await agent.whenIdle()`，**从不调用取消 API**；
- `stepWaitTimeoutMs` 到期只置 `slowWarning`（「已等待 N 分钟」），**继续等待**；
- `actionDeadlineMs` 到期释放闩锁、恢复会话、标记 `FAILED`，**不做破坏性动作**；
- 迁移前置阶段用户发来新消息 → 放弃迁移（`CANCELLED`），消息放行原会话；
- 新会话已建、简报未投递完时用户发来新消息 → 该 Step 仍拒绝，消息文本**转投新会话**（追加在简报后）并明示；转投失败则放行原会话并记录提示。

### 2.5 F4 交接简报（M5）

九段固定结构（由会话自身模型撰写，程序提供事实骨架）：

1. 总体目标 2. 约束 3. 已完成 4. 当前进度 5. 已改文件 6. 关键决策 7. 已知问题 8. 未完成 9. 下一步

- **事实段（程序直接读取，不经模型）**：cwd、preset、模型、权限、Plan 模式、累计消费、**上下文占用率**；
- **脱敏**：纯函数替换密钥/token/长凭据串；
- 生成失败或为空 → **放弃迁移，保留原会话**，零写操作；
- `summaryMaxTokens` 限制输出长度。

### 2.6 F5 会话迁移与配置继承（M6）

逐项继承，每步产出 `已继承 / 回退 / 未继承（原因）`：

| 配置 | 读取 | 写入 |
| --- | --- | --- |
| cwd | `session.header.cwd` | `sessionController.create({ cwd })` |
| 工作区归属 | `workspaceRegistry.resolveByPath(cwd)` | `workspace.attachSession(newId)`（best-effort） |
| Agent preset | `session.header.agentPreset` → `agentPresets.composedPreset(ctx)` | `create({ agentPreset })` |
| 模型 | 日志最新 `model/selection` → `requestHeader().config` → `agent.options` → `agentDefaultModel.currentSelection()` | `sessionController.selectModel(...)` |
| 权限预设 | `permissionPresets.current(session)` | `permissionPresets.set(newSession, name)` |
| 权限 custom | `approval.overrideOf(session)` | `approval.setPolicy(newAgent, policy)` + 明示「sandbox 档位未继承」 |
| Plan 模式 | `agentPresets.serviceFor(agent,'planMode') ?? ctx.get('planMode')` | 新会话 agent 自己的实例上 `planMode.set(newAgent, active)` |

**关键约束**（参考项目实修结论，开发时需在本机再验证一次）：

- 优先「按 cwd 建 → 再 attach 工作区」；`create()` 的 `workspaceId` 与 `cwd` 可能互斥（本机 `SessionCreateRequest` 两个字段都存在，但**互斥性需实测确认**）；
- attach 失败只标记「未继承」，**不**把迁移报成失败；
- 目录未注册为工作区时**不自动 `create()`**（避免静默改动侧边栏顺序），标记「回退」；
- 投递走 `agent.followup()` + `source: { kind: 'plugin' }`（`sessionController.prompt` 固定记 `user-rpc`，语义不符）。

### 2.7 F6 自动压缩（M7，可选）

1. 设闩锁 → pre-step 拒绝下一 Step（人类提示守卫优先）→ `whenIdle()`；
2. `ctx.compaction.compactNow(agent, signal)`；
3. `busy` 错误：250ms × 次数退避重试 ≤ 3 次，每次重试前重新 `whenIdle()`；到上限放弃但**不更新重臂基线**；
4. 其它错误码一次性失败并报错；返回 `null` 是**结果不是失败**（无可安全压缩范围）；
5. **「继续任务」边界**：只在「本次压缩前先软终止了正在跑的 turn」时发送；会话本就空闲则不发，避免 `compact → 继续 → handoff → compact` 循环；
6. 压缩次数计入 `maxAutoActionsPerSession`。

### 2.8 F7 设置（M9）

**本机契约修正（v2 重要）**：`settings` 服务提供 `describe / update / replace / mutate / configure`，**没有** `installSection`。设置就是插件的 `Config`：

- 插件导出 `Config`（schema 默认值 + 校验）；
- 用户在设置卡改值 → Client 走 `settings.update(entryId, patch)` 写 profile patch → `settings/document-updated` 事件 → 插件热生效；
- 无 `settings` 服务时降级为内存态，UI 明示「重启恢复默认」。

字段全表见 §4。

### 2.9 F8 HTTP 通道（M10）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-session-handoff/state?sessionId=<id>` | 状态快照（阶段、占用率、累计、阈值、计数、newSessionId、最近结果、警告、persistence） |
| POST | `/dsh-session-handoff/handoff` | 触发迁移 |
| POST | `/dsh-session-handoff/cancel` | 取消 |
| POST | `/dsh-session-handoff/retry` | 重试 |

`kind: 'prefix'`，`path: '/dsh-session-handoff'`；POST 只接受 loopback；响应只含标量 JSON。缺 `webServer` 时卡片降级「状态通道不可用」，表单仍可读写。

### 2.10 F9 浏览器半（M12 + M13）

**设置卡**五区：

1. **主设置**：自动交接开关 + 触发方式（占用率/累计/两者）+ 占用率阈值（滑块 + 数字）+ 累计阈值；
2. **高级设置**：防抖间隔、重臂、滞回、次数上限、摘要上限、超时、自动跳转；
3. **状态区**：**占用率进度条**（已用/窗口/百分比/精确或估算）+ 累计消费进度条 + 当前阶段 + 是否等待 Step + 最近结果与失败记录；
4. **操作区**：立即迁移 / 取消 / 重试；
5. **提示区**：警告与降级说明。

**常驻切换器（follower）**——由 Client `apply()` 启动、**不寄生在设置卡里**：

- 每 2 秒读当前会话并轮询 `GET /state`；
- **基线规则**：会话首次被观察到只记录其 `newSessionId`、不动作；只有 `undefined → 有值` 的跃迁才切换；
- **重试规则**：新行未出现或仍 `blank` 时，先 `ctx.sessions.refresh()`（让 Host 重算 `blank` 的唯一手段）→ 读 `byId[newId]` → `ctx.sessions.open(id)`；每 tick 放弃下 tick 重试，最多 12 次后静默放弃；
- `openNewSessionOnHandoff=false` 时不动作；内部错误全部隔离。

**Client 半依赖**：`inject: ['slots', 'settingsScope', 'sessions']`，三者缺一整个 bundle 不挂载。

### 2.11 F10 展示资源（M11）

`locale/zh.json` + `locale/en.json`（`meta.title` / `meta.description`）、原创 `icon.svg`（≤ 256 KiB）、完整 `exports`/`files`。

---

## 3. 触发引擎设计（核心）

### 3.1 两个度量怎么算

**度量 A：上下文占用率**

```
used   = tokenMeter.measure(session).surfaceTokens        // 当前模型可见 surface 的 token
window = session.requestContext()?.contextWindow          // 当前请求路由的模型上下文窗口
percent = window ? used / window : null
```

- `measure()` 返回 `TokenMeasurement`：`surfaceTokens`（当前 surface）、`totalTokens`（基线 + 增量）、`baseline.kind`（`'usage'`/`'estimated'`/`'none'`）；
- `baseline.kind === 'usage'` → 标注 `exact`；否则 `estimated`；
- `window` 缺失 → 标注 `window-unavailable`，A/C 触发停用；
- `measure()` 抛错 → 本次跳过 + 记 warning，下个评估周期重试。

**度量 B：累计消费**

```
cumulative = uncachedInput + output + cacheRead + cacheWrite
```

来源优先级（与参考实现一致）：

1. `sessionProjections.stateOf(session, 'tokenUsage')` 投影（durable 日志纯折叠，可重放）；
2. `tokenMeter.measure(session).totalTokens`（估算回退）；
3. 都不可用 → `unavailable`，B 停用。

> **阶段 0 必须实测**：本机 `SessionProjectionMap` 基类为空，`tokenUsage` 投影键由其他包声明合并而来；`stateOf` 返回 `undefined` 就说明该部署未注册，此时 B 直接走 `measure()`。

### 3.2 评估时机

| 项 | 规则 |
| --- | --- |
| 触发事件 | `session/event`，只处理 surface 事件：`user/message`、`assistant/message`、`tool/result` |
| 模型/窗口变更 | `request/context` 事件到达时重算 `window`（切模型可能换窗口） |
| 防抖 | 同一会话两次评估间隔 ≥ `evaluateIntervalMs`（默认 5000ms） |
| 水位去重 | 记录 `lastEvaluatedSeq`，`event.seq <= lastEvaluatedSeq` 直接返回 |
| 活跃性 | 只评估有 live agent 的会话；空闲会话不评估，恢复活跃后首次评估 |
| 单动作互斥 | 协调器已有待执行动作时不再排新的 |
| 手动优先 | 手动 `/handoff` 不受上述任何限制 |

### 3.3 判定流程（伪流程）

```
onSurfaceEvent(session, event):
  if (!autoHandoffEnabled && !autoCompactEnabled) return
  if (now - lastEvalAt < evaluateIntervalMs) return
  if (event.seq <= lastEvaluatedSeq) return
  if (coordinator.hasPending(session)) return
  lastEvalAt = now; lastEvaluatedSeq = event.seq

  m = measure(session)                    // 失败 → warning + return
  p = m.window ? m.surfaceTokens / m.window : null
  c = cumulative(session)

  // 1) 占用率交接
  if (triggerIncludes('context') && p != null && p*100 >= handoffAtContextPercent
      && armedContext(session)) 
        return coordinator.request('handoff', {reason:'context', percent:p})

  // 2) 累计交接
  if (triggerIncludes('cumulative') && c >= autoHandoffThreshold
      && armedCumulative(session))
        return coordinator.request('handoff', {reason:'cumulative', tokens:c})

  // 3) 压缩
  if (autoCompactEnabled && p != null && p*100 >= autoCompactPercent
      && armedCompact(session))
        return coordinator.request('compact', {reason:'context', percent:p})
```

**为什么是这个顺序**：交接 > 压缩。若反过来，压力 90% 时会先压缩、压缩后 88% 又超阈值，来回抖动。

### 3.4 重臂（rearm）与滞回（hysteresis）

每次**成功**动作后：

| 度量 | 重臂条件 | 目的 |
| --- | --- | --- |
| 占用率（交接） | 压力须先回落到 `handoffPercent - contextRearmDeltaPercent` 以下，再重新武装 | 防止压缩后压力微降就立刻再次触发 |
| 累计消费 | `cumulative >= lastActionAtTokens + rearmDeltaTokens` | 防止同一水位反复触发 |
| 压缩 | 压力须先回落到 `compactPercent - contextRearmDeltaPercent` 以下 | 防止连续压缩 |

**次数上限**：每会话自动动作 ≤ `maxAutoActionsPerSession`（默认 3），交接与压缩共享计数。

**为什么不会循环**：

1. 交接成功 → 旧会话 `retired`，不再产生任何自动动作；
2. 压缩成功 → 压力下降，必须跌破滞回带才重新武装；
3. 每会话动作次数封顶；
4. 同一时刻只有一个待执行动作。

### 3.5 优先级与互斥矩阵

| 状态 | 占用率超交接阈值 | 占用率超压缩阈值 | 累计超阈值 |
| --- | --- | --- | --- |
| 空闲、无待执行动作 | → 交接 | → 压缩 | → 交接 |
| 已有待执行交接 | 忽略 | 忽略 | 忽略 |
| 已有待执行压缩 | 忽略 | 忽略 | 忽略 |
| 交接完成、会话 retired | 不评估 | 不评估 | 不评估 |
| 手动 `/handoff` | 立即执行 | — | — |

### 3.6 边界与异常

| 场景 | 行为 |
| --- | --- |
| `contextWindow` 缺失 | A/C 停用；UI 显示「模型未上报上下文窗口」；B 照常 |
| `measure()` 抛错 | 本次跳过 + warning，下周期重试；不阻塞会话 |
| `window` 变很小（切模型） | 立即重算，可能立即触发；属预期行为 |
| 压缩后压力仍 ≥ 交接阈值 | 压缩完成回调里**立即评估一次**，直接排交接 |
| 压缩后压力跌到滞回带内 | 不重新武装，等跌破 `compactPercent - delta` |
| 会话空闲无 live agent | 不评估；下次活跃时首次评估 |
| 多浏览器标签 | Host 单实例状态表，天然去重 |
| 插件刚启动 | 每个会话第一次评估只记录基线，不动作（避免启动即触发） |

> 最后一条很重要：插件加载时若会话已达 90%，**不应该**立刻触发交接（用户可能马上处理）。策略：首次观察只建立基线并记一条 `baseline` warning；下一次评估（≥ 5 秒且出现新 surface 事件）才允许触发。

### 3.7 与压缩的配合

```
占用率 70% → 压缩（若开启）→ 压力降到 ~35%
占用率 85% → 交接（若开启）
```

- 压缩会显著降低压力，因此压缩后通常能续命很久；
- 若压缩后压力仍在高位（压缩效果差或上下文增长极快），直接排交接；
- 压缩与交接共享次数上限，避免一个会话反复折腾。

---

## 4. 设置项全表

命名空间/entry id：`dsh-session-handoff`。

### 4.1 主设置

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `autoHandoffEnabled` | boolean | `false` | 启用自动交接 |
| `autoHandoffTrigger` | `'context' \| 'cumulative' \| 'either'` | `'context'` | 触发方式 |
| `autoHandoffAtContextPercent` | 整数 1–100 | **`85`** | 上下文占用率达到多少百分比交接 |
| `autoHandoffThreshold` | 整数 ≥ 0 | `2000000` | 累计消费阈值（`cumulative` 时生效） |
| `autoCompactEnabled` | boolean | `false` | 启用自动压缩 |
| `autoCompactAtContextPercent` | 整数 1–99 | `70` | 占用率达到多少百分比压缩 |

### 4.2 高级设置

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `evaluateIntervalMs` | 整数 ≥ 1000 | `5000` | 评估防抖间隔 |
| `contextRearmDeltaPercent` | 整数 0–50 | `10` | 滞回带宽度 |
| `rearmDeltaTokens` | 整数 ≥ 0 | `200000` | 累计重臂增量 |
| `maxAutoActionsPerSession` | 整数 1–10 | `3` | 单会话自动动作上限（交接+压缩共享） |
| `summaryMaxTokens` | 整数 ≥ 256 | `4096` | 摘要模型输出上限 |
| `stepWaitTimeoutMs` | 整数 ≥ 1000 | `900000` | 等 Step 多久算偏久（只提示不中断） |
| `actionDeadlineMs` | 整数 ≥ 1000 | `1800000` | 动作总时限；到期只释放闩锁并标记失败 |
| `openNewSessionOnHandoff` | boolean | `true` | 迁移成功后浏览器自动切到新会话 |

### 4.3 跨字段校验

| 规则 | 行为 |
| --- | --- |
| 数值越界 | schema 拒绝；旧文档缺字段自动补默认 |
| 交接与压缩都开启，且 `autoCompactAtContextPercent >= autoHandoffAtContextPercent` | **硬拒绝写入**，返回原因「压缩阈值必须低于交接阈值」 |
| 只开一个时阈值顺序颠倒 | 允许保存，卡片与 `status` 给警告 |
| `autoHandoffAtContextPercent` < 50 | 允许，给警告「阈值偏小，可能频繁交接」 |
| 触发方式含 context，但当前模型无 `contextWindow` | 允许，给警告「该触发在当前模型下不生效」 |
| 两个开关都关 | 纯手动模式，零干扰 |

---

## 5. UI 设计

### 5.1 设置卡布局

```
┌─ 会话交接 ────────────────────────────────────────────┐
│  自动交接  [ 开关 ]                                     │
│  触发方式  (占用率) (累计) (两者)                        │
│                                                         │
│  上下文占用达到  [=====85=====] 85%  交接               │
│  累计消费达到    [ 2,000,000 ] token                    │
│                                                         │
│  ▸ 高级设置                                             │
│                                                         │
│  ── 状态 ────────────────────────────────────────────  │
│  上下文  ████████████████░░░░  78%  156k / 200k  估算   │
│  累计    42.1k tokens                                   │
│  阶段    IDLE · 阈值 85% · 今日自动动作 1/3             │
│  最近    2026-10-19 20:11 手动交接成功 → 新会话 a1b2    │
│                                                         │
│  [ 立即迁移 ]  [ 取消 ]  [ 重试 ]                        │
│  ⚠ 当前模型未上报上下文窗口，占用率触发不可用            │
└─────────────────────────────────────────────────────────┘
```

### 5.2 交互规则

- 两个开关都关时，阈值控件置灰并显示「先启用自动交接」；
- 触发方式不含 `cumulative` 时，累计阈值置灰；
- 跨字段非法时保存按钮禁用并就地显示原因；
- 进度条颜色：< 70% 正常色、70–85% 警告色、≥ 85% 危险色（全部走 `--dsw-alias-*` 令牌）；
- 数字输入框失焦时 clamping 到合法范围，不静默吞值。

### 5.3 样式规范

- 颜色只用 `--dsw-alias-*` 设计令牌（字面量仅作老宿主回退），不写 `[data-theme]` 分支；
- 根节点 `data-dsh-plugin="dsh-session-handoff"` / `data-dsh-surface="settings-modal"`；
- 字段行 `data-dsh-part="field"`，控件 `data-dsh-field="<字段名>"`；
- 自写控件、复制宿主行为（switch 的 `role`/`aria-checked`、Modal 焦点与 Escape），不 require 宿主 UI 包。

---

## 6. 依赖的运行时 API（已实测）

> 2026-10-19 通过 `cordis_inspect` 在本机核对。写代码前仍需逐个拉精确签名。

### 6.1 Host 服务

| 服务 | 用途 | 关键成员 |
| --- | --- | --- |
| `tokenMeter` | **占用率测量** | `measure(session)` → `TokenMeasurement{ surfaceTokens, totalTokens, baseline.kind }` |
| `sessionController` | 建会话 / 选模型 | `create({ cwd?, workspaceId?, sessionId?, agentPreset? })`、`selectModel(request)` |
| `sessionProjections` | 累计 Token 投影 | `stateOf(session, key)`、`snapshot(session, keys?)` |
| `llm` | 简报生成 | 生成接口（缺失 → 放弃迁移） |
| `commands` | `/handoff` | `register(definition)` |
| `settings` | 设置持久化 | `describe()`、`update(ns, patch)`、`replace()`、`mutate()`、`document-updated` 事件 |
| `webServer` | HTTP | `register({ kind:'prefix', path })` |
| `workspaceRegistry` | 工作区归属 | `resolveByPath(path)`、`attachSession(id)` |
| `agentPresets` | preset 继承 + realm 解析 | `composedPreset(ctx)`、`serviceFor(agent,'planMode')` |
| `permissionPresets` | 权限继承 | `current(session)`、`set(session,name)` |
| `approval` | custom 权限 | `overrideOf(session)`、`setPolicy(agent,policy)` |
| `compaction` | 压缩 | `compactNow(agent, signal, sourceCommandId?)` |
| `planMode` | Plan 模式 | `get(agent)`、`set(agent, active)` |
| `agentDefaultModel` | 模型回退 | `currentSelection()` |

> `Session.requestContext()` → `RequestContext{ provider, model, contextWindow? }` 是**占用率分母**的来源。
> `Session.header` → `{ cwd, agentPreset, ... }` 是继承事实的来源。

### 6.2 Host 事件

| 事件 | 模式 | 用途 |
| --- | --- | --- |
| `agent/pre-step` | waterfall | 软终止：`PreStepDecision = {kind:'reject'} \| {kind:'enter', messages, startsRequestSeries?}` |
| `agent/created` | serial | 新会话继承钩子 |
| `session/event` | emit | 触发引擎入口（surface 事件过滤） |
| `session/disposed` | emit | 清理状态 |
| `settings/document-updated` | emit | 设置热生效 |

### 6.3 Client 半

- `dsh.client.inject: ['slots', 'settingsScope', 'sessions']`
- Slot：`settings.plugin.item`，`key: "dsh-session-handoff"`

---

## 7. 代码结构

```
dsh-session-handoff/
├── package.json              # dsh.bundle.patch、dsh.client、exports、files、versions
├── cordis.patch.yml          # insert 插件行 + Config 默认值
├── icon.svg
├── locale/{zh,en}.json
├── scripts/build-client.mjs  # tsc 产物内联进 __ModuleLoader__.load 信封
├── src/                      # Host 半（TS strict + verbatimModuleSyntax）
│   ├── index.ts              # 入口：惰性 serviceReader、装配、订阅、卸载
│   ├── types.ts              # 阶段、记录、文案、注入接口
│   ├── redaction.ts          # 纯函数脱敏
│   ├── settings.ts           # Config schema + 跨字段校验 + 持久化桥
│   ├── measure.ts            # 【新】两个度量：占用率 + 累计，含标注
│   ├── trigger.ts            # 【新】触发引擎：优先级、防抖、水位、重臂、滞回
│   ├── graceful-stop.ts      # 闩锁、pre-step 判定、边界等待
│   ├── session-summary.ts    # 简报构造、事实读取、渲染、模型调用
│   ├── session-migration.ts  # 建会话 + 继承 + 投递 + 核验
│   ├── compact-handler.ts    # 压缩：有界重试 +「继续任务」边界
│   ├── coordinator.ts        # 单动作、阶段机、取消/重试/幂等
│   ├── state.ts              # 进程内状态表
│   ├── command.ts            # /handoff 注册与渲染
│   └── routes.ts             # HTTP 状态与操作通道
├── src/client/
│   ├── index.ts              # 常驻 follower + 注册设置卡
│   ├── protocol.ts           # React-free 共享契约
│   ├── follow.ts             # 切换器
│   └── card.ts               # 卡片组件（createElement）
├── lib/                      # 预构建产物（随仓库提交）
└── test/{unit,integration}/
```

工程约定：

- `lib/` 随源码提交，`github:` 直装可用（构建挂 `prepublishOnly`）；
- 运行时依赖最小化：Host 半只保留 `dsh-llm` 构造器与 schema 库，其余 `import type`；
- `devDependencies` 精确锁本机版本；`peerDependencies` 用显式预发布分支区间。

---

## 8. 分阶段开发步骤

每阶段有产物与**完成判据**。阶段内先查契约，再写代码。

### 阶段 0：脚手架与契约核对（0.5 天）

1. 用 `cordis_inspect_query` 拉取 §6 全部服务的精确契约，写入 `docs/api-contracts.md`；
2. **实测两项关键事实**：① `stateOf(session,'tokenUsage')` 是否可用；② `create()` 的 `workspaceId`/`cwd` 是否互斥；
3. 确认本机 Harness 版本，锁 `devDependencies`；
4. 建 `package.json`、`cordis.patch.yml`、`tsconfig*.json`、`build-client.mjs`；
5. 写 locale、icon、`exports`/`files`；
6. **判据**：`typecheck` 通过，manifest 检查无误。

### 阶段 1：设置层（M9）（0.5 天）

1. `src/settings.ts`：完整 schema、跨字段校验（§4.3）、持久化桥；
2. 单测：越界拒绝、缺字段补默认、硬拒绝、全部警告路径；
3. **判据**：单测全绿。

### 阶段 2：度量层（M2）（1 天）

1. `src/measure.ts`：
   - `readContextOccupancy(session)` → `{ used, window, percent, quality }`
   - `readCumulativeUsage(session)` → `{ tokens, source }`
   - `measure()` 异常包装（不抛出，返回 `{ unavailable, error }`）；
2. 单测覆盖：window 缺失、baseline `none`/`estimated`/`usage`、measure 抛错、投影缺失回退；
3. **判据**：对真实会话打印占用率，与页面上的上下文指示一致（允许 ±5% 启发式误差）。

### 阶段 3：触发引擎（M3）（1 天）

1. `src/trigger.ts`：评估防抖、水位去重、三种触发判定、优先级、重臂与滞回、次数上限、首次基线规则；
2. `src/state.ts`：状态表 + `session/disposed` 清理；
3. 接入 `session/event`（本阶段只产出「建议动作」日志，不真正执行）；
4. 单测：把 §3.5 互斥矩阵逐行变成用例；
5. **判据**：模拟事件流时动作序列与预期完全一致，无重复触发。

### 阶段 4：软终止（M4）（1 天）

1. `src/graceful-stop.ts` + 协调器骨架；
2. 人类提示守卫、`whenIdle` 等待、`slowWarning`、总时限释放；
3. 替身 Agent 的 `cancel` 是 spy，断言调用次数 **0**；
4. **判据**：对真实空闲会话能「设闩锁 → 边界即达 → 释放」，原会话照常可用。

### 阶段 5：交接简报（M5）（1 天）

1. `src/session-summary.ts`：事实读取（含占用率）、九段骨架、脱敏、模型调用；
2. 失败路径：生成失败/为空 → 放弃迁移；
3. 单测：骨架渲染、脱敏矩阵、空摘要拒绝；
4. **判据**：测试会话产出结构正确的简报。

### 阶段 6：会话迁移（M6）（1.5 天）

1. `src/session-migration.ts`：建会话 → 逐项继承 → attach → 投递 → 核验；
2. 失败矩阵（附录 B）全部覆盖；
3. 集成测试：真实 Cordis Context + 替身服务；
4. **判据**：真实环境手动 `/handoff`，新会话带简报启动、旧会话停用。

### 阶段 7：自动压缩（M7）（1 天）

1. `src/compact-handler.ts`：busy 退避、`null` 结果语义、「继续任务」边界、压缩后立即复评；
2. 单测覆盖 F6；
3. **判据**：调低阈值触发一次压缩，原会话可继续。

### 阶段 8：命令与 HTTP（M1 + M10）（0.5 天）

1. `src/command.ts` 四命令；`src/routes.ts` 四路由 + loopback 校验；
2. **判据**：命令不进模型历史；curl 得到正确快照。

### 阶段 9：浏览器半（M12 + M13）（1.5 天）

1. `protocol.ts` → `follow.ts` → `card.ts` → `index.ts`；
2. 设置卡五区 + 进度条 + 禁用规则；
3. follower：基线、跃迁、refresh→open、blank 重试、错误隔离；
4. **判据**：设置卡可操作；`/handoff` 后自动跳到新会话。

### 阶段 10：整装联调与文档（1 天）

1. `build` + 全量测试 + `install_bundle` 安装；
2. 端到端：手动交接、**占用率自动交接**、累计自动交接、压缩、cancel/retry；
3. 降级路径：无 settings / 无 webServer / 无 window / 无 compaction；
4. README + 限制清单；
5. **判据**：§11.2 验证清单全过。

> 总预估：约 11–12 个工作日（单人、含测试）。

---

## 9. 测试矩阵

### 9.1 单元测试

| 文件 | 覆盖 |
| --- | --- |
| `redaction.test.ts` | 脱敏矩阵 |
| `measure.test.ts` | 占用率/累计、三种标注、window 缺失、异常 |
| `trigger.test.ts` | 优先级、防抖、水位、重臂、滞回、次数上限、首次基线 |
| `settings.test.ts` | 越界、补默认、硬拒绝、警告 |
| `session-summary.test.ts` | 骨架、事实段、空摘要 |
| `graceful-stop.test.ts` | 人类提示守卫、reject 语义、超时释放 |
| `coordinator.test.ts` | 单动作互斥、阶段机、幂等 |
| `command.test.ts` | `/handoff status` 渲染 |
| `compact-handler.test.ts` | busy 退避、null、继续任务边界 |
| `follow.test.ts` | 基线、跃迁、blank 重试、放弃、错误隔离 |

### 9.2 集成测试

- 真实 `@deepseek-ai/cordis` + 可控替身服务；
- 真实插件模块 `apply()`、真实事件总线、真实 HTTP handler；
- 覆盖迁移全链路、继承各失败分支、工作区归属、装卸回收、`session/disposed` 清理；
- **铁律**：所有替身 Agent 的 `cancel` 是 spy，结束时断言调用 0 次。

### 9.3 场景级验收

| # | 场景 | 预期 |
| --- | --- | --- |
| S1 | 手动 `/handoff` | 边界停下 → 新会话带简报 → 自动跳转 |
| S2 | 占用率到 85%（触发方式=context） | 自动交接，交接后旧会话不再触发 |
| S3 | 占用率到 70%（压缩开启） | 只压缩，不交接 |
| S4 | 压缩后仍 ≥85% | 压缩完立即交接 |
| S5 | 压缩后 78%（滞回带内） | 不重新武装 |
| S6 | 累计到 200 万（触发方式=cumulative） | 自动交接 |
| S7 | 两种触发同时满足 | 占交接优先，只执行一次 |
| S8 | window 缺失 | 不触发占用率，UI 明示 |
| S9 | 插件启动时会话已 90% | 首次只建基线，不触发 |
| S10 | 动作失败后 | 闩锁释放、原会话可继续、`retry` 可用 |
| S11 | 迁移中用户发消息（前置/后置） | 放弃并放行 / 转投新会话 |

---

## 10. 风险与限制

| # | 限制 | 原因 | 应对 |
| --- | --- | --- | --- |
| L1 | 无独立「软停止」服务 | Harness 未提供 | `agent/pre-step` reject |
| L2 | 被 reject 的 step 中已 claim 的消息不写历史 | dsh-agent 契约 | 人类提示守卫 |
| L3 | 无法从 Host 删除旧会话消息 | 日志只追加 | 迁移期新消息转投 |
| L4 | 协调状态不落盘 | 不新建数据库 | 内存态 + 文档说明 |
| L5 | 静态包无通用 Host↔Client RPC | 平台限制 | `webServer` 路由 + fetch |
| L6 | `custom` 权限无法整体继承 | 无 preset 名 | 逐项继承 + 报告未继承项 |
| L7 | 服务可能晚于 `apply()` 发布 | Loader 并发装配 | 全部惰性读取 |
| L8 | `purpose` 是封闭联合 | 当前版本声明 | 不传 `purpose` |
| L9 | `contextWindow` 可能缺失 | 模型/适配器能力 | 占用率触发停用并明示 |
| L10 | `measure()` 是 O(surface) | 实现成本 | 防抖 + 水位去重 |
| L11 | 估算与真实 usage 有偏差 | 数据源 | 标注 `estimated`，不掩盖 |
| L12 | Web 面 `planMode`/`compaction` 在 preset realm 内 | 宿主行被禁用 | `agentPresets.serviceFor` 解析 |
| L13 | cwd 未注册工作区时新会话「未分组」 | 不自动建工作区 | 标记「回退」并说明 |
| L14 | 简报未启动 turn 时新行仍 blank | 只有重拉列表重算 | follower refresh→open + 重试 |
| L15 | 自动跳转只在浏览器半生效 | 纯 UI 行为 | 未开页面时迁移照常完成 |

---

## 11. 安装、验证与发布

### 11.1 安装

```
plugin_manager install_bundle（绝对包目录）→ 重启生效
```

- Host 改动需重装/重启；Client 半有 HMR 时可热更；
- 用 `cordis_inspect_query`（Config.listConfigs / Slots.listSubTree）确认行与卡注册。

### 11.2 验证清单

- [ ] 四条命令可用且不进模型历史
- [ ] 空白会话拒绝
- [ ] 新会话继承：cwd、工作区、preset、模型、权限、Plan 模式逐项核对
- [ ] 简报九段完整、事实段正确、脱敏生效
- [ ] 执行中的 Step 不被中断（turn 在边界以 blocked 收尾）
- [ ] 迁移期新消息：前置放弃 / 后置转投
- [ ] **占用率触发**：调低阈值到 30% 能稳定触发；恢复后不重复触发
- [ ] 累计触发、压缩、优先级与滞回符合 S1–S11
- [ ] window 缺失时只有 B 生效且 UI 明示
- [ ] 设置卡校验、进度条标注、按钮状态正确
- [ ] 自动跳转（含 blank 重试）
- [ ] 三种降级路径
- [ ] 卸载后监听器/定时器/闩锁全部回收

### 11.3 发布（可选）

`npm publish`（`prepublishOnly` 构建）→ GitHub 保持 `lib/` 提交 → 提交 dsh-market。

---

## 附录 A：状态机

```
                    ┌──────────┐
        ┌──────────►│   IDLE   │◄─────────── 失败/取消后释放闩锁
        │           └────┬─────┘
        │                │ request(handoff|compact)
        │           ┌────▼──────────┐
        │           │   PREPARING   │
        │           └────┬──────────┘
        │                │ 设闩锁
        │           ┌────▼────────────────────┐
        │           │ WAITING_FOR_STEP_BOUNDARY│──超时──► FAILED
        │           └────┬────────────────────┘
        │                │ pre-step reject + whenIdle
        │           ┌────▼──────────┐
        │           │  SUMMARIZING  │──摘要失败──► FAILED（保留原会话）
        │           └────┬──────────┘
        │           ┌────▼──────────┐
        │           │CREATING_SESSION│──创建失败──► FAILED
        │           └────┬──────────┘
        │           ┌────▼──────────┐
        │           │ TRANSFERRING  │──投递失败──► FAILED（返回新会话 id）
        │           └────┬──────────┘
        │           ┌────▼──────────┐
        └───────────│  COMPLETED    │  旧会话 retired
                    └───────────────┘
```

## 附录 B：失败矩阵

| 失败点 | 行为 |
| --- | --- |
| 无法读取会话历史 | 中止，保留原会话，报原因 |
| `measure` 失败 | 跳过本次评估，记 warning |
| 摘要生成失败/为空 | 放弃迁移，零写操作 |
| 新会话创建失败 | 保留原会话，可稍后重试 |
| 逐项继承失败 | 逐项降级并列出原因 |
| 简报投递失败 | 不假装成功：返回已建会话 id |
| attach 工作区失败 | 标记「未继承」，迁移仍算成功 |
| 压缩失败（busy） | 退避重试 ≤3，之后放弃且不更新重臂 |
| 压缩失败（其它码） | 一次性失败并报错 |
| 动作超时 | 释放闩锁、恢复运行、标记失败 |
| 插件卸载 | 回收监听器/定时器/闩锁，`Promise.allSettled` |

## 附录 C：决策记录

| # | 决策 | 备选 | 理由 |
| --- | --- | --- | --- |
| D1 | 占用率改用 `surfaceTokens ÷ contextWindow` | 用单次请求 usage | usage 是单次调用计费，不是「当前上下文大小」；`surfaceTokens` 才是模型下一步真正看到的量 |
| D2 | 默认只开占用率触发，且自动交接默认关 | 默认开 | 默认关保证零干扰；占用率是用户最关心的度量，设为默认触发方式 |
| D3 | 阈值用百分比而非绝对 token | 绝对 token | 200k 窗口与 1M 窗口的「满」含义不同；百分比跨模型可迁移 |
| D4 | 交接优先于压缩 | 压缩优先 | 避免「压完又满」抖动；交接是终局动作 |
| D5 | 压缩阈值默认 70%，交接 85% | 都设 85% | 留 15% 余量给压缩生效，避免同点竞争 |
| D6 | 压缩后立即复评 | 等下一个事件 | 压缩可能无效，需要立刻决定是否交接 |
| D7 | 首次观察只建基线 | 立即触发 | 启动即触发会让用户莫名其妙失去会话 |
| D8 | `measure()` 防抖 5s | 每事件 | O(surface) 成本，热路径不能每个事件都跑 |
| D9 | 设置走 `Config` + `settings.update` | 独立设置文档 | 本机 `settings` 服务无 `installSection`；Config 是唯一受支持的持久化面 |
| D10 | 简报投递用 `agent.followup` | `sessionController.prompt` | 后者固定记 `user-rpc`，破坏来源语义 |
