# 拿 DSH 当镜子：对照阅读指南

> 目标不是"读懂 DeepSeek Harness"，是**把自己的 mini-agent 里每个含糊的决策，换成一个有依据的决策**。
> 每条差异必须落成一个 commit。没有 commit 的阅读等于观光。

参考仓库：`github.com/deepseek-ai/deepseek-harness`（MIT，developer preview，约 2.2 万 commit，58 个包）
本地副本：`E:/code/dsh`（已 clone，`master` @ `687f282`，2026-10-17；约 200MB）

---

## 一、入口顺序（不要从代码开始）

DSH 有**完整的中文文档**（`*.zh.md` 与英文源配对维护），这是白送的红利。先文档后代码，能把 700 行的文件读成 200 行。

| 顺序 | 读什么 | 行数 | 为什么先读它 |
|---|---|---|---|
| 1 | `docs/architecture.zh.md` | 169 | 一张全景图，先建立坐标系 |
| 2 | `docs/tool-execution-pipeline.zh.md` | 67 | **最短、最值钱**。一次工具调用要穿过哪些关卡，全在这张 mermaid 里 |
| 3 | `docs/subsystems/compaction.zh.md` | 284 | 上下文压缩的完整策略，你目前只有"显示百分比" |
| 4 | `docs/subsystems/spill.zh.md` | 124 | 工具结果太长时的正确解法 |
| 5 | `docs/capability-seams.zh.md` | 716 | 为什么这样切模块边界（架构判断力的来源） |
| 6 | `docs/postmortem/*.zh.md` | 4 篇 | 线上事故复盘。**面试故事富矿** |

`docs/module-graph.zh.md`（1778 行）是生成的索引，**当字典查，不要通读**。

---

## 二、对照表：你的文件 ↔ 它的包

左边是 `src/` 下的实际文件，右边是可读的最小集合。

### 1. 主循环

| 你 | 它 | 读什么 |
|---|---|---|
| `harness/loop.ts`（353 行，while + 串行工具） | `packages/core/agent-loop/src/agent.ts`（705）<br>`tool-calls.ts`（290）<br>`inbox.ts`（244） | 循环如何表达终止条件；工具批次如何"等齐"（batch settled）；外部消息如何插进运行中的循环（inbox） |

**要回答的问题**：你的 `MAX_TURNS = 16` 是"防跑飞"的补丁，它是怎么在结构上避免无限循环的？

### 2. 工具结果过长

| 你 | 它 | 读什么 |
|---|---|---|
| `TOOL_RESULT_PREVIEW_LIMIT = 200`（**只截 UI，上下文零截断**） | `packages/compaction/compaction-tool-result-pruner/src/index.ts`（**185 行，全文读完**）<br>`packages/spill/`（1209） | 裁剪 vs 落盘的取舍；头尾保留；按 code point 切；裁剪后如何让模型知道"被裁了、去哪拿" |

**这是最好的第一个目标**：185 行、单一职责、和你的实现正面撞车。读完当天就能改。
示范笔记见 [`dsh-notes/0001-tool-result-pruning.md`](./dsh-notes/0001-tool-result-pruning.md)——**写这条笔记时才发现，我的 200 字符截断只作用于 UI，进上下文的是全文**。这就是"镜子"的价值：不读对照，你根本不会去查自己那行代码到底喂了什么给模型。

### 3. 上下文压缩

| 你 | 它 | 读什么 |
|---|---|---|
| 无（只算用量百分比） | `packages/compaction/compaction`<br>`compaction-basic`<br>`compaction-image-offload` | 什么时候触发压缩；压缩丢什么、留什么；压缩本身失败怎么办 |

### 4. 工具分发

| 你 | 它 | 读什么 |
|---|---|---|
| `harness/tools.ts`（709，if/else + 表驱动） | `packages/core/tools`<br>`docs/subsystems/tools.zh.md`（747） | `pre-execute` / `execute` / `post-execute` 三段 waterfall；结果如何被改写而不改循环 |

### 5. 执行安全

| 你 | 它 | 读什么 |
|---|---|---|
| `skill-runtime/run-process.ts`（直接 spawn，无隔离） | `packages/sandbox/sandbox-local`<br>`sandbox-windows-acl/src/token.ts`（243）<br>`docs/subsystems/sandbox.zh.md`（221） | 进程如何被降权；Windows 上如何用 ACL 划工作区；沙箱失败时如何降级提示 |

**你这里是明显短板**：技能脚本是任意代码，直接跑在用户机器上。面试官问"你怎么防止技能脚本删库"，现在你答不上来。

### 6. 续跑与持久化

| 你 | 它 | 读什么 |
|---|---|---|
| `checkpoint.ts`（version: 1，整体覆盖写） | `packages/session/session-checkpoint-policy`<br>`session-format-v0-to-v1` … `v4`<br>`docs/subsystems/session.zh.md`（1343，**只读 checkpoint 相关章节**） | 幂等性；格式演进为什么需要 v0→v4 五次迁移；写入时机 |

### 7. 缺失的能力（你还没有的）

| 能力 | 它的包 | 价值 |
|---|---|---|
| 重复工具调用检测 | `packages/guard/repeat-tool-reminder/src/index.ts`（240） | 模型原地绕圈是最常见的失败模式，你现在没有护栏 |
| 工具超时策略 | `packages/guard/timeout-policy/src/index.ts`（81） | 你只有 skill-run 的超时，没有通用超时 |
| LLM 重试 | `packages/llm/llm-retry` | SSE 断流/限流怎么办 |
| 系统提示词组装 | `packages/core/system-prompt` | 你的系统提示词是硬编码字符串吗 |
| 上下文注入 | `packages/context/time-context`、`file-reference` | 时间、文件引用如何进上下文 |

