# mini-agent 项目总览与生产化路线图

> 面向初学者的完整导读：这个项目是什么、怎么跑起来的、用了哪些技术、要变成能上线的产品还缺什么。
> 阅读顺序建议：第 1～6 章理解现状，第 7～8 章理解好与不好的地方，第 9～11 章看要怎么改。
> 本文是**导读与规划**，细节设计见同目录下的 `ARCHITECTURE.md` / `HARNESS-ARCHITECTURE.md`。

---

## 目录

1. [这个项目是什么](#1-这个项目是什么)
2. [技术栈全景](#2-技术栈全景)
3. [三层进程架构：安全边界在哪里](#3-三层进程架构安全边界在哪里)
4. [一轮对话的完整链路](#4-一轮对话的完整链路)
5. [五个核心机制](#5-五个核心机制)
6. [代码地图](#6-代码地图)
7. [这个项目已经做对的地方](#7-这个项目已经做对的地方)
8. [已知的坑与技术债](#8-已知的坑与技术债)
9. [往生产走：分三阶段改造](#9-往生产走分三阶段改造)
10. [技术选型对照总表](#10-技术选型对照总表)
11. [给初学者的学习路径](#11-给初学者的学习路径)

---

## 1. 这个项目是什么

**一句话**：一个跑在你自己电脑上的桌面 AI 助手。它不依赖任何云服务，API Key 存本地，能读写你指定目录里的文件，还能把跨对话有价值的结论记下来。

### 能力清单（现状）

| 能力 | 状态 | 说明 |
|---|---|---|
| 多会话管理 | 有 | 侧栏列表、新建、删除、自动起标题、重启后恢复上次会话 |
| 流式输出 | 有 | 逐字上屏的「打字机」效果，可随时停止 |
| 多模型服务 | 有 | DeepSeek（云端，需 Key）+ Ollama（本地，无需 Key） |
| 消息编辑重发 | 有 | 改一条用户消息 → 该条及之后全部作废 → 重新生成 |
| 工具调用（Agent） | 有 | 6 个内置工具，手写 agent loop，最多 8 轮 |
| 工作区隔离 | 有 | 每个会话可以绑定一个目录，文件工具只能在这个目录里操作 |
| 覆盖前自动备份 | 有 | 写工具覆盖已有文件前，先把原文备份到工作区之外 |
| 跨对话记忆 | 有 | 自动把有价值的结论提炼进工作区里的 `MEMORY.md`，可一键关闭 |
| 会话导出 | 有 | 每轮结束自动生成 Markdown 镜像，放在工作区里 |
| 深色 / 浅色主题 | 有 | 跟随系统 / 强制浅色 / 强制深色 |
| 联网搜索 | 无 | 见第 9.2 节 |
| 执行命令（shell） | 无 | 有意的安全选择 |
| 写操作前人工确认 | 无 | 这是与 Claude Code 之类的产品最大的行为差异，见第 9.1 节 |
| 多人 / 账号 / 云同步 | 无 | 见第 9.3 节 |

### 它不是什么

- **不是纯聊天客户端**：它带工具调用循环，属于「Agent」而不是「Chat」。
- **不是框架的封装**：没用 LangChain / LangGraph / OpenAI Agents SDK，agent loop 是手写的（见第 5.3 节）。
- **不是服务端应用**：没有后端，所有逻辑在你本机进程里跑。

---

## 2. 技术栈全景

### 2.1 运行时与构建

| 层 | 技术 | 版本 | 解决什么问题 |
|---|---|---|---|
| 桌面壳 | **Electron** | ^34 | 用 Web 技术写桌面应用；提供原生窗口、文件系统、系统钥匙串 |
| 构建工具 | **electron-vite** | ^3.1 | 三套独立 Vite 配置（主进程 / preload / 渲染层），HMR、产物路径约定开箱即用 |
| 打包 | **electron-builder** | ^25 | 产出 Windows NSIS 安装包 |
| 包管理 | **pnpm** | — | 更省磁盘、依赖树更严格 |

### 2.2 前端（渲染层）

| 技术 | 版本 | 用途 |
|---|---|---|
| **React** | ^19 | UI 框架 |
| **TypeScript** | ^5.7 | 类型系统。开启 `strict` / `noUnusedLocals` / `noUnusedParameters` |
| **Tailwind CSS** | ^4 | 原子化 CSS。注意 v4 是全新架构，配置方式和 v3 不同 |
| **HeroUI** | ^3 | 组件库（按钮、弹层、对话框等） |
| **zustand** | ^5 | 全局状态管理。比 Redux 轻很多，一个文件搞定 |
| **react-markdown** + remark-gfm + rehype-highlight | ^9 / ^4 / ^7 | 把模型输出的 Markdown 渲染成带代码高亮的 HTML |
| **highlight.js** | ^11 | 代码高亮的样式主题 |

**没有用**：MUI、Redux、axios、zod、任何 agent 框架。这是一个刻意的克制——依赖越少越好维护。

### 2.3 类型与语言约束（很重要，容易踩）

- **渲染层的 `lib` 锁在 ES2022**（`tsconfig.web.json`）。这意味着**不能用 ES2023 的新方法**，比如 `Array.prototype.findLast`、`toSorted`。代码里已经出现过用 `filter(...).at(-1)` 替代 `findLast` 的写法。
- **`noUnusedLocals` 打开**：任何没用到的 import 或 type 都会报错。这对保持代码整洁有帮助，但也意味着改完代码可能因为一个残留 import 而编译失败。
- `src/shared/` 下的文件**零依赖**，不允许 import 任何 Node / Electron / 浏览器专有模块——因为它要被主进程、preload、渲染层三方同时引用。

---

## 3. 三层进程架构：安全边界在哪里

Electron 应用有两个「世界」：能碰系统的（主进程）和只能画界面的（渲染层）。本项目在中间加了一层「传达室」（preload），把两者彻底隔开。

```
┌─────────────────────────────────────────────────────────────────┐
│ 主进程 src/main/  ——  唯一的安全边界，也是唯一能干"脏活"的地方    │
│  Node.js 环境：文件系统、网络、API Key 解密、agent loop 全在这里   │
└─────────────────────────────────────────────────────────────────┘
        ▲                                    
        │ ipcMain.handle / webContents.send（进程间通信，走"通道"）
        ▼                                    
┌─────────────────────────────────────────────────────────────────┐
│ preload src/preload/  ——  白名单传达室                            │
│  通过 contextBridge 只暴露若干函数，不放行 fetch / require / fs    │
└─────────────────────────────────────────────────────────────────┘
        ▲                                    
        │ window.api.xxx()（只有这些函数可用）
        ▼                                    
┌─────────────────────────────────────────────────────────────────┐
│ 渲染层 src/renderer/  ——  纯状态机 + 视图                          │
│  浏览器环境：只负责把数据画出来，不碰文件、不碰网络、不碰 Key        │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 主进程（`src/main/index.ts`）

负责：

- 创建窗口，配置安全开关
- 启动时准备数据文件（`ensureStorageReady`）
- 注册全部 IPC 处理器
- 单实例锁（第二次启动时激活已有窗口，而不是开新窗口）
- 安全加固：禁止渲染层新开窗口、禁止外部导航

**窗口安全基线**（四项，缺一不可）：

```ts
nodeIntegration: false,    // 渲染层拿不到 Node API
contextIsolation: true,    // 渲染层和 preload 的运行环境隔离
sandbox: true,             // 渲染层跑在系统沙箱里
webSecurity: true,         // 保留同源策略
```

### 3.2 preload（`src/preload/index.ts`）

只做一件事：用 `contextBridge.exposeInMainWorld('api', api)` 把一组函数挂到 `window.api` 上。

设计要点：

- **只暴露封装好的 `invoke` 调用和事件订阅**，绝不暴露通用的「任意通道转发」函数——否则渲染层被 XSS 之后可以调用主进程任意能力。
- 所有通道名从 `src/shared/ipc-channels.ts` 引入，仓库里不存在硬编码的通道字符串。
- 每个事件订阅函数都返回一个「取消订阅」函数，组件卸载时调用。

### 3.3 渲染层（`src/renderer/`）

浏览器环境，只能通过 `window.api` 与外界交互。生产打包后还会被加上一条 CSP（内容安全策略）：

```
connect-src 'none'    → 渲染层完全不允许发起网络请求
```

这条策略带来一个重要的架构结论：**渲染层永远不会直连模型 API**。所有网络请求都从主进程发出。

> **注意**：CSP 只在打包后生效（开发期需要 Vite 的热更新 WebSocket）。这会造成「开发能跑、打包出问题」的风险，改安全策略后必须在打包环境实测一次。

---

## 4. 一轮对话的完整链路

这是理解整个项目最重要的一节。假设用户在输入框敲了「帮我看看 test.txt 里写了什么」并回车：

```
① 渲染层 Composer 捕获 Enter
        │
        ▼
② store.sendMessage()：乐观更新
   · 立刻往界面插入两条消息（用户消息 + 空的助手消息）
   · 生成 requestId，创建流式状态 streams[requestId]
   · 界面立刻出现「生成中」
        │
        ▼
③ window.api.sendChat({ requestId, conversationId, content })
        │  preload 转发
        ▼
④ 主进程 handleChatSend()
   · 读配置 → 取 Provider → 解密 API Key（明文只留在内存）
   · 未配置？落盘一条带错误标记的消息，推送 chat:error，结束
   · 已配置？把用户消息 + 助手占位消息写入会话，落盘
   · 组装上下文：注入 2 条 system 消息 + 最近 20 条消息
   · 在 running 表里登记 { requestId → AbortController }
   · 立刻返回 { requestId, userMessageId, assistantMessageId }（不等待模型）
        │
        ▼
⑤ 后台异步执行 runChatStream() → runAgentLoop()
        │
        ├─ 第 1 轮：带 6 个工具声明调用模型
        │    模型流式输出，每段增量 → emit('chat:chunk')  → 渲染层逐字上屏
        │    模型决定调用 read_text_file({ path: "test.txt" })
        │        → emit('chat:step', running)  → 界面显示「正在调用」
        │        → 工具执行（校验路径 → 读文件）
        │        → 结果作为 role:'tool' 消息回灌上下文
        │        → emit('chat:step', done)     → 界面显示 ✓ + 耗时
        │
        ├─ 第 2 轮：把上一步结果一起发给模型
        │    模型基于文件内容作答，不再请求工具
        │
        └─ 返回 { text, finishReason, turns, steps }
        │
        ▼
⑥ 收尾 finalizeAssistantMessage()
   · 把完整正文 + 结束状态 + 工具步骤写进会话，落盘
   · 导出 Markdown 镜像到工作区
   · 追加一条工作区记忆（额外一次模型调用，失败静默）
        │
        ▼
⑦ emit('chat:end') → 渲染层清空流状态、解锁输入框、刷新侧栏
```

### 4.1 为什么这样设计

三个关键判断：

1. **`chat:send` 立刻返回，不等结果。** 如果等结果，IPC 调用会被挂住几十秒，界面没法显示中间过程。所以它只回三个 id，真正的内容靠**事件推送**。
2. **用 `requestId` 做多路复用。** 每个流式状态都按 `requestId` 隔离存放。这样两个会话可以同时生成而不串台；切换会话时把旧流标记为 `discarded`，后续增量直接丢弃。
3. **工具步骤走独立的 `chat:step` 通道。** 而不是塞进 `chat:chunk` 的文本里。这样界面上「工具调用」是一块独立、可折叠、有成功/失败状态的 UI，而不是一段混在正文里的文字。

---

## 5. 五个核心机制

### 5.1 IPC 契约与流式协议

**IPC**（进程间通信）是 Electron 里主进程和渲染层唯一的说话方式。它有两个方向：

- **invoke / handle**：渲染层发起请求，主进程返回结果（一问一答）
- **webContents.send / on**：主进程主动推送事件（单向广播）

本项目定义了 17 个通道（`src/shared/ipc-channels.ts`），命名规范是「域:动作」：

| 方向 | 通道 | 用途 |
|---|---|---|
| 问答 | `conversation:list` / `create` / `get` / `delete` | 会话增删查 |
| 问答 | `chat:send` | 发起一轮生成（**立即返回**） |
| 问答 | `chat:abort` | 停止生成 |
| 问答 | `config:get` / `config:save` | 读写配置 |
| 问答 | `models:list` | 拉取候选模型 |
| 问答 | `workspace:pick` / `conversation:setWorkspace` | 选择 / 绑定工作区 |
| 问答 | `app:openExternal` | 用系统浏览器打开链接 |
| 推送 | `chat:chunk` | 文本增量（高频） |
| 推送 | `chat:step` | 工具步骤全量快照 |
| 推送 | `chat:end` | 正常结束 / 被中止 |
| 推送 | `chat:error` | 异常结束 |
| 推送 | `app:openSettings` | 主进程要求打开设置弹层 |

**设计要诀**：`chat:step` 推的是**全量快照**而不是增量，渲染层按 `step.id` 覆盖即可。这比设计一套增量协议简单得多，也更不容易出 bug。

### 5.2 Provider 抽象层：把厂商差异关进一个盒子

模型厂商的 API 各有各的脾气。DeepSeek 用 OpenAI 兼容协议（SSE 流），Ollama 用自己的私有格式（NDJSON 流）。项目的做法是在中间放一个接口：

```ts
interface LLMProvider {
  id: ProviderId;
  label: string;
  unreachableHint: string;      // 服务不可达时给用户的专属提示
  isConfigured(config): boolean;
  listModels(config, signal): Promise<ModelInfo[]>;
  chatStream(params, config, callbacks): Promise<ChatStreamResult>;
}
```

**厂商差异必须收敛在两个地方**，绝不能泄漏到上层：

**① 协议格式差异**（`src/main/providers/types.ts`）

| 差异点 | OpenAI 兼容 | Ollama |
|---|---|---|
| 消息映射函数 | `toWireMessages` | `toOllamaMessages` |
| 工具结果关联字段 | `tool_call_id` | `tool_name` |
| 工具调用参数类型 | JSON **字符串** | JSON **对象** |
| 工具调用是否有 id / type | 有 | 无 |
| 流式工具调用 | **分片**，`arguments` 要按 index 累加 | **完整给出**，直接映射 |

这张表里每一行都是一个真实的坑。比如流式 `tool_calls` 的分片：同一个工具的参数会跨多个 chunk 到达，流结束前那个字符串根本不是合法 JSON，必须 `+=` 累加而不能赋值。

**② 错误语义差异**（`src/main/providers/types.ts`）

所有异常统一收敛成 `ProviderError(code, userMessage, retryable)`：

- `toProviderError()` 把 `ECONNREFUSED` 映射为「服务未启动」，各种网络错误码映射为「网络问题」，`fetch` 失败（`TypeError`）也算网络问题
- 错误码 → 中文文案 → 是否可重试，三张表分开定义在 `src/shared/types.ts`，**全仓唯一来源**
- 「服务不可达」的文案由各 Provider 自己提供（Ollama 会说「请确认已启动 ollama serve」），不污染共享层

**新增一家厂商只需要两步**：写一个 adapter 文件 + 在 `providers/index.ts` 的注册表里登记。IPC 层和渲染层一行都不用改。

### 5.3 Agent Harness：手写的 agent loop

「Harness」指的是把模型和工具串起来、驱动多轮循环的那层代码。本项目没用任何框架，全部手写，核心只有两个文件。

**循环本体（`src/main/harness/loop.ts`，约 190 行）**

```
for (let turn = 1; turn <= 8; turn++) {
  检查用户是否点了停止
  → 带工具声明调用模型（流式）
  → 模型没请求工具？→ 这轮就是最终答案，返回
  → 把 assistant 的发言（含它想调的工具）存回上下文
  → 依次执行每个工具，把结果作为 role:'tool' 消息回灌
}
达到 8 轮上限 → 追加一句提示语收尾
```

四条关键约定，每一条都是踩过坑之后加的：

1. **工具失败绝不让整轮变成错误。** 工具不存在、参数非法、被安全边界拒绝——全部转成可读的文本，照常回灌给模型，让模型自己解释。否则用户会看到「生成失败」而不是「哦，路径写错了」。
2. **`execute()` 必须自己吞掉异常，绝不向上抛。** 工具层返回 `{ ok, text }` 结构，`ok` 决定界面上显示 ✓ 还是 ✕。
3. **文本跨轮累积。** `text` 变量在所有轮次上累加，最终返回完整全文。所以即使模型中间调了三次工具，用户看到的还是一段连贯的回答。
4. **每轮开头检查中止信号。** 用户点了停止就立刻退出，不再发一次请求白烧 token。

**工具注册表（`src/main/harness/tools.ts`）**

6 个工具，全部在主进程执行：

| 工具 | 类型 | 安全措施 |
|---|---|---|
| `get_current_time` | 只读 | — |
| `calculator` | 只读 | 白名单正则彻底排除字母，杜绝 `process.env` 之类的属性访问 |
| `read_text_file` | 只读 | 路径双门校验 + 20,000 字符截断 |
| `write_text_file` | 写 | 路径双门 + **覆盖前备份** + 200,000 字符上限 |
| `edit_text_file` | 写 | 同上 |
| `append_daily_note` | 写 | 路径完全由系统推导，不接受外部输入；记忆关闭时**从工具列表中摘除** |

三个精妙之处：

- **工具声明是动态生成的，不是静态常量。** `define(context)` 是个方法而不是字段，因为工作区的绝对路径只有运行时才知道。而且这段 `description` 是**模型能读到的唯一环境事实**——模型对「我在哪、我能碰什么」的全部认知都来自这里。声明里不写真实路径，模型就会自己编（真的发生过：模型编出「虚拟工作区」「需要上传文件」这类说法）。
- **路径校验有两道门。** 第一道是纯字符串比较（`path.relative` 不能以 `..` 开头）；第二道是 `realpath` 复核，防止有人在工作区里放一个指向 `C:\Windows` 的符号链接来逃逸。写操作的目标可能还不存在，所以第二道门取的是「最近的已存在祖先」的真实路径。
- **工具执行上下文是逐层传参的，不是全局变量。** `ToolContext`（工作区根目录 / 备份目录 / 会话 id / 记忆开关）从 IPC 层一路传到工具。如果用模块级全局变量，两个会话同时生成时会互相覆盖——A 会话的工具会跑到 B 会话的工作区里去读写文件。

### 5.4 存储与密钥

**存储：两个物理分离的 JSON 文件**（`src/main/storage.ts`）

```
<userData>/conversations.json   ← 会话与消息
<userData>/config.json          ← 配置与加密后的 Key
```

分开的理由很实际：**清空聊天历史不应该把 API Key 也弄丢**。

写入有两个保护：

**① 原子替换**。永远不直接覆盖目标文件，而是「写临时文件 → rename 覆盖」。rename 在同一文件系统内是原子操作，所以任何时刻要么是完整的旧文件，要么是完整的新文件，**不会出现写了一半的损坏文件**。

**② 串行队列**。所有「读最新 → 修改 → 写回」的操作排成一个队列（`enqueue`）。

```ts
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);   // 接在队尾
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}
```

不这样做的话，两个并发的异步流程会各自读到旧数据、各自写回，后写的那个把先写的成果覆盖掉（经典的 lost update）。

**还有两个容易忽略的防御：**

- `normalizeConfig()` 是**白名单式重建**：从磁盘读到的配置会被「字段一个一个挑出来重新构造」，任何不在白名单里的字段都会被丢弃。这是为了容忍旧版本文件或被用户手动改坏的文件。代价是——**新增配置字段时必须同步加进这个函数，否则每次读盘都会丢掉用户的选择**。这是个很容易忘的坑。
- `normalizeConversations()` 会过滤掉结构异常的记录（比如缺 `id` 或 `messages` 不是数组），避免一条坏数据让整个应用起不来。

**密钥：用 Electron 内置的 safeStorage**（`src/main/secret.ts`）

```
明文 Key  →  safeStorage.encryptString()  →  base64 密文  →  写进 config.json
```

- safeStorage 底层调用操作系统的钥匙串（Windows 上是 DPAPI），**不引任何第三方加密库**。
- 明文 Key 只在主进程内存里存在，**绝不通过 IPC 传出去**。渲染层只能看到一个布尔值 `hasApiKey`。
- **降级策略是安全底线**：如果系统不支持加密（`isEncryptionAvailable()` 为假），**绝不退化成明文落盘**，改为只在内存里持有，并让设置页显示提示。
- `hasSecret()` 的判据是「**能否真正解密出非空明文**」，而不是「密文是否存在」。因为换机器或系统钥匙串变更后密文解不开了，如果按「密文存在」判断，界面会显示「已配置」但发送时报「未配置」，自相矛盾。

### 5.5 工作区与记忆

**工作区**（`src/main/workspace.ts`）：文件工具的沙箱边界。

| 场景 | 默认工作区位置 |
|---|---|
| 开发期 | 项目目录的**上一级**下的 `workspace/`（本项目即 `E:\code\LocalAgent\workspace`） |
| 打包后 | `<userData>/workspace/` |

用 `path.dirname(app.getAppPath())` 推导而**不硬编码盘符**，换机器、换项目目录都不用改代码。每个会话还可以单独绑定自己的目录，没绑定的回退到默认工作区。

**备份目录**刻意放在工作区**外面**（`<userData>/backups/<会话id>/`），这样它既不会污染工作区内容，也不会被文件工具或模型的目录感知看到。

**记忆系统**（`src/main/workspace-memory.ts`）：两级结构。

```
<工作区>/.agent/memory/MEMORY.md        ← 长期记忆，由系统自动维护，上限 4000 字符
<工作区>/.agent/memory/2026-09-21.md    ← 每日笔记，由 agent 主动调用工具追加
<工作区>/.agent/conversations/*.md      ← 会话 Markdown 镜像（不参与模型上下文）
```

长期记忆的提炼流程：**每轮对话结束后，额外发一次模型请求**，把「本轮对话」和「已有记忆」一起交给模型，要求它输出合并后的完整新版记忆。

这个额外请求被三道闸门保护，都是真金白银换来的经验：

1. **门槛闸**：本轮对话太短（不足 200 字符）就跳过，省一次调用。
2. **空输出保护**：模型返回空内容时直接放弃写入，**绝不把已有记忆清空**。
3. **收缩保护**：新内容短于已有内容的 30% 时放弃写入——模型明显把内容弄丢了，不能让它把几周的积累一次性抹掉。

而且整个「读已有记忆 → 调模型 → 写回」是**串行化**的。只锁写不锁读是不够的：第二个提炼会读到旧记忆，然后覆盖掉第一个的成果。

**一个重要的概念区分**（代码注释里专门强调了）：`conversations/*.md` 这个镜像文件**不参与模型上下文**。写它消耗零 token，模型只有在主动调用 `read_text_file` 时才会读到它。这和「把对话历史塞进上下文」是完全不同的两件事。

---

## 6. 代码地图

```
mini-agent/
├── package.json                  依赖与脚本
├── electron.vite.config.ts       三进程构建配置
├── electron-builder.yml          打包配置（NSIS / Windows x64）
├── tsconfig.json / .node.json / .web.json    三套 TS 配置（对应三个进程）
├── docs/                         设计文档
└── src/
    ├── shared/                   ★ 三方共用的契约层，零依赖
    │   ├── types.ts              数据模型 + 错误码 + 错误文案 + 各项默认值
    │   └── ipc-channels.ts       IPC 通道名 + 全部请求/响应类型
    │
    ├── main/                     ★ 主进程：唯一能干脏活的地方
    │   ├── index.ts              窗口创建、安全加固、生命周期、单实例锁
    │   ├── ipc.ts                IPC 路由 + 流式编排（最核心的编排文件）
    │   ├── storage.ts            会话与配置的持久化（原子写 + 串行队列）
    │   ├── secret.ts             API Key 加解密（safeStorage）
    │   ├── workspace.ts          工作区路径解析 + 备份目录
    │   ├── workspace-memory.ts   记忆提炼 + 注入 + 每日笔记
    │   ├── conversation-export.ts 会话 Markdown 镜像
    │   ├── providers/            模型服务适配层
    │   │   ├── index.ts          注册表
    │   │   ├── types.ts          LLMProvider 接口 + 错误收敛 + 协议映射
    │   │   ├── sse.ts            流式解析（SSE / NDJSON 共用）+ 信号合并
    │   │   ├── deepseek.ts       OpenAI 兼容协议实现
    │   │   └── ollama.ts         本地 Ollama 实现
    │   └── harness/              ★ agent 编排层
    │       ├── loop.ts           手写 agent loop（8 轮上限）
    │       ├── tools.ts          6 个内置工具
    │       ├── types.ts          HarnessTool / ToolContext / ToolResult 契约
    │       └── index.ts          统一出口
    │
    ├── preload/index.ts          白名单 API 暴露
    │
    └── renderer/                 渲染层：纯状态机 + 视图
        ├── main.tsx              入口（先 await 主题，再 render，避免首帧闪白）
        ├── App.tsx               布局骨架 + 水合 + 事件订阅
        ├── index.css             CSS 引入顺序（很关键，见下）
        ├── styles/theme.css      ★ 全仓唯一的色值定义处
        ├── lib/api.ts            window.api 的类型化封装
        ├── lib/theme.ts          主题解析与应用
        ├── store/useAppStore.ts  ★ 全局状态（单文件 zustand store）
        └── components/           Sidebar / TopBar / MessageList /
                                  MessageBubble / Composer / ModelPicker /
                                  SettingsDialog / WorkspacePicker
```

### 6.1 一条 CSS 的约束（容易踩，但很重要）

`theme.css` 是全仓**唯一允许出现十六进制色值**的文件。组件里只用语义化的工具类（`text-fg` / `text-muted` / `bg-surface` / `border-line` / `text-danger`）。

原因：如果需要改配色，只改一个文件就够了；如果色值散落在 20 个组件里，换主题会是一场灾难。

这个文件有四段，**顺序不可调换**：

1. **语义变量覆盖**——只有这一层允许出现色值
2. **交互态压制**——必须写成「未分层」，才能压过第三方库
3. **`@theme inline` 桥接**——把变量接进 Tailwind 的命名空间
4. **BEM 覆盖 + 动效压制**

这里有一条反直觉的规律，已经踩过三次以上：**Tailwind v4 里 `@layer components` 压不过 `@layer utilities`，也压不过完全没有分层的样式**。而第三方 CSS（`@heroui/styles`、`highlight.js`）往往就是未分层或 `@layer base` 的。所以**凡是要覆盖第三方，必须写成未分层样式**。

另一条：**同属性的两个工具类不能同时存在**。比如 `text-muted` 和 `text-danger` 特异性相同，谁生效取决于生成的 CSS 顺序，属于未定义行为。必须用三元表达式做互斥选择，不能靠「后面追加的覆盖前面」。

---

## 7. 这个项目已经做对的地方

这些设计判断值得单独拿出来学习，它们解决的都是真实问题：

| 做对了什么 | 为什么重要 |
|---|---|
| **目录结构即架构约束** | `src/main` / `src/preload` / `src/renderer` 三个目录正好对应三个安全层级。想越界就得先破坏目录约定，很难「不小心」写错 |
| **副作用全部下沉主进程** | 渲染层退化成纯状态机，XSS 攻击面被压到最小 |
| **单一真相源** | 错误文案集中在 `shared/types.ts`、通道名集中在 `ipc-channels.ts`、色值集中在 `theme.css`。同一句话只在一个地方定义 |
| **协议差异收敛在映射函数里** | 厂商差异不会泄漏到上层，加一家厂商只需改注册表 |
| **错误是数据，不是异常** | 工具失败转成 `{ ok: false, text }` 回灌给模型，而不是抛异常中断整轮 |
| **原子写 + 串行队列** | 同时解决「崩溃留下半截文件」和「并发覆盖」两个问题 |
| **降级不等于降低安全** | safeStorage 不可用时宁可不落盘，也不明文存储 |
| **敏感数据只进不出** | Key 明文永不跨进程，渲染层只看到布尔值 |
| **一次只加一个安全边界** | 不做 shell 执行、不做联网——每个能力都是新的攻击面，需要单独设计防护 |
| **工具用上下文传参而非全局变量** | 从设计之初就考虑了并发会话场景 |

---

## 8. 已知的坑与技术债

这一节是诚实盘点。**这些都不是 bug，是取舍或尚未处理的债务。**

### 8.1 跨轮丢失「工具调用证据」

`ipc.ts` 的 `buildContextMessages()` 只把每条消息映射成 `{ role, content }`，而 `storage.ts` **只持久化 user / assistant 两类消息，tool 消息从不落盘**（工具步骤存在 `meta.steps` 里，仅供界面展示）。

后果：**下一轮对话时，模型不知道上一轮调用过什么工具**。它可能重复读同一个文件、重复搜同一个问题。

好处是协议上不会出现「孤儿 tool 消息」（有 tool 结果但找不到对应的 tool_call），所以一直没出问题。这个取舍在只有文件工具时影响不大，但**如果将来加联网搜索，会明显变痛**。

### 8.2 `normalizeConfig` 的白名单陷阱

它是白名单式重建，新增配置字段时必须同步加进去。忘了的话不会报错，只会「用户每次重启后设置丢失」——一个很难定位的 bug。

### 8.3 上下文只有「条数」没有「token」

`CONTEXT_MESSAGE_LIMIT = 20` 是消息**条数**上限，不是 token 上限。20 条长消息完全可能超出模型窗口；10 条超长消息也可能浪费钱。

同理，`loop.ts` 里的 `TOOL_RESULT_PREVIEW_LIMIT = 200` **只是界面预览的截断**，回灌给模型的仍是完整结果。目前工具结果都不大所以没事，但这是「加联网搜索就会爆」的地方。

### 8.4 存储是 O(n) 写放大

`mutateConversations` 每次都要「读全量 → 修改 → 写全量」。会话多了之后，改一条消息要重写整个文件，而且 `JSON.parse` 大文件会阻塞主进程的事件循环（界面会卡顿）。

### 8.5 消息列表没有虚拟滚动

`MessageList.tsx` 是朴素的 `messages.map(...)`，长会话（几百条消息 + 富 Markdown + 代码高亮）会明显掉帧。

### 8.6 没有日志、没有崩溃上报

出问题只能靠用户描述。没有结构化日志，也没有任何错误聚合手段。

### 8.7 开发与生产环境行为不一致

CSP 只在打包后生效（开发期需要 Vite 的热更新）。这意味着**在开发期能跑通的功能，打包后可能因为 CSP 而被拦掉**。比如 `img-src 'self' data:` 会阻止 Markdown 里的远程图片加载。

### 8.8 其他零散项

- 未设置 `session.setPermissionRequestHandler`。Electron 默认会弹权限请求（摄像头、麦克风、通知等），生产环境应显式全部拒绝
- 打包只覆盖 Windows x64，没有代码签名和自动更新
- 没有任何形式的自动化测试，也没有 CI

---

## 9. 往生产走：分三阶段改造

先明确一个判断标准，避免过度工程：**「生产可用」不是指技术先进，而是指「陌生人能安全地用、出问题你能查、升级不需要用户重装」。**

所以下面按这三条标准分阶段，**严格按照顺序做，不要跳**。

---

### 阶段一：能让别人用（从「自己玩的 demo」到「可以交付的产品」）

这一阶段不需要动架构，目标是把「不敢给别人用」的地方补上。

#### 9.1.1 写操作前的人工确认（最高优先级）

**现状**：agent 调用 `write_text_file` 就直接写了（虽有备份）。
**问题**：你不能把「一个会自动改你文件的程序」交给陌生人。
**为什么排第一**：这是「能给别人用」和「不能给别人用」的分水岭，而且现在改最便宜。

**怎么改**：在现有架构上加一条审批通道，让 loop 在工具执行前暂停等待用户决定。

```
① 新增 IPC 通道：chat:approval（主进程→渲染层，携带工具名和参数）+ chat:approve（渲染层→主进程，携带决定）
② 主进程维护 pendingApprovals: Map<toolCallId, {resolve, reject}>
③ loop 里执行「需要审批的工具」前：检查策略 → 需要审批时
   · emit('chat:approval', {...})
   · await 一个 Promise（挂在 pendingApprovals 上）
④ 渲染层弹确认框 → invoke('chat:approve', { toolCallId, approved })
⑤ 主进程 resolve 那个 Promise，loop 继续或跳过
⑥ 用户中途点「停止」时，要 reject 所有挂起的 Promise，否则 loop 会永久卡住
```

**配套设计**：

- 每个工具声明 `requiresApproval: boolean`（读工具不需要，写工具需要）
- 提供「本次会话内不再询问」的选项，否则连续写 10 个文件要点 10 次确认
- 超时要有默认动作（建议默认拒绝）
- **这是 LangGraph 里 `interrupt()` / `resume` 的手工实现**——你的项目结构完全支持，不需要换框架

#### 9.1.2 可观测性

| 要补什么 | 用什么 | 说明 |
|---|---|---|
| 结构化日志 | `electron-log` | 落盘 + 分级 + 自动轮转。至少记录：每轮的 turns / 工具名 / 耗时 / 错误码 |
| 崩溃上报 | `@sentry/electron` | 需要用户同意 + 隐私说明。或者退一步只做「一键导出诊断包」 |
| 运行指标 | 自己写 | 首 token 延迟、工具成功率、轮数分布、错误码分布。有数据才知道该优化什么 |

**要点**：日志绝不能包含 API Key 和完整对话内容（除非用户显式同意）。

#### 9.1.3 上下文按 token 预算裁剪

**现状**：固定最近 20 条。
**怎么改**：

1. **先拿到真实的 token 用量**。OpenAI 兼容协议支持在请求体里加 `stream_options: { include_usage: true }`，最后一个 chunk 会带 `usage` 字段。先用它校准估算公式。
2. **按预算裁剪而不是按条数**。把最近的消息从后往前累加，超过预算就停。
3. **工具结果单独设上限**（建议 6000 字符），截断时要在文本里显式告知模型「内容已截断」。
4. **给上下文分层**：system 提示（永不裁）→ 最近 N 轮（永不裁）→ 更早的历史（可裁/可摘要）。

#### 9.1.4 发布工程化

| 要补什么 | 用什么 | 注意 |
|---|---|---|
| 代码签名 | Windows 代码签名证书 或 Azure Trusted Signing | **没有签名的安装包会被 SmartScreen 拦截**，用户不敢装 |
| 自动更新 | `electron-updater` | 配 GitHub Releases 或自建更新服务器。这一步做完，以后修 bug 不用让用户重装 |
| 打包完整性 | `electron-builder` 的 `afterSign` / 证书配置 | 目前 `electron-builder.yml` 只有 NSIS 配置，无签名 |
| CI 流水线 | GitHub Actions | **注意：这与本项目「禁止执行任何命令」的开发约定冲突**。要进生产，这条约定必须解除——自动化构建、类型检查、打包都需要跑命令 |

#### 9.1.5 权限与隐私

- 设置 `session.setPermissionRequestHandler`，默认拒绝所有权限请求
- 提供隐私说明：数据存在哪里、是否上传、如何删除
- 提供「清除全部数据」入口（现在只能手动删 userData 目录）

---

### 阶段二：能做复杂任务（从「问答工具」到「真正的 agent」）

#### 9.2.1 补齐工具能力（性价比最高的一步）

**现状**：只有 `read` / `write` / `edit`，**没有 `ls` / `glob` / `grep`**。

**这个问题有多严重**：模型**不知道工作区里有什么**。它只能猜路径，猜错了就报错，或者干脆问用户「请问文件在哪」。这是当前最明显的能力断层。

**怎么改**：加三个只读工具，复用现有的路径双门校验。

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_dir` | `path`（默认 `.`） | 目录项列表（名字 + 类型 + 大小） |
| `glob_files` | `pattern`（如 `**/*.ts`） | 匹配的文件路径列表（要有数量上限） |
| `search_text` | `pattern`、`path`、`glob` | 匹配的文件名 + 行号 + 上下文行（行数要设上限） |

**注意事项**：
- 必须在 description 里写清楚「返回结果有数量上限，超出会被截断」
- 大目录要排除 `node_modules` / `.git` 之类的噪声目录（或者做成可选参数）
- 结果要排序（按修改时间倒序最有用）

#### 9.2.2 联网搜索（按需）

前面已经详细讨论过。核心结论：

- **DeepSeek 的 `/chat/completions` 没有厂商托管的 web_search**，只能用「客户端函数工具」方案
- 先只做 `web_search` 一个工具，够用再加 `web_fetch`
- 必须解决：回灌体积上限、超时、响应体积上限、域名策略
- 搜索源推荐 `Tavily`（返回干净片段，最省事）或 `Brave Search API`
- **加联网 = 第一次给 agent 开网络出口，这是安全模型的质变**，要单独设计

#### 9.2.3 并行工具执行

**现状**：`for...of` 串行执行。抓 3 个网页 = 3 次串行 HTTP。
**怎么改**：改成 `Promise.all`，但注意：

- 结果回灌上下文的**顺序必须稳定**（按 `toolCallId` 排序，而不是完成顺序）
- UI 展示顺序同理
- `chat:step` 是全量快照，天然支持乱序更新，不用改
- 建议加并发上限（如 4），避免一次发起几十个请求

#### 9.2.4 上下文压缩

**现状**：没有压缩，只有滑动窗口（滑掉的内容永久丢失）。
**怎么改**：

- **简单版**：超过阈值时，把最早的那批消息交给模型摘要成一段「前情提要」，替换掉原文
- **进阶版**（Deep Agents 2026-03 的做法）：**把压缩做成一个工具，让模型自己决定什么时候压**。理由是压缩时机有好有坏——重构到一半时压缩会丢关键细节，做完一个交付物之后再压缩就很合适
- 压缩时必须保留：system 提示、最近若干轮、以及所有「未完成的待办」

#### 9.2.5 存储换成 SQLite

**现状**：单文件 JSON，全量读写，O(n) 写放大。
**建议路径（渐进式，别一步到位）**：

1. **第一步（不引依赖）**：拆成 `conversations/index.json` + `conversations/<id>.json`。改一条消息只重写一个小文件。这一步就能解决大部分性能问题。
2. **第二步（引 SQLite）**：表设计大致如下，WAL 模式。

```sql
conversations(id, title, created_at, updated_at, provider_id, model, workspace_root)
messages(id, conversation_id, role, content, created_at, meta_json)
tool_steps(id, message_id, name, args, status, result, elapsed_ms)
settings(key, value)
```

**技术选择**：

| 方案 | 优点 | 缺点 |
|---|---|---|
| `better-sqlite3` | 同步 API 最适合主进程、性能最好 | **原生模块，打包时需要为 Electron 重编译**（`electron-builder` 支持，但要配置） |
| `sql.js` | WASM，无需原生构建 | 全内存，要自己管落盘，大数据量不合适 |
| `node:sqlite` | Node 内置，零依赖 | 需要较新的 Node 版本，**Electron 34 内置的 Node 版本是否够用需要核实** |

**迁移要点**：写一个 `migrateFromJson()`，启动时检测到旧文件就导入一次并改名备份。**不要删旧文件**。

#### 9.2.6 消息列表虚拟滚动

用 `@tanstack/react-virtual` 或 `react-virtuoso`。注意与「自动贴底」逻辑配合：用户手动往上滚时不要强制拉回底部。

#### 9.2.7 工具定义的延迟加载

**现状**：每轮把全部 6 个工具的完整 description 都塞进请求（其中 `read_text_file` 的 description 里还有真实绝对路径）。
**什么时候需要改**：工具超过 10 个之后。塞太多 schema 会吃 token，还会降低 prompt cache 命中率。
**参考做法**：OpenAI 的 `tool_search`——只给模型工具名清单，它需要时再拉取详细定义。

---

### 阶段三：规模化 / 多人（架构级变化）

如果这个产品的目标变成「给一个团队用」或「做成商业产品」，架构会根本性改变。**现在不要提前做，但要知道会变成什么样。**

| 维度 | 现在 | 多人 / 云端形态 |
|---|---|---|
| 客户端 | Electron，持有全部逻辑和数据 | Electron 退化为**瘦客户端**，只负责 UI 和本地文件操作代理 |
| Agent loop | 主进程 | **移到服务端**（必须统一管控 Key 和成本） |
| 存储 | 本机 JSON | 服务端数据库（Postgres + 对象存储） |
| 身份 | 无 | 账号体系、组织、角色权限 |
| 密钥 | 用户自配，本地加密 | 服务端统一持有，或支持 BYOK |
| 成本 | 用户自付 | 配额、计费、限流、审计 |
| 合规 | 无 | 数据落地位置、删除权、审计日志、DPA |

**这时候才真正需要** LangGraph / OpenAI Agents SDK 那一级的运行时能力：跨进程持久化、崩溃续跑、多租户隔离、审批流、可回放的状态历史。因为那时的问题从「怎么把 loop 写好」变成了「怎么管住几百个并发跑的 loop」。

**判断信号**（出现任一条就可以考虑）：
- 需要「崩了能续跑」的长任务
- 需要服务端审批流
- 需要同时服务多个用户
- 需要在服务端做成本管控和审计

---

## 10. 技术选型对照总表

| 领域 | 现在用什么 | 生产建议 | 为什么改 |
|---|---|---|---|
| 桌面壳 | Electron 34 | 保持 | 成熟、生态好 |
| 构建 | electron-vite | 保持 | 三进程配置开箱即用 |
| 打包 | electron-builder（仅 Windows） | + 代码签名 + `electron-updater` + macOS 公证 | 没签名的包用户不敢装；没更新就得让用户重装 |
| UI | React 19 + Tailwind v4 + HeroUI v3 | 保持 | — |
| 状态 | zustand 单 store | 保持（除非要做复杂撤销/时间旅行） | 现阶段完全够用 |
| Agent 运行时 | **手写 loop** | 阶段一二保持手写；阶段三换 LangGraph / Agents SDK | 现在换框架的成本大于收益；运行时能力（持久化、中断、并行归约）在单机单线程场景用不上 |
| 存储 | 单文件 JSON | 阶段一拆文件 → 阶段二 SQLite | O(n) 写放大 + 无查询能力 |
| 密钥 | Electron safeStorage | 保持；或加一层服务端代理签发临时 token | safeStorage 依赖系统钥匙串，够用；但换机器解不开 |
| 长列表 | 朴素 `.map()` | 虚拟滚动 | 长会话会掉帧 |
| 日志 | 无 | `electron-log` | 出问题无法排查 |
| 崩溃上报 | 无 | `@sentry/electron` 或诊断包导出 | 无法发现线上问题 |
| 测试 | **无（项目禁止执行命令）** | 单测（vitest）+ E2E（Playwright for Electron） | **要进生产这条禁令必须解除**。至少覆盖：路径校验、协议映射、存储原子性、错误收敛 |
| CI | 无 | GitHub Actions | 自动化构建、类型检查、打包 |
| 上下文管理 | 固定 20 条 | token 预算 + 摘要压缩 | 条数 ≠ token 数 |
| 工具执行 | 串行 | 并行（带并发上限） | 延迟随工具数线性增长 |
| 工具确认 | 无 | 审批通道（interrupt/resume） | 陌生人不敢用会自动改文件的程序 |
| 文件工具 | read / write / edit | + `list_dir` / `glob` / `search_text` | 模型不知道工作区里有什么，只能猜 |
| 网络能力 | 无 | `web_search`（+ 可选 `web_fetch`） | 时效性问题答不了；注意这是安全模型的质变 |

---

## 11. 给初学者的学习路径

如果你想通过这个项目学 Electron + Agent，建议按这个顺序读代码：

**第一步：看一遍聊天流程**

1. `src/renderer/components/Composer.tsx` —— 用户怎么发出消息
2. `src/renderer/store/useAppStore.ts` 的 `sendMessage` —— 乐观更新是怎么做的
3. `src/shared/ipc-channels.ts` —— 通道和类型定义（这是三方的「合同」）
4. `src/preload/index.ts` —— 渲染层能调用的全部能力，就这么多
5. `src/main/ipc.ts` 的 `handleChatSend` —— 请求进入主进程后发生了什么

**第二步：看流式输出**

6. `src/main/providers/sse.ts` —— 流式解析的完整实现（`TextDecoder({stream:true})` 是个关键技巧）
7. `src/main/providers/deepseek.ts` 的 `chatStream` —— 怎么把流变成回调
8. `src/renderer/App.tsx` 的事件订阅 —— 增量怎么上屏

**第三步：看 Agent 循环**

9. `src/main/harness/types.ts` —— 工具契约（先看契约，再看实现）
10. `src/main/harness/loop.ts` —— 整个 loop 只有 190 行，能读完
11. `src/main/harness/tools.ts` —— 工具怎么写、怎么保证安全

**第四步：看工程化细节**

12. `src/main/storage.ts` —— 原子写和串行队列，这两个模式值得记住
13. `src/main/secret.ts` —— 密钥处理
14. `src/renderer/styles/theme.css` —— 主题收束的思路

### 三个值得记住的通用模式

| 模式 | 在哪里用到 | 什么时候用 |
|---|---|---|
| **原子替换**（写临时文件 + rename） | `storage.ts`、`workspace-memory.ts`、`conversation-export.ts` | 任何「不能留下半截文件」的场景 |
| **串行队列**（`enqueue`） | `storage.ts`、`workspace-memory.ts` | 任何「读-改-写」且可能并发调用的场景 |
| **双门校验**（字符串检查 + realpath 复核） | `harness/tools.ts` | 任何接受外部路径输入的场景 |

### 一句建议

**先把这个项目跑起来，改一个小东西，看它怎么坏。**

比如：把 `MAX_TURNS` 从 8 改成 2，看看多步任务会怎样失败；或者故意在 `calculator` 里传一个字母，看错误是怎么回灌给模型的。**看到系统如何失败，比看它如何成功学到的东西多得多。**

---

## 附：这份文档涉及的关键文件索引

| 想了解 | 看哪个文件 |
|---|---|
| 数据模型长什么样 | `src/shared/types.ts` |
| 有哪些 IPC 通道 | `src/shared/ipc-channels.ts` |
| 一轮对话的编排 | `src/main/ipc.ts` |
| agent 循环 | `src/main/harness/loop.ts` |
| 工具定义与安全 | `src/main/harness/tools.ts` |
| 厂商协议差异 | `src/main/providers/types.ts` |
| 流式解析 | `src/main/providers/sse.ts` |
| 持久化 | `src/main/storage.ts` |
| 密钥 | `src/main/secret.ts` |
| 记忆系统 | `src/main/workspace-memory.ts` |
| 前端状态 | `src/renderer/store/useAppStore.ts` |
| 主题与配色 | `src/renderer/styles/theme.css` |
| 打包 | `electron-builder.yml` |
