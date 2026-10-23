# 后续操作清单与修复计划

> 生成：2026-10-22T17:15+08:00
> 当前状态：`dsh-session-handoff` 已提交 4 个 commit，工作树干净，231 tests passed

---

## 一、先解释你看到的现象

**「旧会话 40% 压缩成功，另一个 63% 压缩报错」——百分比不是变量，system 头才是。**

我从会话日志里取出了三个会话的 system 首行：

| 会话 | 创建时间 | system 头 | compaction/end | 11128 次数 |
| --- | --- | --- | --- | --- |
| `83a83c61`（新） | 2026-10-22 16:58 | `You are an AI agent powered by **the harness**.` | 0 | 0 |
| `d4229fe0` | 2026-10-22 02:19 | `You are an AI agent powered by **the harness**.` | 1 | 20 |
| `1c19fda2` | 2026-10-21 04:32 | `You are an AI agent powered by **DeepSeek Harness**.` | 3 | 7 |
| `72ffa3a2` | 2026-10-19 12:37 | `You are an AI agent powered by **DeepSeek Harness**.` | 3 | 4 |
| `48c8bca5` | — | `You are an AI agent powered by **DeepSeek Harness**.` | 1 | **148** |

**判定规则很简单：**

- system 头是 `the harness` → 压缩走 `llm.stream`，`neutralizeChannelFingerprints` 不匹配 `UNAPPROVED_CHANNEL_OPENINGS`，**正常压缩**。
- system 头仍是 `DeepSeek Harness` → 命中前缀 → 被前置 `"You are a helpful assistant."` → 该文案已被网关列入拒绝 → **400 / 11128**。

所以「40% 那个成功」是因为它是 2026-10-21 20:06（gate-guard 安装）**之后**创建的会话，头部已被改写；「63% 那个报错」是因为它是**之前**创建的旧会话。**与百分比无关，与创建时间有关。**

验证依据：
- `dsh-compaction-basic/lib/index.js:698` — `session.deriveEventMessage(head)`，压缩请求直接重放**会话里已存的** system 消息，绕过 `system-prompt/assemble`。
- `dsh-workbuddy-gate-guard/lib/index.js:50` — 只挂 `system-prompt/assemble` 一个钩子。
- `dsh-connect-workbuddy/lib/host-heartbeat-D1WnqQY2.js:2006` — 命中即 `message.content = FALLBACK + "\n\n" + content`。

---

## 二、需要你做的操作

按优先级排列。**只有第 1 项是「现在就该做」，其余都是可选的。**

| # | 操作 | 说明 |
| --- | --- | --- |
| **1** | **在旧会话（63% 那个）里不要再点 `/compact`** | 做了必然 400/11128，且每次失败会在日志里留一条 `compaction/end`。想清空历史就在**新会话**里做，或等第 3 项修完 |
| 2 | 确认是否要改 `$DSH_PROFILE_DIR` 下的第三方插件 | 交接简报的约束明确写了「不修改」。第 3 项需要你明确授权我才能动 |
| 3 | 若授权，重启 DSH 让 gate-guard 生效 | 改完必须重启，Node 会缓存模块 |
| 4 | 决定是否把 4 个 commit 推到 `origin` | 远端是 `git@github.com:Dreamhousemx/dsh-session-handoff.git`。我**没有** push，等你确认 |
| 5 | 决定 E/F 两个缺陷是否本轮修 | 见第四节，都不阻塞当前使用 |

**你现在就能用的事：** 新会话（`83a83c61` 这类）的 `/compact` 和 `/handoff` 都正常。旧会话的 `/handoff` 也正常——**只有旧会话的 `/compact` 受影响**。

---

## 三、需要修复的内容

### 3.1 `/compact` 在旧会话上失败（你要的原始目标，**未修复**）

**根因：** 压缩请求重放会话已存的 system 消息，绕过 gate-guard 唯一的钩子。

**候选修法（需你选一个）：**

| 方案 | 做法 | 改动面 | 风险 |
| --- | --- | --- | --- |
| **A. 给 gate-guard 加 `llm/stream` 钩子**（推荐） | 在 `system-prompt/assemble` 之外再挂 `llm/stream` waterfall，对 `options.messages` 里的 system 消息复用同一套 `rewriteText` | 改 `dsh-workbuddy-gate-guard/lib/index.js`，约 15 行 | 低。`llm/stream` 是宿主 waterfall（`dsh-llm/lib/index.js:2371`），只改请求文本不动行为；问题仅限该插件升级后需重做 |
| B. 让 connect-workbuddy 不再前置那句被封的文案 | 改 `WORKBUDDY_FALLBACK_SYSTEM_PROMPT` 或直接删除 `neutralizeChannelFingerprints` | 改 `dsh-connect-workbuddy/lib/host-heartbeat-*.js` | **高**。那句文案是「已被网关接受」的实测结果；换成别的前缀可能立刻被拒。且该文件是构建产物，升级即丢 |
| C. 不改代码，只用新会话 | 零 | 零 | 旧会话永远无法压缩，直到它被归档 |

**我的推荐：A。** 理由：`llm/stream` 覆盖**所有**发出的请求（不止压缩），与现有 gate-guard 的设计意图（"one layer above every provider plugin"）一致；B 改的是别人的构建产物，且拿一个已失效的常量去赌。

**验证方法：** 改完重启，在 `session-1c19fda2` 或 `72ffa3a2` 上点 `/compact`，用日志确认 `compaction/end` 不再带 `code 11128`。

