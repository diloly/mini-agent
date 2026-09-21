/**
 * 工作区记忆：把跨对话仍然成立的信息，自动提炼进 `<工作区>/.agent/memory/MEMORY.md`。
 *
 * 语义：**每个工作区一份记忆**，同一工作区下的多个会话共享
 * （与参考产品的「工作区级记忆」一致）。
 *
 * 目录分层：记忆类文件统一收进 `.agent/memory/`（长期记忆 MEMORY.md + 每日笔记 `<日期>.md`），
 * 与 `.agent/conversations/` 下按会话生成的镜像分开存放。
 *
 * 两道防线：
 * - 提炼门槛：一轮对话太短（user + assistant 正文字符数不足 EXTRACT_MIN_CHARS）就跳过，
 *   省一次模型调用；
 * - 收缩保护：模型明显把已有内容丢掉（新内容远短于旧内容）时放弃本次写入。
 *
 * 绝不抛异常：记忆属附加能力，磁盘 / 权限 / 模型失败都不得影响对话主流程。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Conversation, Message } from '../shared/types';
import type { LlmMessage, LLMProvider, ProviderConfig } from './providers/types';
import { resolveWorkspaceRoot } from './workspace';

/** 长期记忆文件名（位于 .agent/memory/ 下） */
const MEMORY_FILE = 'MEMORY.md';
/** 记忆正文长度上限（字符）。与参考产品同配额。 */
export const MEMORY_CHAR_LIMIT = 4000;
/** 触发提炼的最小对话量（user + assistant 正文字符数之和） */
export const EXTRACT_MIN_CHARS = 200;
/** 防「越提炼越少」的收缩保护阈值：已有内容大于此长度时启用保护 */
const SHRINK_GUARD_MIN_EXISTING = 200;
/** 收缩保护比例：新内容短于已有内容 × 该比例则放弃本次写入 */
const SHRINK_GUARD_RATIO = 0.3;

/** 提炼用的 system 指令（逐字照用，勿改） */
const EXTRACT_SYSTEM_PROMPT = `你是一个记忆整理器。你的任务是把一段对话中有长期价值的信息，合并进一份「工作区记忆」文档。

规则：
- 只保留跨对话仍然成立的信息：用户的偏好与要求、项目的事实与约定、未决事项与待办。
- 丢弃一次性的内容：寒暄、只针对当前这一轮才成立的临时指令、已经完成且无关后续的琐碎操作。
- 已有的记忆条目没有新信息时原样保留；有新信息时合并更新；被后面的对话推翻时修正或删除。
- 输出**完整的、合并后的文档全文**。不要输出任何解释、前言、结语，不要用代码块包裹。
- 篇幅上限 4000 字符，超限时优先保留最重要的条目。
- 若这批对话没有任何值得长期记住的信息，就原样输出已有的记忆文档；若已有记忆为空，则只输出下面这个标题行。
- 用简体中文。

文档结构（固定的三个二级标题，没有内容的章节标题也保留）：
# 工作区记忆

## 用户偏好与要求

## 项目事实与约定

## 待办与未决`;

/** 两位补零 */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地日期 `YYYY-MM-DD`（刻意不用 toISOString —— 那是 UTC） */
function formatLocalDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时间 `HH:mm:ss`（刻意不用 toISOString —— 那是 UTC） */
export function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 记忆目录：把记忆类文件收进 .agent/memory/，不再与 .agent/conversations/ 平铺 */
function memoryDirPath(root: string): string {
  return path.join(root, '.agent', 'memory');
}

/** 长期记忆文件绝对路径 */
export function memoryFilePath(root: string): string {
  return path.join(memoryDirPath(root), MEMORY_FILE);
}

/** 当日笔记文件绝对路径（文件名是本地日期 YYYY-MM-DD.md） */
export function dailyNoteFilePath(root: string): string {
  return path.join(memoryDirPath(root), `${formatLocalDate(Date.now())}.md`);
}

/**
 * 模块级串行写队列：同一工作区可能被多个会话并发提炼。
 * 若只锁写、不锁读，第二个提炼会**读到旧记忆**再覆盖掉第一个的成果 ——
 * 所以必须把「读现有 → 调模型 → 写回」整段串起来（写法同 storage.ts 的 enqueue）。
 */
let memoryChain: Promise<unknown> = Promise.resolve();

