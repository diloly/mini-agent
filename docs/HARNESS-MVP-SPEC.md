# HARNESS MVP SPEC（薄 harness：手写 agent loop + tool calling）

## 0. 约束（不得违反）

- **不引任何 agent 框架**：不装 `@openai/agents`、不装 `langchain`、不装 `zod`。全部手写。
- **不跑测试**：不要执行 `pnpm typecheck` / `pnpm build` / `pnpm dev` / lint / 任何冒烟命令。改完直接汇报，由用户自己验证。
- **不动 UI 主题**：沿用现有 Tailwind class 与 HeroUI 组件，不引入新颜色、不引入渐变。
- **不碰密钥路径**：`src/main/secret.ts` 一行不改。
- **零写入 / 禁 shell**：三个工具都必须只读，不得写文件、不得执行命令。

## 1. 目标

现有 `chat:send` 是「一次请求 → 一次回答」。本期改为 **agent loop**：

```
用户提问
  → 带 tools 调模型
  → 模型返回 tool_calls？ ── 否 ─→ 输出文本，结束
                            └─ 是 ─→ 本地执行工具 → 把结果回填 → 再调模型（最多 8 轮）
```

工具的每一步都要实时推到 UI（新增 `chat:step`）。

---

## 2. 共享契约（唯一真相源，两个 worker 都必须逐字遵守）

### 2.1 `src/shared/types.ts`

新增：

```ts
/** 工具步骤的执行状态 */
export type ToolStepStatus = 'running' | 'done' | 'error';

/** 一次工具调用的可展示记录 */
export interface ToolStep {
  id: string;
  /** 工具名，如 read_text_file */
  name: string;
  /** 模型给出的参数，已序列化为紧凑 JSON 文本（用于展示） */
  args: string;
  status: ToolStepStatus;
  /** 结果摘要：成功为结果前 200 字，失败为错误文案 */
  result?: string;
  /** 执行耗时（毫秒）；status 为 running 时无此字段 */
  elapsedMs?: number;
}
```

`MessageMeta` 增加两个可选字段（**保持其余字段不变**）：

```ts
  /** 本轮的工具调用步骤（无工具调用时不写） */
  steps?: ToolStep[];
  /** 本轮 agent loop 实际消耗的轮数 */
  turns?: number;
```

同时修正已核实的事实错误：`DEFAULT_MODEL.deepseek` 由 `'deepseek-chat'` 改为 `'deepseek-v4-flash'`（旧 id 已弃用）。

### 2.2 `src/shared/ipc-channels.ts`

- `CHANNELS` 增加 `CHAT_STEP: 'chat:step'`（放在 `CHAT_ERROR` 之后）。
- 新增事件负载类型：

```ts
/** 工具步骤更新：全量快照（非增量），渲染层直接按 step.id 覆盖即可 */
export interface ChatStepEvent {
  requestId: string;
  messageId: string;
  step: ToolStep;
}
```

### 2.3 `src/main/providers/types.ts`

```ts
/** 暴露给模型的工具声明（JSON Schema，不引 zod） */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 模型请求调用的一次工具 */
export interface LlmToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串（未解析），执行前由 harness 解析 */
  arguments: string;
}
```

`LlmMessage` 由「三选一 role」扩展为：

```ts
export interface LlmMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** assistant 消息携带的待执行工具调用 */
  toolCalls?: LlmToolCall[];
  /** role==='tool' 时对应的 tool call id */
  toolCallId?: string;
  /** role==='tool' 时的工具名 */
  name?: string;
}
```

`ChatStreamParams` 增加 `tools?: ToolDefinition[]`。
`ChatStreamResult` 增加 `toolCalls?: LlmToolCall[]`。
`StreamCallbacks` 增加：

```ts
  /** 模型开始请求某个工具时立即回调（用于 UI 立刻显示「正在调用」） */
  onToolCallStart?: (call: { id: string; name: string }) => void;
```

**注意**：`StreamCallbacks.onDelta` 语义不变（仍然是「文本增量」）。工具调用的参数增量**不得**走 onDelta。

---

## 3. 主进程 worker 的任务

### 3.1 新增 `src/main/harness/tools.ts`

```ts
export interface HarnessTool {
  definition: ToolDefinition;
  /** 执行工具；必须自己吞掉异常并返回可读字符串，不要向上抛 */
  execute: (rawArgs: string, signal: AbortSignal) => Promise<string>;
}

export const HARNESS_TOOLS: HarnessTool[] = [...];
export function findTool(name: string): HarnessTool | undefined;
```

三个工具（全部只读）：

