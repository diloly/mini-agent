# 以 DSH 为镜：源码阅读与对照方法

> 目的不是「学会用 DeepSeek Harness」，而是**借它校准自己的 harness**。
> 每读一个模块，必须产出一条「我要怎么改自己」的决定；产不出来，这次阅读作废。

参考仓库：`https://github.com/deepseek-ai/deepseek-harness`（分支是 **master**，不是 main）
官方文档：`https://deepseek-harness.github.io/deepseek-harness/`

---

## 0. 三条原则

1. **不读全量，只读同题。** DSH 是 60+ 包的产品级 monorepo（`packages/` 下按能力分组：core / llm / tools / session / compaction / spill / guard / sandbox / skill / subagent …）。通读是无效功，读你**已经做过取舍**的题才有对照价值。
2. **先文档后源码，先契约后实现。** 它每个包都有 `README.md`，每个子系统都有 `docs/subsystems/*.md`。先读文档建立契约，再进 `src` 验证——反过来会被实现细节带跑。
3. **抄问题，不抄答案。** 你的约束（单进程 Electron、串行工具、16 轮上限）和它不同，照搬设计只会做出一个四不像。

---

## 1. 阅读路线（按顺序，别跳）

| # | 入口 | 要回答的问题 |
|---|---|---|
| 1 | `docs/architecture.md` | 它怎么分层？我的 `loop.ts` 在它那儿对应哪个包？ |
| 2 | 同文件的 **Turn flow** 一节 | 一次 turn 拆成哪些 step/事件？我的循环里哪些是硬编码的？ |
| 3 | `docs/subsystems/tools.md`、`docs/tool-execution-pipeline.md` | 工具执行有几个钩子？我只有「执行」，缺哪些前后置？ |
| 4 | `docs/subsystems/session.md` | 它为什么把消息存在**事件日志**里，而不是存 `messages` 数组？ |
| 5 | `docs/agent-lifecycle.md` | 中断、失败、重试分别落在哪个事件上？ |
| 6 | `packages/core/agent-loop/README.md` | 最后才看实现，且只在这个 README 指路之后看 |
| 7 | `.agents/notes/implemented/architecture/*.md` | **决策记录**。这是整个仓库最值钱的东西，见下 |

### 两个高杠杆技巧

**① 先看它启动了什么，而不是先看代码。**

```bash
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness && pnpm install && pnpm run build
pnpm dsh web --profile web --dump-config
```

`--dump-config` 会打印这台机器实际加载的插件树。**任何一个插件行都能被 patch 掉**——这就是「一切皆插件」的字面含义。看完这棵树，你对「harness 由哪些能力组成」的理解会立刻结构化，比自己猜快十倍。

**② 读决策记录，不读 commit message。**

DSH 把架构决策写成了独立文档，例如 `2026-09-02-system-prompt-as-surface-node.md`、`2026-08-31-released-session-format-migrations.md`。每篇都记录了：问题是什么、备选方案有哪些、为什么选这个、代价是什么。

这正好是你 `docs/` 缺的那一层。你现在的文档写的是「系统长什么样」（架构/PRD/设计），缺的是「**为什么不是另一种样子**」。后者才是面试官真正想听的。

---

## 2. 四步对照法

```
定位同题  →  抄下自己的约束  →  读它的实现  →  写差异笔记  →  自己重写自己的代码
```

1. **定位同题**：拿你一个文件，去它那儿找一个包。找不到对应 = 这题你没做，先记下来（比如 subagent、sandbox）。
2. **抄下自己的约束**：动它的源码之前，先用两行写下你当时为什么这么做（`MAX_TURNS = 16` 是因为实测 4 步任务要 9~11 轮）。**没有约束的对照是无效对照**——你会误以为「它更高级」，其实只是场景不同。
3. **读它的实现**：只读该包的 `README.md` + 主文件，**限定 30 分钟**。读不完说明这个包太大，拆成两个题。
4. **写差异笔记**：固定三栏 —— 我的做法 / 它的做法 / 差异的代价。第三栏最重要，也是最容易写空的一栏。
5. **自己重写**：改自己的代码，**不许让 AI 代写**。这一步是把「读懂」变成「会」的唯一环节。

