# 交接链路验收（2026-10-23）

上一段会话把「E / D / I-1 三项验收」留在未完成里，本文件是那三步的实测结果，以及复查中发现并修掉的第四个缺陷（E1）。

## 一、验收方法：为什么不是「在 fork 会话里跑一次 /handoff status」

交接计划原本要求在 `session-05402558-bae6-4444-b4e9-c3deeb37ba11` 里执行 `/handoff status`。实测做不到，原因也不是缺陷：

- 宿主在此期间重启过两次（Web GUI 端口从 9834 变为 6386），`05402558` 从未被加载进新进程；
- HTTP `/dsh-session-handoff/state?sessionId=session-05402558-…` 返回
  `{"occupancy":{"quality":"unavailable","used":0},"cumulative":{"tokens":0,"source":"none"}}`；
- 这份输出**不能**判 E 未修好：全库 71 个会话里只有 2 个在内存中，连刚刚压缩成功的
  `9023d291` 也返回同样的 `unavailable`。`used: 0` 是「没有会话对象」，不是「取数失败」。

所以改用更强的证据：把 `app.asar` 里的宿主包解出，用宿主**真实的 `Session.fromRestore`**
还原这份 fork 日志，再把同一个对象交给插件的真实代码。

```
REAL Session constructed: session-05402558-bae6-4444-b4e9-c3deeb37ba11
  snapshotEvents().length = 112
  ownEvents().length      = 2   -> session/end-seed, session/title
  inheritedEventCount     = 110
  requestContext()        = {"provider":"deepseek-account","model":"deepseek-flash",
                             "contextWindow":1000000}
  header.cwd              = D:\Workspace\DeepSeek Harness
  header.parentSession    = session-b01f9f16-f04e-4c8b-8d4d-c3fa30f0ab8a
```

## 二、E（fork 历史可见性）：已修好

同一真实 `Session` 对象，交给两条取数路径：

| 路径 | 事件数 | user/message | turn/start | activityCheck | 模型窗口 |
| --- | --- | --- | --- | --- | --- |
| 新代码 `sessionEvents()` | 112 | 3 | 1 | **true → 放行交接** | **1000000** |
| 旧代码 `ownEvents()` | 2 | 0 | 0 | **false → 拒绝「空白会话」** | **undefined** |

旧路径在这个真实 fork 上确实只看得到 `session/end-seed` + `session/title`，判为空白并拒绝交接，
且拿不到 `request/context`，窗口为 `undefined`。这既复现了「拒绝交接」，也解释了旧的
「/handoff status 显示不可用」。

回归用例：`tests/unit/measure.spec.ts` 的 `a real fork whose whole history is inherited`
固定了真实 112 条事件类型序列（逐条对齐，不折叠），并断言索引 12 = `turn/start`、
16–18 = 三条 `user/message`、20 = `request/context`、104 = `tool/result`、110–111 = 自有段。

**变异验证：** 把 `sessionEvents` 改回 `ownEvents` 优先后，该 describe 下 5 个用例全部失败
（`expected undefined to be 'tool/result'` 等）；还原后 260 项全绿。

## 三、D（上下文占用口径）：已修好

真实 fork + 宿主口径的 `contextPressure` projection：

```
occupancy = {"quality":"estimated","used":10165,"window":1000000,
             "percent":0.010165,"baseline":"estimated","source":"contextPressure"}
status 行 = - 上下文占用：10165 / 1000000 tokens · 1% · 估算 · 与输入框一致
```

降级路径（无 projection、仅 tokenMeter）：

```
status 行 = - 上下文占用：300000 / 1000000 tokens · 30% · 精确 · 回退：surface 估算
```

**一处验证手段的缺口（不是缺陷）：** `source` 标记只有命令行 `/handoff status` 输出；
HTTP `/state` 的 `StatePayload.occupancy` 只有 `quality / used / window / percent`
（`routes.ts`）。想从设置卡片或 HTTP 验证「与输入框一致」做不到，必须走命令。

## 四、I-1（未答复提问检测）：已修好

两个分支都实测通过。

「助手最后发言」分支 —— 本会话实际收到的那条简报里就带着这一行（原文）：

```
- ⚠ 原会话末尾：最后一条是助手发言，其后没有用户消息——可能仍在等用户回话，交接不等于已经获得执行「下一步」的许可
```