| name | parameters | execute 行为 |
|---|---|---|
| `get_current_time` | `{ type:'object', properties:{}, required:[] }` | 返回本地时间字符串 `2026-09-18 17:53:21 (周五)` |
| `calculator` | `{ type:'object', properties:{ expression: {type:'string', description:'仅含数字与 + - * / ( ) 的算术表达式'} }, required:['expression'] }` | 见下方安全要求 |
| `read_text_file` | `{ type:'object', properties:{ path: {type:'string', description:'相对于工作区根目录的文件路径'} }, required:['path'] }` | 见下方安全要求 |

**calculator 安全要求（硬性）**：
1. 表达式长度 ≤ 200；
2. 必须完全匹配白名单正则 `^[\d+\-*/().\s]+$`（无字母即无标识符，杜绝一切属性访问）；
3. 通过后用 `Function('"use strict"; return (' + expr + ')')()` 求值；
4. 结果为数字则返回字符串形式，否则返回「表达式无效」；
5. 任何异常 → 返回错误字符串（不抛）。

**read_text_file 安全要求（硬性）**：
1. 根目录 = `path.join(app.getPath('documents'), 'mini-agent-workspace')`，从 `electron` import `app`；
2. 目标路径 = `path.resolve(root, 传入的 path)`；
3. **必须**校验：解析后的绝对路径以 root 开头（用 `path.relative(root, target)` 判断，`relative` 结果不以 `..` 开头且非绝对路径才算通过）。不通过 → 返回「拒绝访问：路径不在工作区内」；
4. 用 `fs.promises.realpath` 复核一次（防符号链接逃逸），失败 → 返回友好文案；
5. 只读文本：`fs.promises.readFile(target, 'utf8')`，内容超过 20000 字符则截断并追加 `\n…（内容已截断）`；
6. 目录不存在 / 文件不存在 / 不是文件 → 返回可读文案（例如 `工作区目录不存在：<root>，请先创建该目录并放入文件`），让模型自己决定怎么回复；
7. 全程传 `signal` 给 fs 调用不可行时，至少在入口检查 `signal.aborted` 并早退。

所有工具的返回值都会作为 `role:'tool'` 消息的 content 回灌给模型，所以文案要让模型看得懂。

### 3.2 新增 `src/main/harness/loop.ts`

```ts
export interface HarnessCallbacks {
  onDelta: (delta: string) => void;
  onStep: (step: ToolStep) => void;
}

export interface HarnessResult {
  text: string;
  finishReason: FinishReason;
  turns: number;
  steps: ToolStep[];
}

export async function runAgentLoop(params: {
  provider: LLMProvider;
  providerConfig: ProviderConfig;
  messages: LlmMessage[];          // 已含本轮 user 提问
  signal: AbortSignal;
  callbacks: HarnessCallbacks;
}): Promise<HarnessResult>;
```

循环逻辑：

```
const MAX_TURNS = 8;
let text = ''; const steps: ToolStep[] = [];
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  1. 调 provider.chatStream({ messages, tools: HARNESS_TOOLS.map(t => t.definition), signal },
                            providerConfig,
                            { onDelta: d => { text += d; callbacks.onDelta(d); },
                              onToolCallStart: c => { /* 立即 emit 一个 running 的 ToolStep */ } })
  2. 若 result.toolCalls 为空 → 返回 { text, finishReason, turns: turn, steps }
  3. 否则：
     a. 把 assistant 消息追加进 messages：{ role:'assistant', content: result.text, toolCalls: result.toolCalls }
     b. 依次执行每个 toolCall：
        - 解析 arguments（JSON.parse 失败 → 当作 {}）
        - 执行前 emit running step，执行后 emit done/error step（含 elapsedMs、result 摘要）
        - 结果字符串追加进 messages：{ role:'tool', toolCallId: call.id, name: call.name, content: 结果 }
     c. 继续下一轮
}
// 超过 MAX_TURNS：在 text 末尾追加一行提示并返回
```

要点：
- **每轮开始时检查 `signal.aborted`**，已中止则抛 `createAbortError()`（复用 `src/main/providers/sse.ts` 的导出）。
- `text` 是**跨轮累积**的（模型每轮可能都吐一些文本），最终返回完整累积文本。
- 工具执行**不抛异常中断 loop**：失败信息也要回灌给模型，让它自己解释。
- `finishReason` 取最后一轮 provider 返回的值；若因 MAX_TURNS 退出，用 `'length'`。
- 工具并行执行**不做**（MVP 串行，顺序更利于 UI 展示）。

### 3.3 新增 `src/main/harness/index.ts`

