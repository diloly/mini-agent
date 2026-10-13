/**
 * 技能命名的唯一事实来源：目录名正则 + 安全校验。
 *
 * `registry` / `frontmatter` 与 `harness/tools-skill-run.ts` 的 `run_skill_script` **都从这里 import**，
 * 避免正则在多处漂移（设计 §10 第 2 条：全仓只有一处定义）。
 * 本模块是纯逻辑，不含宿主桌面框架依赖，可在任意环境加载。
 */

/**
 * 技能目录名 / 技能名允许的字符集。
 * 🔴 必须**以字母或数字开头**：点开头的一律不是技能，而是应用内部产物
 * （如导入时的临时目录 `.importing-<rand>`，见 `install.ts`）。若放行点开头，
 * 临时目录一旦残留就会被 `registry` 当成正常技能注入给模型。
 */
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 是否为安全的一级技能目录名：匹配正则即可——新正则要求首字符为字母 / 数字，
 * 故 "." 与 ".." 天然不匹配。这里仍显式排除一次作双保险（路径段被拿去做「上一级」
 * 的代价太大，宁可重复一次判断）。
 */
export function isSafeSkillDirName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name) && name !== '.' && name !== '..';
}

/**
 * 技能**标识符**：相对技能根目录的路径，**1~2 段**。
 * - 一级 = 技能根下的技能（未分组），如 `find-skills`；
 * - 二级 = 套件目录下的技能，如 `finance-data/westock-data`。
 *
 * 🔴 `read_skill` / `run_skill_script` 的 `skill` 参数与 `deleteSkill` 的 `dirName`
 *    必须用本正则校验（**不能**再用 `SKILL_NAME_PATTERN`）—— 它们现在允许含一个 `/`。
 *    本正则一次性封死六种危险形态：
 *    ① 段数 > 2（`a/b/c`）；② 空段（`a//b`）；③ `.` / `..` 段（`a/../b`）；
 *    ④ 绝对路径（`/abs`）；⑤ **反斜杠**（`a\b`）—— Windows 上 `path.join` 会把 `\` 当分隔符，
 *    不排除它等于给路径穿越留口子；⑥ 点开头的段（点开头是应用内部产物的约定）。
 *    另外 `isSafeSkillRef` 再兜一次 `\0`。
 */
export const SKILL_REF_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

/** 是否为安全的技能标识符（相对技能根的路径，1~2 段）。语义见 `SKILL_REF_PATTERN`。 */
export function isSafeSkillRef(ref: string): boolean {
  return SKILL_REF_PATTERN.test(ref) && !ref.includes('\0');
}

/**
 * `run_skill_script` 的 `script` 的「技能根」前缀。以它开头的 script **不相对技能目录**，
 * 而是相对**技能根**解析（如 `@/.bin/westock.exe`）。
 *
 * 用途：技能根下的 `.bin` 目录存放**跨技能共用**的可执行文件（多个技能共用同一个 CLI 时放这里）。
 *
 * 为什么需要它：若只允许写相对技能目录的退层路径（如 `../../.bin/x`），正确的「退几层」
 * 会**随技能的嵌套深度变化**（根下技能退 1 层、套件内技能退 2 层），模型极易算错；
 * 而算错的后果是「脚本不存在」这种无从自纠的报错。本前缀与技能位置无关，一次讲清就不会错。
 *
 * 🔴 它**不放松任何安全边界**：拼接结果仍交给同一套双门守卫、根仍是 skillsRoot，
 *    既逃不出技能根，也仍然拒绝技能根之外的任何路径。
 */
export const SKILL_ROOT_PREFIX = '@/';

/**
 * 技能根下存放**跨技能共用程序**的目录名（相对技能根）。
 * 点开头 = 应用内部产物 ⇒ `isSkillPack` 要求目录内有 `SKILL.md`，它没有 ⇒ 天然不进技能清单。
 */
export const SHARED_BIN_DIR = '.bin';
