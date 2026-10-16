/**
 * 「找文件」只读工具：list_dir（列目录）+ search_text（按内容搜索）。
 *
 * 设计来源：docs/HARNESS-SEARCH-DESIGN.md（§2 / §4 / §6）。本模块只依赖 node:fs / node:path，
 * 零新依赖；路径安全**不另造一套**，而是由 tools.ts 通过工厂把既有双门守卫注入进来，
 * 从而避免 tools-search ↔ tools 形成 import 环。
 *
 * 三条硬纪律：
 * - 手写剪枝递归（禁用 readdir 的 recursive:true）：命中忽略名单的目录**在 path.join / 入栈之前**
 *   就 continue，根本不下降，避免先走进 node_modules / .git 再过滤；
 * - query 一律**字面量**匹配（includes），绝不把用户输入交给 new RegExp；glob 是自造编译产物，长度受限；
 * - execute 自吞异常，任何错误都转成 { ok:false, text }，绝不向上抛。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '../providers/types';
import type { HarnessTool, ToolContext, ToolResult } from './types';

/* ───────────────────────── 路径守卫（由 tools.ts 注入，避免循环依赖） ───────────────────────── */

/** 第一道门：路径解析结果（ok 时给工作区内的绝对路径） */
export type PathResolution = { ok: true; target: string } | { ok: false; text: string };

/** 工作区根解析结果（ok 分支带的是 realRoot，与 PathResolution 不同，切勿合并） */
export type RealRootResolution = { ok: true; realRoot: string } | { ok: false; text: string };

/** 第二道门：realpath 复核结果（无成功载荷） */
export type RealPathCheck = { ok: true } | { ok: false; text: string };

export interface WorkspacePathGuards {
  resolveInsideWorkspace: (root: string, relPath: string) => PathResolution;
  resolveWorkspaceRealRoot: (root: string) => Promise<RealRootResolution>;
  verifyRealPath: (realRoot: string, target: string) => Promise<RealPathCheck>;
}

/* ────────────────────────────────── 限流常量 ────────────────────────────────── */

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
const SEARCH_MAX_FILE_BYTES = 262_144; // 256 KB
const SEARCH_MAX_SCAN_FILES = 2_000;
const SEARCH_MAX_SCAN_BYTES = 33_554_432; // 32 MB
const SEARCH_BINARY_SNIFF_BYTES = 8_000;

/** glob 模式长度上限（防自造超长模式拖垮编译） */
const GLOB_MAX_LENGTH = 100;

/* ──────────────────────────────── 忽略名单与二进制快筛 ──────────────────────────────── */

/** 忽略目录名单（单一事实来源；剪枝在下降前发生，见 walkPruned） */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  '.agent',
]);

/** 二进制扩展名快速过滤（真正的判据是 \0 嗅探，这里是廉价前置） */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.node', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.wav',
]);

/* ──────────────────────────────────── 内部类型 ──────────────────────────────────── */

/** list_dir 入参 */
interface ListDirArgs {
  path?: string;
  depth?: number;
}

/** 一条目录项 */
interface ListEntry {
  /** 相对工作区的 POSIX 风格路径，如 src/main/index.ts */
  relPath: string;
  type: 'dir' | 'file';
  /** 仅 file 有：字节数 */
  size?: number;
}

/** search_text 入参 */
interface SearchArgs {
  query?: string;
  path?: string;
  glob?: string;
  max_results?: number;
  case_sensitive?: boolean;
}

/** 一条命中 */
interface SearchHit {
  /** 相对工作区的 POSIX 风格路径 */
  relPath: string;
  /** 1-based 行号 */
  line: number;
  /** 该行内容（已按 SEARCH_MAX_LINE_CHARS 截断） */
  text: string;
}

/** 被跳过、未纳入检索的内容计数。必须回灌给模型，否则「未找到」会被讲成「不存在」。 */
interface SearchSkips {
  /** 扩展名快筛或 \0 嗅探判定为二进制而跳过 */
  binary: number;
  /** 超过 SEARCH_MAX_FILE_BYTES 而跳过 */
  oversize: number;
  /** readFile 失败（权限 / 竞态删除）而跳过 */
  unreadable: number;
  /** 整个目录 readdir 失败，其下全部文件未纳入检索 */
  unreadableDirs: number;
}

