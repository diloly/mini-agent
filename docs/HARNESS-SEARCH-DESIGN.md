# mini-agent · 增量设计：`list_dir` + `search_text`（第一批「找文件」能力）

> 版本：v1.0 · 编写：高见远（架构师） · 类型：**增量设计**（不重写 `docs/ARCHITECTURE.md` / `docs/HARNESS-ARCHITECTURE.md`）
> 输入：主理人齐活林派发任务 + `src/main/harness/{tools,types,loop}.ts`、`src/main/providers/types.ts` 现状取证
> 下游：寇豆码（工程师）实现
> 🚫 硬约束：本轮**只做设计、不改任何源码**；不得执行任何命令；不得启动浏览器 / 查 DOM。验收一律「静态核对」或「用户手动运行肉眼确认」。

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 新增工具 | `list_dir`（列目录）、`search_text`（按内容搜）—— 均**只读** |
| 工具总数 | 6 → 8（仍在合理范围；loop 每轮重发全量 schema） |
| 新依赖 | **无**。纯 Node `fs` 手写，不装 ripgrep / 任何搜索库 |
| 新文件 | `src/main/harness/tools-search.ts`（一个模块承载两工具 + 共享辅助） |
| `tools.ts` 改动 | 很小：① 一行 import；② 一次工厂调用；③ `HARNESS_TOOLS` 展开；④ `read_text_file` description 补一句。**禁止 Write 整文件重写** |
| `query` 语义 | **字面量（literal substring）**，默认**大小写不敏感**；不做正则（理由见 §5.2） |
| 递归遍历 | **手写剪枝递归**：`readdir(dir,{withFileTypes:true})` 逐层下降，**进目录前**按忽略名单剪枝。**禁用** `readdir(recursive:true)` |
| 头号约束 | **三重输出上限 + 内部扫描预算**，超限回灌「引导缩小范围」的文案（§6） |
| 三重上限取值 | list_dir：**200 项 / 单行 300 字符 / 8000 字符**；search_text：**命中默认 50、硬顶 200 / 单文件 256 KB / 8000 字符**（推导见 §6.1） |
| 写工具 | **不改** `write_text_file` / `edit_text_file` 行为；只动 `read_text_file` 的 description 文案 |
| 渲染层 | **零改动**：复用现有 `chat:step` 通道展示 |

---

## 1. 背景与核心缺口

现状 `HARNESS_TOOLS`（`tools.ts:548-555`）共 6 个工具：
`get_current_time` / `calculator` / `read_text_file` / `write_text_file` / `edit_text_file` / `append_daily_note`。

**核心缺口**：**没有任何工具能「发现」文件**。`read_text_file` 只能读模型**已经知道路径**的文件 —— 面对非空工作区，模型对「工作区里有什么」**没有任何事实来源**，只能：
- 用先验猜路径（如猜 `src/index.ts`），猜错就拿到 `文件读取失败`；
- 或者反问用户「请问文件在哪」。

这直接导致「找文件」能力缺失。本轮补齐两个**只读发现工具**：`list_dir`（看目录结构）+ `search_text`（按内容定位）。模型的标准工作流变为 **`list_dir` 概览 → `search_text` 定位 → `read_text_file` 精读**。

> 本轮**不做**「规划」能力（`update_plan`，第二批）；不碰 Plan 模式、子智能体、上下文压缩。

---

## 2. 实现方案

### 2.1 总体思路

新增一个模块 `src/main/harness/tools-search.ts`，承载两个工具与它们的**共享辅助**（忽略名单、剪枝遍历、glob 匹配、二进制探测、限流计数、字节格式化）。`tools.ts` 只做「取用 + 注册」。

为什么拆成独立模块（本仓硬事实）：`tools.ts` 已 **573 行**，且本仓**发生过多次「整文件重写静默丢代码」事故**。把新工具放进独立模块后，`tools.ts` 的改动面降到最小、review 容易，也**规避对 >500 行文件做整文件重写的风险**。

### 2.2 复用既有安全资产（不另造一套）

两个工具都需要「路径必须落在工作区内」这条**双门校验**，现成实现在 `tools.ts`：

| 资产 | 位置 | 作用 |
|---|---|---|
| `resolveInsideWorkspace(root, rel)` | `tools.ts:47` | 第一道门：字符串层面解析 + 越界检查 |
| `realpathNearestExisting(dir)` | `tools.ts:63` | 取最近已存在祖先的 realpath（被第二道门复用）|
| `resolveWorkspaceRealRoot(root)` | `tools.ts:84` | 工作区根必须存在且是目录，返回其 realpath 作基准 |
| `verifyRealPath(realRoot, target)` | `tools.ts:106` | 第二道门：realpath 复核，防符号链接逃逸 |

**复用方式：依赖注入（工厂），避免循环依赖。**

`tools-search.ts` **不** import `./tools`；改为导出一个工厂，由 `tools.ts` 把自己的守卫函数**注入**进去：

```ts
// tools-search.ts（对外）
export type PathGuardResult = { ok: true; target: string } | { ok: false; text: string };

export interface WorkspacePathGuards {
  resolveInsideWorkspace: (root: string, relPath: string) => PathGuardResult;
  resolveWorkspaceRealRoot: (root: string) => Promise<PathGuardResult>;
  verifyRealPath: (realRoot: string, target: string) => Promise<{ ok: true } | { ok: false; text: string }>;
}

/** 用注入的守卫构造两个搜索工具（闭包持有守卫，避免 import 循环） */
export function createSearchTools(guards: WorkspacePathGuards): HarnessTool[];
```