function enqueueMemory<T>(task: () => Promise<T>): Promise<T> {
  const run = memoryChain.then(task, task);
  memoryChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 读取工作区记忆；文件不存在 / 读失败一律返回空串。不抛 */
export async function readWorkspaceMemory(root: string): Promise<string> {
  const current = memoryFilePath(root);
  try {
    return (await fs.promises.readFile(current, 'utf8')).trim();
  } catch {
    // 新位置读不到：尝试从旧位置搬迁一次（早期版本把 MEMORY.md 直接放在 .agent/ 下）。
    // 放在这里是为了让正常路径不承担额外的 stat 开销。
    await migrateLegacyMemoryFile(root);
    try {
      return (await fs.promises.readFile(current, 'utf8')).trim();
    } catch {
      return '';
    }
  }
}

/**
 * 早期版本把 MEMORY.md 直接放在 .agent/ 下；这里做一次性搬迁，避免已有记忆静默失效。
 * 新位置已存在 / 旧文件不存在 / 任何 IO 失败都静默返回（记忆会由下一轮提炼重新生成）。
 */
async function migrateLegacyMemoryFile(root: string): Promise<void> {
  try {
    const current = memoryFilePath(root);
    const exists = await fs.promises
      .access(current)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      return;
    }
    const legacy = path.join(root, '.agent', MEMORY_FILE);
    await fs.promises.mkdir(memoryDirPath(root), { recursive: true });
    await fs.promises.rename(legacy, current);
  } catch {
    // 旧文件不存在是常态；记忆会由下一轮提炼重新生成
  }
}

/**
 * 原子写文本：先写临时文件再 rename 覆盖，任一步失败都不会留下半截目标文件。
 * 思路同 storage.ts 的 atomicWrite，但那是内部函数、未导出，故此处自备一份。
 */
async function atomicWriteText(filePath: string, text: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, text, 'utf8');
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * 把一条笔记追加到当日笔记文件。
 *
 * 文件名与路径**完全由工作区根目录推导，不接受任何外部输入**，因此不存在路径穿越。
 * 刻意用 `appendFile` 而非「先读整份再写回」：read_text_file 有 20000 字符截断，
 * 日文件一旦超长，读回再整份覆盖就会**静默删掉后面的记录**；追加则零截断风险。
 * 本函数可抛异常，由工具层捕获后转成可读文案。
 */
export async function appendDailyNoteToFile(root: string, note: string): Promise<void> {
  await fs.promises.mkdir(memoryDirPath(root), { recursive: true });
  const filePath = dailyNoteFilePath(root);
  const exists = await fs.promises
    .access(filePath)
    .then(() => true)
    .catch(() => false);
  // 首次创建时给一个日期标题；已存在则用空行与前一条笔记分隔
  const prefix = exists ? '\n' : `# ${formatLocalDate(Date.now())}\n\n`;
  const block = `${prefix}## ${formatLocalTime(Date.now())}\n\n${note}\n`;
  await fs.promises.appendFile(filePath, block, 'utf8');
}

/**
 * 清洗模型输出：去首尾空白；若整段被一个围栏包裹（``` 或 ```markdown）则剥掉这层围栏。
 * 只处理「整段被包裹」这一种情况，不做通用 markdown 解析；正文其余字符一律不动。
 */
function cleanExtraction(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced) {
    text = fenced[1];
  }
  return text.trim();
}

/**
 * 找出「本轮」这一段对话：从末尾往前找最后一条 assistant，再在它之前找最近一条 user。
 * 任一找不到返回 null（用倒序 for 循环，避免 ES2023 的 findLast）。
 */
function findLatestExchange(messages: Message[]): { user: Message; assistant: Message } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'assistant') {
      continue;
    }
    for (let sub = index - 1; sub >= 0; sub -= 1) {
      if (messages[sub].role === 'user') {
        return { user: messages[sub], assistant: messages[index] };
      }
    }
    return null;
  }
  return null;
}

/** 拼装提炼的 user message 正文 */
function buildExtractInput(existing: string, user: Message, assistant: Message): string {
  const memoryBlock = existing.length > 0 ? existing : '（暂无）';
  const parts: string[] = [
    '【已有的工作区记忆】',
    memoryBlock,
    '',
    '---',
    '',
    '【本轮对话】',
    '',
    '用户：',
    user.content,
    '',
    '助手：',
    assistant.content,
  ];

  // 工具调用摘要：给模型判断「它到底做了什么」用，别省
  const steps = assistant.meta?.steps;
  if (steps && steps.length > 0) {
    parts.push('', '本轮工具调用：');
    for (const step of steps) {
      const outcome = step.status === 'done' ? '成功' : '失败';
      const result = step.result && step.result.length > 0 ? step.result : '无输出';
      parts.push(`- ${step.name}（${outcome}）：${result}`);
    }
  }

  return parts.join('\n');
}

