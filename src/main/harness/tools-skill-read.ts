/**
 * 技能说明书读取工具：`read_skill`。
 *
 * 设计来源：docs/SKILL-LOADING-DESIGN.md（§2.5 / §4.9 / §4.10 / §6.3 / §7）。
 *
 * 本模块**不依赖宿主桌面框架**（grep 宿主框架名应为 0 命中）：
 * - 路径安全**不另造一套**，复用 tools.ts 经工厂注入的双门守卫（`guards.*`）；守卫的「根」是
 *   skillsRoot（不是 workspaceRoot）——守卫语义是「任意根 + 相对路径」，直接复用；
 * - 读取逻辑（去 frontmatter / 二进制嗅探 / 8000 截断）全在 `skills/content.ts`；
 * - 故本模块**不反向 import `tools.ts`**，与工具集合之间无 import 环。
 *
 * 🔴 失败语义必须分类（本项目最高频缺陷）：「技能不存在」「技能内文件不存在」「非文本」「截断」「越界」
 *    五类首句两两不同、互不混淆；**截断不判失败**。文案由 `content.ts` 统一产出。
 */
import type { ToolDefinition } from '../providers/types';
import type { WorkspacePathGuards } from './tools-search';
import type { HarnessTool, ToolContext, ToolResult } from './types';
import { isSafeSkillRef, SHARED_BIN_DIR, SKILL_ROOT_PREFIX } from '../skills/names';
import { readSkillFileContent, READ_SKILL_LIMIT_CHARS } from '../skills/content';
// 支持类型列表的**单一事实来源**（无 electron 的纯逻辑模块）：不在此另写一份副本，避免两处漂移。
import { SUPPORTED_EXTENSIONS } from '../skill-runtime/interpreter';
// 平台相关的路径拼接（安装目录示例用）：不手写分隔符，避免 Windows / POSIX 两处漂移。
import * as path from 'node:path';

/** read_skill 入参 */
interface ReadSkillArgs {
  skill?: unknown;
  path?: unknown;
}

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

/**
 * 本应用**不具备**的宿主能力名（比较前统一转小写）。
 *
 * 背景（2026-10-13 实测）：技能包的 SKILL.md 会在 frontmatter 里用 `allowed-tools` 声明它要用到
 * 哪些宿主工具（Agent Skills 生态的通用字段，常见值如 `Read,Bash`）。但技能是在**别的宿主**
 * （有 shell、有联网的宿主）里写的，声明的能力本应用未必有；不点明的话，模型读完文档就会
 * 直接去调那些并不存在的工具（实测把文档里的命令 `westock quote sh600519` 当成了工具名）。
 *
 * 🔴 只列本应用**没有同名的宿主工具**：本应用没有「执行任意命令」的通用入口、没有联网工具、
 *    不起子代理，故 `Bash` / `Shell` / `Terminal` / `WebFetch` 等名字在本应用**根本不存在**
 *    （见 docs/PROJECT-GUIDE.md 的现行口径）。
 *    ⚠️ 但这**不代表技能不可用**：技能包内的脚本/程序文件可以用 `run_skill_script` 运行
 *    （2026-10-13 起，支持的脚本类型见 `SUPPORTED_EXTENSIONS`）—— 故命中提示只说明
 *    「这个工具名不存在」，绝不断言技能不可用。
 *    其余名字（`Read` / `Write` / `Edit` / `Glob` / `Grep` 等）本应用都有等价工具，
 *    **未列出的名字一律不提示** —— 宁可不提示，也不误报。
 *
 * ⚠️ 命中不等于「该技能不能用」：`Bash` 最常见的用途是跑**技能包内的脚本**，
 *    而本应用恰好有等价能力（run_skill_script）。故下面的提示文案只说明能力边界，
 *    绝不断言技能不可用。
 */
const ABSENT_HOST_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'terminal',
  'bashoutput',
  'killshell',
  'webfetch',
  'websearch',
  'task',
  'agent',
  'notebookedit',
]);

/**
 * 在正文顶部插入能力边界提示；声明里没有「本应用不具备」的能力时原样返回。
 * 必须插在**正文之前**，且读取侧已截断完成之后 —— 提示绝不能被正文截断吃掉。
 */
function withCapabilityNotice(text: string, declared: string[] | undefined): string {
  if (declared === undefined || declared.length === 0) {
    return text;
  }
  const absent = Array.from(
    new Set(declared.filter((name) => ABSENT_HOST_TOOL_NAMES.has(name.toLowerCase()))),
  );
  if (absent.length === 0) {
    return text;
  }
  return (
    `⚠ 能力提示：该技能的 SKILL.md 声明要用到 ${absent.join('、')}，` +
    `而本应用**没有**名为 ${absent.join('、')} 的工具。\n` +
    `这不代表该技能不能用 —— 它包内的脚本/程序文件仍可用 run_skill_script 运行` +
    `（skill = 技能标识符，如 my-skill 或 finance-data/westock-data；` +
    `script = 相对该技能目录的路径，如 scripts/setup.cjs；` +
    `支持的类型：${SUPPORTED_EXTENSIONS.join(' / ')}）。\n` +
    `但 SKILL.md 里若出现 \`some-cli <子命令>\` 这类**命令行调用**（不是包内文件），` +
    `只能把它落成「运行技能包内对应的那个可执行文件」；` +
    `若那个 CLI 装在技能目录**之外**（如用户主目录），就越界、执行不了 —— ` +
    `请如实告知用户，不要编造结果。\n\n` +
    `（以下为 SKILL.md 正文）\n\n` +
    text
  );
}

