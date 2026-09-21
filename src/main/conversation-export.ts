/**
 * 会话记录的外部 Markdown 镜像。
 *
 * 位置：`<工作区根目录>/.agent/conversations/<净化标题>-<会话id前8位>.md`，
 * 每轮对话结束后整体覆盖重写（幂等：同一会话始终只保留一个当前文件）。
 *
 * 关键区分：**本文件产出的 md 不参与模型上下文**。写它消耗零 token；
 * 模型只有在主动调用 `read_text_file` 时才会读到它。这与「把对话历史塞进上下文」
 * 是完全不同的两件事，不要混为一谈。
 *
 * 绝不抛异常：镜像属附加能力，磁盘 / 权限等问题不得影响对话主流程。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Conversation, Message, ToolStep } from '../shared/types';
import { resolveWorkspaceRoot } from './workspace';

/** 文件名里标题的最大长度（超过则截断） */
const MAX_TITLE_LENGTH = 60;

/** 角色 → 展示名；system 及其它一律按「系统」 */
function roleLabel(role: Message['role']): string {
  if (role === 'user') {
    return '用户';
  }
  if (role === 'assistant') {
    return '助手';
  }
  return '系统';
}

/**
 * 把会话标题净化为可用于文件名的字符串。
 * 纯字符替换，不用 path.basename 之类：
 * - Windows 非法字符 `<>:"/\|?*` 与控制字符统一替换为 `-`；
 * - 连续 `-` 合并为一个；
 * - 去掉首尾的 `-` 与 `.`；
 * - 超过 60 字符截断；为空则回退 `会话`。
 */
function sanitizeTitle(title: string): string {
  const replaced = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const truncated = replaced.slice(0, MAX_TITLE_LENGTH);
  return truncated.length > 0 ? truncated : '会话';
}

/** 两位补零 */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地时间 `yyyy-MM-dd HH:mm:ss`（刻意不用 toISOString —— 那是 UTC） */
function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** 本地时间 `HH:mm:ss` */
function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 把文本包成 CommonMark 行内代码：
 * 1. 先把换行及其两侧空白压成单个空格，保证内容单行；
 * 2. 取内容中最长的连续反引号串长度 n，用 n+1 个反引号作界定符
 *    （界定符严格长于内容里的最长反引号串即安全）；
 * 3. 两端各留一个空格，以兼容内容首尾本身就是反引号的情况。
 */
function inlineCode(text: string): string {
  const single = text.replace(/\s*\n\s*/g, ' ');
  let longest = 0;
  const runs = single.match(/`+/g);
  if (runs) {
    for (const run of runs) {
      if (run.length > longest) {
        longest = run.length;
      }
    }
  }
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${single} ${fence}`;
}

/**
 * 解析用于头部展示的模型信息：优先取最后一条带 `meta.model` 的 assistant 消息，
 * 取不到再回退会话自身；字段为空一律写 `未知`。
 */
function resolveModelInfo(conversation: Conversation): { providerId: string; model: string } {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    const model = message.meta?.model;
    if (message.role === 'assistant' && model) {
      return {
        providerId: message.meta?.providerId ?? conversation.providerId,
        model,
      };
    }
  }
  return { providerId: conversation.providerId, model: conversation.model };
}

/** 结束状态行：仅 aborted / error / length 输出，stop 与缺省不写 */
function finishReasonLine(message: Message): string | null {
  const reason = message.meta?.finishReason;
  if (reason === 'aborted') {
    return '（已停止生成）';
  }
  if (reason === 'error') {
    const detail = message.meta?.errorText ?? message.meta?.errorCode ?? '未知错误';
    return `（生成失败：${detail}）`;
  }
  if (reason === 'length') {
    return '（达到长度上限）';
  }
  return null;
}

