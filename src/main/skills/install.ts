/**
 * 技能安装 / 删除：把用户选中的文件夹复制进技能根（未分组落根下、成套落 `套件/技能`），
 * 或删除技能根下 1~2 层的技能目录。
 *
 * 本模块是**纯逻辑**：`skillsRoot` 由调用方**显式传参**（与 `registry.ts` / `content.ts` 同一纪律），
 * 因此不含任何宿主桌面框架依赖，可独立推理与测试。
 *
 * 🔴 **绝不抛异常**：两个导出函数整体都 try/catch 兜底，任何失败都返回结构化结果，
 * 单个技能导入失败只记入 `skipped`，绝不拖垮整批。
 *
 * 复制护栏（手写递归复制，不用 `fs.cp`，以便逐条加护栏）：
 * - 跳过符号链接（防止复制出一个指向技能根外的链接）、跳过 `.git` / `node_modules` / `__pycache__`；
 * - 总字节 / 文件数双上限，超限抛内部错误 → 回滚；
 * - 目标同名已存在 → 拒绝，绝不覆盖；
 * - 先复制到技能根内的临时目录，成功后 `rename` 原子落位，失败即删临时目录，绝不留半成品。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillDeleteResult, SkillImportResult, SkillImportSkip } from '../../shared/skills';
import { isSafeSkillDirName, isSafeSkillRef } from './names';
import { parseFrontmatter, readSkillMdHead } from './frontmatter';
import { invalidateSkillsCache } from './registry';
import { forgetSkill } from './suites';

/** 单个技能包总字节上限 */
const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
/** 单个技能包文件数上限 */
const IMPORT_MAX_FILES = 1_000;
/** 复制时跳过的噪音目录名 */
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', '__pycache__']);
/** 技能包标识文件名 */
const SKILL_MD = 'SKILL.md';
/**
 * 发现技能包时向下遍历的最大层数。
 * 宿主插件缓存的实际布局是「容器/插件名/版本」或「容器/插件名/版本/skills/技能名」，
 * 最深 3 层；取 6 层留足余量，同时挡住误选盘符根之类的长遍历。
 */
const DISCOVER_MAX_DEPTH = 6;
/** 发现过程中最多访问的目录数（防误选盘符根 / 用户目录导致长时间遍历） */
const DISCOVER_MAX_DIRS = 2_000;
/** 单次导入最多识别的技能包数 */
const DISCOVER_MAX_PACKS = 100;

/**
 * 一个待导入目标。
 * 这里**只记源路径**：导入后落在技能根下的目录名由 `resolvePackName()` 另行解析
 * （优先取 frontmatter 的 `name`），不在此处预先定名 —— 否则会出现两个「目标名」的事实来源。
 */
interface ImportTarget {
  src: string;
  /** 相对所选目录的路径（`/` 分隔；所选目录自身记为 `.`），仅用于提示文案 */
  rel: string;
  /** 推导出的套件名；无法确定时 undefined（宁可不分组，也不瞎猜） */
  suite?: string;
}

/** 一次「多版本合并」决策：某目录下并存多个版本，只保留了其中最新的一个 */
interface VersionChoice {
  /** 发生并存的那个目录（相对所选目录的路径，'/' 分隔；所选目录自身记为 '.'） */
  parent: string;
  /** 被保留的最高版本目录名 */
  kept: string;
  /** 被跳过的较低版本目录名（升序） */
  skipped: string[];
}

/** 技能包发现结果；truncated=true 表示遍历因触顶提前结束，**不能**据此声称「没有更多技能包」 */
interface DiscoveryOutcome {
  targets: ImportTarget[];
  truncated: boolean;
  /** 因并存多版本而只保留最高版本的决策记录；空数组表示没遇到这种情况 */
  versionChoices: VersionChoice[];
}

/** 复制累计计数器（字节 / 文件数），用于双上限校验 */
interface CopyCounter {
  bytes: number;
  files: number;
}

