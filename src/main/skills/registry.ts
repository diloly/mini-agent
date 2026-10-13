/**
 * 技能注册表：扫描技能根下的技能包，产出 `SkillMeta[]`（进程内缓存 + mtime 校验）。
 *
 * 扫描规则（设计 §2.3.1）——**两级**结构（支持物理嵌套套件）：
 * - 用 `fs.readdir(skillsRoot, { withFileTypes: true })` 取**一级**目录 `D`；
 * - 若 `D/SKILL.md` 是文件 ⇒ `D` 本身就是一个「根下技能」（一级技能）；
 * - 否则视 `D` 为**套件容器**，再看它的子目录 `S`：若 `S/SKILL.md` 是文件 ⇒ `D/S` 是「套件内技能」（二级技能）；
 * - **绝不** `recursive: true`（只有两层，无需递归）；符号链接目录跳过（防「软链指到系统目录」被当成技能包）；非目录条目忽略；
 * - 套件归属**路径优先 + 清单回退**：二级技能由目录路径推导（套件 = 一级目录名）；一级技能回退查技能根下的 `.suites.json` 清单。
 *
 * 本模块是**纯逻辑**：`skillsRoot` 由调用方**显式传参**（与 `content.ts` 一致），
 * 因此不 import `./paths`、不含宿主桌面框架依赖，可独立推理与测试。
 *
 * 🔴 **绝不抛异常**：任何失败都返回 `[]`；单个坏技能只跳过它自己，绝不拖垮整份清单。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSafeSkillDirName } from './names';
import { parseFrontmatter, readSkillMdHead } from './frontmatter';
import { readSuites } from './suites';

/** 单个 description 解析后的硬上限（防某技能写超长 description 撑爆内存 / 日志；清单还会再截到 80） */
const SKILL_DESC_MAX_CHARS = 1_024;
/** 扫描 / 列出的最多技能数；超出按目录名排序取前 N，保证结果确定（catalog 据此声明截断） */
export const SKILLS_MAX_COUNT = 50;

/** 一个已安装技能的内部形态（含路径，供工具层使用） */
export interface SkillMeta {
  /**
   * 技能标识符（相对技能根，1~2 段）：根下技能 = 目录名（`find-skills`），
   * 套件内技能 = `套件名/技能名`（`finance-data/westock-data`）。
   * 也是 read_skill / run_skill_script 的 skill 参数值。
   */
  dirName: string;
  /** frontmatter 里的展示名；缺失时等于 dirName */
  displayName: string;
  description: string;
  /** SKILL.md 绝对路径 */
  skillMdPath: string;
  /** 技能目录绝对路径 */
  dirPath: string;
  /** 是否含 scripts/ 目录 */
  hasScripts: boolean;
  /**
   * 所属套件名；未分组时为 undefined。
   * 二级技能由**目录路径**推导（= 一级目录名）；一级技能回退查 `.suites.json` 清单。
   */
  suite?: string;
}

interface SkillsCache {
  root: string;
  entries: SkillMeta[];
  dirMtime: Map<string, number>;
}

/**
 * 模块级缓存（单根）。⚠️ 这是本项目「ToolContext 逐层传参」纪律的**唯一例外**，理由：
 * 技能根是**设备级**的（`<userData>/skills`，与账号 / 会话无关），只读共享；
 * 不存在「两个会话并发生成互相覆盖」的问题（那正是该纪律要防的场景）。
 * 故可安全地放模块级，而不必挂到 ToolContext 上。
 */
let skillsCache: SkillsCache | null = null;

/** 清空缓存（导入 / 删除技能后调用，使变更立即生效，不必等 mtime 变化） */
export function invalidateSkillsCache(): void {
  skillsCache = null;
}

/** 扫描并返回全部技能（带缓存 + mtime 校验）。绝不抛异常，失败返回 []。 */
export async function listSkills(skillsRoot: string): Promise<SkillMeta[]> {
  try {
    return await scanSkills(skillsRoot);
  } catch {
    return [];
  }
}