/**
 * 在正文顶部插入**无条件**的「命令式用法适配说明」。
 *
 * 🔴 为什么必须无条件：`withCapabilityNotice` 只在 SKILL.md 的 frontmatter 用 `allowed-tools`
 *    声明了「本应用不具备的能力」时才插入。而 2026-10-13 实测：`finance-data/westock-data`
 *    **根本没有 `allowed-tools` 字段** ⇒ 那条提示一次都没触发 ⇒ 模型读到 SKILL.md 里写的
 *    `westock quote sh600519` 之后，**没有任何人告诉它这在本应用里要拆成 script + args**，
 *    于是把整条命令（甚至只把子命令）填进 `script`，连错三次。
 *    这条规则与 frontmatter 无关，故改为**每次读取都附上**。
 *
 * 与 `withCapabilityNotice` 同样必须插在正文之前、读取侧截断完成之后，保证不被截断吃掉。
 *
 * 🔴 2026-10-14 真机补充：安装目录参数必须给**技能根内的绝对路径**。westock 实测：安装脚本的
 *    `-d` 收相对目录时，落点是**工作区**（run_skill_script 的子进程 cwd 就是工作区），
 *    装出来的 exe 在技能根之外 ⇒ 运行必被双门守卫拒绝。故本说明直接给出含真实技能根的
 *    示例路径，不再给 `<技能根>` 这类占位符（模型拿不到真实路径，会自己发明 @/.bin 然后装错地方）。
 */
function withHostNotice(text: string, context: ToolContext): string {
  const skillsRoot = context.skillsRoot;
  const sharedBinAbs = path.join(skillsRoot, SHARED_BIN_DIR);
  return (
    `⚠ 本应用适配说明（每次读取都会附上）：本应用**没有「执行任意命令」的通用入口**` +
    `（不存在 shell / 终端这类工具）。\n` +
    `上面文档里若出现「程序名 + 子命令 + 参数」形式的**命令行调用**（如 westock quote sh600519），` +
    `**不能照搬**，必须拆成 run_skill_script 的两个字段：\n` +
    `  · script = 那个**程序文件本身**` +
    `（如 ${SKILL_ROOT_PREFIX}${SHARED_BIN_DIR}/westock.exe，或装进该技能目录内的 bin/westock.exe）；\n` +
    `  · args = 命令行里剩下的**每一个词**，逐项放进数组（如 ["quote", "sh600519"]）。\n` +
    `🔴 **绝不要把子命令、参数或整条命令写进 script** —— script 只能是文件名，` +
    `不能含空格分隔的命令片段；写成 script 等于 "quote sh600519" 必然报「脚本不存在」。\n` +
    `若那个程序还不在技能根内，先用该技能的安装脚本（如 scripts/setup.cjs）把它装进技能根再运行；` +
    `装到技能根之外（如用户主目录下的 .local/bin）的程序一律越界、执行不了。\n` +
    `🔴 安装目录参数（如 -d / --bindir）**必须填技能根内的绝对路径**：脚本执行时的当前目录是**工作区**，` +
    `填相对目录（bin、.bin、@/.bin 等）会落到工作区里而不是技能根里，装好了也永远运行不了。` +
    `多个技能共用 → args=["-d", "${sharedBinAbs}"]，装好后 script 填 "${SKILL_ROOT_PREFIX}${SHARED_BIN_DIR}/<文件名>"；` +
    `单个技能自用 → args=["-d", "${skillsRoot}/<技能标识符>"]。` +
    `另外 ${SKILL_ROOT_PREFIX} 只是 run_skill_script 的 script 字段的前缀约定，安装脚本不认识它，` +
    `传给安装脚本的路径不要带 ${SKILL_ROOT_PREFIX}；script 与 args 的每个值都不能带前导或尾随空格。\n` +
    `🔴 安装与运行都是**你自己的职责**，请连续完成，不要先把步骤推给用户。\n\n` +
    `（以下为 SKILL.md 正文）\n\n` +
    text
  );
}

/**
 * 用注入的守卫构造 `read_skill` 工具。
 * 闭包持有 guards，故本模块不 import `tools.ts`、也不依赖宿主桌面框架，彻底无环。
 */