> **为什么用注入而非 `export` + 互相 import**：`tools.ts` 需要 import `tools-search.ts` 来完成注册；若 `tools-search.ts` 反过来 import `tools.ts`，就形成**循环依赖**。ESM 对函数声明（提升）通常能容忍这种环，但这是已知易错点（初始化顺序敏感）。注入式工厂**彻底无环**，同时满足「不另造一套双门校验」。
> 备选（若工程师更偏好直白 import）：把 4 个守卫**移动**到新模块 `tools-path.ts`，两边都 import。也可行，只是对 `tools.ts` 的删改面更大。**本设计采用注入式工厂为主选。**

### 2.3 手写剪枝递归（🔴 关键，禁用 `readdir(recursive:true)`）

`fs.promises.readdir(dir, { recursive: true })` 会**先走进 `node_modules` / `.git` 再让你过滤** —— 十万级条目白白遍历，CPU 与内存都不可接受。

**正确做法**：用 `withFileTypes: true` 逐层 `readdir`，在**下降进子目录之前**判断名字是否命中忽略名单，命中就**根本不 push 进待访问栈**：

```
entries = await readdir(abs, { withFileTypes: true })   // 只读一层
for e of entries_sorted:
    if e.name ∈ IGNORED_DIRS: continue        // ← 剪枝：直接不下降
    if e.isSymbolicLink():    continue        // ← 不跟随符号链接（防逃逸 / 防环）
    ...                                        // 目录：登记 + 视深度决定是否入栈；文件：登记
```

忽略名单（单一常量，`IGNORED_DIRS`）：
`node_modules` / `.git` / `out` / `dist` / `.agent`
> 说明：`.agent` 屏蔽的是系统自维护的 `.agent/memory/` 与 `.agent/conversations/`（见 `workspace-memory.ts`），避免把记忆文件当普通文件搜出来。

编译约束（`tsconfig.node.json`：`target/lib = ES2022`、`noUnusedLocals`、`noUnusedParameters`）：
- **禁用 ES2023+ 方法**（`findLast` / `toSorted` / `toReversed` 等）；
- 不能留未使用的变量 / 参数（会编译失败）。

---

## 3. 文件清单

| 文件（相对仓库根） | 动作 | 说明 |
|---|---|---|
| `src/main/harness/tools-search.ts` | **新增** | 两工具实现 + 共享辅助（`IGNORED_DIRS` / 剪枝遍历 / `globToRegExp` / `isProbablyBinary` / `formatBytes` / 限流常量 / `createSearchTools` 工厂） |
| `src/main/harness/tools.ts` | **修改（极小）** | 见 §3.1 的 4 个精确编辑点 |

**不改动**：`harness/types.ts`、`harness/loop.ts`、`harness/index.ts`（barrel 已 `export { HARNESS_TOOLS } from './tools'`，注册进数组即自动生效）、`providers/*`、`shared/*`、`ipc.ts`、`preload/*`、`renderer/*`。

### 3.1 `tools.ts` 精确编辑点（4 处，全部 Edit 定点改）

| # | 位置 | 改动 |
|---|---|---|
| ① | 文件顶部 import 区（现 `tools.ts:16-20` 附近） | 新增 `import { createSearchTools } from './tools-search';` |
| ② | `HARNESS_TOOLS` 定义处（`tools.ts:547` 之前） | 新增一行：`const searchTools = createSearchTools({ resolveInsideWorkspace, resolveWorkspaceRealRoot, verifyRealPath });` |
| ③ | `HARNESS_TOOLS` 数组（`tools.ts:548-555`） | 在数组末尾（`appendDailyNote,` 之后）追加 `...searchTools,` |
| ④ | `readTextFile.define` 的 `description`（`tools.ts:242-245`） | 在模板字符串**末尾**追加一句约束（§3.2）。**只动字符串，不动行为** |

### 3.2 `read_text_file` description 增补（借 WorkBuddy 的「约束化」写法）

在现 description 末尾（`…本工具无法读取工作区外的任何文件。` 之后）追加：

```
不知道文件路径时，先用 list_dir 查看目录、或用 search_text 按内容定位，再填入 path；不要凭猜测填写 path。
```

> 作用：把「该用哪个工具」从**建议**升级为**约束**，直接降低模型猜路径失败率。**仅字符串改动**，`execute` 逻辑一行不动。

---

## 4. 数据与接口定义

### 4.1 `ToolDefinition`（既有契约，`providers/types.ts:14`）

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema（不引 zod）
}
```

`HarnessTool`（`harness/types.ts:39`）：`{ define(context) => ToolDefinition; execute(rawArgs, signal, context) => Promise<ToolResult> }`，`ToolResult = { ok: boolean; text: string }`。**`execute` 必须自吞异常，绝不向上抛。**

### 4.2 `list_dir`

**JSON Schema 原文**（`define(context).parameters`）：

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "相对于工作区根目录的目录路径，默认 \".\"（工作区根目录）"
    },
    "depth": {
      "type": "integer",
      "description": "递归深度，默认 1（仅当前层）；取值范围 1~3"
    }
  },
  "required": []
}
```

**description 模板**（必须拼入真实工作区路径，照抄 `readTextFile.define` 的写法）：

```ts
description:
  `列出工作区内某个目录的内容（只读）。当前工作区根目录为 ${root}；` +
  `path 填相对该目录的目录路径（默认 "." 表示工作区根）。` +
  `目录在前、文件在后，文件附大小；自动跳过 node_modules / .git / out / dist / .agent。` +
  `工作区之外的本机路径一律拒绝。` +
  `输出有上限（约 200 项），超出会被截断——需要看更多时请缩小 path 或降低 depth。`
```