/** 提取异常文案（统一成字符串，避免把非 Error 直接塞进界面） */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 目标条目是否已存在：用 lstat，连悬空符号链接也算「已存在」，避免误覆盖用户已有条目 */
function existsNoFollow(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** 目录根下是否有 `SKILL.md`，且它是**常规文件**（符号链接不算，避免复制时被跳过而产出残缺技能包） */
async function isSkillPack(dir: string): Promise<boolean> {
  try {
    const stats = await fs.promises.lstat(path.join(dir, SKILL_MD));
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * 目录是否「**看起来**是技能包」——用 `stat`（**跟随符号链接**），与 `registry.ts` 的判定口径一致。
 *
 * 为什么必须与 `isSkillPack` 分开：两者回答的是**不同问题**。
 * - `isSkillPack`（`lstat`，不跟随）：问「能不能安全复制」，软链 `SKILL.md` 复制时会被跳过、
 *   产出残缺包 ⇒ 一律不算。只用于导入发现（`discoverTargets.walk`）。
 * - 本函数（`stat`，跟随）：问「这个目录在 registry 眼里是不是一个技能包」，用于
 *   「容器 / 技能包」判定。判错的代价是技能从列表里消失或删不掉，所以必须跟 registry 同口径。
 */
async function looksLikeSkillPack(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(path.join(dir, SKILL_MD))).isFile();
  } catch {
    return false;
  }
}

/** 相对所选目录的可读路径（统一用 `/` 分隔；所选目录自身记为 `.`） */
function relativeLabel(source: string, dir: string): string {
  const rel = path.relative(source, dir);
  return rel.length > 0 ? rel.split(path.sep).join('/') : '.';
}

/**
 * 版本目录名：形如 `1`、`1.5`、`1.5.0`、`v2.0.1`。
 * 宿主插件缓存的布局是 `插件名/<版本>/...`，且**同一插件会并存多个版本**，
 * 因此需要识别它们并只保留最高版本（见 `discoverTargets` 里的合并逻辑）。
 */
const VERSION_DIR_PATTERN = /^v?\d+(\.\d+)*$/;

/** 该目录名是否形如版本号 */
function isVersionDirName(name: string): boolean {
  return VERSION_DIR_PATTERN.test(name);
}

/**
 * 比较两个版本目录名的大小（按 `.` 分段、逐段数值比较，短者缺位补 0）。
 * 返回 > 0 表示 a 更新。仅用于「谁是最高版本」的排序，不追求完整 semver 语义。
 */
function compareVersionNames(a: string, b: string): number {
  const strip = (name: string): string =>
    name.startsWith('v') || name.startsWith('V') ? name.slice(1) : name;
  const pa = strip(a).split('.').map((part) => Number.parseInt(part, 10));
  const pb = strip(b).split('.').map((part) => Number.parseInt(part, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) {
      return va - vb;
    }
  }
  return 0;
}

/**
 * 推导「套件名」：宿主套件把多个技能放在 `插件/<版本>/skills/<技能名>/SKILL.md` 下，
 * 这些技能天然属于同一个套件（如 `finance-data`）。
 *
 * 规则（**保守**：取不到就不分组，绝不瞎猜）：
 * 1. 技能包的父目录必须叫 `skills`（这是套件布局的固定一层；其它布局一律不分组）；
 * 2. 若 `skills` 的父目录名形如版本号（`1.7.0`），再往上取一层 ⇒ `finance-data`；
 * 3. 同一个 `skills` 目录下必须发现 **≥2 个**技能包 —— 只有一个技能时聚成套件
 *    只是白白多一次点击，反而更差；
 * 4. 推导出的名字为空 / 是 `.`、`..` / 以点开头 ⇒ 该组不分组。
 *
 * 纯字符串运算（`path.dirname` / `basename`），不读盘 —— 所选目录之上不存在的层级也能取到名字。
 */
function deriveSuiteNames(targets: ImportTarget[]): void {
  // 按技能包的父目录分组；只收「父目录叫 skills」的布局
  const groups = new Map<string, ImportTarget[]>();
  for (const target of targets) {
    const parent = path.dirname(target.src);
    if (path.basename(parent) !== 'skills') {
      continue;
    }
    const list = groups.get(parent);
    if (list === undefined) {
      groups.set(parent, [target]);
    } else {
      list.push(target);
    }
  }

  for (const [skillsDir, members] of groups) {
    // 只有一个技能包时不聚成套件：白白多一次点击，反而更差
    if (members.length < 2) {
      continue;
    }
    let owner = path.dirname(skillsDir);
    if (isVersionDirName(path.basename(owner))) {
      owner = path.dirname(owner);
    }
    const suiteName = path.basename(owner);
    // 🔴 套件名会成为落点的**目录名**，必须先过与「单段目录名」同一套安全校验。
    //    否则推出「finance data」这类含非法字符的名字时，目录会被建出来、
    //    但 registry 会因名字非法而拒收 ⇒ 技能导入「成功」却在列表里消失。
    if (!isSafeSkillDirName(suiteName)) {
      continue;
    }
    for (const target of members) {
      target.suite = suiteName;
    }
  }
}

/**
 * 发现待导入的技能包：向下遍历，把「根目录下直接有 SKILL.md」的目录各算一个技能包。
 *
 * 为什么必须递归：真实的技能分发目录**深度不一致**。宿主插件缓存里既有
 * `插件名/版本/SKILL.md`（深 2 层），也有 `插件名/版本/skills/技能名/SKILL.md`（深 4 层）。
 * 只查一级子目录会让「选中整个插件目录」必然报「没有找到 SKILL.md」。
 *
 * 两条边界：
 * - **命中即停**：某目录自己就是技能包时不再往下走 —— 包内部的 scripts / references / assets
 *   是它的资源，不是独立技能（这也是 Agent Skills 规范的定义）。
 * - **不跟随符号链接**，并跳过点开头目录与 SKIP_DIR_NAMES 里的噪音目录。
 *
 * 🔴 触顶（层数 / 目录数 / 包数）时把 `truncated` 置真 —— 调用方**必须**据此显式告诉用户
 * 「查找没查完」，绝不能把截断讲成「没有更多技能包」。
 */
async function discoverTargets(source: string): Promise<DiscoveryOutcome> {
  const targets: ImportTarget[] = [];
  let visitedDirs = 0;
  let truncated = false;
  const versionChoices: VersionChoice[] = [];

  /** 能否继续向下：任一上限触顶都记为「遍历被截断」 */
  function canDescend(nextDepth: number): boolean {
    if (
      targets.length >= DISCOVER_MAX_PACKS ||
      visitedDirs >= DISCOVER_MAX_DIRS ||
      nextDepth > DISCOVER_MAX_DEPTH
    ) {
      truncated = true;
      return false;
    }
    return true;
  }

  async function walk(dir: string, depth: number): Promise<void> {
    visitedDirs += 1;
    if (await isSkillPack(dir)) {
      targets.push({ src: dir, rel: relativeLabel(source, dir) });
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // 不可读的目录直接当空目录处理：单个目录读不了不该拖垮整批导入
      return;
    }
    // 排序：让「重名时保留谁」与最终的提示文案每次运行都可复现
    const childDirs = dirents
      .filter((dirent) => dirent.isDirectory() && !dirent.isSymbolicLink())
      .map((dirent) => dirent.name)
      .filter((name) => !name.startsWith('.') && !SKIP_DIR_NAMES.has(name))
      .sort();
    // 同一插件并存多个版本目录时，只走最高版本那一支：否则各版本 `skills/` 下的同名
    // 技能会互相撞名，而按目录名字典序「先到先得」会导入**最旧**的版本
    // （实测 `finance-data` 下并存 1.5.0 / 1.6.0 / 1.7.0）。非版本目录照常下探。
    const versionDirs = childDirs.filter(isVersionDirName);
    let descend = childDirs;
    if (versionDirs.length >= 2) {
      const kept = versionDirs.reduce((best, cur) =>
        compareVersionNames(cur, best) > 0 ? cur : best,
      );
      descend = childDirs.filter((name) => !isVersionDirName(name) || name === kept);
      versionChoices.push({
        parent: relativeLabel(source, dir),
        kept,
        skipped: versionDirs.filter((name) => name !== kept).sort(compareVersionNames),
      });
    }

    for (const name of descend) {
      if (!canDescend(depth + 1)) {
        return;
      }
      await walk(path.join(dir, name), depth + 1);
      if (truncated) {
        return;
      }
    }
  }

  await walk(source, 0);
  deriveSuiteNames(targets);
  return { targets, truncated, versionChoices };
}

/**
 * 决定导入后落在技能根下的目录名：优先用 SKILL.md frontmatter 的 `name`。
 *
 * 为什么不能只用目录 basename：宿主插件缓存的常见布局是 `插件名/版本/SKILL.md`，
 * 此时 basename 会是一个版本号（如 `1.3.0`），当技能名会让人和模型都读不懂它是什么。
 * `name` 是技能的正式标识，符合 Agent Skills 规范。
 *
 * 绝不因命名失败而让导入失败：读不到 / `name` 缺失 / `name` 不合法，一律退回 basename。
 * 注意本函数只决定**技能目录叫什么**（单段 basename），不含套件前缀 ——
 * 套件前缀由调用方按 `套件名/技能名` 拼接，与 `run_skill_script` 的寻址语义不冲突。
 */
async function resolvePackName(dir: string): Promise<string> {
  const fallback = path.basename(dir);
  try {
    const raw = await readSkillMdHead(path.join(dir, SKILL_MD));
    const name = parseFrontmatter(raw).name?.trim();
    if (name !== undefined && name.length > 0 && isSafeSkillDirName(name)) {
      return name;
    }
  } catch {
    // 读不到就退回 basename
  }
  return fallback;
}

/** 递归复制目录内容；累计字节 / 文件数，超上限即抛错中止（外层负责回滚） */
async function copyDirRecursive(
  src: string,
  dest: string,
  counter: CopyCounter,
): Promise<void> {
  const dirents = await fs.promises.readdir(src, { withFileTypes: true });
  for (const dirent of dirents) {
    const srcPath = path.join(src, dirent.name);
    const destPath = path.join(dest, dirent.name);
    // 符号链接一律跳过：复制出的链接可能指向技能根外（复制后即逃逸护栏）
    if (dirent.isSymbolicLink()) {
      console.warn(`[skills] 跳过符号链接：${srcPath}`);
      continue;
    }
    if (SKIP_DIR_NAMES.has(dirent.name)) {
      continue;
    }
    if (dirent.isDirectory()) {
      // 点开头的目录一律不复制：本仓约定「点开头 = 应用内部产物」（见 names.ts 的同名规则），
      // 技能的正式内容不应放在里面；同时避开宿主插件缓存里的 `.in_use/<pid>`、`.codebuddy-plugin`
      // 这类运行期目录 —— `.in_use` 下是被其它进程持有的标记文件，复制它可能直接失败。
      // 只过滤目录、不过滤文件：`.gitignore` 这类点开头**文件**仍是技能内容的一部分。
      if (dirent.name.startsWith('.')) {
        console.warn(`[skills] 跳过点开头目录：${srcPath}`);
        continue;
      }
      await fs.promises.mkdir(destPath, { recursive: true });
      await copyDirRecursive(srcPath, destPath, counter);
      continue;
    }
    if (dirent.isFile()) {
      const stats = await fs.promises.stat(srcPath);
      counter.bytes += stats.size;
      counter.files += 1;
      if (counter.bytes > IMPORT_MAX_BYTES) {
        throw new Error('技能包过大，已超过 10 MB 上限，未导入。');
      }
      if (counter.files > IMPORT_MAX_FILES) {
        throw new Error('技能包文件数过多，已超过 1000 个上限，未导入。');
      }
      await fs.promises.copyFile(srcPath, destPath);
      continue;
    }
    // 其余类型（FIFO / socket / 设备等）：跳过，不予复制
  }
}

/**
 * 把源技能目录原子地复制进技能根下的 `<relId>`（`relId` 可含一个 `/`，父目录不存在时创建）：
 * 先复制到临时目录，再 rename 到目标。任何失败都回滚临时目录与本次新建的父目录，
 * 绝不留半成品；错误原样抛给调用方（由它记为 skipped）。
 */
async function copySkillTree(src: string, root: string, relId: string): Promise<void> {
  // ⚠️ 临时目录**必须钉在技能根下**，绝不能建到 `<root>/<套件>/` 里：
  //    `cleanupStaleImports` 只扫技能根**一级**的 `.importing-*`，藏进子目录的残留永远清不掉。
  const temp = path.join(
    root,
    `.importing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const dest = path.join(root, relId);
  const destParent = path.dirname(dest);
  let createdParent = false;
  try {
    await fs.promises.mkdir(temp, { recursive: true });
    const counter: CopyCounter = { bytes: 0, files: 0 };
    await copyDirRecursive(src, temp, counter);
    // 落点的父目录（套件目录）此刻才建。已存在则必须是**真目录**：
    // 被符号链接或同名文件占着时 rename 会落到意料之外的位置 ⇒ 直接拒绝。
    const parentStat = await fs.promises.lstat(destParent).catch(() => null);
    if (parentStat !== null) {
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw new Error(`落点父目录被非目录或符号链接占用：${destParent}`);
      }
      // 🔴 落点父目录必须是**容器**（自己不带 SKILL.md）。若它其实是一个同名的一级技能包，
      //    新技能会被塞进技能包内部；而 registry 见到父目录带 SKILL.md 就把它当一级技能、
      //    不再往下看 ⇒ 新技能会直接「消失」。裸名落点时 destParent === root，故只在嵌套时检查。
      if (relId.includes('/') && (await looksLikeSkillPack(destParent))) {
        throw new Error(
          `套件名与技能根下一个技能同名（${path.basename(destParent)}），无法在它下面存放技能`,
        );
      }
    } else {
      await fs.promises.mkdir(destParent, { recursive: true });
      createdParent = true;
    }
    // 原子落位：同盘 rename 是原子操作，避免出现「半成品目标目录」被 registry 扫到
    await fs.promises.rename(temp, dest);
  } catch (error) {
    // 回滚：临时目录可能只写了一部分，整目录删掉；删除失败也不掩盖原始错误
    await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    // 仅当父目录是本次新建的才回收（rmdir 只删空目录，非空必失败 ⇒ 绝不误删兄弟技能）
    if (createdParent) {
      await fs.promises.rmdir(destParent).catch(() => undefined);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * 把技能根下的一个同名技能**原子地迁入套件目录**：`<root>/<name>` → `<root>/<suite>/<name>`。
 *
 * 为什么用 `rename` 而不是「复制 + 删源」：源与目标同在技能根之下（同盘），`rename` 是
 * 内核原子操作 —— 只有「全成 / 全不动」两种结局，绝不产生半个技能，比「先复制后删」更彻底；
 * 且不读字节，天然不受导入的 10MB / 1000 文件上限约束。
 * 失败时源保持原位（rename 不成功则两边都不变），调用方按 skipped 记录即可。
 */
async function migrateSkillIntoSuite(root: string, name: string, suite: string): Promise<void> {
  const source = path.join(root, name);
  const sourceStat = await fs.promises.lstat(source).catch(() => null);
  if (sourceStat === null || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`技能根下的同名项不是可迁移的目录：${name}`);
  }
  // 🔴 源必须是**技能包**（自己带 SKILL.md）。否则若同名项其实是某个套件容器目录，
  //    迁移会把整个容器塞进套件里形成三层嵌套 —— registry 只扫两层，容器下的技能会集体消失。
  if (!(await looksLikeSkillPack(source))) {
    throw new Error(`技能根下的同名项不是一个技能包（缺 ${SKILL_MD}）：${name}`);
  }
  const suiteDir = path.join(root, suite);
  const suiteStat = await fs.promises.lstat(suiteDir).catch(() => null);
  let createdSuite = false;
  if (suiteStat !== null) {
    if (suiteStat.isSymbolicLink() || !suiteStat.isDirectory()) {
      throw new Error(`套件目录被非目录或符号链接占用：${suite}`);
    }
    // 🔴 同上：套件目录必须是**容器**（自己不带 SKILL.md），不能是一个同名的一级技能包，
    //    否则被迁进去的技能会「消失」（registry 见父目录带 SKILL.md 就当一级技能、不再下探）。
    if (await looksLikeSkillPack(suiteDir)) {
      throw new Error(`套件名与技能根下一个技能同名（${suite}），无法在它下面存放技能`);
    }
  } else {
    await fs.promises.mkdir(suiteDir, { recursive: false });
    createdSuite = true;
  }
  try {
    await fs.promises.rename(source, path.join(suiteDir, name));
  } catch (error) {
    // 迁移失败：源完好无损；回收本次新建的空套件目录（rmdir 只删空，非空必失败 ⇒ 安全）
    if (createdSuite) {
      await fs.promises.rmdir(suiteDir).catch(() => undefined);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** 从用户选中的文件夹导入技能（单包或任意深度的容器）。绝不抛异常。 */
export async function importSkillsFrom(
  skillsRoot: string,
  sourceDir: string,
): Promise<SkillImportResult> {
  const imported: string[] = [];
  const skipped: SkillImportSkip[] = [];
  try {
    const root = path.resolve(skillsRoot);
    const source = path.resolve(sourceDir);

    const { targets, truncated, versionChoices } = await discoverTargets(source);
    if (targets.length === 0) {
      // 并存多版本时，只搜了最高版本 —— 若因此没找到，必须说清楚并给出下一步
      const versionHint =
        versionChoices.length > 0
          ? `（注意：该目录下并存多个版本，已只查找最高版本 ${versionChoices
              .map((choice) => choice.kept)
              .join('、')}；若这是误判，请直接选中某个版本目录再导入。）`
          : '';
      return {
        ok: false,
        canceled: false,
        imported,
        skipped,
        // 🔴 遍历触顶而止时**绝不能**说「没有技能包」——只能说「没查完」，并给出下一步
        error: truncated
          ? `未能确认所选文件夹里有没有技能包：向下查找达到上限（最多 ${DISCOVER_MAX_DEPTH} 层 / ${DISCOVER_MAX_DIRS} 个目录）后提前结束。请改选更靠近技能包的那一层目录再试。${versionHint}`
          : `所选文件夹里没有找到 ${SKILL_MD}（已向下查找 ${DISCOVER_MAX_DEPTH} 层；技能包根目录下必须有一个 ${SKILL_MD}）。${versionHint}`,
      };
    }

    /** 本次已「落定」的标识符（复制或迁移）：用于识别容器里同名技能包，显式报出来而不是静默只导一个 */
    const planned = new Set<string>();
    /** 由技能根**迁入**套件目录的标识符（不是新安装，回显与 note 都要说明） */
    const migrated: string[] = [];
    for (const target of targets) {
      const name = await resolvePackName(target.src);
      if (!isSafeSkillDirName(name)) {
        skipped.push({
          name,
          reason: `技能名不合法：「${name}」（只能包含字母、数字、点、下划线、连字符，且必须以字母或数字开头）`,
        });
        continue;
      }
      const suite = target.suite;
      // 落点标识符：推得出套件名就落 `<套件>/<技能>`，否则落技能根下（未分组）
      const relId = suite !== undefined ? `${suite}/${name}` : name;
      if (planned.has(relId)) {
        skipped.push({
          name: relId,
          reason: `与本次已导入的技能重名（来源：${target.rel}），本次跳过；如需另一个版本，请单独选中它再导入。`,
        });
        continue;
      }
      if (existsNoFollow(path.join(root, relId))) {
        skipped.push({
          name: relId,
          reason: `技能「${relId}」已存在，未覆盖。请先删除旧技能再导入。`,
        });
        continue;
      }
      // 🔴 同名则迁移：套件内同名、且技能根下已有一个同名技能时，**不重复安装**，
      //    而是把根下那只原子地迁进套件目录。迁移与复制是**互斥分支**，
      //    故不存在「迁移成功但导入失败」的半截状态。
      if (suite !== undefined && existsNoFollow(path.join(root, name))) {
        try {
          await migrateSkillIntoSuite(root, name, suite);
          // 清单里那条裸名记录已成悬空引用：技能已迁入二级，若不清掉，将来同名一级技能
          // 落回技能根下会被错误归组。清理失败只记 warning —— 技能本身已经就位。
          const cleaned = await forgetSkill(root, name);
          if (!cleaned) {
            console.warn(`[skills] 迁移技能后清理套件清单失败：${name}`);
          }
          planned.add(relId);
          imported.push(relId);
          migrated.push(relId);
        } catch (error) {
          skipped.push({
            name: relId,
            reason:
              `技能根下已存在同名技能「${name}」，但把它迁入套件目录失败：${errorMessage(error)}` +
              `（技能根下那份保持原位，本次未安装新副本）。`,
          });
        }
        continue;
      }
      try {
        await copySkillTree(target.src, root, relId);
        planned.add(relId);
        imported.push(relId);
      } catch (error) {
        skipped.push({ name: relId, reason: `复制失败：${errorMessage(error)}` });
      }
    }

    // 🔴 缓存失效必须放在**所有写盘之后**（含 copySkillTree 的 rename、迁移的 rename、
    // 以及 forgetSkill 写清单）：先失效、后写盘会留下一个窗口 ——
    // 期间若有 listSkills（如聊天轮次构建 system 提示）会以**中间态**把元数据写进缓存，
    // 而技能 SKILL.md 的 mtime 此后不会再变 ⇒ 缓存被一直复用，落点/归属长期显示错误。
    if (imported.length > 0) {
      invalidateSkillsCache();
    }
    // 两种「结论有前提」都要显式说出来，绝不静默
    const notes: string[] = [];
    if (truncated) {
      notes.push(
        `注意：查找在达到上限后提前结束，结果可能不完整 —— 还有未遍历到的技能包。请改选更靠近技能包的目录重新导入。`,
      );
    }
    for (const choice of versionChoices) {
      const where = choice.parent === '.' ? '所选目录' : choice.parent;
      notes.push(
        `注意：${where}下并存多个版本（${[...choice.skipped, choice.kept].join(
          '、',
        )}），已只导入最高版本 ${choice.kept} 的技能（其余版本未导入）。`,
      );
    }
    if (migrated.length > 0) {
      notes.push(
        `注意：其中 ${migrated.length} 个技能（${migrated.join('、')}）在技能根下已有同名技能，` +
          `已把它们**迁入**套件目录（**保留原有内容**，本次导入的副本未落盘）。` +
          `若要换成本次导入的版本，请先在技能页删除它，再重新导入。`,
      );
    }
    return {
      ok: imported.length > 0,
      canceled: false,
      imported,
      skipped,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    };
  } catch (error) {
    return { ok: false, canceled: false, imported, skipped, error: errorMessage(error) };
  }
}

/** 删除一个技能目录（技能根下 1~2 层：根下技能或 `套件/技能`）。confirm 为真才执行。绝不抛异常。 */
export async function deleteSkill(
  skillsRoot: string,
  dirName: string,
  confirm: boolean,
): Promise<SkillDeleteResult> {
  try {
    if (confirm !== true) {
      return { ok: false, error: '未确认，已取消删除' };
    }
    if (!isSafeSkillRef(dirName)) {
      return { ok: false, error: `技能标识符不合法：${dirName}` };
    }
    const root = path.resolve(skillsRoot);
    const target = path.resolve(root, dirName);
    // 防目录穿越：目标必须恰好是技能根下的 1~2 层。
    //（`isSafeSkillRef` 已挡住 `..` 与反斜杠；这里按解析后的相对路径再核对段数，作纵深防御）
    const relSegments = path.relative(root, target).split(path.sep);
    if (
      path.relative(root, target).startsWith('..') ||
      path.isAbsolute(path.relative(root, target)) ||
      relSegments.length < 1 ||
      relSegments.length > 2
    ) {
      return { ok: false, error: '拒绝：目标不在技能根目录内' };
    }
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(target);
    } catch {
      return { ok: false, error: `技能不存在：${dirName}` };
    }
    // 符号链接先于「是否目录」判断：lstat 下链接不是目录，需给它专属文案
    if (stats.isSymbolicLink()) {
      return { ok: false, error: `拒绝删除符号链接：${dirName}` };
    }
    if (!stats.isDirectory()) {
      return { ok: false, error: `目标不是技能目录：${dirName}` };
    }
    // 🔴 目标必须是**技能包**（自己带 SKILL.md）：技能根下不带 SKILL.md 的目录是套件容器，
    //    对它递归删除会连带删掉容器内的所有技能。registry 从不列出容器，正常路径走不到这里，
    //    这道校验纯属纵深防御。
    if (!(await looksLikeSkillPack(target))) {
      return {
        ok: false,
        error: `目标目录里没有 SKILL.md，不是技能包：${dirName} —— 拒绝递归删除，以免连带删掉其中的技能；如需处理请到技能目录里手动操作。`,
      };
    }
    try {
      await fs.promises.rm(target, { recursive: true, force: false });
    } catch (error) {
      return { ok: false, error: `删除失败：${errorMessage(error)}` };
    }
    // 二级技能：套件目录被删空就顺手回收。**必须用 rmdir**（只删空目录，非空必失败）——
    // 绝不能用递归删除，那会连兄弟技能一起删掉。删不掉也无害：registry 忽略没有 SKILL.md 的目录。
    if (relSegments.length === 2) {
      await fs.promises.rmdir(path.join(root, relSegments[0])).catch(() => undefined);
    }
    // 同步清理套件归属；清单写不进去不影响「技能已删除」这个事实，但要留痕
    const cleaned = await forgetSkill(root, dirName);
    if (!cleaned) {
      console.warn(`[skills] 删除技能后清理套件清单失败：${dirName}`);
    }
    // 🔴 缓存失效必须放在**所有写盘之后**（含 forgetSkill 写清单）——
    //    顺序与 importSkillsFrom 保持一致，避免「先失效、后写盘」留下中间态窗口。
    invalidateSkillsCache();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `删除失败：${errorMessage(error)}` };
  }
}

/**
 * 清理技能根下残留的导入临时目录（`.importing-*`）。
 *
 * 为什么需要：导入是「先复制到临时目录，再 rename 落位」。正常路径下临时目录要么已
 * rename 成技能、要么已被回滚删除；但**复制途中应用被强杀**时回滚根本不会执行，
 * 临时目录会永久残留。启动时扫一遍清掉，避免垃圾堆积。
 * （残留目录已不可能被当成技能 —— 见 `names.ts` 的「必须以字母/数字开头」规则。）
 *
 * 绝不抛异常：任何失败只记 warning，绝不影响启动。
 */
export async function cleanupStaleImports(skillsRoot: string): Promise<void> {
  try {
    const root = path.resolve(skillsRoot);
    const dirents = await fs.promises.readdir(root, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !dirent.name.startsWith('.importing-')) {
        continue;
      }
      const stale = path.join(root, dirent.name);
      try {
        await fs.promises.rm(stale, { recursive: true, force: true });
        console.warn(`[skills] 已清理残留的导入临时目录：${stale}`);
      } catch (error) {
        console.warn(`[skills] 清理残留临时目录失败（忽略）：${stale} —— ${errorMessage(error)}`);
      }
    }
  } catch {
    // 技能根不存在 / 不可读：启动期无需打扰
  }
}
