/**
 * 读技能包内文本文件：内容读取 + 去 frontmatter + 二进制嗅探 + 截断。
 *
 * 设计来源：docs/SKILL-LOADING-DESIGN.md（§2.5 / §4.6 / §5 / §7）。
 *
 * 关键点：
 * - 路径安全**不另造一套**：只用调用方注入的 `guards.*`（双门守卫，根 = skillsRoot）；
 * - `relPath` 省略 → 读 `<skillsRoot>/<skill>/SKILL.md` 并返回**去掉 frontmatter 的正文**
 *   （frontmatter 是元数据、已由一级清单消费，正文再重复一遍纯浪费）；
 * - `relPath` 给定 → 读包内相对文件（如 `references/api.md`），**不去** frontmatter；
 * - 只读文本：二进制嗅探（复用 `tools-search` 的 `isProbablyBinary`）命中则拒绝；
 * - 输出上限 `READ_SKILL_LIMIT_CHARS`，超限**截断不判失败**（`ok:true`），但必须显式声明「内容不完整」；
 * - 本模块为纯逻辑：不含宿主桌面框架依赖（`skillsRoot` 由调用方传入）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isProbablyBinary, type WorkspacePathGuards } from '../harness/tools-search';
import { parseFrontmatter } from './frontmatter';

/** 输出字符上限：与 `list_dir` / `search_text` / `run_skill_script` 同口径 */
export const READ_SKILL_LIMIT_CHARS = 8_000;
/**
 * 前缀读字节上限。为什么要有上限、而不是读整份：正文输出本就截到 8000 字符，无需把整份大文件读进内存。
 * 为什么是「字节前缀 → 字符截断」两步、而不是只读 8KB：8KB 的多字节文本可能只解出约 2700 字符，
 * 会把「其实还很长」误报成「内容完整」（截断必须声明，误报即违约）。64KB 前缀对任意 UTF-8
 * 至少解出约 16000 字符，足以触发 8000 字符上限，判定不会失真。
 */
const READ_SKILL_MAX_BYTES = 65_536;
/** 技能说明书固定文件名 */
const SKILL_MD = 'SKILL.md';

export type ReadSkillResult =
  | {
      ok: true;
      text: string;
      truncated: boolean;
      /**
       * SKILL.md frontmatter 里 `allowed-tools` 的切分结果（已去空白、去空项）；
       * 读的是包内其它文件（无 frontmatter）、或 frontmatter 里没写该字段时为 undefined。
       * 仅作**能力声明**透出：本模块**不判断**这些能力是否存在（那是 harness 层的事）。
       */
      allowedTools?: string[];
    }
  | { ok: false; text: string };

