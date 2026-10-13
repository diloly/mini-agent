/**
 * 技能套件清单（技能根下的 `.suites.json`）—— **只承载「技能根下一级技能」的套件归属**。
 *
 * 新模型（物理嵌套）下，套件归属有两条来源，**路径优先**：
 * - 二级技能（`<套件>/<技能>/SKILL.md`）⇒ 归属由**目录路径**表达，不查本清单；
 * - 一级技能（`<技能根>/<技能>/SKILL.md`）⇒ 回退查本清单（存量归属数据的兼容来源）。
 *
 * 因此本模块现在**只读、只清理**：`readSuites` 供 registry 回退匹配；`forgetSkill` 供
 * 删除/迁移技能后清理悬空条目。导入**不再写清单**（`recordImport` 已移除）。
 * 清单里存的一律是**裸目录名**（如 `westock-data`），只对一级技能有意义。
 *
 * 🔴 纯逻辑：skillsRoot 由调用方**显式传参**（与 registry.ts / install.ts / content.ts 同一纪律）。
 * 🔴 绝不抛异常：读失败一律当作「没有套件信息」（返回 []），写失败返回 false，
 *    绝不让导入 / 删除因为清单写不进去而失败。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 清单文件名（点开头 = 应用内部产物） */
export const SUITES_FILE = '.suites.json';

/** 一个套件：套件名 + 它包含的技能目录名 */
export interface SuiteEntry {
  name: string;
  dirs: string[];
}

/** 清单的磁盘格式 */
interface SuitesFile {
  version: 1;
  suites: SuiteEntry[];
}

/** 清单文件的绝对路径 */
export function suitesFilePath(skillsRoot: string): string {
  return path.join(skillsRoot, SUITES_FILE);
}

/** 是否可用作套件名：不校验字符集，只挡住明显的坏值 */
function isUsableSuiteName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 64 &&
    name !== '.' &&
    name !== '..' &&
    !name.startsWith('.')
  );
}

/** 读取套件清单。文件不存在 / 格式不符 / 任何异常 ⇒ 返回 []（当作全都未分组），绝不抛。 */
export async function readSuites(skillsRoot: string): Promise<SuiteEntry[]> {
  try {
    const raw = await fs.promises.readFile(suitesFilePath(skillsRoot), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return [];
    }
    const suites = (parsed as { suites?: unknown }).suites;
    if (!Array.isArray(suites)) {
      return [];
    }
    const result: SuiteEntry[] = [];
    // 逐条白名单式校验：坏条目跳过，而不是整份放弃（一条脏数据不该让其余套件全丢）
    for (const item of suites) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }
      const name = (item as { name?: unknown }).name;
      const dirs = (item as { dirs?: unknown }).dirs;
      if (!isUsableSuiteName(name) || !Array.isArray(dirs)) {
        continue;
      }
      const cleanDirs = Array.from(
        new Set(dirs.filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)),
      );
      if (cleanDirs.length === 0) {
        continue;
      }
      result.push({ name, dirs: cleanDirs });
    }
    return result;
  } catch {
    return [];
  }
}

/** 原子写入套件清单（临时文件 + rename）。失败返回 false，绝不抛。 */
export async function writeSuites(skillsRoot: string, suites: SuiteEntry[]): Promise<boolean> {
  const target = suitesFilePath(skillsRoot);
  const temp = `${target}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.promises.mkdir(skillsRoot, { recursive: true });
    const payload: SuitesFile = { version: 1, suites };
    await fs.promises.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.promises.rename(temp, target);
    return true;
  } catch {
    // 回滚：临时文件可能只写了一部分；删除失败也不掩盖原始错误
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    return false;
  }
}

/**
 * 删除技能后同步清理：把 dirName 从所有套件里摘掉，摘空的套件整条移除。
 * 内容无变化时直接返回 true，不写盘。
 */
export async function forgetSkill(skillsRoot: string, dirName: string): Promise<boolean> {
  try {
    if (dirName.length === 0) {
      return true;
    }
    const existing = await readSuites(skillsRoot);
    const next: SuiteEntry[] = [];
    let changed = false;
    for (const suite of existing) {
      if (!suite.dirs.includes(dirName)) {
        next.push(suite);
        continue;
      }
      changed = true;
      const kept = suite.dirs.filter((dir) => dir !== dirName);
      if (kept.length > 0) {
        next.push({ name: suite.name, dirs: kept });
      }
    }
    if (!changed) {
      return true; // 没有任何套件包含它 ⇒ 无变化，不写盘
    }
    // 写盘前再比一次内容：无变化就不落盘
    if (JSON.stringify(next) === JSON.stringify(existing)) {
      return true;
    }
    return await writeSuites(skillsRoot, next);
  } catch {
    return false;
  }
}