只做 re-export：`runAgentLoop` / `HarnessResult` / `HarnessCallbacks` / `HARNESS_TOOLS`。

### 3.4 改 `src/main/providers/deepseek.ts`

1. 请求体：`params.tools?.length` 为真时加 `tools: params.tools`、`tool_choice: 'auto'`。
2. `ChatCompletionChunk.choices[0].delta` 的类型扩展为 `{ role?; content?; tool_calls?: Array<{ index; id?; type?; function?: { name?; arguments? } }> }`。
3. **流式 tool_calls 聚合（本期最易写错的地方）**：
   - 按 `delta.tool_calls[].index` 建立 `Map<number, { id: string; name: string; argsText: string }>`；
   - `id` / `function.name` 只在首次出现时赋值（后续分片通常不再带）；
   - `function.arguments` 是**字符串分片，必须累加**，它在流结束前不是合法 JSON；
   - 每次收到带 `function.name` 的分片时，若该 index 首次拿到 name，调用一次 `callbacks.onToolCallStart?.({ id, name })`；
   - 流结束后，把 Map 按 index 升序转成 `LlmToolCall[]`，放进返回值。
4. **`finish_reason === 'tool_calls'` 时 `finishReason` 仍记为 `'stop'`**（不要把 tool_calls 当成异常结束）。
5. `FALLBACK_MODELS` 换成 v4 两条：`{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }`、`{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }`。
6. 只有在 `toolCalls` 为空时才把 `content` 视作最终答案（这个判断属于 loop 的职责，provider 只负责如实返回两者）。

### 3.5 改 `src/main/providers/ollama.ts`

1. 请求体加 `tools: params.tools`（有则加）。
2. `OllamaChatChunk.message` 类型扩展为 `{ role?; content?; tool_calls?: Array<{ id?; function?: { name?; arguments?: unknown } }> }`。
3. Ollama 的 `tool_calls` 是**完整给出**（不是分片）：直接映射为 `LlmToolCall`，`arguments` 若本来是对象则 `JSON.stringify` 成字符串（保持与 DeepSeek 一致的「字符串」契约），`id` 缺失时用 `tool-${index}` 生成。
4. 收到 tool_calls 时同样触发一次 `callbacks.onToolCallStart`。
5. Ollama 的 `content` 与 `tool_calls` 可能同时出现，都要如实返回。

### 3.6 改 `src/main/ipc.ts`

把 `runChatStream` 里的单次 `provider.chatStream(...)` 替换为 `runAgentLoop(...)`。

- `ChatSession` 接口不变（`text` 字段仍是累积全文）。
- `onDelta` → 照旧 `emit(CHANNELS.CHAT_CHUNK, ...)`。
- `onStep` → `emit(CHANNELS.CHAT_STEP, { requestId, messageId: session.assistantMessageId, step } satisfies ChatStepEvent)`。
- 结束落盘时，`finalizeAssistantMessage` 额外写入 `steps` 与 `turns`（放进 `MessageMeta`）。
- ABORTED 分支：照旧落盘已有 text + steps，emit `chat:end { finishReason: 'aborted' }`。
- 错误分支：照旧落盘 errorCode/errorText + steps。
- 注意 `finalizeAssistantMessage` 的 `meta` 参数要扩展（新增 `steps?` / `turns?`），且 `message.meta` 构造时不要把 `steps` 弄丢。

### 3.7 改 `src/main/providers/index.ts`

若其中有需要同步的类型再导出则同步；否则不动。

---

## 4. 渲染层 worker 的任务

> 与主进程 worker **零文件重叠**，可完全并行。只依赖第 2 节的契约。

### 4.1 `src/preload/index.ts`

增加：

```ts
onChatStep: (listener: EventListener<ChatStepEvent>): (() => void) =>
  subscribe<ChatStepEvent>(CHANNELS.CHAT_STEP, listener),
```

放在 `onChatError` 之后。同时补 `ChatStepEvent` 的 type import。

### 4.2 `src/renderer/types/window.d.ts`

`MiniAgentApi` 增加：

```ts
  /** 订阅工具调用步骤更新 */
  onChatStep(listener: (event: ChatStepEvent) => void): () => void;
```

### 4.3 `src/renderer/lib/api.ts`

增加：

```ts
/** 订阅工具步骤更新；返回取消订阅函数 */
export function onChatStep(listener: (event: ChatStepEvent) => void): () => void {
  return ensureApi().onChatStep(listener);
}
```

### 4.4 `src/renderer/store/useAppStore.ts`

1. `StreamState` 增加 `steps: ToolStep[]`。
2. 新增 action：

