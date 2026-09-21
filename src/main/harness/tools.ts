/**
 * 内置工具集合：共 6 个工具 —— 3 个只读（get_current_time / calculator / read_text_file），
 * 2 个写文件（write_text_file / edit_text_file），1 个追加当日笔记（append_daily_note）。
 * 其中 append_daily_note 受记忆功能开关控制，关闭时经 harnessToolsFor 从暴露列表中摘除。
 *
 * 安全底线：
 * - calculator：白名单正则彻底排除字母/标识符，杜绝任何属性访问（如 `process.env`）；
 * - read_text_file / write_text_file / edit_text_file：路径必须落在工作区内，
 *   且以「realpath 后的工作区根目录」为基准做越界比较，防符号链接逃逸；
 * - 写工具在覆盖已有文件前，先把原内容备份到**工作区之外**的备份目录；备份失败则中止写入；
 * - 任何工具执行异常都转成可读字符串返回，绝不向上抛。
 *
 * 工作区根目录不再用模块级全局变量，改由 ToolContext 逐层显式传入
 * （两个会话并发生成时，全局变量会互相覆盖）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '../providers/types';
import { appendDailyNoteToFile, dailyNoteFilePath, formatLocalTime } from '../workspace-memory';
import type { HarnessTool, ToolContext, ToolResult } from './types';

/** 中文星期，用于时间展示 */
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 把 JSON 字符串解析为对象；解析失败回退为 {}。
 * 工具自己负责解析入参，loop 只负责透传原始字符串。
 */
function parseArgs<T>(rawArgs: string): T {
  if (!rawArgs) {
    return {} as T;
  }
  try {
    return JSON.parse(rawArgs) as T;
  } catch {
    return {} as T;
  }
}

/** 路径解析结果：通过校验给绝对路径，否则给中文拒绝文案 */
type PathResolution = { ok: true; target: string } | { ok: false; text: string };

/**
 * 第一道门：把模型给出的路径解析为工作区内的绝对路径（纯字符串层面校验）。
 * 注意：传入绝对路径时 path.resolve 会直接采用它，随后的越界检查会拦下。
 */
function resolveInsideWorkspace(root: string, relPath: string): PathResolution {
  const trimmed = relPath.trim();
  if (trimmed.length === 0) {
    return { ok: false, text: '参数错误：缺少 path 字段' };
  }
  const target = path.resolve(root, trimmed);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, text: `拒绝访问：路径不在工作区内（当前工作区根目录：${root}）` };
  }
  return { ok: true, target };
}

/**
 * 从 dir 向上找到最近的**已存在**目录，返回它的 realpath；一路到根都不存在时返回 null。
 */
async function realpathNearestExisting(dir: string): Promise<string | null> {
  let probe = dir;
  for (;;) {
    try {
      return await fs.promises.realpath(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return null;
      }
      probe = parent;
    }
  }
}

/**
 * 工作区根目录必须是存在且是目录，返回它的 realpath 作为后续越界比较的基准。
 *
 * 为什么用 realpath 后的路径作基准：工作区自身也可能是符号链接，
 * 拿未解析的 root 去比会把它下面的合法路径误判成越界。
 */
async function resolveWorkspaceRealRoot(
  root: string,
): Promise<{ ok: true; realRoot: string } | { ok: false; text: string }> {
  try {
    const stat = await fs.promises.stat(root);
    if (!stat.isDirectory()) {
      return { ok: false, text: `工作区目录不存在：${root}，请先创建该目录并放入文件` };
    }
    return { ok: true, realRoot: await fs.promises.realpath(root) };
  } catch {
    return { ok: false, text: `工作区目录不存在：${root}，请先创建该目录并放入文件` };
  }
}

/**
 * 第二道门：对「目标（或它最近的已存在祖先）」做 realpath，确认真实路径仍在工作区内。
 *
 * 读写共用同一条逻辑：
 * - 读的目标必然存在，realpath 返回它自己的真实路径（防符号链接逃逸）；
 * - 写的目标可能尚不存在，返回的是最近祖先的真实路径 —— 不存在的部分由我们创建，
 *   而创建目录不会替换已存在的符号链接，所以祖先安全就意味着新建出来的路径也安全。
 */