---

## 3. 对照清单

> 状态列由你自己维护：`待读` / `已读` / `已改` / `不改（附理由）`
> 「不改」也是有效结论，但必须写清理由。

| # | 题目 | 我的位置 | DSH 位置 | 状态 |
|---|---|---|---|---|
| 1 | 循环终止条件 | `loop.ts` `MAX_TURNS = 16` | `packages/guard`（重复调用提醒 + 执行截止期） | 待读 |
| 2 | 工具结果溢出 | `loop.ts` `TOOL_RESULT_PREVIEW_LIMIT = 200` | `packages/spill` | 待读 |
| 3 | 上下文压缩 | 无（只做了用量百分比） | `packages/compaction` | 待读 |
| 4 | 工具并发调度 | 明确串行（MVP 取舍） | `packages/core/tools` 执行流水线 | 待读 |
| 5 | 工具前后置钩子 | 只有「执行」 | `tools/pre-execute` / `post-execute` | 待读 |
| 6 | 消息持久化 | `storage.ts` + `checkpoint.ts` 直接存 messages | `packages/core/session`（append-only 事件日志，`deriveMessages()` 投影） | 待读 |
| 7 | 中断与失败恢复 | `createAbortError` + 错误回灌 | `agent/assistant-attempt` + 补写缺失 tool result | 待读 |
| 8 | 进度通知 | 回调 `onDelta` / `onStep` | `agent/assistant-stream` + `session/event` | **已改（见 §4）** |
| 9 | 技能加载 | `skills/catalog.ts` 渐进加载 | `packages/skill`（provider 注册表 + 目录/加载器） | 待读 |
| 10 | 脚本执行隔离 | `skill-runtime/run-process.ts` 直接 spawn | `packages/sandbox`（bwrap / Landlock / Seatbelt） | 待读 **安全题，面试必问** |
| 11 | 系统提示词组装 | 硬编码字符串？ | `packages/core/system-prompt`（section 组装） | 待读 |
| 12 | 子代理 / 委派 | 无 | `packages/subagent` | 待读 |
| 13 | 后台任务 | 无 | `packages/jobs` | 待读 |
| 14 | 计划与待办 | 自建 `update_plan` 工具 | `packages/plan` / `packages/todo` | 待读 |

第 10 项优先做。你的技能运行时直接 spawn 进程、跑用户装的脚本，没有隔离层——这是真实的安全缺口，也是能讲出深度的话题。

---

## 4. 示范：循环的驱动方式（已完成 → 2026-10-20 修订落地）

### 我的做法（改动前）

`loop.ts` 用 `HarnessCallbacks` 三个回调把外部能力直接绑在循环上：

```ts
export interface HarnessCallbacks {
  onDelta: (delta: string) => void;
  onStep: (step: ToolStep) => void;
  onCheckpoint?: (convo: LlmMessage[], turn: number) => void;
}
```

353 行，UI 渲染和 checkpoint 落盘都是循环的**内部细节**。想给 UI 加一个「工具耗时」，就得改 `loop.ts`。

更具体的耦合面（本次改动的直接动机）：`onStep` 的 `ToolStep` 是渲染层展示结构；`contentOffset`（正文分界点）是纯 UI 布局参数却由 loop 生产并落进持久数据；`onToolCallStart` 在流式期间被回调，只为让 UI 提前显示「正在调用」；`ToolContext.emitPlan` 让 update_plan 工具直接持有渲染层通道。**每加一个 UI 需求都要改 loop 的契约。**

### 它的做法

turn / step 全部表达为**事件**，分两个域：

- **durable**：`turn/start`、`step/start`、`user/message`、`assistant/message`、`tool/result` …… 进 append-only 的 session log，重载后可重放。
- **live**：`agent/assistant-stream`、`agent/pre-step`、`agent/request`、`tools/execute` …… 只在本进程内广播，UI 是消费者，**不 import loop**。