**内部类型**：

```ts
interface ListDirArgs { path?: string; depth?: number; }

interface ListEntry {
  /** 相对工作区的 POSIX 风格路径，如 src/main/index.ts */
  relPath: string;
  type: 'dir' | 'file';
  /** 仅 file 有：字节数 */
  size?: number;
}
```

### 4.3 `search_text`

**JSON Schema 原文**：

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "要搜索的字面量文本（不做正则），默认大小写不敏感"
    },
    "path": {
      "type": "string",
      "description": "相对于工作区根目录的起始目录，默认 \".\""
    },
    "glob": {
      "type": "string",
      "description": "文件名过滤，如 *.ts、*.md、src/**/*.ts；不含 \"/\" 时按文件名匹配，含 \"/\" 时按相对路径匹配；省略则不过滤"
    },
    "max_results": {
      "type": "integer",
      "description": "最多返回的命中行数，默认 50，上限 200"
    },
    "case_sensitive": {
      "type": "boolean",
      "description": "是否区分大小写，默认 false"
    }
  },
  "required": ["query"]
}
```

**description 模板**：

```ts
description:
  `在工作区内按内容搜索文本（只读，字面量匹配，非正则）。当前工作区根目录为 ${root}；` +
  `path 填相对该目录的起始目录（默认 "."）。` +
  `返回形如「相对路径:行号: 该行内容」，按文件聚集；自动跳过 node_modules / .git / out / dist / .agent 与二进制文件。` +
  `命中数有上限（默认 50 行），超出会被截断——请加 glob 或缩小 path 重搜。` +
  `不知道文件名时优先用它定位，再用 read_text_file 精读。工作区之外一律拒绝。`
```

**内部类型**：

```ts
interface SearchArgs {
  query?: string;
  path?: string;
  glob?: string;
  max_results?: number;
  case_sensitive?: boolean;
}

interface SearchHit {
  /** 相对工作区的 POSIX 风格路径 */
  relPath: string;
  /** 1-based 行号 */
  line: number;
  /** 该行内容（已按 SEARCH_MAX_LINE_CHARS 截断） */
  text: string;
}
```

### 4.4 共享辅助（`tools-search.ts` 内部导出）

```ts
/** 忽略目录名单（单一事实来源；剪枝在下降前发生） */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'out', 'dist', '.agent',
]);

/** 二进制扩展名快速过滤（真正的判据是 \0 嗅探，这里是廉价前置） */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.node', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.wav',
]);

/** 把 glob 编译成 RegExp；仅支持 * ? **，无新依赖 */
export function globToRegExp(pattern: string): RegExp;

/** glob 是否匹配给定相对路径（不含 "/" 时按 basename 匹配） */
export function matchGlob(relPath: string, pattern: string): boolean;

/** 二进制探测：读取缓冲区内出现 0x00 即判定为二进制 */
export function isProbablyBinary(buffer: Buffer): boolean;

/** 人类可读体积，如 "1.2 KB" */
export function formatBytes(bytes: number): string;
```

**glob 语义**（写死，避免歧义）：
- `*` 匹配任意非 `/` 字符；`?` 匹配单个非 `/` 字符；`**` 匹配任意字符（跨 `/`）。
- 模式**不含 `/`** → 对 **basename** 匹配（`*.ts` 命中 `src/a.ts`）。
- 模式**含 `/`** → 对**相对路径**匹配（`src/**/*.ts` 命中 `src/main/a.ts`）。
- 长度上限 **100 字符**，超长直接判定「不匹配」（防自造超长模式）。

---

## 5. `query` 语义决策：字面量，非正则

| 维度 | 决策 |
|---|---|
| 匹配方式 | **字面量子串**（`String.prototype.includes` / `indexOf`） |
| 大小写 | 默认**不敏感**（两边 `toLowerCase()` 后比较）；可用 `case_sensitive=true` 关闭 |

**理由**：
1. **正则 → ReDoS**：模型可产出 `(a+)+$` 这类灾难性回溯正则，单次搜索即可卡死主进程事件循环（桌面端会界面冻结）。防 ReDoS 需要安全正则校验器（如 `safe-regex`），而**本批禁止新增依赖**；手写可靠的 ReDoS 静态分析不可行。
2. **字面量是线性**：`includes` 无病态回溯，成本可预测，天然适配「限流 + 可中止」需求。
3. **覆盖度够用**：「找文件」主场景是找标识符 / 字符串 / 函数名，字面量足够；确需模式匹配时，模型可先 `list_dir` 缩范围再逐文件 `read_text_file`。
4. 大小写不敏感能显著减少「漏搜」（模型常记不准标识符大小写）；`case_sensitive` 作为可选项保留精确搜索能力。

> `case_sensitive` 是对主理人给定参数表的**一处显式增补**（默认 `false`，可选），**不是静默改动** —— 理由如上，成本极低、收益明确。
> `glob` 的 `*`/`**` 是**我们自造的**编译产物（非模型直接提交的正则），模式长度受限（≤100）、输入是短路径，**无 ReDoS 面**。

---

## 6. 关键流程：三重限流 + 剪枝递归

### 6.1 🔴 输出上限取值与推导依据（主理人要求重点核对的数字）

#### 取值总表

| 工具 | ① 条数上限 | ② 单文件 / 单行上限 | ③ 总输出字符上限 | 内部扫描预算（安全阀） |
|---|---|---|---|---|
| `list_dir` | **200** 个目录项 | 单行渲染 **≤ 300 字符** | **8000 字符** | 最多访问 **5000** 个条目 |
| `search_text` | 命中默认 **50** 行，硬顶 **200** 行 | 单文件 **≤ 256 KB**（超限跳过）；单命中行显示 ≤ **200 字符** | **8000 字符** | 最多扫描 **2000** 个文件 且 总读入 **≤ 32 MB** |

常量名（写进 `tools-search.ts`）：

```ts
const LIST_MAX_ENTRIES = 200;
const LIST_MAX_LINE_CHARS = 300;
const LIST_MAX_OUTPUT_CHARS = 8_000;
const LIST_MAX_DEPTH = 3;
const LIST_VISIT_BUDGET = 5_000;

