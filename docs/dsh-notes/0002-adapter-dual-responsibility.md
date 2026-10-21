# 0002 · 适配层该不该同时管 UI 和持久化

- **日期**：2026-10-20
- **对照对象**：DSH 的 session log / event 域（`docs/architecture.zh.md`、`docs/event-producer-consumer.zh.md`、`packages/core/session/src/known-event-types.ts`）
- **我的文件**：`src/main/ipc.ts` L646-727（`runChatStream` 内的 `emitHarness` 闭包）

## 我的做法

上一轮解耦后，`loop.ts` 只发领域事件，`ipc.ts` 的 `emitHarness` 成为唯一适配层。它现在长这样：

```ts
const emitHarness = (event: HarnessEvent): void => {
  switch (event.type) {
    case 'text':                  // ① UI：CHAT_CHUNK + session.text 累加
    case 'tool-call-start':       // ① UI：CHAT_STEP(running) + contentOffset 折算 + stepMap
    case 'tool-call-end':         // ① UI：CHAT_STEP(done/error) + stepMap
    case 'plan-updated':          // ① UI：CHAT_PLAN + session.plan
    case 'conversation-snapshot': // ② 持久化：checkpoint.writeCheckpoint()，零 emit
  }
};
```

**一个 switch，两个职责。** 用户一眼看出问题：DSH 里 session log 是事实源，UI 和持久化是**并列的订阅者**；我这里却是「UI 适配的 switch 里塞了一个持久化 case」。

## 它的做法

- durable 事件（`turn/start`、`assistant/message`、`tool/call`、`tool/result`）进 append-only session log，**日志是唯一事实源**。
- UI 是消费者：从 `session/event` 投影出视图，不接收视图模型。
- 持久化不是「另一个写盘动作」，而是**日志本身就是持久化**——不存在「UI 写完再顺手存一份」。
- 横切能力（checkpoint policy、记忆提炼、遥测）全部挂事件监听，loop 不知道谁在听。

## 差异本质

| 维度 | 我 | 它 |
|---|---|---|
| 事实源 | 两套（messages + checkpoint） | 一套（事件日志），checkpoint 是副产品 |
| 消费者关系 | switch 里的并列 case（有主次） | 平级订阅者（无主次） |
| 加消费者的动作 | 改 switch | 加一个订阅者 |
| 加事件字段 | 改用到该字段的 case | 改投影函数，其余免费 |

## 关键判定：这属于哪一批活

**属于「上下文压缩 + 持久化」那批，不是第一轮 UI 解耦的遗留缺口。** 三条硬证据：

1. **`conversation-snapshot` 语义上不是 UI 事件**：这个 case 里零 `emit()`、零 session 写入，是唯一不产 IPC 事件的 case。UI 契约（CHUNK / STEP / PLAN）根本没有 convo 通道——渲染层要看 convo 只能走会话读取。
2. **它出现在时间线的最前面**：`loop.ts` 在续跑时、任何 `text` / `tool-call-start` 之前就发一条 snapshot，纯粹为了给续跑播种 checkpoint。一个纯持久化诉求插在 UI 时间线第 0 位，本身就说明它不在这条线上。
3. **上一轮的目标已达成**：目标是「loop 不依赖 UI 概念」，已经做到（loop 零 UI 字段、零 checkpoint import）。「5 个 case 里有 1 个服务持久化」是**下一层**的形态问题，驱动力来自持久化设计，不是 UI 解耦没做完。

顺带发现一个更真实的残留：**`stepMap` / `session.text` / `session.plan` 写在 UI 的 case 里，却只服务收尾落盘**（`stepMap` 完全不喂 UI）。这才是「双职责」的准确描述——不是「UI + checkpoint」，而是「UI 投影 + 展示态累加」。但它同样服务持久化，所以同样归那一批。

## 演化推演：第三个消费者会长成什么样

用户问的是「导出 / 回放 / telemetry 来了，这个 switch 会长成什么样」。三种形态：

**形态 A（现状，case 内分叉）**

```ts
case 'text':
  session.text += event.delta;
  emit(CHAT_CHUNK, {...});     // ① UI
  recorder?.append(event);     // ③ 新消费者
  return;
case 'conversation-snapshot':
  void writeCheckpoint({...}); // ② 持久化
  recorder?.append(event);     // ③ 新消费者
  return;
```

加消费者 **5 处**（每个 case 尾部）；加字段 **0 处**（钩子转发整个 event，新字段免费）；加事件类型 1+N。
**陷阱**：`text` 的 `if (!event.delta) return` 是早退——尾部钩子会**静默漏掉**空增量事件，而新消费者根本不知道有这回事。