/** 工具调用块：仅在有步骤时调用 */
function renderSteps(steps: ToolStep[]): string {
  const lines: string[] = ['**工具调用**', ''];
  for (const step of steps) {
    // running 收尾时理论上不会残留；万一出现按 ✗ 处理
    const symbol = step.status === 'done' ? '✓' : '✗';
    const elapsed = step.elapsedMs != null ? ` — ${step.elapsedMs}ms` : '';
    lines.push(`- ${symbol} \`${step.name}\`${elapsed}`);
    if (step.args) {
      lines.push(`  - 参数：${inlineCode(step.args)}`);
    }
    if (step.result) {
      lines.push(`  - 结果：${inlineCode(step.result)}`);
    }
  }
  return lines.join('\n');
}

/** 渲染整份 Markdown 文本 */
function renderMarkdown(conversation: Conversation, root: string): string {
  const info = resolveModelInfo(conversation);
  const providerLabel = info.providerId && info.providerId.length > 0 ? info.providerId : '未知';
  const modelLabel = info.model && info.model.length > 0 ? info.model : '未知';

  const parts: string[] = [
    `# ${conversation.title}`,
    '',
    `> 会话 ID：\`${conversation.id}\``,
    `> 创建：${formatDateTime(conversation.createdAt)}`,
    `> 更新：${formatDateTime(conversation.updatedAt)}`,
    `> 模型：\`${providerLabel}\` / \`${modelLabel}\``,
    `> 工作区：\`${root}\``,
    `> 消息数：${conversation.messages.length}`,
    '',
  ];

  if (conversation.messages.length === 0) {
    parts.push('---', '', '（暂无消息）');
    return `${parts.join('\n')}\n`;
  }

  conversation.messages.forEach((message, index) => {
    parts.push('---', '');
    parts.push(`## ${index + 1}. ${roleLabel(message.role)} · ${formatTime(message.createdAt)}`);
    parts.push('');
    // content 原样输出，绝不包代码块（assistant 正文本身就是 Markdown）
    parts.push(message.content);

    const reasonLine = finishReasonLine(message);
    if (reasonLine) {
      // 前面必须空一行：Markdown 里单个换行属于软换行（多数渲染器会并成一行），
      // 否则「（已停止生成）」会直接黏在正文末尾。
      parts.push('', reasonLine);
    }

    const steps = message.meta?.steps;
    if (steps && steps.length > 0) {
      parts.push('', renderSteps(steps));
    }
    parts.push('');
  });

  return `${parts.join('\n')}\n`;
}

/**
 * 原子写文本：先写临时文件再 rename 覆盖，任何一步失败都不会留下半截目标文件。
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
 * 把一份会话导出为外部 Markdown 镜像（每轮结束调用一次，整体覆盖重写）。
 *
 * 绝不抛异常：磁盘不可写、权限不足等都静默跳过，下一轮会自动重写。
 * @param conversation 当前完整会话（含全部消息）
 */
export async function exportConversationMarkdown(conversation: Conversation): Promise<void> {
  try {
    const root = resolveWorkspaceRoot(conversation);
    const dir = path.join(root, '.agent', 'conversations');
    await fs.promises.mkdir(dir, { recursive: true });

    const shortId = conversation.id.slice(0, 8);
    const fileName = `${sanitizeTitle(conversation.title)}-${shortId}.md`;

    // 清理同一会话的旧文件：标题会随首条用户消息变化（编辑第一条消息时会被重置重算），
    // 不清理就会残留一堆旧名字的文件。用 `-<shortId>.md` 后缀锁定范围，不会误删别的会话。
    try {
      const entries = await fs.promises.readdir(dir);
      await Promise.all(
        entries
          .filter((entry) => entry !== fileName && entry.endsWith(`-${shortId}.md`))
          .map((entry) => fs.promises.unlink(path.join(dir, entry)).catch(() => undefined)),
      );
    } catch {
      // 目录读取失败不阻断主流程
    }

    const markdown = renderMarkdown(conversation, root);
    await atomicWriteText(path.join(dir, fileName), markdown);
  } catch {
    // 静默：镜像属附加能力，失败不得影响对话主流程；下一轮会自动重写
    return;
  }
}