const SEARCH_DEFAULT_RESULTS = 50;
const SEARCH_MAX_RESULTS = 200;
const SEARCH_MAX_OUTPUT_CHARS = 8_000;
const SEARCH_MAX_LINE_CHARS = 200;
const SEARCH_MAX_QUERY_CHARS = 200;
const SEARCH_MAX_FILE_BYTES = 262_144;        // 256 KB
const SEARCH_MAX_SCAN_FILES = 2_000;
const SEARCH_MAX_SCAN_BYTES = 33_554_432;     // 32 MB
const SEARCH_BINARY_SNIFF_BYTES = 8_000;
```

#### 推导过程（为什么是这些数）

**① 锚点**：本仓既有 `read_text_file` 把**单个文件**截断在 **20,000 字符**（`tools.ts:288`）。这是本仓已经接受过的「一次工具结果最多多大」的天花板。

**② 定位工具必须显著便宜于「读文件」**：`list_dir` / `search_text` 的职责是**定位**，不是**通读**。若一次搜索返回量接近一次读文件，模型就失去「先缩范围再精读」的动机，反而拿搜索结果当内容用。故搜索/列表单次输出定为 **8,000 字符 ≈ 一次读文件上限的 40%**。

**③ 8000 字符 ≈ 多少 token**：以英文/代码为主约 4 字符/token → **~2,000 token**；中文混排约 1–1.5 字符/token → 至多 **~6,000 token**。即使模型连发两次（一 list 一 search）也约 **4,000–12,000 token**，远小于主流模型窗口，也远小于「8 轮里再叠加 6 次读文件」的最坏情形。

**④ 命中条数与行长共同推出「默认 50」**：一条命中行 ≈ `路径:行号: 代码` ≈ **80–120 字符**。取 50 行 × 120 字符 = **6,000 字符 < 8,000** → **默认参数下几乎永不触发截断**，模型一次搜索通常就能拿全结果，不用反复重搜（避免多烧轮次）。
> 若默认给更大（如 200），200 × 120 = 24,000 字符会**立即撞上 8,000 字符上限**，等于把「默认值」变成「必然残缺」，逼模型重搜 —— 这正是要避免的。

**⑤ 硬顶 200 的意义**：给模型一个「主动要更多」的旋钮（`max_results=200`），但**8000 字符上限才是真正的守门人** —— 行很长时字符先到顶、条数还没到，这正是我们想要的：**按信息量而非按行数封顶**。所以**条数是人体工学默认，字符是硬约束**。

**⑥ `list_dir` 的 200 项与 8000 字符是「同一量级」**：一条目录项 ≈ `[file] path (1.2 KB)` ≈ **40 字符**，200 × 40 = **8,000 字符** → **两个上限同时命中**，不会出现「条数没用完但字符爆了」的错配。取 200 而非更大，是为了让 `depth>1` 时**很快截断**，逼模型「缩 path / 降 depth」，而不是拿一份巨大的树。

**⑦ 单文件 256 KB**：95% 以上的源码/文档远小于此；而打包产物、压缩包、日志、数据集往往数 MB —— 对其逐行扫描**性价比极低且极易淹没结果**。256 KB 既覆盖正常文件，又把单文件最坏内存占用钉死。
**⑧ `search_text` 单命中行 200 字符**：防止一行被 minify 的 JS / 长 JSON 独占整个 8000 字符预算 —— 若不截断，**一行就等于全部结果**。
**⑨ 内部扫描预算（安全阀，非输出上限）**：`search_text` 最多开 2,000 个文件、最多读入 32 MB；`list_dir` 最多访问 5,000 条目。它们**不影响输出格式**，只用于**封顶最坏 I/O 时间**（否则深目录 + 大文件会让工具卡住主进程）。触顶时回灌「已扫描 N 个文件后停止，请缩小 path 或加 glob」。

> **一句话原则**：**宁可少给、让模型加条件重搜**，绝不一次给全。截断不是失败，而是**把「范围太大」这个事实告诉模型**，由它自己收窄。

### 6.2 剪枝递归伪代码

```text
async function walkPruned(startAbs, guardsContext, options):
  # options: maxDepth, visitBudget, onDir(rel), onFile(rel, size) -> boolean(是否继续)
  stack = [ { abs: startAbs, rel: '.', depth: 0 } ]      # BFS；rel 用 POSIX 分隔符
  visited = 0
  truncatedByBudget = false

  while stack 非空:
      if signal.aborted: return { aborted: true }         # 每个目录出栈时检查一次
      node = stack.shift()                                 # BFS 队首（保证层级顺序稳定）
      entries = await readdir(node.abs, { withFileTypes: true })   # 失败(无权限/消失) → 跳过该目录
      entries.sort(byDirThenNameCodeUnit)                  # 确定性排序，见 §6.5

      for e of entries:
          visited += 1
          if visited > options.visitBudget: truncatedByBudget = true; return
          if IGNORED_DIRS.has(e.name): continue            # ★ 剪枝：命中名单直接不下降
          if e.isSymbolicLink(): continue                  # ★ 不跟随符号链接（防逃逸/环）
          childRel = (node.rel === '.') ? e.name : node.rel + '/' + e.name
          if e.isDirectory():
              onDir(childRel)
              if node.depth + 1 < options.maxDepth:
                  stack.push({ abs: path.join(node.abs, e.name), rel: childRel, depth: node.depth + 1 })
          else if e.isFile():
              size = (await stat(path.join(node.abs, e.name))).size
              if onFile(childRel, size) === false: return   # 上层要求提前停（预算耗尽）
  return { truncatedByBudget }