/** 剪枝遍历的待访问节点 */
interface WalkNode {
  /** 绝对路径 */
  abs: string;
  /** 相对起始目录的 POSIX 风格路径；起始目录自身为 '.' */
  rel: string;
  depth: number;
}

/** 剪枝遍历选项 */
interface WalkOptions {
  /** 最大深度；search_text 传正无穷（受访问预算约束） */
  maxDepth: number;
  /** 最多访问的条目数（安全阀） */
  visitBudget: number;
  /** 目录回调（根目录自身不回调） */
  onDir: (relPath: string, absPath: string) => void;
  /** 文件回调；返回 false 表示上层要求立即停止遍历 */
  onFile: (relPath: string, absPath: string, size: number) => Promise<boolean>;
}

/** 剪枝遍历结果：始终返回同一形状，避免出现裸 return 造成返回类型不一致 */
interface WalkResult {
  /** 因访问预算耗尽（或上层回调要求停止）而提前结束 */
  truncatedByBudget: boolean;
  /** 因 signal.aborted 提前结束 */
  aborted: boolean;
  /** readdir 失败的目录（相对路径，起始目录本身失败记为 '.'），其下内容全部未纳入 */
  unreadableDirs: string[];
}

/* ──────────────────────────────────── 通用辅助 ──────────────────────────────────── */

/** 解析工具入参的 JSON；失败回退为空对象（工具自己负责解析，loop 只透传原始字符串） */
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

/** 异常 → 可读文案（不向上抛） */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 目录参数归一：非字符串 / 空白一律回落为 '.'（工作区根） */
function normalizeDirArg(value: unknown): string {
  if (typeof value !== 'string') {
    return '.';
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? '.' : trimmed;
}

/** 把任意值收敛为 [1, LIST_MAX_DEPTH] 的整数深度；非法值回落默认 1 */
function clampDepth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }
  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > LIST_MAX_DEPTH) {
    return LIST_MAX_DEPTH;
  }
  return normalized;
}

/** 把任意值收敛为 [1, SEARCH_MAX_RESULTS] 的整数；非法值回落默认 50 */
function clampMaxResults(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return SEARCH_DEFAULT_RESULTS;
  }
  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > SEARCH_MAX_RESULTS) {
    return SEARCH_MAX_RESULTS;
  }
  return normalized;
}

/** 单行截断：超过 maxChars 时截断并追加省略号 */
function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) {
    return line;
  }
  return `${line.slice(0, maxChars)}…`;
}

/**
 * 命中行截断：以命中位置为中心开窗，保证窗口内**一定包含命中词**。
 * 直接从头截断会出现「命中行里看不到查询词」的矛盾，模型会误判为假命中。
 */
function truncateAroundHit(line: string, hitIndex: number, maxChars: number): string {
  if (line.length <= maxChars) {
    return line;
  }
  const headRoom = Math.floor(maxChars / 2);
  const start = Math.max(0, hitIndex - headRoom);
  const end = Math.min(line.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

/** 人类可读体积，如 "1.2 KB"；小于 1KB 给整数字节 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * 二进制探测：仅在前 SEARCH_BINARY_SNIFF_BYTES 字节内查找 0x00。
 * 只看开头即可判定（文本文件的开头几乎不会出现 NUL），也避免对超大缓冲做全量扫描。
 */
export function isProbablyBinary(buffer: Buffer): boolean {
  const head = buffer.subarray(0, SEARCH_BINARY_SNIFF_BYTES);
  return head.includes(0);
}

/* ──────────────────────────────────── glob 编译 ──────────────────────────────────── */

/** 转义 glob 中的正则元字符（* ? 已在 globToRegExp 里单独处理，不会走到这里） */
function escapeGlobChar(ch: string): string {
  return '\\^$.|+()[]{}'.includes(ch) ? `\\${ch}` : ch;
}

/** 单个 * 编译出的正则片段 */
const STAR_SOURCE = '[^/]*';
/** 两个星号编译出的正则片段 */
const ANY_SOURCE = '.*';

/**
 * 把 glob 编译成正则（仅支持 * ? **，无新依赖）。
 * - `*`  匹配任意非 '/' 字符；
 * - `?`  匹配单个非 '/' 字符；
 * - `**` 匹配任意字符（可跨 '/'）。
 *
 * 连续通配符会先折叠再输出（如三个星号连写、星号紧跟星号中间隔一个斜杠的接法）：
 * 它们全是「零或更多」量词且类互相包含（`*` ⊆ `**`），折叠语义完全等价，
 * 但每一个多余的通配片段都会给正则引擎多开一条回溯分支 ——
 * `(a+)+$` 式回溯爆炸在连续通配符构成的 pattern 上同样成立（GLOB_MAX_LENGTH
 * 只挡 pattern 长度，挡不住量词组合）。MEMORY-REFERENCE 记录的 glob 残留
 * 缺口（2026-10-16 修）就是指这一类。
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  let index = 0;
  // 上一个已输出的通配片段类型，供折叠判断
  let lastWildcard: 'none' | 'star' | 'any' = 'none';
  while (index < pattern.length) {
    const ch = pattern[index];
    if (ch === '*') {
      const isDouble = pattern[index + 1] === '*';
      index += isDouble ? 2 : 1;
      if (isDouble) {
        if (lastWildcard === 'star') {
          // 形如 */** 的接法：前面的 [^/]* 被 .* 完全覆盖，撤掉它只留一个 .*
          source = source.slice(0, -STAR_SOURCE.length);
        }
        if (lastWildcard !== 'any') {
          source += ANY_SOURCE;
        }
        lastWildcard = 'any';
        continue;
      }
      // 单个 * 跟在 * 或 ** 后面同样冗余（同一个片段已能覆盖它）
      if (lastWildcard === 'none') {
        source += STAR_SOURCE;
        lastWildcard = 'star';
      }
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      index += 1;
      lastWildcard = 'none';
      continue;
    }
    source += escapeGlobChar(ch);
    index += 1;
    lastWildcard = 'none';
  }
  return new RegExp(`^${source}$`);
}