async function verifyRealPath(
  realRoot: string,
  target: string,
): Promise<{ ok: true } | { ok: false; text: string }> {
  const realProbe = await realpathNearestExisting(target);
  if (!realProbe) {
    return { ok: false, text: '无法解析目标路径' };
  }
  const rel = path.relative(realRoot, realProbe);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, text: `拒绝访问：路径不在工作区内（当前工作区根目录：${realRoot}）` };
  }
  return { ok: true };
}

/**
 * 覆盖前备份：把原文件复制到「工作区之外」的备份目录，按会话分目录、文件名带时间戳。
 *
 * 备份失败则整次写入中止：用户明确选定了「覆盖前备份」这个策略，
 * 静默跳过备份会违背约定；而且备份失败通常意味着磁盘或权限出了问题，
 * 那种状态下继续写入同样不安全。
 */
async function backupBeforeOverwrite(
  context: ToolContext,
  target: string,
): Promise<{ ok: true; backupPath: string } | { ok: false; text: string }> {
  try {
    const dir = path.join(context.backupRoot, context.conversationId);
    await fs.promises.mkdir(dir, { recursive: true });
    // 时间戳里的冒号与点在 Windows 上是非法文件名字符，统一换成短横线
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dir, `${path.basename(target)}.${stamp}.bak`);
    await fs.promises.copyFile(target, backupPath);
    return { ok: true, backupPath };
  } catch (error) {
    return {
      ok: false,
      text: `备份原文件失败，已中止写入：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 单次写入的内容长度上限（字符） */
const WRITE_CONTENT_LIMIT = 200_000;

/** 单条每日笔记的长度上限（字符） */
const DAILY_NOTE_LIMIT = 2000;

/** 当前本地时间，形如 `2026-09-18 17:53:21 (周五)` */
const getCurrentTime: HarnessTool = {
  define(): ToolDefinition {
    return {
      name: 'get_current_time',
      description: '获取当前本地时间（含星期）',
      parameters: { type: 'object', properties: {}, required: [] },
    };
  },
  async execute(_rawArgs: string, signal: AbortSignal, _context: ToolContext): Promise<ToolResult> {
    if (signal.aborted) {
      return { ok: false, text: '已停止：获取时间被用户中止' };
    }
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return { ok: true, text: `${date} ${time} (${WEEKDAY_CN[now.getDay()]})` };
  },
};

/**
 * 算术求值：仅允许数字与 + - * / ( ) 与空白。
 * 白名单正则已排除一切字母，故 Function 求值无法访问任何属性，可安全执行。
 */
const calculator: HarnessTool = {
  define(): ToolDefinition {
    return {
      name: 'calculator',
      description: '对算术表达式求值（仅含数字与 + - * / ( )）',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '仅含数字与 + - * / ( ) 的算术表达式',
          },
        },
        required: ['expression'],
      },
    };
  },
  async execute(rawArgs: string, signal: AbortSignal, _context: ToolContext): Promise<ToolResult> {
    if (signal.aborted) {
      return { ok: false, text: '已停止：计算被用户中止' };
    }
    const { expression } = parseArgs<{ expression?: string }>(rawArgs);
    const expr = typeof expression === 'string' ? expression : '';
    if (expr.length === 0) {
      return { ok: false, text: '参数错误：缺少 expression 字段' };
    }
    if (expr.length > 200) {
      return { ok: false, text: '表达式过长（上限 200 字符）' };
    }
    // 硬性白名单：只允许数字、运算符、括号、空白；任何字母都进不来
    if (!/^[\d+\-*/().\s]+$/.test(expr)) {
      return { ok: false, text: '表达式含非法字符，仅允许数字与 + - * / ( )' };
    }
    try {
      // 白名单已排除标识符，Function 求值无属性访问风险
      const value = Function('"use strict"; return (' + expr + ')')();
      if (typeof value === 'number' && Number.isFinite(value)) {
        return { ok: true, text: String(value) };
      }
      return { ok: false, text: '表达式无效' };
    } catch {
      // 除数归零、语法异常等一律转成可读字符串，绝不上抛
      return { ok: false, text: '表达式无效' };
    }
  },
};

/**
 * 读工作区内文本文件。
 * 安全顺序：先校验路径落在 root 内 → realpath 复核（防符号链接逃逸）→ 确认是文件 → 读取。
 */
const readTextFile: HarnessTool = {
  /**
   * 这里用方法而不是静态字面量，原因有两层：
   * 1. 工作区绝对路径只有运行时才知道，静态字面量写不进去；
   * 2. 这段 description 是模型能直接读到的**唯一环境事实**——模型对"我在哪、我能碰什么"
   *    的全部认知都来自工具声明。声明里不写真实路径，模型缺事实时就会用先验补全，
   *    编出"虚拟工作区／需要上传文件"这类说法（实测出现过）。
   */
  define(context: ToolContext): ToolDefinition {
    const root = context.workspaceRoot;
    return {
      name: 'read_text_file',
      description:
        `读取文本文件（只读）。当前工作区根目录为 ${root}；` +
        `path 填相对该目录的路径（如 test.txt）。` +
        `工作区之外的本机路径一律拒绝，本工具无法读取工作区外的任何文件。`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对于工作区根目录的路径，例如 test.txt',
          },
        },
        required: ['path'],
      },
    };
  },
  async execute(rawArgs: string, signal: AbortSignal, context: ToolContext): Promise<ToolResult> {
    if (signal.aborted) {
      return { ok: false, text: '已停止：读取被用户中止' };
    }
    const { path: relPath } = parseArgs<{ path?: string }>(rawArgs);
    const filePath = typeof relPath === 'string' ? relPath : '';

    const root = context.workspaceRoot;
    // 第一道门：解析后的相对路径不能越出工作区
    const resolved = resolveInsideWorkspace(root, filePath);
    if (!resolved.ok) {
      return { ok: false, text: resolved.text };
    }
    // 工作区根目录本身必须存在，否则给出引导文案
    const rootCheck = await resolveWorkspaceRealRoot(root);
    if (!rootCheck.ok) {
      return { ok: false, text: rootCheck.text };
    }
    // 第二道门：realpath 复核，确认真实路径仍落在 realpath(root) 内（防符号链接逃逸）
    const verified = await verifyRealPath(rootCheck.realRoot, resolved.target);
    if (!verified.ok) {
      return { ok: false, text: verified.text };
    }

    try {
      const stat = await fs.promises.stat(resolved.target);
      if (!stat.isFile()) {
        return { ok: false, text: '目标不是文件，无法读取' };
      }
      let content = await fs.promises.readFile(resolved.target, 'utf8');
      if (content.length > 20000) {
        // 超长截断，避免把巨量文本塞进上下文
        content = `${content.slice(0, 20000)}\n…（内容已截断）`;
      }
      return { ok: true, text: content };
    } catch {
      // 文件不存在 / 无权限等都转成可读文案，让模型自己决定怎么回复
      return { ok: false, text: `文件读取失败：${filePath}（请确认文件存在于工作区 ${root} 内）` };
    }
  },
};

/**
 * 写入 / 覆盖工作区内的文本文件。
 * 覆盖已有文件前会先把原内容备份到工作区外；父目录不存在时自动创建。
 */
const writeTextFile: HarnessTool = {
  define(context: ToolContext): ToolDefinition {
    const root = context.workspaceRoot;
    return {
      name: 'write_text_file',
      description:
        `把内容整体写入文本文件：文件不存在则创建，已存在则**整体覆盖**原内容。` +
        `当前工作区根目录为 ${root}；path 填相对该目录的路径（如 notes/a.md）。` +
        `父目录不存在时会自动创建。工作区之外的本机路径一律拒绝。` +
        `覆盖已有文件前，原内容会自动备份，因此可以放心使用；` +
        `但这是整体覆盖，只想改动局部内容时应改用 edit_text_file。`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对于工作区根目录的路径，例如 notes/a.md' },
          content: { type: 'string', description: '要写入的完整文件内容（会整体覆盖原内容）' },
        },
        required: ['path', 'content'],
      },
    };
  },
  async execute(rawArgs: string, signal: AbortSignal, context: ToolContext): Promise<ToolResult> {
    if (signal.aborted) {
      return { ok: false, text: '已停止：写入被用户中止' };
    }
    const { path: relPath, content } = parseArgs<{ path?: string; content?: string }>(rawArgs);
    const filePath = typeof relPath === 'string' ? relPath : '';
    if (typeof content !== 'string') {
      return { ok: false, text: '参数错误：缺少 content 字段' };
    }
    if (content.length > WRITE_CONTENT_LIMIT) {
      return {
        ok: false,
        text: `内容过长（上限 ${WRITE_CONTENT_LIMIT} 字符，当前 ${content.length} 字符）`,
      };
    }

    const root = context.workspaceRoot;
    const resolved = resolveInsideWorkspace(root, filePath);
    if (!resolved.ok) {
      return { ok: false, text: resolved.text };
    }
    const rootCheck = await resolveWorkspaceRealRoot(root);
    if (!rootCheck.ok) {
      return { ok: false, text: rootCheck.text };
    }
    const verified = await verifyRealPath(rootCheck.realRoot, resolved.target);
    if (!verified.ok) {
      return { ok: false, text: verified.text };
    }

    try {
      const stat = await fs.promises.stat(resolved.target).catch(() => null);
      if (stat && !stat.isFile()) {
        return { ok: false, text: `目标已存在且不是普通文件，拒绝覆盖：${filePath}` };
      }
      if (stat) {
        const backup = await backupBeforeOverwrite(context, resolved.target);
        if (!backup.ok) {
          return { ok: false, text: backup.text };
        }
        await fs.promises.writeFile(resolved.target, content, 'utf8');
        return {
          ok: true,
          text: `已覆盖文件：${filePath}（写入 ${content.length} 字符，原内容已备份到 ${backup.backupPath}）`,
        };
      }
      // 目标不存在：先把父目录建出来（都在工作区内，创建目录不会替换已存在的符号链接）
      await fs.promises.mkdir(path.dirname(resolved.target), { recursive: true });
      await fs.promises.writeFile(resolved.target, content, 'utf8');
      return { ok: true, text: `已创建文件：${filePath}（${content.length} 字符）` };
    } catch (error) {
      return {
        ok: false,
        text: `文件写入失败：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
      };
    }
  },
};