export function createSkillReadTools(guards: WorkspacePathGuards): HarnessTool[] {
  const readSkill: HarnessTool = {
    define(context: ToolContext): ToolDefinition {
      const skillsRoot = context.skillsRoot;
      return {
        name: 'read_skill',
        description:
          `读取某个技能包内的文本文件（只读）。技能根目录为 ${skillsRoot}。` +
          `skill 填**技能标识符**：根下技能写目录名（如 my-skill），套件内技能写 \`套件名/技能名\`（如 finance-data/westock-data）。` +
          `可用技能见系统消息里的「可用技能」清单。` +
          `省略 path 时读取该技能的 SKILL.md 正文（说明书，已去掉元数据），` +
          `给了 path 时读取技能包内的相对文件（如 references/api.md）。` +
          `技能目录之外、工作区之外的路径一律拒绝。` +
          `返回内容有 ${READ_SKILL_LIMIT_CHARS} 字符上限，超出会被截断。` +
          `在运行技能脚本前，通常应先读它的 SKILL.md 了解用法。` +
          `⚠ 本应用**没有「执行任意命令」的通用入口**（不存在 shell / 终端这类工具）：` +
          `SKILL.md 里若让你执行外部命令（如 \`some-cli <子命令>\`、curl、npm），` +
          `不能直接照搬 —— script 只填程序文件本身，子命令与参数逐项放进 args。` +
          `但技能包内**已存在的脚本/程序文件**可以用 run_skill_script 运行，` +
          `支持的类型：${SUPPORTED_EXTENSIONS.join(' / ')}。` +
          `若某技能让你先装一个 CLI 再用它查数据，先让安装脚本把程序装进技能根内` +
          `（安装目录参数必须填技能根内的绝对路径，填相对目录会落到工作区里、装了也运行不了）；` +
          `若那个 CLI 装在技能目录**之外**（如用户主目录），就越界、执行不了：请如实告知用户，不要编造结果。`,
        parameters: {
          type: 'object',
          properties: {
            skill: {
              type: 'string',
              description:
                '技能标识符：根下技能填目录名（如 pdf-tools），套件内技能填 套件名/技能名（如 finance-data/westock-data）',
            },
            path: {
              type: 'string',
              description:
                '相对该技能目录的文件路径，例如 references/api.md；省略时读取 SKILL.md 正文',
            },
          },
          required: ['skill'],
        },
      };
    },

    async execute(rawArgs: string, signal: AbortSignal, context: ToolContext): Promise<ToolResult> {
      try {
        // ① 已中止早退（用户点了「停止」）
        if (signal.aborted) {
          return { ok: false, text: '已停止：读取技能被用户中止' };
        }

        const args = parseArgs<ReadSkillArgs>(rawArgs);

        // ② skill 形状（1~2 段安全标识符；与 run_skill_script 共用 isSafeSkillRef）
        if (typeof args.skill !== 'string' || args.skill.trim().length === 0) {
          return {
            ok: false,
            text: '参数错误：必须提供 skill（字符串，技能根下的技能标识符，如 my-skill 或 finance-data/westock-data）',
          };
        }
        const skill = args.skill.trim();
        if (!isSafeSkillRef(skill)) {
          return {
            ok: false,
            text:
              `拒绝：技能标识符非法（${skill}）。skill 必须是技能根下的**技能标识符**：` +
              `根下技能写目录名（如 my-skill），套件内技能写 \`套件名/技能名\`（如 finance-data/westock-data）。` +
              `每段只能含字母 / 数字 / 点 / 下划线 / 连字符且必须以字母或数字开头，最多两段。`,
          };
        }

        // ③ path 形状（可选；空白视为「读 SKILL.md 正文」）
        if (typeof args.path === 'string' && args.path.includes('\0')) {
          return { ok: false, text: '参数错误：path 不能包含空字符（\\0）' };
        }
        const relPath =
          typeof args.path === 'string' && args.path.trim().length > 0
            ? args.path.trim()
            : undefined;

        // ④ 读取：守卫 + 去 frontmatter + 嗅探 + 截断都在 content.ts 里，失败已按五类分好
        const result = await readSkillFileContent(guards, context.skillsRoot, skill, relPath);
        if (!result.ok) {
          return { ok: false, text: result.text };
        }
        // 能力提示 + 宿主适配说明都只在读取成功时插；读取侧已截断完成，插在前面保证不被截断吃掉。
        // 顺序：宿主适配说明（最外层 ⇒ 出现在最前）→ frontmatter 能力提示 → SKILL.md 正文。
        return {
          ok: true,
          text: withHostNotice(withCapabilityNotice(result.text, result.allowedTools), context),
        };
      } catch (error) {
        // 🔴 execute 绝不上抛：任何异常都转成可读文案回灌给模型
        return {
          ok: false,
          text: `工具内部错误：${messageOf(error)}（不是「技能不存在」或「技能内文件不存在」）。`,
        };
      }
    },
  };

  return [readSkill];
}