这正是简报预测到的情况：原会话 `9023d291` 最后一条是助手发言，其后没有用户消息。

「登记未答复提问」分支（来自 `userQuestions` 投影，`dsh-user-questions` 注册
`key: "userQuestions"`，`active[]` 元素为 `{callId, questions, state}`，与读取路径一致）：

```
- ⚠ 未答复提问：是否继续？（程序检测：原会话结束时系统仍登记该提问为未答复）
```

在真实 fork `05402558` 上则**正确地不触发**：该日志最后一条 surface 事件是
`tool/result`（seq 104），不是 `assistant/message`。

## 五、E1（本轮新发现并修复）：状态行把五种原因说成同一种

验收途中发现 `/handoff status` 的「上下文占用」行有一处静默降级：**每一种「没有百分比」
都打印「未知（模型未上报上下文窗口）」，其中两种把责任错归给模型**，还有一种是自相矛盾的句子。

修复前的实测输出：

| 情况 | 修复前 | 问题 |
| --- | --- | --- |
| 会话未加载 | `0 tokens · 未知（模型未上报上下文窗口） · 不可用` | 怪模型，实际是主机看不到这个会话 |
| 表面为空、窗口已知 | `0 / 1000000 tokens · 未知（模型未上报上下文窗口） · 不可用` | 刚打印了窗口，又说没有窗口 |
| 部署缺测量服务 | 同上（怪模型） | 实际是部署没有 `sessionProjections` / `tokenMeter` |
| 模型确实未上报窗口 | 同上 | 这一种才是真的 |
| 测量抛错 | 同上（怪模型） | 实际是测量失败 |

修复：`ContextOccupancy` 增加 `reason` 字段（`no-session` / `no-source` / `empty-surface` /
`no-window` / `error`），由 `measure.ts` 在各条返回路径打标，`command.ts` 按标记出句。
修复后同一组情况：

```
- 上下文占用：0 tokens · 未知（该会话未加载到当前进程，无法测量） · 不可用
- 上下文占用：0 / 1000000 tokens · 空（当前可见表面为空） · 不可用 · 回退：surface 估算
- 上下文占用：10 tokens · 未知（模型未上报上下文窗口） · 精确 · 回退：surface 估算
- 上下文占用：0 tokens · 未知（当前部署没有 sessionProjections / tokenMeter，无法测量） · 不可用
- 上下文占用：250000 / 1000000 tokens · 25% · 精确 · 回退：surface 估算   ← 正常路径无回归
```

## 六、两处只记录、不改行为的事实

**① 两个事件访问器在宿主里已 `@deprecated`。** `dsh-session/lib/index.js` 第 1446 行
（`snapshotEvents`）与第 1461 行（`ownEvents`）都标注 "new calls are prohibited"，依据是
「弃用同步会话事件读取」的 Agent Note。插件整条链路都从这里起步，而宿主建议的
「监听 `session/event` + 折叠投影」无法回答**已经存在**的会话（上个月的 fork、从磁盘恢复的
会话、交接时的原会话）。故保留，理由写入 `contracts.ts` 注释。
失效后果：一旦宿主移除，`sessionEvents` 回退到 `[]`，`activityCheck` 把所有会话判成空白，
`/handoff` 全部拒绝——失败会集中在两个函数里，便于定位。

**② 投递的简报消息没有 `id`，由上层补。** `session-migration.ts` 构造的
`{role, source, content}` 不带 `id`；宿主 `Session.append` 的 `validateSessionEventData`
对实时 append 不强制，但实际投递成功时 `id` 是由 profile 里的 `dsh-context` 包生成的
（本会话 seq 9 的 `dshctx-769dd55f-…`）。即投递依赖一个本函数不设置、本插件也没有声明的字段。
不改行为（宿主 id 格式不在插件可读的契约内），只把耦合写入注释。

## 七、回归基线

```
npx vitest run        ->  Test Files 12 passed (12) | Tests 260 passed (260)
npx tsc -p tsconfig.json --noEmit          -> clean
npx tsc -p tsconfig.client.json --noEmit   -> clean
npm run build                              -> lib/index.js 116.51 kB, lib/client.js 36.59 kB
```

用例数从 248 增至 260：E 真实 fork 4 条、E1 状态措辞 5 条、E1 度量原因 3 条。
