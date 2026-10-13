/**
 * 技能脚本执行工具：`run_skill_script`。
 *
 * 设计来源：docs/SKILL-RUNTIME-DESIGN.md（§4.5 / §5 / §6.3 / §6.4 / §7 / §10）。本模块**不依赖宿主桌面框架**：
 * - 路径安全**不另造一套**，复用 tools.ts 经工厂注入的双门守卫（`guards.*`）；
 * - runtime 根只经**注入的 `RuntimeResolver` 接口**取得（`import type`，编译期擦除）；
 * - 解释器分派 / 进程执行分别落在 `skill-runtime/interpreter.ts` 与 `skill-runtime/run-process.ts`。
 * 故本模块**不反向 import `tools.ts`**，与工具集合之间无 import 环。
 *
 * 🔴 失败语义必须分类（§7，本项目最高频缺陷）：「部分成功 / 超时 / 截断」**不得**讲成「不存在 / 失败」。
 *    所有失败文案统一由本文件的 execute / render 产出，首句两两互不相同。
 */
import * as fs from 'node:fs';
import type { ToolDefinition } from '../providers/types';
import type { WorkspacePathGuards } from './tools-search';
import type { RuntimeResolver } from '../skill-runtime/runtime-paths';
import type { HarnessTool, ToolContext, ToolResult } from './types';
import {
  pickInterpreter,
  assertInterpreterExists,
  buildScriptArgv,
  SUPPORTED_EXTENSIONS,
} from '../skill-runtime/interpreter';
import {
  buildChildEnv,
  runProcess,
  RUN_TIMEOUT_MS,
  OUTPUT_LIMIT_CHARS,
  type RunProcessResult,
} from '../skill-runtime/run-process';
import { isSafeSkillRef, SHARED_BIN_DIR, SKILL_ROOT_PREFIX } from '../skills/names';

/* ────────────────────────────────── 限流常量（§5） ────────────────────────────────── */

const ARGS_MAX_COUNT = 16;
const ARG_MAX_CHARS = 1000;

/** 超时秒数：从单一事实来源 RUN_TIMEOUT_MS 派生，避免文案与常量漂移。 */
const TIMEOUT_SECONDS = RUN_TIMEOUT_MS / 1000;

/* ──────────────────────────────────── 公共契约 ──────────────────────────────────── */

/** 一次技能脚本执行请求（审批门策略据此决策） */
export interface SkillRunRequest {
  skill: string;
  script: string;
  args: string[];
}

/** 执行前策略：下一批的「审批门」就实现这个接口（§2.14）。本批默认恒放行。 */
export interface SkillRunPolicy {
  requiresApproval: (context: ToolContext, request: SkillRunRequest) => boolean;
}

/** 默认策略：恒不需要批准。本批未传 policy 时使用，行为零变化。 */
const DEFAULT_POLICY: SkillRunPolicy = { requiresApproval: () => false };

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

/** 校验并归一 args：必须是 string[]、≤16 项、每项 ≤1000 字符、不含 \0。 */
function normalizeRunArgs(value: unknown): { ok: true; args: string[] } | { ok: false; text: string } {
  if (value === undefined || value === null) {
    return { ok: true, args: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, text: '参数错误：args 必须是字符串数组（可省略）' };
  }
  if (value.length > ARGS_MAX_COUNT) {
    return {
      ok: false,
      text: `参数错误：args 最多 ${ARGS_MAX_COUNT} 个（当前 ${value.length} 个）`,
    };
  }
  const collected: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      return { ok: false, text: '参数错误：args 的每一项都必须是字符串' };
    }
    if (item.length > ARG_MAX_CHARS) {
      return {
        ok: false,
        text: `参数错误：单个参数最多 ${ARG_MAX_CHARS} 字符（当前 ${item.length} 字符）`,
      };
    }
    if (item.includes('\0')) {
      return { ok: false, text: '参数错误：参数不能包含空字符（\\0）' };
    }
    collected.push(item);
  }
  return { ok: true, args: collected };
}