```

要点：
- **在 `for` 循环里、`path.join` 之前**就 `continue` 掉忽略目录 —— 这就是「剪枝」的全部含义：**不下降**。
- `readdir` 单层失败（无权限、目录刚被删）**不应中断整体遍历**：`try/catch` 后跳过该目录继续。
- `signal.aborted` 每个目录检查一次（而非每文件），既及时又不过度开销。
- 排序在**每个目录内部**做（见 §6.5），保证输出稳定可复现。

### 6.3 `list_dir` 执行流程与输出格式

```text
execute(rawArgs, signal, context):
  try:
      { path: rel=".", depth=1 } = parseArgs(rawArgs)
      depth = clamp(depth, 1, LIST_MAX_DEPTH)
      # 双门路径校验（复用注入的守卫）
      r1 = guards.resolveInsideWorkspace(context.workspaceRoot, rel)      # 第一道门
      if r1 失败: return { ok:false, text: r1.text }
      r2 = await guards.resolveWorkspaceRealRoot(context.workspaceRoot)   # 根必须存在
      if r2 失败: return { ok:false, text: r2.text }
      r3 = await guards.verifyRealPath(r2.realRoot, r1.target)            # 第二道门
      if r3 失败: return { ok:false, text: r3.text }
      # 目标必须存在且是目录
      st = await stat(r1.target); if !st.isDirectory(): return { ok:false, text:'目标不是目录：' + rel }

      entries = []
      walkPruned(r1.target, { maxDepth: depth, visitBudget: LIST_VISIT_BUDGET,
                              onDir: d => entries.push({relPath:d, type:'dir'}),
                              onFile: (f,s) => entries.push({relPath:f, type:'file', size:s}) })
      # 三重限流 + 渲染
      return { ok:true, text: renderList(rel, depth, entries) }
  catch error:
      return { ok:false, text: `列目录失败：${rel}（${message(error)}）` }   # 自吞异常
```

`renderList` 组装文本，**逐条累加，任一上限触发即停止并追加截断文案**：

```text
renderList(rel, depth, entries):
  lines = [`目录列表：${rel}（深度 ${depth}）`]
  shown = 0; chars = lines[0].length; truncated = null

  for e of entries:
      if shown >= LIST_MAX_ENTRIES: truncated = `条目数上限 ${LIST_MAX_ENTRIES}`; break
      line = (e.type === 'dir')
             ? `[dir]  ${e.relPath}/`
             : `[file] ${e.relPath} (${formatBytes(e.size)})`     # e.relPath 超 LIST_MAX_LINE_CHARS 时截断
      if chars + line.length > LIST_MAX_OUTPUT_CHARS: truncated = `输出字符上限 ${LIST_MAX_OUTPUT_CHARS}`; break
      lines.push(line); chars += line.length + 1; shown += 1

  dirCount = ...; fileCount = ...
  lines.push('', `共 ${shown} 项（目录 ${dirCount} / 文件 ${fileCount}）`)
  if truncated:
      lines.push(`…（已截断：命中${truncated}。请缩小 path、或降低 depth 后重试，以看到其余内容）`)
  return lines.join('\n')
```

正常输出示例：

```text
目录列表：.（深度 1）
[dir]  src/
[dir]  docs/
[file] README.md (1.2 KB)
[file] package.json (0.9 KB)

共 4 项（目录 2 / 文件 2）
```

截断输出示例：

```text
…
共 200 项（目录 8 / 文件 192）
…（已截断：命中条目数上限 200。请缩小 path、或降低 depth 后重试，以看到其余内容）
```

### 6.4 `search_text` 执行流程与输出格式

```text
execute(rawArgs, signal, context):
  try:
      { query, path=".", glob, max_results=50, case_sensitive=false } = parseArgs(rawArgs)
      if typeof query !== 'string' || query.trim()==='' : return { ok:false, text:'参数错误：缺少 query 字段' }
      if query.length > SEARCH_MAX_QUERY_CHARS:          return { ok:false, text:`查询过长（上限 ${SEARCH_MAX_QUERY_CHARS} 字符）` }
      limit = clamp(max_results, 1, SEARCH_MAX_RESULTS)
      needle = case_sensitive ? query : query.toLowerCase()

      # 双门路径校验（同上，略）
      # 递归遍历 + 三重限流
      hits = []; scanFiles = 0; scanBytes = 0; stopped = null
      walkPruned(target, { maxDepth: Infinity, visitBudget: LIST_VISIT_BUDGET,
          onFile: (rel, size) =>
              if glob && !matchGlob(rel, glob): return true                 # glob 不匹配 → 继续
              if BINARY_EXTENSIONS.has(extname(rel)): return true           # 扩展名快筛
              if size > SEARCH_MAX_FILE_BYTES: return true                  # ② 单文件上限 → 跳过
              if scanFiles >= SEARCH_MAX_SCAN_FILES: stopped='扫描文件数'; return false
              buf = await readFile(abs)                                     # 单文件最大 256KB
              scanFiles++; scanBytes += buf.length
              if scanBytes >= SEARCH_MAX_SCAN_BYTES: stopped='扫描字节预算'; return false
              if isProbablyBinary(buf): return true                         # \0 探测 → 跳过
              text = buf.toString('utf8')
              for (line, i) of text.split('\n'):
                  hay = case_sensitive ? line : line.toLowerCase()
                  if hay.includes(needle):
                      hits.push({ relPath: rel, line: i+1, text: clampLine(line, SEARCH_MAX_LINE_CHARS) })
                      if hits.length >= limit: stopped='命中数上限'; return false   # ① 条数上限
                  if signal.aborted: stopped='已中止'; return false
              return true
      })
      return { ok:true, text: renderSearch(query, path, glob, case_sensitive, hits, stopped) }
  catch error:
      return { ok:false, text: `搜索失败（${message(error)}）` }
