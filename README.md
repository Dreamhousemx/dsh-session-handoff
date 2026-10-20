# dsh-session-handoff

DeepSeek Harness 插件：把长会话**结构化交接**给同一工作区里的新会话，并继续未完成的任务。

> 上下文快满时，会话会在**安全的 Step 边界**停下来（不打断正在跑的步骤、工具调用或命令），由会话自己的模型写一份九段交接简报，在同一个工作区创建新会话，逐项继承 preset / 模型 / 权限 / Plan 模式，再把简报作为新会话的第一条消息投递过去。

## 为什么是「上下文用了多少」

多数交接插件按「累计花了多少 token」触发。那衡量的是账单，不是**上下文还剩多少空间**。

本插件默认按上下文占用率触发：

```
上下文占用率 = 当前上下文 token 数(surfaceTokens) ÷ 模型上下文窗口(contextWindow)
```

两个数都来自运行时本身（`tokenMeter.measure()` 与 `session.requestContext().contextWindow`），并且会标注这个数字是**精确**（有提供方 usage 背书）还是**估算**（启发式）。模型不上报窗口时，占用率触发自动停用并明确告知，而不是拿 0% 假装正常。

## 安装

```sh
dsh plugin --profile <profile> add github:<owner>/dsh-session-handoff
# 或本地目录
dsh plugin --profile <profile> add "file:D:/path/to/dsh-session-handoff"
```

安装后重启 dsh。宿主与浏览器半都在同一个包里，无需额外行。

## 用法

| 命令 | 行为 |
| --- | --- |
| `/handoff` | 立即把当前会话交接到同工作区的新会话 |
| `/handoff status` | 阶段、上下文占用率、累计消费、阈值、自动动作次数、最近结果 |
| `/handoff cancel` | 取消进行中的动作（在下一个安全检查点生效） |
| `/handoff retry` | 重试最近一次失败 |

命令不进入模型可见历史。

设置位置：**设置 → 插件 → 会话交接 → 配置**（`plugins.row.config` 槽）。

## 三种自动触发

| 触发 | 度量 | 默认 |
| --- | --- | --- |
| 上下文占用率交接 | `surfaceTokens ÷ contextWindow` | 85% |
| 累计消费交接 | 四个 bucket 之和 | 200 万 token |
| 原地压缩 | 上下文占用率 | 70% |

**优先级：占用率交接 > 累计交接 > 压缩。** 交接是终局动作，压缩只是续命；先判交接，避免「刚压完又满 → 再压」的抖动。

默认**全部关闭**：装上这个插件只多一条命令和一张配置卡，不改变现有会话的任何行为。

## 设置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `autoHandoffEnabled` | `false` | 自动交接总开关 |
| `autoHandoffTrigger` | `context` | `context` / `cumulative` / `either` |
| `autoHandoffAtContextPercent` | `85` | 占用率达到多少百分比交接 |
| `autoHandoffThreshold` | `2000000` | 累计消费阈值（仅 cumulative/either 生效） |
| `autoCompactEnabled` | `false` | 自动压缩开关 |
| `autoCompactAtContextPercent` | `70` | 占用率达到多少百分比压缩 |
| `evaluateIntervalMs` | `5000` | 两次测量的最短间隔（`measure()` 是 O(surface)） |
| `contextRearmDeltaPercent` | `10` | 滞回带：动作后须回落这么多才重新武装 |
| `rearmDeltaTokens` | `200000` | 累计触发后须再增长这么多 |
| `maxAutoActionsPerSession` | `3` | 单会话自动动作上限（交接+压缩共享） |
| `summaryMaxTokens` | `4096` | 简报输出上限 |
| `stepWaitTimeoutMs` | `900000` | 等待边界多久算偏久（只提示，不中断） |
| `actionDeadlineMs` | `1800000` | 动作总时限，到期释放闩锁并标记失败 |
| `openNewSessionOnHandoff` | `true` | 迁移完成后切到新会话 |

**硬规则**：交接与压缩同时开启时，`autoCompactAtContextPercent` 必须**低于** `autoHandoffAtContextPercent`，否则拒绝保存。

## 它绝不会做的事

- **绝不中断正在执行的工作。** 代码库里没有任何 `cancel()` 调用；停止只做两件事：设闩锁、等 `whenIdle()`。
- **绝不吞掉用户消息。** 被拒绝的 Step 里已 claim 的消息不会入库，所以只要这批消息里有人类输入，守卫就放行该 Step。
- **绝不删改原会话日志。**
- **绝不假装成功。** 每项继承结果都会报「已继承 / 回退 / 未继承（原因）」；简报投递失败时连新会话 id 一起返回。
- **绝不创建空会话。** 空白会话拒绝交接。
- **绝不无限循环。** 水位去重 + 重臂基线 + 滞回带 + 每会话动作上限。

## 失败时的行为

| 失败点 | 行为 |
| --- | --- |
| 读取/生成简报失败 | 放弃交接，**保留原会话**，零写操作 |
| 新会话创建失败 | 保留原会话，稍后可 `retry` |
| 某项继承失败 | 逐项降级并列出原因，迁移仍算成功 |
| 简报投递失败 | 不假装成功：返回已建会话 id，可手动继续 |
| 等不到 Step 边界 | 超时后释放闩锁、恢复原会话、标记失败 |
| 压缩 busy | 250ms 退避重试 ≤3 次；到上限放弃但不更新重臂 |