---

## 三、五个读法

**1. 先读测试，再读实现。**
`packages/core/agent-loop/tests/loop.spec.ts`、`cancel.spec.ts`、`properties.spec.ts`。
测试是行为的规格说明书，断言写明了"必须怎样"，比实现代码好读十倍。读完测试你就有了一张"这个模块承诺了什么"的清单。

**2. 读 commit，不读文件。**
```bash
git log --oneline -- packages/compaction/compaction-tool-result-pruner
git log -p --follow -- <某个文件> | head -200
```
2.2 万 commit 里大量是 `fix(...)`。**每一个 fix 就是一个坑的坐标**。看它修了什么，比看它写了什么更接近真相。

**3. 读 postmortem。**
`docs/postmortem/0001`~`0004`：ACP 默认导出丢注入、JS 表达式禁用文件工具、Web GUI 反馈环、Landlock 部分失败被误分类。
这四篇是"工程判断力"的直接样本。你 `tools-skill-run.ts` 里那句"部分成功/超时/截断不得讲成不存在/失败"——`0004` 就是同一个坑的工业级版本。

**4. 读 seams，不读实现。**
`docs/capability-seams.zh.md` 讲的是"为什么在这里切一刀"。你现在的模块边界（harness / skills / providers / skill-runtime）是自己摸出来的，对照它能看出哪些切对了、哪些是巧合。

**5. 读完立刻 diff，一个差异一个 commit。**
顺序固定：`读 → 写四栏笔记 → 改自己的代码 → typecheck → commit`。
commit message 里带上对照来源，例如：
`refactor(harness): 工具结果改为落盘引用，对齐 dsh compaction-tool-result-pruner`

---

## 四、黑名单（不要碰）

58 个包、2.2 万 commit，通读会淹死。以下明确跳过：

- `vendor/`（内嵌的 cordis / cosmokit 等）
- `native/`、`python/`（原生层与 Python 运行时）
- `packages/ptc-runtime`、`browser-use`、`computer-use`、`ssh`、`lsp`、`acp`
- `apps/`、`website/`、`benchmarks/`、`snapshots/`
- 所有 `*.i18n.yaml`（双语配对元数据，不是内容）

**Cordis 框架本身（"一切皆插件"）也不要一上来就读。** 它是 DSH 的地基，但不是你要学的东西——你学的是 harness 的决策，不是 DI 容器的实现。等你能答上来第二节的所有问题，再回头看 `docs/cordis-primer.zh.md`。

---

## 五、笔记模板

每个对照点写一张，四栏，不超过 15 行：

```
## 工具结果过长怎么办

- 我的做法：tools-skill-run.ts 里 TOOL_RESULT_PREVIEW_LIMIT=200，直接 slice + "…(已截断)"
- 它的做法：pruner 按类型分级裁剪；超阈值落盘（spill），回填时给路径和摘要，模型可再读
- 差异本质：我解决的是"别撑爆上下文"，它解决的是"别撑爆 + 别丢信息"
- 我改不改：改。理由：技能脚本输出经常是数据分析结果，砍掉就等于任务失败
- 怎么改：<一句话方案> → commit <hash>
```

**"我改不改"这一栏必须写理由。** 不是所有差异都要跟——跟了却讲不出为什么，比不跟更糟。

### 已完成的笔记

| 编号 | 主题 | 结论 |
|---|---|---|
| [0001](./dsh-notes/0001-tool-result-pruning.md) | 工具结果过长 | 待改：UI 改折叠、上下文加头尾裁剪；发现现有截断方向搞反了 |

---

## 六、两周排期

| 时间 | 动作 | 产出 |
|---|---|---|
| D1 | `architecture.zh.md` + `tool-execution-pipeline.zh.md` | 画一张自己项目的对应流程图 |
| D2–D3 | `compaction-tool-result-pruner`（185 行）全文 + `spill.zh.md` | 改掉 200 字符硬截断，1 个 commit |
| D4 | `agent-loop/tests/loop.spec.ts` + `agent.ts` | 四栏笔记：终止条件、批次等齐、取消语义 |
| D5 | `repeat-tool-reminder`（240 行） | 加一个重复调用护栏，1 个 commit |
| D6–D7 | `postmortem/` 四篇 | 一篇 1500 字笔记《我从 DSH 的四个事故里学到什么》→ 可发博客 |
| D8–D9 | `sandbox.zh.md` + `sandbox-local` | 至少给技能脚本加"工作区外写入需确认"，1 个 commit |
| D10 | `capability-seams.zh.md` | 修订自己的架构文档，标出"巧合切对"的边界 |

两周后你应该有：**4 个带对照来源的 commit + 5 张四栏笔记 + 1 篇博客**。这比再堆 5000 行功能有用得多。

---

## 七、验收标准

能不看代码回答下面五个问题，才算真读懂了：

1. 一次工具调用在 DSH 里要穿过几道关卡？哪一道是你没有的？
2. 工具结果太长，除了截断还有什么解法？代价是什么？
3. 上下文压缩什么时候触发？压缩本身失败了怎么兜底？
4. 循环靠什么保证一定会停？你的 `MAX_TURNS` 和它的做法差在哪？
5. 技能脚本是任意代码，怎么保证它不能删库？你现在靠什么？
