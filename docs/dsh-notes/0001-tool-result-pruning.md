# 0001 · 工具结果过长怎么办

- **日期**：2026-10-20
- **对照对象**：`packages/compaction/compaction-tool-result-pruner/src/index.ts`（185 行，全文读完）
- **我的文件**：`src/main/harness/loop.ts` L132 / L136

## 我的做法

```ts
const resultPreview = result.text.slice(0, TOOL_RESULT_PREVIEW_LIMIT); // 200
convo.push({ role: 'tool', content: result.text, ... });               // 全文
steps.push({ ..., result: resultPreview });                            // 预览
```

两个事实（写这条笔记时才发现的）：

1. **上下文里是全文，零截断。** `TOOL_RESULT_PREVIEW_LIMIT` 只作用于 `step.result`，也就是**只给 UI 看的**，`convo.push` 用的是 `result.text` 原样。一次 `skill-run` 跑出 300KB 的 CSV 摘要，就整块进上下文。
2. **UI 反而被截断。** 用户看不到完整输出，也就无法判断 agent 到底拿到了什么。

**方向是反的**：该省的地方（上下文）没省，不该省的地方（给人看的）省了。

## 它的做法

`ToolResultPruner.pruneContent()`：

- **阈值触发**：`thresholdChars` 以内原样返回 `null`，不做无谓改写。
- **头 / 中 / 尾三段保留**：删掉中间 `headChars ~ (total - tailChars)` 这一段，头和尾都留。
- **按 Unicode code point 切**：`Array.from(block.text)` 后 `slice`，而不是直接 `text.slice()`。注释明写「retained boundary cannot split a surrogate pair」——按 UTF-16 code unit 切会把 emoji / 生僻字切成半个字符。
- **插显式 marker**（`PRUNE_MARKER`），不是省略号：让模型明确知道「中间被删了」，而不是以为输出就这么短。
- **非文本块（图片等）原样保留**，且不参与字符预算。
- **不变式自检**：裁剪后必须「更小且在阈值内」，否则直接 throw。
- **重放安全**：裁剪不是改历史，而是 append 一个 `compaction/prune` 事件（记录被遮蔽节点与 token 数）+ 一个 replacement `tool/result` 事件 + `surfaceOp: replace`。这样 token 计量可以纯函数地减掉，不需要每个节点保存状态。

## 差异本质

| 维度 | 我 | 它 |
|---|---|---|
| 解决什么 | UI 别撑爆 | 上下文别撑爆，且不丢关键信息 |
| 丢哪一段 | 尾部（保留头） | 中间（头尾都留） |
| 粒度 | UTF-16 code unit | Unicode code point |
| 告知模型 | 无（模型不知道被截了） | 显式 marker |
| 可回溯 | 不能 | 能（事件日志 + 影子定价） |

**为什么它保留尾部**：工具输出（尤其是报错、日志、命令回显）的信息密度是 U 形分布的——开头是"我执行了什么"，结尾是"结果/错误是什么"，中间是大段重复噪音。只保留头部，恰好把最重要的结论扔了。

## 我改不改：改。分三步

1. **UI 侧先改成折叠**：`step.result` 存全文，渲染层默认折叠到 3 行、可展开。这一步只改渲染，不碰协议。
2. **上下文侧加裁剪函数**：新文件 `src/main/harness/prune-tool-result.ts`，
   `pruneToolResult(text, { thresholdChars, headChars, tailChars }): { text, pruned }`，
   按 code point 切，中间插 `\n…（已省略 N 字符，原长 M）…\n`，并在 `pruned=true` 时于工具消息尾部追加一句提示让模型知道可以重新取。
3. **不变式**：裁剪后长度必须 `< 原长` 且 `<= threshold`，否则抛错（对应它的两处 `v8 ignore` 断言）。

阈值先取：`thresholdChars = 8000`、`headChars = 2000`、`tailChars = 4000`。后续用真实技能输出调。

**不做**：暂不引入事件日志 + 影子定价那套（那是为 replay / 计费一致性服务的，我没有这两个需求）。**但要能讲出它为什么需要**——这是面试里"你有没有想过更大规模"的答案。

## 面试可讲的三点

1. 工具结果的信息密度是 U 形分布的，所以裁中间不裁尾。
2. `slice()` 按 UTF-16 切会切坏代理对，中文/emoji 场景下是真实 bug。
3. 我把"给模型看的"和"给人看的"截断搞反了——这是读完对照才发现的设计错误。

## 后续可对照

- `packages/spill/`（1209 行）：阈值更大时，不裁而是落盘 + 回填路径，模型可再读。裁 vs 落盘的取舍在哪。
- `packages/compaction/compaction-basic`：多轮累积后如何整体压缩，而不只是压单条结果。