配套的原则是那句 **「Model-visible means logged」**：模型能看到的一切必须能从日志重建。所以它不是「存 messages」，而是「从事件日志投影出 messages」（`deriveMessages()`）。

### 差异的代价

| 维度 | 回调（我） | 事件（它） |
|---|---|---|
| 上手成本 | 低，一个文件看完全局 | 高，要先懂 Cordis 的 ctx / 事件 / waterfall |
| UI 耦合 | UI 依赖 loop | UI 只依赖事件契约，loop 可被 HMR 换掉 |
| 可测性 | 要 mock 三个回调 | 订阅事件即可断言 |
| 持久化 | 循环里调 `onCheckpoint` | 事件落盘，与循环解耦 |
| 调试 | 断点少、路径短 | 事件多，需要 trace 工具 |

### 落地（2026-10-20）：只取「事件契约」这一层

**不建事件总线、不引 Cordis、不搞 append-only session log**（上述「不划算」判断不变），但把最初「摘一个依赖」的小事升级为完整的事件契约：**loop 只发领域事实，UI 信封与落盘时机全部收进 IPC 适配层一处**。

| 旧（回调） | 新（`harness/events.ts` 的领域事件） |
|---|---|
| `onDelta(delta)` | `{ type: 'text', delta }` |
| `onStep(ToolStep)`（UI 展示结构） | `{ type: 'tool-call-start' }` + `{ type: 'tool-call-end', ok, preview, elapsedMs }` |
| `ToolContext.emitPlan(PlanStep[])`（工具直推 UI） | 工具经 `ToolResult.plan` 交回数据，loop 发 `{ type: 'plan-updated' }` |
| `onCheckpoint(convo, turn)`（loop 管落盘） | `{ type: 'conversation-snapshot', convo, turn }` 中性事实，落不落由消费方定 |
| `ToolStep.contentOffset` 由 loop 打 | 适配层按「事件到达时已看到多少正文」折算 |

落点：`src/main/harness/events.ts`（契约）、`loop.ts`（只产事件）、`ipc.ts` 的 `runChatStream.emitHarness`（**唯一**适配层）。IPC 事件契约与渲染层零改动，无感升级。

### 我的决定（2026-10-20 修订）

~~**不重构成事件总线**~~ —— 这条**依然成立**：单进程 Electron、单人维护，事件总线那套基础设施的收益撑不起成本。

但最初的「小事」（把 onCheckpoint 改成注入的落盘函数）只摘了持久化一个依赖，UI 耦合原样保留，代价一直在付：工具耗时、「思考中」状态行、SVG 图标，每次 UI 需求都要动 loop 或它的回调契约。所以升级为上面那一步——**保留判断（不建总线），落实行动（UI 不进门）**。

> 面试话术同步更新为：「我知道事件驱动在 DSH 里是对的，但在我的约束下事件总线不划算——所以我取它最值钱的那一层（事件契约），让 loop 只陈述事实，把 UI 信封、展示字段、落盘时机收进唯一一个适配层。将来做上下文压缩或回放，消费方直接在事件上挂，loop 一行不用改。」

---

## 5. 面试话术

不要说「我写了一个 agent harness」。说这三句：

1. 「我实现过一个桌面端 agent harness，核心循环 353 行，支持工具调用、技能渐进加载、中断续跑。」
2. 「后来 DeepSeek 开源了 DSH，我拿它的 `agent-loop` 和 `spill` 对照过自己的实现——比如工具结果溢出，我用的是固定长度硬截断，它是把大结果 spill 到存储再给模型一个引用。」
3. 「我没有照搬它的插件化架构，因为……（说你的约束和代价）。」

第 3 句是分水岭。前两句证明你做过，第三句证明你想过。

---

## 6. 纪律

- 一周一个题目，多了必烂尾。
- 每篇笔记 ≤ 800 字，写不下说明没想清。
- 读完必须有一次 commit，commit message 写「为什么改」，不写「改了什么」。
- 笔记攒够 5 篇，直接整理成一篇博客 —— 这是求职时比 README 更有说服力的东西。