**形态 B（多 switch 分文件）**：`uiProject` / `persistProject` / `recorderProject`，组合点 `(e) => { uiProject(e); persistProject(e) }`。
加消费者 1 文件 + 1 行；加字段 0-1 处；加事件类型 N 个分支。**代价**：共享累加器（`session.text` / `stepMap`）无处安放，必须提升到组合层显式传递。

**形态 C（reduce + 手工 sink 数组，不引库）**

```ts
const reduce = (s: HarnessState, e: HarnessEvent): HarnessState => { ... };
const sinks = [uiSink, checkpointSink];   // 手工数组，不是事件总线
for (const sink of sinks) sink(prev, next, e);
```

加消费者 1 纯函数 + 1 行；加字段 0 处；加事件类型 N 个分支。代价 +50 行、多一层抽象、`noUnusedParameters` 下签名要写 `_prev` / `_next`。

| | 加第 N 消费者 | 加事件字段 | 加事件类型 | 新增代码 |
|---|---|---|---|---|
| A 现状 | 5 行 | 0 | 1+N | 0 |
| B 分文件 | 1 文件 + 1 行 | 0-1 | N | ~60 |
| C reduce + sink | 1 函数 + 1 行 | 0 | N | ~50 |

**结论：边际成本是「每消费者 5 行 vs 1 个函数」，不是数量级差异。** A 的问题从来不是行数，是**早退陷阱**和**累加器归属**。

## 我改不改：不改，等持久化那批

现在改约 1.5-2h（搬迁 + IPC 契约零变化 + 手测续跑/中止/异常三条路径），而省下的边际成本小于成本。**等。**

必须重构的触发条件（任一命中即动手，目标形态是 **C**，不是 B——B 解决不了累加器归属）：

1. 第三个消费者需要**逐事件全量**（要在 ≥3 个 case 加钩子）。若它只关心 turn 边界（例如导出），在 snapshot case 加一行就够，A 仍然够用。
2. 某消费者需要**顺序 + 时间戳**（回放 / telemetry）→ 早退与 case 内分叉会让时间线不完整，必须换 C。
3. **早退导致新消费者漏事件，真实 bug 出现一次**（最硬的信号，别提前防）。
4. `session.text` / `stepMap` 被第三消费者读取（累加器不再 UI 私有）→ 必须提升为显式 state。
5. 压缩在 loop 内改写 convo、snapshot 需要区分压缩前/后版本 → 语义本身要变，顺手一起做。

**现在唯一值得做的（~15 行，零行为变化）**：把两个 guard 提到 switch 之前，snapshot 拆成具名函数。

```ts
type UiHarnessEvent = Exclude<HarnessEvent, { type: 'conversation-snapshot' }>;

const emitHarness = (event: HarnessEvent): void => {
  if (event.type === 'conversation-snapshot') { persistSnapshot(event); return; }
  if (event.type === 'text' && !event.delta) return;   // 空增量对任何消费者都无意义
  projectUi(event);                                    // 已收窄，只剩 4 个纯 UI case
};
```

值得做的理由**不是「解耦」**（结构没变），而是它是**唯一一个不改结构就能消掉未来 bug 面的动作**：早退从「UI case 的私事」升级成「事件的语义」，第三个消费者将来挂在 `projectUi` 尾部也不会被静默跳过；snapshot 变成有名字的 `persistSnapshot`，第二个消费者不再藏在 switch 深处。若持久化批两周内启动，直接并进那批，不必单独提交。

## 面试可讲的三点

1. 「适配层住两个消费者」不等于耦合缺陷——要看**被解耦的是什么**。上一轮解耦的是「loop 依赖 UI 概念」，已达成；现在这个是「同一层的两个下游」，属于下一层的设计问题。
2. 边际成本分析：加消费者从 5 行降到 1 个函数，**不是数量级差异**，所以「等」是对的；真正该动手的信号是「早退漏事件」这种**语义 bug**，不是「代码不好看」。
3. 我明确不做事件总线，但能讲清 DSH 为什么需要它：它要 replay / audit / fork / 计费一致性，我没有这些需求。**知道更好的方案，并说清为什么现在不划算**，比直接照搬更像工程判断。

## 后续可对照

- `packages/core/session/` 的 `deriveMessages()`：怎么从事件日志投影出 messages（我们目前是 messages 和 checkpoint 两套真相）。
- 压缩批开工时，重点看 snapshot 在 DSH 里是怎么变成「日志的一部分」而不是「额外的写盘动作」。