失败后闩锁一定释放，原会话立即可继续工作。

## 验证情况（本机 dsh 0.2.1-rc.2）

已通过（有证据，非推断）：

| 项 | 证据 |
| --- | --- |
| 类型检查 | 宿主 + 浏览器两份 tsconfig 均无错误 |
| 单元测试 | **164 个用例全绿**（度量、触发、软终止、简报、迁移、压缩、协调器、命令、follower、契约形状、客户端激活） |
| 构建产物 | Host ESM `lib/index.js` + Client `lib/client.js`，客户端只 `require("react")`，信封为 `window.__ModuleLoader__.load` |
| **在真实镜像里激活（宿主）** | 独立 profile 跑 `dsh headless`，**无 "did not activate" 警告**（最小组合与完整 profile 都验过） |
| **配置 schema 可被宿主投影** | `cordis_inspect` 返回 `status: "schema"`，14 个字段的默认值与范围完整；`limitations: []` |
| **安装生效** | `plugin_manager install_bundle` 返回 `application: "applied"` |
| **命令与路由注册** | 驱动安装副本的 `apply()`：命令 `handoff`、路由 `prefix /dsh-session-handoff`、`agent/pre-step` 与 `session/event` 监听器均已挂 |
| **命令真实返回** | `/handoff bogus` 走真实 handler，返回 `{"kind":"error","text":"未知子命令「bogus」…"}` |
| **配置卡注册** | 驱动安装的 `lib/client.js`：`plugins.row.config` / `dsh-session-handoff#dsh-session-handoff` 注册成功，注入 `getSettings`/`saveSettings`/`sessionId` |
| **客户端只声明 `slots`** | `inject: ["slots"]`，不再等待不存在的服务 |
| **状态路由在活实例上真实响应** | 桌面端 `GET /dsh-session-handoff/state?sessionId=…` 返回完整快照，字段与 `protocol.ts` 的 `HandoffState` 逐项同形；`occupancy.quality: "exact"`、`persistence: "durable"` |
| **读配置路由返回已存值** | `GET /dsh-session-handoff/config` 在 profile 存 40% 时返回 `40`，**不是代码默认的 85** —— 正是「卡片显示 85% 说明读失败」那条判别信号的反向证据 |
| **写配置往返打通** | POST 40→45：`cordis.patch.yml` 落盘 `45`，`/config` 读回 `45`；再写回 40，文件与测试前**逐字节一致**（幂等、无副作用） |
| **越权输入被拒** | 缺 `sessionId` → `400 {"ok":false,"error":"缺少 sessionId"}`；未知动作 → `{"ok":false,"error":"未知操作"}` |

需要在浏览器中人工确认的两项，步骤与逐项期望值见
[`docs/web-acceptance-checklist.md`](docs/web-acceptance-checklist.md)：
配置卡的**视觉渲染**、一次真实的**完整交接**（换会话）。

> 2026-10-20 21:5x 补充：`renderStatus` 与 `/handoff` 命令族此前**没有测试覆盖**
> （只测了 `parseCommandArgs`），`/handoff status` 的实际文本全靠人读源码。现补
> `tests/unit/command.spec.ts`（13 例），把子命令表、三种继承标签、以及「窗口缺失时
> 明说未知而不是印 0%」钉住，测试总数 151 → 164。

### 五条实测出来的关键契约（都已修正）

1. **不要 `inject` 一个当前组合可能没有的服务**。注入了，整行会永久 `pending`，插件根本不激活。宿主侧现在只注入 `sessions`，其余惰性 `ctx.get`。
2. **客户端服务名是 `configForms`，不是 `forms`**。客户端服务目录里没有 `forms`；声明它会让**整个浏览器半**保持休眠。现在客户端只注入 `slots`，`configForms` 与 `sessions` 都按需软取。
3. **`Config` 必须是 `schemastery` 实例**。`dsh-settings` 读 `schema.meta`、遍历 `schema.dict`、调 `schema.toJSON()` 来投影配置页；普通对象只会得到 `status: "unsupported"`——行在，但配置页永远不出现。
4. **`Config` 同时必须是 Standard Schema**。Cordis 的 `resolveConfig` 调 `Config['~standard'].validate(raw)` 并要求**同步**返回；`schemastery` 自带该接口，所以一份声明同时满足 3 和 4。
5. **`schemastery` 要写成真依赖**。完整 profile 里它只是被别的插件**提升（hoist）**上来的传递依赖；最小组合里根本没有。依赖侥幸存在，会在那个插件被卸载时崩掉。


## 已知限制

- 协调状态（阶段、闩锁、计数）只在内存中，重启后丢失；**设置**与**已创建的新会话**不受影响。
- `custom` 权限预设没有名字可重放，只继承审批策略，并在报告中注明「sandbox 档位未继承」。
- 模型不上报 `contextWindow` 时，占用率触发不可用（累计触发仍可用）。
- 原会话本轮迁移期间收到的新消息：交接前置阶段会放弃交接并放行消息；交接后置阶段转投新会话。
- Web 面上 `planMode` / `compaction` 位于各 preset 的隔离 realm 内，按 agent 解析，宿主平面读取仅作回退。

## 许可

MIT