/** 判断技能目录下是否有 scripts/ 子目录（纯展示提示） */
async function hasScriptsDir(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(path.join(dirPath, 'scripts'));
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function scanSkills(skillsRoot: string): Promise<SkillMeta[]> {
  const reusable = skillsCache !== null && skillsCache.root === skillsRoot ? skillsCache : null;
  const previousMtime = reusable?.dirMtime;
  const previousMeta = new Map<string, SkillMeta>();
  if (reusable !== null) {
    for (const entry of reusable.entries) {
      previousMeta.set(entry.dirName, entry);
    }
  }

  // 套件归属有两条来源（路径优先）：
  // - 二级技能（<套件>/<技能>）⇒ 套件 = 一级目录名（见下方情形 B），**不查清单**；
  // - 一级技能（技能根下）⇒ 回退查技能根下的清单（见下方情形 A）。
  //   清单里存的都是**裸目录名**，故只对一级技能有意义。
  // 清单坏了 / 没写 ⇒ 全都算未分组，绝不因此让整份清单失败。
  const suiteByDir = new Map<string, string>();
  for (const suite of await readSuites(skillsRoot)) {
    for (const dir of suite.dirs) {
      // 一个技能只属于一个套件：先到先得（recordImport 已保证不重复，这里只是防御）
      if (!suiteByDir.has(dir)) {
        suiteByDir.set(dir, suite.name);
      }
    }
  }

  const dirents = await fs.promises.readdir(skillsRoot, { withFileTypes: true });
  const entries: SkillMeta[] = [];
  const dirMtime = new Map<string, number>();

  /**
   * 收集一个技能目录：取 SKILL.md 的 mtime → 命中缓存则复用元数据 → 否则读 frontmatter 重建。
   * @param ref     相对技能根的**标识符**（一级 = 目录名；二级 = `套件/目录名`）。
   *                它同时是 `read_skill` / `run_skill_script` 的 skill 参数值，也是 `SkillMeta.dirName`。
   * @param dirPath 技能目录的绝对路径
   * @param suite   所属套件名；未分组时 undefined
   */
  const collect = async (
    ref: string,
    dirPath: string,
    suite: string | undefined,
  ): Promise<void> => {
    const skillMdPath = path.join(dirPath, 'SKILL.md');
    let mtimeMs: number;
    try {
      const mdStats = await fs.promises.stat(skillMdPath);
      if (!mdStats.isFile()) {
        return; // 同名目录 / 非常规文件 ⇒ 不算技能包
      }
      mtimeMs = mdStats.mtimeMs;
    } catch {
      return; // 没有 SKILL.md ⇒ 不是技能包（属正常情况，不记 warning）
    }

    dirMtime.set(ref, mtimeMs);

    // 缓存命中：目录存在且 SKILL.md mtime 未变 ⇒ 直接复用元数据，不重读磁盘。
    // 键是含 '/' 的完整 ref：技能从技能根迁进套件目录后 ref 变化 ⇒ 自然 miss ⇒ 重读。
    const cachedMeta = previousMeta.get(ref);
    if (cachedMeta !== undefined && previousMtime?.get(ref) === mtimeMs) {
      entries.push(cachedMeta);
      return;
    }

    const head = await readSkillMdHead(skillMdPath).catch(() => null);
    if (head === null) {
      console.warn(`[skills] 读取失败，已跳过：${skillMdPath}`);
      return;
    }
    const parsed = parseFrontmatter(head);
    const displayName = parsed.name !== undefined && parsed.name.length > 0 ? parsed.name : ref;
    const description = (parsed.description ?? '').slice(0, SKILL_DESC_MAX_CHARS);
    entries.push({
      dirName: ref,
      displayName,
      description,
      skillMdPath,
      dirPath,
      hasScripts: await hasScriptsDir(dirPath),
      ...(suite !== undefined ? { suite } : {}),
    });
  };

  for (const dirent of dirents) {
    // 只要一级目录；符号链接目录跳过（isDirectory 对软链本就为 false，这里显式写出意图）
    if (dirent.isSymbolicLink() || !dirent.isDirectory()) {
      continue;
    }
    const topName = dirent.name;
    if (!isSafeSkillDirName(topName)) {
      // 目录名无法被 skill 参数寻址，列出来只会误导模型 ⇒ 跳过并记 warning
      console.warn(`[skills] 跳过非法技能目录名：${topName}`);
      continue;
    }
    const topPath = path.join(skillsRoot, topName);

    // 情形 A：一级目录自己就有 SKILL.md ⇒ 它本身是一个技能。
    // 套件归属回退查清单（清单只存裸目录名）。命中后**不再往下看** —— 技能包内不会有子技能包。
    let topIsSkill = false;
    try {
      const topMd = await fs.promises.stat(path.join(topPath, 'SKILL.md'));
      topIsSkill = topMd.isFile();
    } catch {
      topIsSkill = false;
    }
    if (topIsSkill) {
      await collect(topName, topPath, suiteByDir.get(topName));
      continue;
    }

    // 情形 B：一级目录是「套件容器」—— 它自己没有 SKILL.md，看它的子目录。
    // 不做递归：套件只有一层（标识符最多两段，见 names.ts 的 SKILL_REF_PATTERN）。
    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(topPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.isSymbolicLink() || !child.isDirectory()) {
        continue;
      }
      const subName = child.name;
      if (!isSafeSkillDirName(subName)) {
        console.warn(`[skills] 跳过非法技能目录名：${topName}/${subName}`);
        continue;
      }
      // 二级技能的套件 = 一级目录名（路径优先，不查清单）
      await collect(`${topName}/${subName}`, path.join(topPath, subName), topName);
    }
  }

  // 排序键 = (套件名, 标识符) 元组：让同一套件的技能必然相邻、未分组集中在前。
  // 刻意不用单纯 localeCompare 比较含 '/' 的路径 —— 不同 ICU 实现对 '/' 的排序可能不一致，
  // 元组比较是完全确定的（清单顺序必须稳定）。
  entries.sort((a, b) => {
    const suiteA = a.suite ?? '';
    const suiteB = b.suite ?? '';
    if (suiteA !== suiteB) {
      return suiteA < suiteB ? -1 : 1;
    }
    return a.dirName.localeCompare(b.dirName);
  });
  if (entries.length > SKILLS_MAX_COUNT) {
    // 截断必须留痕：清单只列前 N 个；若无声丢弃，模型会以为技能总共就这么多，
    // 进而对第 N+1 个断言「不存在」（本项目最忌讳的「把不确定性讲成确定性」）。
    console.warn(
      `[skills] 技能数（${entries.length}）超过上限 ${SKILLS_MAX_COUNT}，` +
        `清单只列出前 ${SKILLS_MAX_COUNT} 个；其余技能不会被注入。`,
    );
  }
  const limited = entries.slice(0, SKILLS_MAX_COUNT);
  // ⚠️ 套件归属来自两处：**二级技能 = 一级目录名（路径）**、**一级技能 = 清单回退**。
  // 这两处 + 技能目录本身的变更（导入 / 迁移 / 删除）均由**写入方**（install.ts）负责调用
  // invalidateSkillsCache()；本函数内**不重复调用**（否则每读一次就清缓存）。
  skillsCache = { root: skillsRoot, entries: limited, dirMtime };
  return limited;
}