/**
 * 把工作区记忆包装成一条注入用的 system 消息。
 * 第二句必须保留：前者防止陈旧记忆压过当前指令，后者防止模型每轮复述记忆。
 */
export function buildMemorySystemMessage(memory: string): LlmMessage {
  return {
    role: 'system',
    content:
      '以下是本工作区的长期记忆，由往次对话自动整理，可能不完整或已过时。\n' +
      '它与用户当前的要求冲突时，一律以用户当前的要求为准；不要向用户复述本段内容。\n\n' +
      memory,
  };
}

/**
 * 常驻的工作区约定：每轮都注入（与记忆是否为空无关），让模型知道工作区边界；
 * 记忆功能开启时再加上「做完实质工作要记一条每日笔记」等要求。
 * @param memoryEnabled 记忆功能总开关，关闭时不注入任何记忆相关条款
 */
export function buildWorkspaceRulesMessage(root: string, memoryEnabled: boolean): LlmMessage {
  const rules = [
    `你的工作区根目录是 ${root}。所有文件类工具的相对路径都以此为基准，工作区之外一律不可访问。`,
  ];
  if (memoryEnabled) {
    rules.push(
      '完成实质工作后，必须调用 append_daily_note 记录一条简短笔记（做了什么、根因是什么、得出什么结论、选定了哪个方案）。实质工作包括：创建或修改文件、修复问题、产出文档或报告、重构代码、做技术选型。寒暄、普通问答、一次性查询不要记录。',
      '笔记只写有长期价值的事实，不要复述整段对话，不要写临时路径或普通报错。一次调用只记一条，篇幅控制在几行以内。',
      '`.agent/memory/` 下还有由系统维护的长期记忆 MEMORY.md，你不需要读它或改它。',
    );
  }
  return {
    role: 'system',
    content: `【工作区约定】\n${rules.map((text, index) => `${index + 1}. ${text}`).join('\n')}`,
  };
}

/**
 * 提炼本轮对话并合并写入工作区记忆。
 *
 * 绝不抛异常：任何失败都静默跳过，下一轮会重新尝试。
 * @param conversation 当前完整会话
 * @param llm provider 与其运行期配置（含明文 Key）
 */
export async function extractWorkspaceMemory(
  conversation: Conversation,
  llm: { provider: LLMProvider; config: ProviderConfig },
): Promise<void> {
  try {
    const exchange = findLatestExchange(conversation.messages);
    if (!exchange) {
      return;
    }
    const { user, assistant } = exchange;
    // 门槛：短轮跳过，省一次模型调用（用户明确要求的省钱闸门）
    if (user.content.length + assistant.content.length < EXTRACT_MIN_CHARS) {
      return;
    }

    const root = resolveWorkspaceRoot(conversation);
    const filePath = memoryFilePath(root);

    await enqueueMemory(async () => {
      const existing = await readWorkspaceMemory(root);
      const result = await llm.provider.chatStream(
        {
          messages: [
            { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
            { role: 'user', content: buildExtractInput(existing, user, assistant) },
          ],
          // 用一个永不中止的信号：用户点「停止」时会话自己的 signal 已经 aborted，
          // 复用它会让提炼必然失败（而提炼是收尾之后独立进行的，与那次停止无关）。
          signal: new AbortController().signal,
        },
        llm.config,
        { onDelta: () => undefined },
      );

      const cleaned = cleanExtraction(result.text);
      // 空输出保护：绝不能把已有记忆清空
      if (cleaned.length === 0) {
        return;
      }
      // 收缩保护：模型明显把内容丢了（新内容远短于旧内容）时放弃写入
      if (
        existing.length > SHRINK_GUARD_MIN_EXISTING &&
        cleaned.length < existing.length * SHRINK_GUARD_RATIO
      ) {
        return;
      }
      const finalText = cleaned.slice(0, MEMORY_CHAR_LIMIT);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await atomicWriteText(filePath, finalText);
    });
  } catch {
    // 静默：记忆属附加能力，失败不得影响对话主流程；下一轮会重新尝试
    return;
  }
}