/** 若干文本块去空后以空行拼接（保持段落分隔） */
function joinBlocks(blocks: string[]): string {
  return blocks.filter((block) => block.length > 0).join('\n\n');
}

/** stdout / stderr 各自成段（为空则省略该段），带分隔标题。 */
function formatOutputSections(result: RunProcessResult): string {
  const blocks: string[] = [];
  if (result.stdout.length > 0) {
    blocks.push(`stdout：\n${result.stdout}`);
  }
  if (result.stderr.length > 0) {
    blocks.push(`stderr：\n${result.stderr}`);
  }
  return blocks.join('\n\n');
}

/* ──────────────────────────────────── 结果组装（§6.4） ──────────────────────────────────── */

/**
 * 把执行结果组装成回灌文案。**五类失败语义互不混淆**（§7）：
 * - 首句两两不同，同类不借用他类措辞；
 * - 「超时」显式声明「脚本已启动、不是不存在/不是失败」；
 * - 「截断」显式声明「结果不完整」并给出「落盘 + read_text_file」的下一步；
 * - `exit 0` + 空输出**不是失败**（ok 仍为 true）。
 *
 * 🔴 「输出被截断」**不单方面判失败**：`ok` 只由 `exitCode` 决定。脚本 exit 0 说明它**成功完成**，
 *    截断只影响**我们看到多少**；若判失败，模型会重跑脚本，而重跑同样被截断 —— 死循环。
 */
function render(result: RunProcessResult, request: SkillRunRequest, label: string): ToolResult {
  const seconds = (result.elapsedMs / 1000).toFixed(1);
  const sections = formatOutputSections(result);
  const truncated = result.stdoutTruncated || result.stderrTruncated;
  const emptyOutput = result.stdout.length === 0 && result.stderr.length === 0;

  // 截断提示（§7 #5）：必须声明「结果不完整」+ 可行下一步；**不**据此判失败。
  const truncationNote = truncated
    ? `⚠ 输出超过 ${OUTPUT_LIMIT_CHARS} 字符上限，已截断。**上面的结果不完整**。` +
      `提示：让脚本把结果写入工作区文件，再用 read_text_file 读取。`
    : '';
  const notes = truncationNote.length > 0 ? [truncationNote] : [];

  if (result.outcome === 'timeout') {
    const captured = sections.length > 0 ? sections : '（超时前未捕获到任何输出）';
    return {
      ok: false,
      text: joinBlocks([
        `执行超时：${request.skill}/${request.script} 运行超过 ${TIMEOUT_SECONDS} 秒，已终止（含子进程）。` +
          `这不是「脚本不存在」也不是「运行失败」——脚本确实启动了，只是没有在时限内结束。` +
          `可能原因：数据过大、死循环、或在等待输入（本工具不提供 stdin）。以下是超时前捕获的部分输出：`,
        captured,
        ...notes,
      ]),
    };
  }

  if (result.outcome === 'aborted') {
    const captured = sections.length > 0 ? sections : '（中止前未捕获到任何输出）';
    return {
      ok: false,
      text: joinBlocks([
        `已被用户中止：${request.skill}/${request.script}（已终止进程树）。以下是中止前捕获的部分输出：`,
        captured,
        ...notes,
      ]),
    };
  }

  if (result.outcome === 'spawn-error') {
    return {
      ok: false,
      text: joinBlocks([
        `无法启动脚本进程：${request.skill}/${request.script}（${label}）。` +
          `这不是「脚本不存在」（脚本文件已通过存在性检查），也不是脚本自身退出——进程根本没起来。` +
          `原因：${result.errorText ?? '未知'}。`,
        ...notes,
      ]),
    };
  }

  // outcome === 'exited'
  const exitCode = result.exitCode ?? -1;
  if (exitCode === 0) {
    // §7 附 7：exit 0 + 空输出 = 成功，但要显式说明「没有产生任何输出」，不可写成「无结果 = 失败」。
    // 附 5：即使输出被截断，只要 exit 0 就仍判成功（截断提示另附）。
    const emptyNote = emptyOutput ? '脚本正常结束（退出码 0），但没有产生任何输出。' : '';
    return {
      ok: true,
      text: joinBlocks([
        `已运行 ${request.skill}/${request.script}（${label}，退出码 0，耗时 ${seconds} 秒）`,
        sections,
        ...notes,
        emptyNote,
      ]),
    };
  }
  return {
    ok: false,
    text: joinBlocks([
      `脚本执行失败：退出码 ${exitCode}（${label}，耗时 ${seconds} 秒）。` +
        `脚本本身已启动并主动退出（非超时、非文件不存在）。`,
      sections,
      ...notes,
    ]),
  };
}