/**
 * glob 是否匹配给定相对路径。
 * - 模式不含 '/' → 对 basename 匹配（`*.ts` 命中 `src/a.ts`）；
 * - 模式含 '/'   → 对相对路径匹配（`src/main/*.ts` 命中 `src/main/a.ts`；想跨层级时把中间的 `*` 写成 `**`）；
 * - 空模式或超长（> GLOB_MAX_LENGTH）直接判不匹配。
 *
 * ⚠️ 本注释块内不得出现连续的「双星号 + 斜杠」：那正是块注释的结束符，会提前终止注释、
 * 导致后面的内容被当成代码而编译失败（本文件已踩过一次）。上面第二条示例因此绕开写法，
 * 不直接拼出完整模式。
 */
export function matchGlob(relPath: string, pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > GLOB_MAX_LENGTH) {
    return false;
  }
  const target = pattern.includes('/') ? relPath : path.posix.basename(relPath);
  return globToRegExp(pattern).test(target);
}

/* ────────────────────────────────── 剪枝递归遍历 ────────────────────────────────── */

/**
 * 手写剪枝 BFS 遍历。
 *
 * 关键：用 withFileTypes 逐层 readdir，在 **path.join 与入栈之前** 判掉忽略目录与符号链接，
 * 命中就 continue（根本不下降），从而不会先走进 node_modules / .git 再过滤。
 * 单层 readdir 失败（无权限 / 目录被删）只跳过该目录，不中断整体。
 * signal.aborted 在**每个目录出栈时**检查一次（及时且不过度开销）。
 */