/**
 * 在工作区内做精确文本替换（只替换唯一匹配的那一处）。
 *
 * 刻意要求 old_text 唯一匹配：出现 0 次说明模型对文件内容的记忆有偏差，
 * 出现多次则无法判断该改哪一处 —— 两种情况下直接拒绝，让模型补充上下文重试，
 * 比「猜一处改掉」安全得多。
 */
const editTextFile: HarnessTool = {
  define(context: ToolContext): ToolDefinition {
    const root = context.workspaceRoot;
    return {
      name: 'edit_text_file',
      description:
        `把文件中的一段文本替换为另一段（精确匹配，只替换唯一命中的那一处）。` +
        `当前工作区根目录为 ${root}；path 填相对该目录的路径。` +
        `old_text 必须与文件内容**逐字符一致**（含缩进与换行），且在文件中**只出现一次**——` +
        `出现 0 次或多次都会被拒绝并说明原因。修改前原内容会自动备份。`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对于工作区根目录的路径，例如 notes/a.md' },
          old_text: { type: 'string', description: '要被替换的原文本，必须与文件内容完全一致且唯一' },
          new_text: { type: 'string', description: '替换成的新文本；传空字符串表示删除这段文本' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    };
  },
  async execute(rawArgs: string, signal: AbortSignal, context: ToolContext): Promise<ToolResult> {
    if (signal.aborted) {
      return { ok: false, text: '已停止：修改被用户中止' };
    }
    const { path: relPath, old_text: oldText, new_text: newText } = parseArgs<{
      path?: string;
      old_text?: string;
      new_text?: string;
    }>(rawArgs);
    const filePath = typeof relPath === 'string' ? relPath : '';
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      return { ok: false, text: '参数错误：缺少 old_text 或 new_text 字段' };
    }
    if (oldText.length === 0) {
      // 空字符串在 JS 里 split 会切出无数段，必须先拦住
      return { ok: false, text: '参数错误：old_text 不能为空' };
    }

    const root = context.workspaceRoot;
    const resolved = resolveInsideWorkspace(root, filePath);
    if (!resolved.ok) {
      return { ok: false, text: resolved.text };
    }
    const rootCheck = await resolveWorkspaceRealRoot(root);
    if (!rootCheck.ok) {
      return { ok: false, text: rootCheck.text };
    }
    const verified = await verifyRealPath(rootCheck.realRoot, resolved.target);
    if (!verified.ok) {
      return { ok: false, text: verified.text };
    }

    try {
      const original = await fs.promises.readFile(resolved.target, 'utf8');
      // split(...).length - 1 是「出现次数」的标准算法（ES5 起可用，不依赖 ES2021 的 replaceAll）
      const occurrences = original.split(oldText).length - 1;
      if (occurrences === 0) {
        return {
          ok: false,
          text: `未找到要替换的文本，文件未被修改：${filePath}（请确认 old_text 与文件内容逐字符一致，含缩进与换行）`,
        };
      }
      if (occurrences > 1) {
        return {
          ok: false,
          text: `要替换的文本在文件中出现了 ${occurrences} 次，无法确定改哪一处，文件未被修改：${filePath}（请提供更长的上下文使 old_text 唯一）`,
        };
      }
      const updated = original.replace(oldText, newText);
      const backup = await backupBeforeOverwrite(context, resolved.target);
      if (!backup.ok) {
        return { ok: false, text: backup.text };
      }
      await fs.promises.writeFile(resolved.target, updated, 'utf8');
      return {
        ok: true,
        text: `已修改文件：${filePath}（替换 1 处，${original.length} → ${updated.length} 字符，原内容已备份到 ${backup.backupPath}）`,
      };
    } catch (error) {
      return {
        ok: false,
        text: `文件修改失败：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
      };
    }
  },
};

/**
 * 追加一条工作笔记到当日笔记文件。
 *
 * 只追加、不覆盖此前的记录；日期计算 / 文件定位 / 追加动作全部由主进程完成，
 * 模型只负责产出笔记正文 —— 这样模型既不会因为 read_text_file 的 20000 字符截断
 * 而误删旧记录，也不会把「今天是几号」猜错。
 */
const appendDailyNote: HarnessTool = {
  define(context: ToolContext): ToolDefinition {
    const root = context.workspaceRoot;
    const todayFile = dailyNoteFilePath(root);
    return {
      name: 'append_daily_note',
      description:
        `把一条简短的工作笔记追加到当日记忆文件（完整路径：${todayFile}）。` +
        `只追加、不覆盖此前的记录。` +
        `你只需传笔记正文，日期与文件名由系统自动决定，不要自己写日期、标题或文件名。` +
        `用于记录有长期价值的内容：做了什么改动、问题的根因、得出的结论、选定的方案。` +
        `不要记录寒暄、一次性查询、临时路径或普通报错。` +
        `需要回看历史笔记时，用 read_text_file 读取上面这个完整路径。`,
      parameters: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description: '要记录的笔记正文，简洁的纯文本或 Markdown，建议不超过 500 字',
          },
        },
        required: ['note'],
      },
    };
  },
  async execute(rawArgs: string, signal: AbortSignal, context: ToolContext): Promise<ToolResult> {
    if (signal.aborted) {
      return { ok: false, text: '已停止：记录笔记被用户中止' };
    }
    if (!context.memoryEnabled) {
      return { ok: false, text: '记忆功能已关闭：本次未启用每日笔记' };
    }
    const { note } = parseArgs<{ note?: string }>(rawArgs);
    if (typeof note !== 'string') {
      return { ok: false, text: '参数错误：缺少 note 字段' };
    }
    const trimmed = note.trim();
    if (trimmed.length === 0) {
      return { ok: false, text: '参数错误：note 不能为空' };
    }
    if (trimmed.length > DAILY_NOTE_LIMIT) {
      return {
        ok: false,
        text: `笔记过长（上限 ${DAILY_NOTE_LIMIT} 字符，当前 ${trimmed.length} 字符）`,
      };
    }
    try {
      await appendDailyNoteToFile(context.workspaceRoot, trimmed);
      return {
        ok: true,
        text: `已记录到当日笔记：${dailyNoteFilePath(context.workspaceRoot)}（${formatLocalTime(Date.now())}）`,
      };
    } catch (error) {
      return {
        ok: false,
        text: `记录笔记失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

/** 内置工具列表；loop 会取它们的 define(context) 暴露给模型 */
export const HARNESS_TOOLS: HarnessTool[] = [
  getCurrentTime,
  calculator,
  readTextFile,
  writeTextFile,
  editTextFile,
  appendDailyNote,
];

/**
 * 本次生成实际暴露给模型的工具集合。
 *
 * 记忆功能关闭时摘掉 append_daily_note：它写入的正是被关闭的 `.agent/memory/` 目录，
 * 留着只会白占一份 tool schema 的 token，还可能被模型误调。
 */
export function harnessToolsFor(context: ToolContext): HarnessTool[] {
  return context.memoryEnabled
    ? HARNESS_TOOLS
    : HARNESS_TOOLS.filter((tool) => tool !== appendDailyNote);
}

/** 按工具名查找，找不到返回 undefined（loop 会据此生成可读错误并回灌） */
export function findTool(name: string, context: ToolContext): HarnessTool | undefined {
  return harnessToolsFor(context).find((tool) => tool.define(context).name === name);
}