/** 取文件前缀字节（≤ `maxBytes`）；文件更小时读到实际长度。读失败向上抛，由调用方转文案。 */
async function readFilePrefix(fullPath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.promises.open(fullPath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 把 `allowed-tools` 的原始标量切成名字数组：按逗号切、去空白、丢空项。
 * 容错剥掉可能的 YAML 方括号写法（`[Read, Bash]`）——有些技能会这么写。
 * 切不出任何名字时返回 undefined（**不返回空数组**，让调用方只需判 undefined）。
 */
function splitAllowedTools(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const stripped = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  const names = stripped
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return names.length > 0 ? names : undefined;
}

/**
 * 读取技能包内文本文件。
 * @param guards    注入的双门路径守卫（根 = skillsRoot）
 * @param skillsRoot 技能根目录绝对路径
 * @param skill      技能标识符（相对技能根，1~2 段；调用方已过 `isSafeSkillRef`）
 * @param relPath    相对技能目录的文件路径；省略 / 空白 → 读 SKILL.md 正文
 */
export async function readSkillFileContent(
  guards: WorkspacePathGuards,
  skillsRoot: string,
  skill: string,
  relPath: string | undefined,
): Promise<ReadSkillResult> {
  const useSkillMd = relPath === undefined || relPath.trim().length === 0;
  const relSegment = useSkillMd ? `${skill}/${SKILL_MD}` : `${skill}/${relPath}`;
  const shownPath = useSkillMd ? SKILL_MD : relPath;

  // 技能根存在性：必须在路径解析（守卫）之前自己判一次。
  // 守卫在根缺失/非目录时会回灌「工作区目录不存在…」，把技能根叫成了「工作区」，还让模型
  // 「先创建该目录」——而写工具全绑 workspaceRoot、技能根在工作区之外，模型根本做不到。
  // 文案口径与 tools-skill-run.ts 的技能根前置检查保持一致（本函数拿不到 workspaceRoot，
  // 故只保留「这不是工作区的问题」这半句，不塞具体工作区路径）。
  const skillsRootStat = await fs.promises.stat(skillsRoot).catch(() => null);
  if (!skillsRootStat) {
    return {
      ok: false,
      text:
        `技能根目录不存在：${skillsRoot}。注意：这**不是**工作区的问题` +
        `——技能根与工作区是两个不同的目录，本次失败与工作区无关。` +
        `应用正常启动时会自动创建它，当前缺失可能是被删除或权限不足。` +
        `本工具无法代为创建 —— 请告知用户手动创建该目录，不要重试、也不要凭猜测改路径。`,
    };
  }
  if (!skillsRootStat.isDirectory()) {
    return {
      ok: false,
      text:
        `技能根路径不是目录：${skillsRoot}（被一个同名文件占用了）。` +
        `请告知用户处理，不要重试、也不要凭猜测改路径。`,
    };
  }

  // 双门守卫（复用注入的守卫，不另造一套越界判断；守卫语义是「任意根 + 相对路径」）
  const resolved = guards.resolveInsideWorkspace(skillsRoot, relSegment);
  if (!resolved.ok) {
    return { ok: false, text: resolved.text };
  }
  const rootResolution = await guards.resolveWorkspaceRealRoot(skillsRoot);
  if (!rootResolution.ok) {
    return { ok: false, text: rootResolution.text };
  }
  const verified = await guards.verifyRealPath(rootResolution.realRoot, resolved.target);
  if (!verified.ok) {
    return { ok: false, text: verified.text };
  }

  // 技能目录是否存在：必须与「技能内文件不存在」分开报（二者混淆是最高频缺陷）
  const skillDir = path.join(skillsRoot, skill);
  const skillDirStat = await fs.promises.stat(skillDir).catch(() => null);
  if (!skillDirStat || !skillDirStat.isDirectory()) {
    return {
      ok: false,
      text:
        `技能不存在：${skill}（技能根目录：${skillsRoot}）。已确认不是文件读取失败` +
        `——是技能目录本身就不在。可用技能见系统消息里的「可用技能」清单；不在清单里的技能说明尚未安装。`,
    };
  }

  const fileStat = await fs.promises.stat(resolved.target).catch(() => null);
  if (!fileStat) {
    return {
      ok: false,
      text:
        `技能内文件不存在：${skill}/${shownPath}。技能本身是存在的（已确认不是「技能未安装」）` +
        `——请核对相对路径，或省略 path 先读 SKILL.md 看它引用了哪些文件。`,
    };
  }
  if (!fileStat.isFile()) {
    return {
      ok: false,
      text:
        `目标不是文件：${skill}/${shownPath}（它可能是一个目录）。技能本身是存在的` +
        `——请核对相对路径，或省略 path 先读 SKILL.md。`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await readFilePrefix(resolved.target, READ_SKILL_MAX_BYTES);
  } catch {
    return {
      ok: false,
      text: `读取失败：${skill}/${shownPath}（文件存在但无法读取，可能是权限问题或已被删除）。`,
    };
  }

  if (isProbablyBinary(buffer)) {
    return {
      ok: false,
      text:
        `不是文本文件：${skill}/${shownPath}（疑似二进制）。本工具只读文本；` +
        `如需运行它，请改用 run_skill_script。`,
    };
  }

  const raw = buffer.toString('utf8');
  // 只有 SKILL.md 带 frontmatter；读包内其它文件时既不去 frontmatter、也没有能力声明可透出。
  const frontmatter = useSkillMd ? parseFrontmatter(raw) : null;
  const content = frontmatter ? frontmatter.body : raw;
  const allowedTools = frontmatter ? splitAllowedTools(frontmatter.allowedTools) : undefined;
  if (content.length > READ_SKILL_LIMIT_CHARS) {
    // 截断不判失败（ok:true），但必须显式声明「内容不完整」+ 给出可行的下一步。
    return {
      ok: true,
      truncated: true,
      text:
        content.slice(0, READ_SKILL_LIMIT_CHARS) +
        `\n\n⚠ 内容超过 ${READ_SKILL_LIMIT_CHARS} 字符上限，已截断。**上面的内容不完整**。` +
        `提示：改用 path 读取更小的子文件（如 references/ 下的具体文件）。`,
      ...(allowedTools !== undefined ? { allowedTools } : {}),
    };
  }
  return {
    ok: true,
    text: content,
    truncated: false,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
  };
}