```

`renderSearch` 逐条累加、超总字符上限即停（**③**），末尾附引导文案：

```text
renderSearch(query, path, glob, cs, hits, stopped):
  files = unique(hits.map(h => h.relPath))            # 文件聚集
  header = `搜索 "${query}"（路径 ${path}${glob ? `，glob ${glob}` : ''}，区分大小写 ${cs ? '是' : '否'}）：命中 ${hits.length} 行 / ${files.length} 个文件`
  lines = [header]; chars = header.length

  for h of hits:                                       # hits 已按 文件路径升序 + 行号升序（见 §6.5）
      line = `${h.relPath}:${h.line}: ${h.text}`
      if chars + line.length > SEARCH_MAX_OUTPUT_CHARS: stopped='输出字符上限'; break
      lines.push(line); chars += line.length + 1

  if stopped:
      lines.push(`…（已截断：命中${stopped}。请加 glob 收窄文件类型、或把 path 缩小到具体子目录后重搜）`)
  if hits.length === 0:
      lines = [`未找到包含 "${query}" 的内容（路径 ${path}${glob ? `，glob ${glob}` : ''}）。`,
               `可尝试：换关键字、放宽或去掉 glob、把 path 指向更具体的子目录。`]
  return lines.join('\n')
```

正常输出示例：

```text
搜索 "createServer"（路径 .，glob *.ts，区分大小写 否）：命中 3 行 / 2 个文件
src/server.ts:14: export function createServer(port: number) {
src/server.ts:88:   return createServer(3000);
src/http/app.ts:5: import { createServer } from '../server';

共检索 12 个文件
```

零命中示例：

```text
未找到包含 "createServer" 的内容（路径 .，glob *.ts）。
可尝试：换关键字、放宽或去掉 glob、把 path 指向更具体的子目录。
```

截断示例：

```text
…（已截断：命中命中数上限。请加 glob 收窄文件类型、或把 path 缩小到具体子目录后重搜）
```

### 6.5 确定性排序（保证输出稳定可复现）

| 对象 | 规则 |
|---|---|
| 目录内条目（遍历时） | **目录优先**，同类按 **UTF-16 码元升序**（`a < b ? -1 : a > b ? 1 : 0`） |
| `list_dir` 输出顺序 | **BFS 层级顺序**：先根层、再逐层展开；同层内按上面的规则 |
| `search_text` 命中顺序 | 按 **相对路径码元升序**（文件聚集），同文件内按**行号升序** |

> 为什么不用 `localeCompare`：其行为**依赖运行时 locale**，同一工作区在不同机器上可能给出不同顺序，破坏「可复现」。码元序虽然对中文而言是「任意序」，但**稳定**，而**稳定性正是模型需要的**（同一问题重复搜索得到一致结果）。

### 6.6 时序图（模型典型工作流）

```mermaid
sequenceDiagram
  participant M as 模型
  participant L as harness loop.ts
  participant T as tools-search.ts
  participant F as 工作区文件系统

  M->>L: tool_calls: list_dir { path:".", depth:1 }（模型不知道有哪些文件）
  L->>T: execute(rawArgs, signal, context)
  T->>F: readdir 逐层 + 剪枝
  F-->>T: 条目
  T-->>L: { ok:true, text: 目录树(≤200 项 / ≤8000 字符) }
  L-->>M: tool 结果回灌

  M->>L: tool_calls: search_text { query:"createServer", glob:"*.ts" }
  L->>T: execute(...)
  T->>F: 逐文件读取 + 字面量匹配 + 限流
  F-->>T: 命中行
  T-->>L: { ok:true, text: "path:line: 内容"(≤50 行 / ≤8000 字符) }
  L-->>M: tool 结果回灌

  M->>L: tool_calls: read_text_file { path:"src/server.ts" }（现在知道路径了）
  L-->>M: 文件内容（既有工具，≤20000 字符）
  M->>M: 基于真实内容作答
```

---

## 7. 任务列表（有序，按实现顺序）

> 每个任务都是**纯实现**任务（设计已完成）。依赖关系标注在括号内。

| ID | 任务 | 涉及文件 | 依赖 | 优先级 | 验收（静态） |
|---|---|---|---|---|---|
| **T-S01** | 新建 `tools-search.ts` 共享基础层：限流常量（§6.1 全部常量）、`IGNORED_DIRS`、`BINARY_EXTENSIONS`、`globToRegExp`/`matchGlob`、`isProbablyBinary`、`formatBytes`、剪枝递归 `walkPruned`、`PathGuardResult`/`WorkspacePathGuards` 类型、`createSearchTools` 工厂骨架（先返回空数组占位） | `src/main/harness/tools-search.ts`（新） | — | P0 | 文件存在；无 `recursive: true`；无新依赖 import；只用 ES2022 内 API；无未使用变量 |
| **T-S02** | 在 `createSearchTools` 内实现 **`list_dir`**：`define`（description 拼 `context.workspaceRoot` + 上面 JSON schema 原文）、`execute`（双门校验 → 剪枝遍历 → 三重限流 → `renderList`）、异常自吞、`signal.aborted` 检查 | `src/main/harness/tools-search.ts` | T-S01 | P0 | `define` 的 description 含真实 root；`execute` 无 `throw` 逃逸；命中 200/300/8000 三处判断齐全；截断文案含「缩小 path / 降低 depth」 |
| **T-S03** | 在 `createSearchTools` 内实现 **`search_text`**：`define`（含 `case_sensitive`）、`execute`（双门校验 → 遍历 + glob 过滤 + 扩展名快筛 + 256KB 门槛 + `\0` 探测 + 字面量匹配 + 三重限流 → `renderSearch`）、异常自吞 | `src/main/harness/tools-search.ts` | T-S01 | P0 | `query` 用 `includes`（**无 `RegExp` 用于用户输入**）；行号 1-based；零命中给引导文案；截断文案含「加 glob / 缩小 path」 |
| **T-S04** | 改造 `tools.ts` 完成注册与描述约束：① import 工厂；② `const searchTools = createSearchTools({...})`；③ `HARNESS_TOOLS` 展开 `...searchTools`；④ `read_text_file` description 末尾补「不知道路径先用 list_dir/search_text」 | `src/main/harness/tools.ts` | T-S02、T-S03 | P0 | **仅 4 处 Edit**；`HARNESS_TOOLS` 长度变 8；`harness/index.ts` 无需改（barrel 自动带出） |
| **T-S05** | 静态自查与交付说明：核对本文件 §9 自查清单逐条；确认渲染层/IPC 零改动；产出「手动验收脚本」（主理人照做即可） | 无代码改动（自检报告） | T-S04 | P0 | 自查清单每条给出「文件+行」证据；手动验收步骤可被非开发者照做 |

**关键路径**：T-S01 →（T-S02 ∥ T-S03）→ T-S04 → T-S05。
**可并行**：T-S02 与 T-S03 在同一文件的不同函数，建议**串行**（同文件避免冲突），或一人写完另一人 review。

---

## 8. 实施纪律（🔴 强制，写入交付要求）

1. **只用 `Edit` 定点改，禁止用 `Write` 整文件重写 `tools.ts`。**
   本仓**发生过多次「整文件重写静默丢代码」事故**；`tools.ts` 已 573 行、含安全关键的双门校验与备份逻辑，整文件重写风险极高。改动**只允许**发生在 §3.1 列出的 4 个位置。
2. `tools-search.ts` 是**新文件**，可正常 `Write` 创建；但**创建后**的修改同样**优先 Edit**。
3. **不新增任何依赖**（含 devDependencies）；不得引入 `safe-regex` / `minimatch` / `fast-glob` 等。
4. **ES2022 合规**：禁用 `findLast` / `toSorted` / `toReversed` / `Array.prototype.at` 之外的 ES2023+；不得留未使用变量/参数（`noUnusedLocals`/`noUnusedParameters` 会编译失败）。
5. **`execute` 自吞异常**：任何错误转成 `{ ok:false, text }`，**绝不向上抛**（契约见 `harness/types.ts:52`）。
6. **不使用模块级可变全局**：工作区等环境事实一律来自 `context` 逐层传参。
7. **中文注释、文案单一来源**：所有截断/错误文案集中在 `tools-search.ts` 顶部常量或渲染函数内，不散落。
8. **不碰**：`loop.ts`、`types.ts`、`ipc.ts`、`shared/*`、`renderer/*`、`preload/*`。

---

## 9. 依赖包列表

```
（无）
```

**无新增依赖。** 全部基于 Node 内置 `node:fs` / `node:path`。搜索结果 `HARNESS_TOOLS` 从 6 → 8，工具 schema 总量仍远低于「需要延迟加载」的经验阈值（约 10+）。

---

## 10. 共享知识（跨文件约定）

1. **工具声明是模型唯一的环境事实**：`define(context)` 的 description **必须**拼入 `context.workspaceRoot` 真实绝对路径（照抄 `readTextFile.define`）。不写，模型就会用先验补全、编出「虚拟工作区」。
2. **`define` 是方法不是静态字段**：路径只有运行时才有，静态字面量写不进去。
3. **契约**：`ToolResult = { ok, text }`；`ok:false` 表示「业务失败/被拒绝」，`text` 无论 ok 与否都要回灌给模型（由其自行解释）。
4. **异常自吞**：`execute` 负责把一切异常转为可读 `text`；loop 有兜底（`loop.ts:85`）但**契约要求工具自己负责**。
5. **回灌体量**：`loop.ts:96` 把 `result.text` **全文**回灌；`TOOL_RESULT_PREVIEW_LIMIT = 200`（`loop.ts:29`）**只影响 UI 预览，不影响模型上下文**。故**限流必须在工具内部完成**，不能指望 loop 截断。
6. **轮数预算**：`MAX_TURNS = 8`（`loop.ts:26`）。一次返回过大会挤占后续轮次并推高成本 → 这是「宁可少给」的根本原因。
7. **渲染层复用现成通道**：工具调用通过 `chat:step`（`ToolStep` 全量快照）展示，**新增工具无需任何 IPC/UI 改动**。
8. **路径安全单一来源**：所有文件类工具的路径校验**只用**注入的双门守卫（`resolveInsideWorkspace` + `verifyRealPath`）；**禁止**另写一套越界判断。
9. **记忆开关**：`harnessToolsFor` 只在记忆关闭时摘掉 `append_daily_note`；两个新工具**始终暴露**，无需改 `harnessToolsFor`。

---

## 11. 本期不做（明确排除，勿设计）

| 排除项 | 说明 |
|---|---|
| `update_plan` / 任务清单 / Plan 模式 | 第二批（「规划」能力），本轮不碰 |
| 子智能体 / 上下文压缩 / 上下文落盘 | 不在本批 |
| `read_text_file` 加 `offset` / `limit` 做分段读 | 见 §12「待明确事项」，**本批不放进任务列表** |
| 新 IPC 通道 / 新 UI | 复用 `chat:step` 即可 |
| `glob_files`（按文件名模式列举） | 本批用 `list_dir` + `search_text(glob)` 覆盖；单列一个工具留待后续按需 |
| 正则搜索 / 模糊匹配 / 大小写之外的匹配选项 | 见 §5 决策 |
| 写类能力扩展（搜索替换等） | 不在本批 |

---

## 12. 待明确事项（提请主理人决策，**不阻塞本批**）

| # | 事项 | 我的倾向 | 影响 |
|---|---|---|---|
| Q1 | 是否给 `read_text_file` 增加 `offset` / `limit` 做**分段读**？ | **倾向第二批做**。现状 20000 字符一刀切；大文件「读到但看不全」时，模型只能靠 `search_text` 定位后再读，仍可能定位在 20000 字符之外。分段读能补这个洞，但要改既有工具行为，**不宜与本批同批** | 影响「读懂大文件」的体验；本批用 `search_text` 已能覆盖多数定位需求 |
| Q2 | `list_dir` 是否需要**过滤扩展名**的 `glob` 参数？ | **暂不加**。`list_dir` 职责是「看清结构」，加过滤会与 `search_text(glob)` 重叠 | 无 |
| Q3 | 忽略名单是否要**可配置**（如读 `.gitignore`）？ | **暂不做**。读 `.gitignore` 需实现 ignore 语法，成本与风险都超出本批；固定 5 项已覆盖主噪声 | 若工作区有自定义构建目录（如 `build/`）未在名单内，可能仍被遍历 |
| Q4 | 是否把 `IGNORED_DIRS` 与 `BINARY_EXTENSIONS` 提取到 `shared/`？ | **不**。它们只被主进程搜索工具使用，放 `tools-search.ts` 更内聚；且 `shared/` 要求零依赖 | 无 |
| Q5 | `case_sensitive` 是否保留？ | **保留**（默认 false） | 见 §5 说明 |

---

## 13. 风险与规避

| 风险 | 规避 |
|---|---|
| 整文件重写 `tools.ts` 丢代码 | §8 纪律：**只用 Edit，4 个定点** |
| 剪枝遗漏 → 走进 `node_modules` | `IGNORED_DIRS.has(e.name)` 判断在 `path.join` **之前**；禁用 `recursive:true`；自查清单专项核对 |
| 符号链接逃逸 / 无限环 | 遍历中 `isSymbolicLink()` → **跳过**；根路径仍走双门 realpath 校验 |
| ReDoS | `query` 一律字面量，**不把用户输入编译成正则**；自造 glob 编译产物的模式长度 ≤100 |
| 上下文被打爆 | 三重输出上限 + 内部扫描预算（§6.1） |
| 长行独占预算 | 单命中行 `SEARCH_MAX_LINE_CHARS` 截断（§6.1 ⑧） |
| 大文件读取卡顿 | 单文件 256 KB 门槛 + 扫描字节预算 32 MB（§6.1 ⑦⑨） |
| 中文文件名排序不一致 | 用**码元序**而非 `localeCompare`（§6.5） |
| 编译失败（ES2022 / 未用变量） | §8.4；自查清单专项核对 |
| 异常逃逸到 `chat:error` | `execute` 全程 `try/catch` 自吞（§8.5） |

---

## 附：静态自查清单（T-S05 逐条核对）

- [ ] `tools-search.ts` 中**不存在** `recursive: true`。
- [ ] `IGNORED_DIRS.has(...)` 出现在 `path.join`/入栈**之前**（剪枝正确）。
- [ ] `isSymbolicLink()` 有跳过分支。
- [ ] `list_dir`：三处上限判断（`LIST_MAX_ENTRIES`、`LIST_MAX_OUTPUT_CHARS`、行截断 `LIST_MAX_LINE_CHARS`）均存在。
- [ ] `search_text`：`SEARCH_MAX_FILE_BYTES`、`SEARCH_MAX_SCAN_FILES`、`SEARCH_MAX_SCAN_BYTES`、`isProbablyBinary`、命中数上限、`SEARCH_MAX_OUTPUT_CHARS` 均存在。
- [ ] 两个工具的用户输入均**未**参与 `new RegExp(...)`（`query` 为字面量）。
- [ ] 两个工具 `define(context).description` 均含 `${context.workspaceRoot}`。
- [ ] `execute` 无未捕获 `throw`（全部路径返回 `ToolResult`）。
- [ ] `tools.ts` 改动**仅 4 处**（import / 工厂调用 / 数组展开 / read_text_file description）。
- [ ] `HARNESS_TOOLS` 现为 8 个元素。
- [ ] 全仓**无新增依赖**（`package.json` 未变）。
- [ ] `harness/index.ts` 未改动且仍正常 re-export。
- [ ] `renderer/**` 与 `shared/**` 未改动。
- [ ] 无 ES2023+ 方法、无未使用变量/参数。