async function walkPruned(
  signal: AbortSignal,
  startAbs: string,
  options: WalkOptions,
): Promise<WalkResult> {
  const queue: WalkNode[] = [{ abs: startAbs, rel: '.', depth: 0 }];
  const unreadableDirs: string[] = [];
  let visited = 0;
  let truncatedByBudget = false;
  let aborted = false;

  while (queue.length > 0) {
    if (signal.aborted) {
      aborted = true;
      break;
    }
    const node = queue.shift() as WalkNode;
    const entries = await fs.promises.readdir(node.abs, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      // 单层失败（权限 / 目录被删）：跳过该目录继续，但必须记下来 —— 静默省略会让
      // 模型把「读不到」讲成「是空的」。起始目录自身失败时 rel 为 '.'。
      unreadableDirs.push(node.rel);
      continue;
    }
    // 目录优先、同类按 UTF-16 码元升序（稳定、可复现；不用依赖 locale 的 localeCompare）
    entries.sort((a, b) => {
      const aIsDir = a.isDirectory();
      const bIsDir = b.isDirectory();
      if (aIsDir !== bIsDir) {
        return aIsDir ? -1 : 1;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    for (const entry of entries) {
      visited += 1;
      if (visited > options.visitBudget) {
        truncatedByBudget = true;
        break;
      }
      if (IGNORED_DIRS.has(entry.name)) {
        // ★ 剪枝：命中忽略名单直接不下降（这是「剪枝」的全部含义）
        continue;
      }
      if (entry.isSymbolicLink()) {
        // ★ 不跟随符号链接（防逃逸 / 防环）
        continue;
      }
      const childRel = node.rel === '.' ? entry.name : `${node.rel}/${entry.name}`;
      const childAbs = path.join(node.abs, entry.name);
      if (entry.isDirectory()) {
        options.onDir(childRel, childAbs);
        if (node.depth + 1 < options.maxDepth) {
          queue.push({ abs: childAbs, rel: childRel, depth: node.depth + 1 });
        }
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(childAbs).catch(() => null);
        if (!stat) {
          continue;
        }
        const shouldContinue = await options.onFile(childRel, childAbs, stat.size);
        if (!shouldContinue) {
          truncatedByBudget = true;
          break;
        }
      }
    }

    if (truncatedByBudget) {
      break;
    }
  }

  return { truncatedByBudget, aborted, unreadableDirs };
}

/* ──────────────────────────────────── 渲染函数 ──────────────────────────────────── */

/** 组装 list_dir 文本：逐条累加，任一上限触发即停止并追加截断文案 */
function renderList(rel: string, depth: number, entries: ListEntry[], walk: WalkResult): string {
  const lines: string[] = [`目录列表：${rel}（深度 ${depth}）`];
  let shown = 0;
  let chars = lines[0].length;
  let dirCount = 0;
  let fileCount = 0;
  let truncated: string | null = null;

  for (const entry of entries) {
    if (shown >= LIST_MAX_ENTRIES) {
      truncated = `已达条目数上限（${LIST_MAX_ENTRIES} 条）`;
      break;
    }
    const line =
      entry.type === 'dir'
        ? `[dir]  ${truncateLine(`${entry.relPath}/`, LIST_MAX_LINE_CHARS)}`
        : `[file] ${truncateLine(entry.relPath, LIST_MAX_LINE_CHARS)} (${formatBytes(entry.size ?? 0)})`;
    if (chars + line.length > LIST_MAX_OUTPUT_CHARS) {
      truncated = `已达输出字符上限（${LIST_MAX_OUTPUT_CHARS} 字符）`;
      break;
    }
    lines.push(line);
    chars += line.length + 1;
    shown += 1;
    // 计数与 shown 同口径：只统计「已实际显示」的条目，避免出现「共 200 项」与分项对不上
    if (entry.type === 'dir') {
      dirCount += 1;
    } else {
      fileCount += 1;
    }
  }

  lines.push('', `共 ${shown} 项（目录 ${dirCount} / 文件 ${fileCount}）`);
  if (truncated) {
    lines.push(`…（已截断：${truncated}。请缩小 path、或降低 depth 后重试，以看到其余内容）`);
  } else if (walk.truncatedByBudget) {
    lines.push(
      `…（已达内部访问预算（${LIST_VISIT_BUDGET} 条），仅列出已访问部分。请缩小 path、或降低 depth 后重试）`,
    );
  }
  if (walk.aborted) {
    lines.push('…（已被用户中止，仅列出中止前收集到的部分）');
  }
  if (walk.unreadableDirs.length > 0) {
    // 起始目录自身读失败时此处会出现 '.'，正是最容易让模型误判「目录是空的」的情形
    const shownDirs = walk.unreadableDirs.slice(0, 5).join('、');
    const moreDirs = walk.unreadableDirs.length > 5 ? ' …' : '';
    lines.push(
      `…（另有 ${walk.unreadableDirs.length} 个目录无法读取（权限不足或已被删除），` +
        `未纳入列表：${shownDirs}${moreDirs}）`,
    );
  }
  return lines.join('\n');
}

/** 拼装「被跳过的内容」提示；无跳过时返回 null。让「未找到」的边界显式可见。 */
function skippedNote(skips: SearchSkips): string | null {
  const parts: string[] = [];
  if (skips.oversize > 0) {
    parts.push(`${skips.oversize} 个文件超过大小上限`);
  }
  if (skips.binary > 0) {
    parts.push(`${skips.binary} 个二进制文件`);
  }
  if (skips.unreadable > 0) {
    parts.push(`${skips.unreadable} 个文件读取失败`);
  }
  if (skips.unreadableDirs > 0) {
    parts.push(`${skips.unreadableDirs} 个目录无法读取`);
  }
  if (parts.length === 0) {
    return null;
  }
  return `…（另有 ${parts.join('、')}，未纳入检索；上述结果未覆盖这些内容）`;
}

/** 组装 search_text 文本：逐条累加、超总字符上限即停，末尾附引导文案 */
function renderSearch(
  query: string,
  rel: string,
  glob: string,
  caseSensitive: boolean,
  hits: SearchHit[],
  stopped: string | null,
  scanFiles: number,
  skips: SearchSkips,
): string {
  const skipLine = skippedNote(skips);
  const globPart = glob ? `，glob ${glob}` : '';
  if (hits.length === 0) {
    const lines = [`未找到包含 "${query}" 的内容（路径 ${rel}${globPart}）。`];
    if (stopped) {
      // stopped 非空 = 搜索提前结束，「未找到」只覆盖已检索的部分，必须说清楚，
      // 否则模型会据此向用户断言「工作区里没有该内容」——那是错的。
      lines.push(
        `…（搜索未完成：${stopped}。上述「未找到」仅覆盖已检索的部分，` +
          `请加 glob 收窄文件类型、或把 path 缩小到具体子目录后重搜）`,
      );
    }
    if (skipLine) {
      lines.push(skipLine);
    }
    lines.push(`共检索 ${scanFiles} 个文件。`);
    lines.push('可尝试：换关键字、放宽或去掉 glob、把 path 指向更具体的子目录。');
    return lines.join('\n');
  }

  const fileCount = new Set(hits.map((hit) => hit.relPath)).size;
  const header =
    `搜索 "${query}"（路径 ${rel}${globPart}，区分大小写 ${caseSensitive ? '是' : '否'}）：` +
    `命中 ${hits.length} 行 / ${fileCount} 个文件`;
  const lines: string[] = [header];
  let chars = header.length;
  let truncated: string | null = stopped;

  for (const hit of hits) {
    const line = `${hit.relPath}:${hit.line}: ${hit.text}`;
    if (chars + line.length > SEARCH_MAX_OUTPUT_CHARS) {
      truncated = `已达输出字符上限（${SEARCH_MAX_OUTPUT_CHARS} 字符）`;
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }

  lines.push('', `共检索 ${scanFiles} 个文件`);
  if (truncated) {
    lines.push(`…（已截断：${truncated}。请加 glob 收窄文件类型、或把 path 缩小到具体子目录后重搜）`);
  }
  if (skipLine) {
    lines.push(skipLine);
  }
  return lines.join('\n');
}

/* ──────────────────────────────────── 工具工厂 ──────────────────────────────────── */

/**
 * 用注入的守卫构造两个搜索工具（闭包持有 guards，故本模块不 import tools.ts，彻底无环）。
 */
export function createSearchTools(guards: WorkspacePathGuards): HarnessTool[] {
  /* ------------------------------- list_dir ------------------------------- */
  const listDir: HarnessTool = {
    define(context: ToolContext): ToolDefinition {
      const root = context.workspaceRoot;
      return {
        name: 'list_dir',
        description:
          `列出工作区内某个目录的内容（只读）。当前工作区根目录为 ${root}；` +
          `path 填相对该目录的目录路径（默认 "." 表示工作区根）。` +
          `目录在前、文件在后，文件附大小；自动跳过 node_modules / .git / out / dist / .agent。` +
          `工作区之外的本机路径一律拒绝。` +
          `输出有上限（约 ${LIST_MAX_ENTRIES} 项），超出会被截断——需要看更多时请缩小 path 或降低 depth。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '相对于工作区根目录的目录路径，默认 "."（工作区根目录）',
            },
            depth: {
              type: 'integer',
              description: `递归深度，默认 1（仅当前层）；取值范围 1~${LIST_MAX_DEPTH}`,
            },
          },
          required: [],
        },
      };
    },
    async execute(rawArgs: string, signal: AbortSignal, context: ToolContext): Promise<ToolResult> {
      let rel = '.';
      try {
        const args = parseArgs<ListDirArgs>(rawArgs);
        rel = normalizeDirArg(args.path);
        const depth = clampDepth(args.depth);
        const root = context.workspaceRoot;

        // 双门路径校验（复用注入的守卫，不另造一套越界判断）
        const resolved = guards.resolveInsideWorkspace(root, rel);
        if (!resolved.ok) {
          return { ok: false, text: resolved.text };
        }
        const rootResolution = await guards.resolveWorkspaceRealRoot(root);
        if (!rootResolution.ok) {
          return { ok: false, text: rootResolution.text };
        }
        const verified = await guards.verifyRealPath(rootResolution.realRoot, resolved.target);
        if (!verified.ok) {
          return { ok: false, text: verified.text };
        }

        const stat = await fs.promises.stat(resolved.target).catch(() => null);
        if (!stat) {
          return { ok: false, text: `目录不存在：${rel}（请确认它存在于工作区 ${root} 内）` };
        }
        if (!stat.isDirectory()) {
          return { ok: false, text: `目标不是目录：${rel}（list_dir 只能列出目录）` };
        }

        const entries: ListEntry[] = [];
        const walk = await walkPruned(signal, resolved.target, {
          maxDepth: depth,
          visitBudget: LIST_VISIT_BUDGET,
          onDir: (dirRel) => {
            entries.push({ relPath: dirRel, type: 'dir' });
          },
          onFile: async (fileRel, _absPath, size) => {
            entries.push({ relPath: fileRel, type: 'file', size });
            return true;
          },
        });

        return { ok: true, text: renderList(rel, depth, entries, walk) };
      } catch (error) {
        return { ok: false, text: `列目录失败：${rel}（${messageOf(error)}）` };
      }
    },
  };

  /* ------------------------------ search_text ------------------------------ */
  const searchText: HarnessTool = {
    define(context: ToolContext): ToolDefinition {
      const root = context.workspaceRoot;
      return {
        name: 'search_text',
        description:
          `在工作区内按内容搜索文本（只读，字面量匹配，非正则）。当前工作区根目录为 ${root}；` +
          `path 填相对该目录的起始目录（默认 "."）。` +
          `返回形如「相对路径:行号: 该行内容」，按文件聚集；` +
          `自动跳过 node_modules / .git / out / dist / .agent 与二进制文件。` +
          `命中数有上限（默认 ${SEARCH_DEFAULT_RESULTS} 行），超出会被截断——请加 glob 或缩小 path 重搜。` +
          `不知道文件名时优先用它定位，再用 read_text_file 精读。工作区之外一律拒绝。`,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '要搜索的字面量文本（不做正则），默认大小写不敏感',
            },
            path: {
              type: 'string',
              description: '相对于工作区根目录的起始目录，默认 "."',
            },
            glob: {
              type: 'string',
              description:
                '文件名过滤，如 *.ts、*.md、src/**/*.ts；不含 "/" 时按文件名匹配，含 "/" 时按相对路径匹配；省略则不过滤',
            },
            max_results: {
              type: 'integer',
              description: `最多返回的命中行数，默认 ${SEARCH_DEFAULT_RESULTS}，上限 ${SEARCH_MAX_RESULTS}`,
            },
            case_sensitive: {
              type: 'boolean',
              description: '是否区分大小写，默认 false',
            },
          },
          required: ['query'],
        },
      };
    },
    async execute(rawArgs: string, signal: AbortSignal, context: ToolContext): Promise<ToolResult> {
      try {
        const args = parseArgs<SearchArgs>(rawArgs);
        const query = typeof args.query === 'string' ? args.query : '';
        if (query.trim().length === 0) {
          return { ok: false, text: '参数错误：缺少 query 字段' };
        }
        if (query.length > SEARCH_MAX_QUERY_CHARS) {
          return {
            ok: false,
            text: `查询过长（上限 ${SEARCH_MAX_QUERY_CHARS} 字符，当前 ${query.length} 字符）`,
          };
        }
        const rel = normalizeDirArg(args.path);
        const glob =
          typeof args.glob === 'string' && args.glob.trim().length > 0 ? args.glob.trim() : '';
        const caseSensitive = args.case_sensitive === true;
        const limit = clampMaxResults(args.max_results);
        const needle = caseSensitive ? query : query.toLowerCase();
        const root = context.workspaceRoot;

        // 双门路径校验
        const resolved = guards.resolveInsideWorkspace(root, rel);
        if (!resolved.ok) {
          return { ok: false, text: resolved.text };
        }
        const rootResolution = await guards.resolveWorkspaceRealRoot(root);
        if (!rootResolution.ok) {
          return { ok: false, text: rootResolution.text };
        }
        const verified = await guards.verifyRealPath(rootResolution.realRoot, resolved.target);
        if (!verified.ok) {
          return { ok: false, text: verified.text };
        }

        const stat = await fs.promises.stat(resolved.target).catch(() => null);
        if (!stat) {
          return { ok: false, text: `路径不存在：${rel}（请确认它存在于工作区 ${root} 内）` };
        }
        if (!stat.isDirectory()) {
          return {
            ok: false,
            text: `搜索起始路径不是目录：${rel}（search_text 的 path 需指向目录）`,
          };
        }

        const hits: SearchHit[] = [];
        let scanFiles = 0;
        let scanBytes = 0;
        let stopped: string | null = null;
        const skips: SearchSkips = { binary: 0, oversize: 0, unreadable: 0, unreadableDirs: 0 };

        const walk = await walkPruned(signal, resolved.target, {
          maxDepth: Number.POSITIVE_INFINITY,
          visitBudget: LIST_VISIT_BUDGET,
          onDir: () => {
            // list 类回调在此工具中无需处理
          },
          onFile: async (fileRel, absPath, size) => {
            // glob 过滤 → 扩展名快筛 → 单文件大小门槛：任一不过一律跳过（继续遍历）
            if (glob.length > 0 && !matchGlob(fileRel, glob)) {
              return true;
            }
            if (BINARY_EXTENSIONS.has(path.extname(fileRel).toLowerCase())) {
              skips.binary += 1;
              return true;
            }
            if (size > SEARCH_MAX_FILE_BYTES) {
              skips.oversize += 1;
              return true;
            }
            // 扫描文件数预算：命中即停（在读之前判，避免多读一个文件）
            if (scanFiles >= SEARCH_MAX_SCAN_FILES) {
              stopped = `已扫描 ${SEARCH_MAX_SCAN_FILES} 个文件后停止`;
              return false;
            }

            const buffer = await fs.promises.readFile(absPath).catch(() => null);
            if (!buffer) {
              // 读取失败（权限 / 竞态删除）：跳过该文件，不中断整体
              skips.unreadable += 1;
              return true;
            }
            scanFiles += 1;
            scanBytes += buffer.length;
            if (scanBytes >= SEARCH_MAX_SCAN_BYTES) {
              stopped = `已达扫描字节预算（${Math.round(SEARCH_MAX_SCAN_BYTES / (1024 * 1024))} MB）`;
              return false;
            }
            if (isProbablyBinary(buffer)) {
              skips.binary += 1;
              return true;
            }

            const lines = buffer.toString('utf8').split('\n');
            for (let index = 0; index < lines.length; index += 1) {
              if (signal.aborted) {
                stopped = '已中止';
                return false;
              }
              const rawLine = lines[index].replace(/\r$/, '');
              const haystack = caseSensitive ? rawLine : rawLine.toLowerCase();
              const hitIndex = haystack.indexOf(needle);
              if (hitIndex >= 0) {
                hits.push({
                  relPath: fileRel,
                  line: index + 1,
                  text: truncateAroundHit(rawLine, hitIndex, SEARCH_MAX_LINE_CHARS),
                });
                if (hits.length >= limit) {
                  stopped = `已达命中数上限 ${limit} 行`;
                  return false;
                }
              }
            }
            return true;
          },
        });

        if (walk.aborted && !stopped) {
          stopped = '已中止';
        }
        if (walk.truncatedByBudget && !stopped) {
          stopped = `已达内部访问预算（${LIST_VISIT_BUDGET} 条）`;
        }
        // readdir 失败的目录数（其下文件全部未纳入检索）——由修复 B 的 walk.unreadableDirs 提供
        skips.unreadableDirs = walk.unreadableDirs.length;

        // 命中按「相对路径码元升序 → 行号升序」排列，保证输出稳定可复现
        hits.sort((a, b) => {
          if (a.relPath !== b.relPath) {
            return a.relPath < b.relPath ? -1 : 1;
          }
          return a.line - b.line;
        });

        return {
          ok: true,
          text: renderSearch(query, rel, glob, caseSensitive, hits, stopped, scanFiles, skips),
        };
      } catch (error) {
        return { ok: false, text: `搜索失败（${messageOf(error)}）` };
      }
    },
  };

  return [listDir, searchText];
}