```ts
  /** 覆盖式写入某个工具步骤（step.id 相同则替换） */
  upsertStep: (requestId: string, step: ToolStep) => void;
```

实现：与 `appendDelta` 同构 —— 取 `streams[requestId]`，若不存在或 `discarded` 则原样返回；否则在 `stream.steps` 里按 id 找到则替换、找不到则追加；**同时**（若该流属于当前会话）把 `steps` 写到对应 `messages[i].meta.steps`，保证 UI 立即看到。

3. `finishStream`：把 `steps` 一并写进 `meta`（`meta: { ...(message.meta ?? {}), finishReason, steps: stream.steps }`）。`failStream` 同理（写 `errorCode` / `errorText` / `steps`）。
4. `sendMessage` 里乐观插入的 stream 对象补 `steps: []`。
5. **架构文档点名的「最易漏点」，三处必须同步扩展 steps**：
   - `discardAll` —— 展开时 `steps` 随 `{...value}` 自然带上，无需额外处理，但要确认没写成挑字段；
   - `rebindStreams` —— 同上；
   - `omitStream` —— 同上。
   
   这三处当前都是 `{ ...value }` 展开，因此只要 `StreamState` 加了 `steps` 就自动带上了。**不要改成挑选字段的写法。**
6. `failStream` / `finishStream` 里判断是否更新 messages 的逻辑保持不变。

### 4.5 `src/renderer/App.tsx`

新增订阅（照现有三个的写法，并在 cleanup 里取消）：

```ts
const unsubscribeStep = onChatStep(({ requestId, step }) => {
  useAppStore.getState().upsertStep(requestId, step);
});
```

### 4.6 `src/renderer/components/MessageBubble.tsx`

- `MessageBubbleProps` 增加 `steps?: ToolStep[]`（流式期间由父组件传实时 steps；非流式时回退读 `message.meta?.steps`）。

  更简单的做法：**统一读 `message.meta?.steps`**，由 4.4 保证流式期间也写进 `messages[i].meta.steps`，这样 `MessageBubble` 不需要新 prop。**采用这个做法**，`MessageBubble` 只加渲染逻辑。

- 渲染位置：assistant 消息的**正文上方**（即 markdown 内容之前），每个 step 一行，样式要求「简约、不喧宾夺主」：
  - 容器：`mb-2 flex flex-col gap-1 border-l-2 border-line pl-2`（用现有 token，不引入新颜色）
  - 单行：`flex items-center gap-1.5 text-[12px] text-muted font-mono`
  - 图标用文字字符，不用图片：running → `◐`，done → `✓`，error → `✕`
  - 文案：`{name}({args})`，done 时追加 ` · {elapsedMs}ms`
  - error 时整行用 `text-danger`（若项目没有 `text-danger` 这个 class，用 `text-red-500`）
  - 结果摘要**不展开显示**（避免噪音），但 `title` 属性挂上 `step.result` 便于 hover 查看
- 只在 `steps.length > 0` 时渲染整块。

### 4.7 `src/renderer/components/MessageList.tsx`

`MessageBubble` 的调用不变（因为走 `message.meta.steps`）。但要在**滚动依赖**里加入 steps 变化，保证工具步骤出现时自动贴底：

```ts
const stepsSignature = useMemo(
  () => messages.map((m) => m.meta?.steps?.length ?? 0).join(','),
  [messages],
);
useEffect(() => { /* 原贴底逻辑 */ }, [messages, streamingMessageId, stepsSignature]);
```

注意：`appendDelta` 和 `upsertStep` 都必须产生**新的 messages 数组引用**，否则 React 不会重渲染 —— 两者当前写法（`state.messages.map(...)`）已满足，保持即可。

---

## 5. 完成标准（自检清单）

- [ ] 仓库内 `grep -r "ERROR_MESSAGES"` 仍为零结果（不要引入旧命名）。
- [ ] 仓库内不存在硬编码通道字符串，全部走 `CHANNELS`。
- [ ] `LlmMessage` 的 `tool` role 在 DeepSeek 请求体里被正确序列化为 `{ role:'tool', tool_call_id, content }`（**注意字段名是 `tool_call_id`，不是 `toolCallId`** —— 需要在 provider 发请求前做一次映射）。
- [ ] abort 能穿透 agent loop 与工具执行。
- [ ] 工具失败不会让整轮变成 `chat:error`，而是把失败文案回灌给模型。
- [ ] 未配置模型时的短路逻辑（`NOT_CONFIGURED`）保持不变。
- [ ] 不跑任何测试命令。