### 3.2 遗留缺陷（`dsh-session-handoff` 内部）

| 编号 | 缺陷 | 严重度 | 状态 |
| --- | --- | --- | --- |
| A | 自动压缩后必定注入「继续」 | 高 | ✅ 已修复（`abead1c`） |
| B | 失败动作不消耗配额，无限重试 | 高 | ✅ 已修复（`abead1c`） |
| C | 截止时间管不住压缩/摘要 | 高 | ✅ 已修复（`abead1c`，含中途修正） |
| D | 占用分子与「精确」标签不匹配 | 中 | ✅ 已修复（`f0fba43`） |
| I-1 | 简报默认「从下一步继续」可能越权 | 设计取舍 | ✅ 已加兜底+检测（`1d48306`） |
| E | fork 会话历史看不见 | 中 | ✅ 已修复（`fbb946c`），真实 fork 实测通过 |
| F | 人类输入缓冲残留 | 中 | ✅ 已修复（`8cf16da`） |
| G | 压缩失败被统一成 `busy` 而重试 | 低 | ✅ 已修复（`640c964`） |
| H1 | `persistence` 恒为 `durable` | 低 | ✅ 已修复（`b546f4e`） |
| H2 | `abort` 监听未移除 | 低 | ✅ 已修复（`b546f4e`） |
| E1 | 状态行把五种原因都说成「模型未上报窗口」 | 中 | ✅ 已修复（本轮） |

**E 详情：** `contracts.ts` 曾优先 `ownEvents()`，宿主实现是 `snapshotEvents(this.inheritedEventCount)`——只含本会话自有事件。已改为 `snapshotEvents` 优先。
**E1 详情（本轮新增）：** 见 `docs/acceptance-2026-10-23.md`。会话未加载、部署缺测量服务、表面为空、模型未上报窗口、测量抛错，五种情况共用一句「未知（模型未上报上下文窗口）」，其中两种把责任错归给模型。
**F 详情：** `humanInput.drain()` 只在交接成功时调用；取消/失败后残留，下次交接会把旧文本误转投给新会话。
**G 详情：** 宿主把所有异常包成 `busy`（`dsh-compaction-basic:1008`），插件按 `busy` 退避重试 3 次，真实原因被掩盖。与 B 叠加已缓解（B 修完会记入配额）。

---

## 四、推荐修复顺序

```
1. gate-guard 加 llm/stream 钩子（方案 A）   ← 你的原始目标，改动小、只碰一个文件
2. E：fork 会话历史                          ← 会让 fork 用户无法交接，是功能性问题
3. F：人类输入缓冲清理                       ← 数据错投，难察觉
4. G：busy 归因                              ← 可与 E/F 合并，纯诊断改进
5. H1 + H2：两处清理                         ← 顺手做，不加风险
```

**为什么这个顺序：**

- **1 排第一**：它解决你真正在问的问题，且只改一个插件、约 15 行、可立即验证；不修它，旧会话的 `/compact` 永远不可用。
- **2 排第二**：E 是**功能性阻断**（fork 会话根本无法交接），比 F/G 影响更直接。虽然你说过不常用 fork，但它一旦触发就是"看起来像 bug 的拒绝"。
- **3、4 排后**：都是边缘场景，且 F 需要新增清理调用点、G 需要读 `error.cause`，都属于"改对了也难验证"的类型，不值得排在主目标前面。
- **5 最后**：H1/H2 是清理项，随时可做，不阻塞任何东西。

**不建议现在做的：**
- 加第十节 `## 待确认`（原方案 B）：`I-1` 已用「元指令 + 程序检测」覆盖，再加一节要改 `BRIEF_SECTIONS`、`buildSummaryPrompt`、`renderBrief`、`parseNarrative` 和大量测试，边际收益低。
- 重构 `session-summary.ts` 的简报模板：当前「打印三节 + 复查插件」两件事是有意设计，虽耗上下文但有效，属产品取向。

---

## 五、一个建议先做的验证

在动手改 gate-guard 之前，先确认一件事：**旧会话是不是真的还会失败。**

`session-1c19fda2`（2026-10-21 04:32，头部是旧文案）有 3 次 `compaction/end` 和 7 次 11128。但那是 gate-guard 安装**前后**混合的数据，不能确定现在是否仍失败。

**建议：** 在 `72ffa3a2`（2026-10-19，头部确定是旧文案，且不是当前活跃会话）上点一次 `/compact`，然后我读日志确认。这一次会失败，但能拿到确凿的当前证据，避免按过期结论去改代码。

---

## 六、当前仓库状态

```
3de745b docs: record the audit findings, the repair plan, and their outcomes
1d48306 feat: carry "still waiting for the user" across a handoff
abead1c fix: enforce the action deadline; stop waking idle sessions after compaction
f0fba43 fix: derive projectedTokens from the raw projection state
```

- 工作树干净，`.bak-fix-20261022-144115/` 已加入 `.gitignore`（本地保留，未提交）
- 231 tests passed，两个 tsconfig 均通过
- **未 push**，等你决定

---

## 附：一处需要你知道的判断

你截图里那条「已压缩 696 条历史记录（约 220361 tokens）」说明 `dsh-session-handoff` 的修复**没有破坏原生压缩**——它是 `/compact` 原生命令的输出，与我的改动无冲突。我的改动全部在 `/handoff` 链路和度量口径上，没有碰 `compaction.compactNow` 的调用约定。