/* ──────────────────────────────────── 工具工厂 ──────────────────────────────────── */

/**
 * 用注入的守卫 + runtime resolver（+ 可选策略）构造 `run_skill_script` 工具。
 * 闭包持有依赖，故本模块不 import `tools.ts`、也不依赖宿主桌面框架，彻底无环。
 */
export function createSkillRunTools(
  guards: WorkspacePathGuards,
  runtime: RuntimeResolver,
  policy?: SkillRunPolicy,
): HarnessTool[] {
  const effectivePolicy = policy ?? DEFAULT_POLICY;

  // 🔴 不得在本工具的文案里引导模型用 list_dir / read_text_file 查看技能目录：
  //    那两个工具的根硬绑 context.workspaceRoot（tools-search.ts 的 listDir），
  //    而 skillsRoot = <userData>/skills 在工作区之外 ⇒ 模型照做必然被越界守卫拒绝。
  //    技能枚举改由「系统消息里的『可用技能』清单」提供（src/main/skills/catalog.ts），
  //    本工具的 description 只指向该清单，绝不引导模型去 list_dir 技能根。
  const runSkillScript: HarnessTool = {
    define(context: ToolContext): ToolDefinition {
      const skillsRoot = context.skillsRoot;
      return {
        name: 'run_skill_script',
        description:
          `运行某个技能包里的脚本（在工作区目录下执行）。当前技能根目录为 ${skillsRoot}。` +
          `skill 填**技能标识符**：根下技能写目录名（如 my-skill），套件内技能写 \`套件名/技能名\`（如 finance-data/westock-data）。` +
          `哪些技能可用，见系统消息里的「可用技能」清单——` +
          `若目标技能不在清单里，说明它尚未安装，请告知用户导入，不要凭猜测填写。` +
          `运行脚本前，通常应先用 read_skill 读取该技能的 SKILL.md，了解它的用法与有哪些脚本。` +
          `🔴 最高频错误：把命令行填进 script。若 SKILL.md 里教的是「执行 westock quote sh600519」` +
          `这种**命令行**（程序名 + 子命令 + 参数），必须拆成两个字段：` +
          `script 只填那个**程序文件本身**（如 ${SKILL_ROOT_PREFIX}${SHARED_BIN_DIR}/westock.exe，` +
          `或装进该技能目录内的 bin/westock.exe）；` +
          `args 填命令行里剩下的**每一个词**，逐项放进数组（如 ["quote", "sh600519"]）。` +
          `绝不要把子命令、参数或整条命令写进 script —— script 只能是文件名，` +
          `写成 script 等于 "quote sh600519" 必然报「脚本不存在」。` +
          `⚠ 本应用**没有「执行任意命令」的通用入口**（不存在 shell / 终端这类工具）：` +
          `你只能运行技能根目录内**已存在的**脚本/程序文件，不能凭空执行 \`some-cli <子命令>\` 这类外部命令。` +
          `其中 .bat / .cmd 由 cmd.exe 解释（所以参数不能包含 " % ! ^ & | < > ( ) 这些字符），` +
          `.ps1 由 Windows PowerShell 运行，.sh 需要系统已装 bash（Git Bash 或 WSL）。` +
          `一个常见陷阱：有些技能让你先用安装脚本装一个 CLI、再用那个 CLI 查数据 —— ` +
          `本工具**只能运行技能根目录内的文件**；装到技能根之外（如用户主目录下的 .local/bin）的程序一律越界、执行不了。` +
          `这类技能的安装脚本通常支持指定安装目录，请引导它把程序装进技能根内：` +
          `单个技能自用 → 装进该技能目录（如 bin/westock.exe，运行时 script 填 "bin/westock.exe"）；` +
          `多个技能共用 → 装进技能根下的共享目录 ${SHARED_BIN_DIR}（运行时 script 填 "${SKILL_ROOT_PREFIX}${SHARED_BIN_DIR}/<文件名>"）。` +
          `若 ${SHARED_BIN_DIR} 下还没有目标程序，**你自己先跑安装脚本把它装上**（这是你的职责，不要先问用户），` +
          `装好后再运行它。` +
          `确实做不到时请如实告知用户，不要编造结果，也不要改用其它工具硬凑。` +
          `script 有两种写法：① 相对**该技能目录**的路径（如 scripts/main.py）；` +
          `② 以 ${SKILL_ROOT_PREFIX} 开头，表示相对**技能根**（如 ${SKILL_ROOT_PREFIX}${SHARED_BIN_DIR}/westock.exe，用于引用共享程序）。` +
          `支持的类型：${SUPPORTED_EXTENSIONS.join(' / ')}。` +
          `脚本的 stdout / stderr 会被回传（有 ${OUTPUT_LIMIT_CHARS} 字符上限，超出会被截断）。` +
          `技能根目录之外、工作区之外的路径一律拒绝。`,
        parameters: {
          type: 'object',
          properties: {
            skill: {
              type: 'string',
              description:
                '技能标识符：根下技能填目录名（如 my-skill），套件内技能填 套件名/技能名（如 finance-data/westock-data）',
            },
            script: {
              type: 'string',
              description:
                `脚本路径：相对该技能目录（例 scripts/main.py），或以 ${SKILL_ROOT_PREFIX} 开头表示相对技能根（例 ${SKILL_ROOT_PREFIX}${SHARED_BIN_DIR}/westock.exe）。支持 ${SUPPORTED_EXTENSIONS.join(' / ')}`,
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: '传给脚本的命令行参数数组（可省略）；最多 16 个，每个不超过 1000 字符',
            },
          },
          required: ['skill', 'script'],
        },
      };
    },

    async execute(rawArgs: string, signal: AbortSignal, context: ToolContext): Promise<ToolResult> {
      // ① 已中止早退（用户点了「停止」）
      if (signal.aborted) {
        return { ok: false, text: '已停止：脚本执行被用户中止' };
      }

      try {
        const args = parseArgs<{ skill?: unknown; script?: unknown; args?: unknown }>(rawArgs);
        const skill = args.skill;
        const script = args.script;

        // ② 入参形状（skill 卡成 1~2 段安全标识符；args 形状受限）
        if (typeof skill !== 'string' || typeof script !== 'string') {
          return { ok: false, text: '参数错误：必须提供 skill 与 script（均为字符串）' };
        }
        if (!isSafeSkillRef(skill)) {
          return {
            ok: false,
            text:
              `拒绝：技能标识符非法（${skill}）。skill 必须是技能根下的**技能标识符**：` +
              `根下技能写目录名（如 my-skill），套件内技能写 \`套件名/技能名\`（如 finance-data/westock-data）。` +
              `每段只能含字母 / 数字 / 点 / 下划线 / 连字符且必须以字母或数字开头，最多两段。`,
          };
        }
        if (script.trim().length === 0) {
          return { ok: false, text: '参数错误：script 不能为空' };
        }
        if (script.trim() === SKILL_ROOT_PREFIX) {
          return {
            ok: false,
            text:
              `参数错误：script 不能只写 ${SKILL_ROOT_PREFIX}（它只表示「技能根」本身）。` +
              `${SKILL_ROOT_PREFIX} 后面必须接具体文件，例如 ${SKILL_ROOT_PREFIX}${SHARED_BIN_DIR}/westock.exe。`,
          };
        }
        const normalizedArgs = normalizeRunArgs(args.args);
        if (!normalizedArgs.ok) {
          return { ok: false, text: normalizedArgs.text };
        }

        const skillsRoot = context.skillsRoot;

        // 技能根存在性：必须先自己判一次。守卫在根缺失/非目录时会回灌「工作区目录不存在…」，
        // 那句话把技能根叫成了「工作区」，还让模型「先创建该目录」——而写工具全部绑
        // context.workspaceRoot、技能根在工作区之外，模型根本做不到。文案必须归属准确。
        const skillsRootStat = await fs.promises.stat(skillsRoot).catch(() => null);
        if (!skillsRootStat) {
          return {
            ok: false,
            text:
              `技能根目录不存在：${skillsRoot}。注意：这**不是**工作区的问题` +
              `（工作区是 ${context.workspaceRoot}，与技能根是两个不同目录）。` +
              `应用正常启动时会自动创建它，当前缺失可能是被删除或权限不足。` +
              `本工具无法代为创建 —— 请告知用户手动创建该目录，不要重试、也不要凭猜测改路径。`,
          };
        }
        if (!skillsRootStat.isDirectory()) {
          return {
            ok: false,
            text:
              `技能根路径不是目录：${skillsRoot}（被一个同名文件占用了）。` +
              `本工具无法代为处理 —— 请告知用户移除该文件后重试。`,
          };
        }

        // ③ 双门围栏（复用注入的守卫，不另造一套越界判断；守卫语义是「任意根 + 相对路径」）
        //    script 两种写法：默认相对**技能目录**；以 @ 加斜杠开头则相对**技能根**（引用共享程序）。
        //    两条走同一个守卫、同一个根 ⇒ 安全边界完全一致，该前缀不额外放行任何东西。
        const relativeToSkillRoot = script.startsWith(SKILL_ROOT_PREFIX);
        const joinedPath = relativeToSkillRoot
          ? script.slice(SKILL_ROOT_PREFIX.length)
          : `${skill}/${script}`;
        const resolved = guards.resolveInsideWorkspace(skillsRoot, joinedPath);
        if (!resolved.ok) {
          return { ok: false, text: resolved.text };
        }
        const realRootCheck = await guards.resolveWorkspaceRealRoot(skillsRoot);
        if (!realRootCheck.ok) {
          return { ok: false, text: realRootCheck.text };
        }
        const verified = await guards.verifyRealPath(realRootCheck.realRoot, resolved.target);
        if (!verified.ok) {
          return { ok: false, text: verified.text };
        }

        // ④ 脚本存在性（**必须先于**解释器判断，否则「脚本不存在」与「解释器缺失」会混淆 —— §7 规则 1）
        // 文案要还原模型给的原貌：@ 前缀模式下拼接串已剥掉前缀，
        // 若这里仍用 ${skill}/${script} 拼显示路径，模型会对不上自己填的参数。
        const displayPath = relativeToSkillRoot ? script : `${skill}/${script}`;
        const scriptStat = await fs.promises.stat(resolved.target).catch(() => null);
        if (!scriptStat) {
          // 🔴 这句必须给出「下一步」。只回「不存在」会让模型以为是自己路径写错、于是**原样重试**
          //    （真机上 westock 技能曾对同一参数连续重试 3 次）。故此处显式给出共享目录这条出路。
          return {
            ok: false,
            text:
              `脚本不存在：${displayPath}（技能根目录：${skillsRoot}）。已确认不是解释器问题。` +
              `即该技能根内**没有**这个文件。按下面的顺序**自己处理，不要先问用户**：` +
              `① 先用 read_skill 读该技能的 SKILL.md，确认它到底提供哪些脚本；` +
              `② 若你要找的是多个技能共用的程序，它在技能根的 ${SHARED_BIN_DIR} 目录，` +
              `写法为 ${SKILL_ROOT_PREFIX}${SHARED_BIN_DIR}/<文件名>（如 ${SKILL_ROOT_PREFIX}${SHARED_BIN_DIR}/westock.exe）；` +
              `③ 若 ${SHARED_BIN_DIR} 下**还没有**那个程序，说明它尚未安装 —— ` +
              `先用该技能的安装脚本把它装进去（例：script="scripts/setup.cjs"，` +
              `args=["-d", "<技能根>\\${SHARED_BIN_DIR}"]），装好后再执行第 ② 步。` +
              `不要凭猜测重试同一个路径。`,
          };
        }
        if (!scriptStat.isFile()) {
          return {
            ok: false,
            text:
              `目标不是脚本文件：${displayPath}（技能根目录：${skillsRoot}）。它可能是一个目录。` +
              `已确认不是解释器问题。请向用户确认该技能包内脚本的路径，不要凭猜测重试。`,
          };
        }

        // ⑤ 解释器（runtimeRoot 是**纯字符串**，由注入的 resolver 取得；本模块不依赖宿主桌面框架）
        const runtimeRoot = runtime.resolveRuntimeRoot();
        const spec = pickInterpreter(resolved.target, runtimeRoot);
        if (!spec) {
          return {
            ok: false,
            text:
              `不支持的文件类型：${script}。本工具仅支持 ${SUPPORTED_EXTENSIONS.join(' / ')}。` +
              `请改用受支持的类型，或核对 script 的扩展名。`,
          };
        }
        const interpreterCheck = await assertInterpreterExists(spec);
        if (!interpreterCheck.ok) {
          // 文案由 interpreter.ts 统一产出（首句「运行时缺失：」，与「脚本不存在」互斥）
          return { ok: false, text: interpreterCheck.text };
        }

        // ⑤' 最终 argv：`.bat` / `.cmd` 的 cmd 引号化与安全校验都在这里（含元字符的参数会被拒绝）
        const argv = buildScriptArgv(spec, resolved.target, normalizedArgs.args);
        if (!argv.ok) {
          return { ok: false, text: argv.text };
        }

        // ⑥ cwd 必须存在（否则 spawn 会抛 ENOENT，被误报成「脚本不存在」）
        const workspace = await guards.resolveWorkspaceRealRoot(context.workspaceRoot);
        if (!workspace.ok) {
          return { ok: false, text: workspace.text };
        }

        // ⑦ 审批挂点（§2.14）：**本批 policy 恒未传 ⇒ DEFAULT_POLICY 恒放行**，行为零变化。
        //    此处刻意**不**实现任何弹窗 / 阻塞等待（本批不做审批 UX）。若调用方注入了会返回 true 的
        //    策略，则**拒绝执行**而不静默放行 —— 避免绕过尚未实现的审批门。
        const request: SkillRunRequest = { skill, script, args: normalizedArgs.args };
        if (effectivePolicy.requiresApproval(context, request)) {
          return {
            ok: false,
            text:
              `该脚本被策略标记为需要用户批准，但当前版本尚未提供审批入口，已暂缓执行：` +
              `${skill}/${script}。请更新应用后再试。`,
          };
        }

        // ⑧ 执行（参数数组；cwd 钉工作区 realRoot；env 白名单重建）
        const result = await runProcess({
          command: spec.command,
          args: argv.args,
          cwd: workspace.realRoot,
          env: buildChildEnv(spec.kind, runtimeRoot),
          verbatimArgs: spec.verbatimArgs,
          timeoutMs: RUN_TIMEOUT_MS,
          outputLimitChars: OUTPUT_LIMIT_CHARS,
          signal,
        });
        return render(result, request, spec.label);
      } catch (error) {
        // 🔴 execute 绝不上抛：任何异常都转成可读文案回灌给模型
        return { ok: false, text: `工具内部错误：${messageOf(error)}（不是脚本自身的退出码失败）。` };
      }
    },
  };

  return [runSkillScript];
}
