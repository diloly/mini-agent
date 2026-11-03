/**
 * 生成指纹：让「两条回答的分数能不能放在一起比」变成一个可判定的问题。
 *
 * 四个指纹各有分工：
 * - `promptVersion`：system prompt 的**模板文案**指纹。只 hash 手写模板常量，
 *   刻意排除技能列表内容、记忆正文、工作区绝对路径、当前时间 —— 那些是「每轮都可能变」的
 *   变量，全量 hash 会把「昨天装了个技能」误判成 prompt 变更，A/B 结论随之失真。
 *   模板文案本身改了（改了措辞、加了条款、调了预算阈值）才应该换版本。
 * - `toolSetHash`：本次生成暴露给模型的工具集指纹（工具名排序后哈希）。工具集变了，
 *   模型能做的事就变了，分数自然不可比。
 * - `questionHash`：归一化后的问题指纹，用于把「同一个问题的多次回答」归到一组。
 * - `appVersion`：应用版本，用于区分跨版本的历史数据。
 *
 * 全部哈希统一走 `sha8`（sha256 前 8 位十六进制），全仓只有这一处实现。
 * 本模块只被主进程的 IPC 编排与 judge 使用，不得被 harness 反向依赖。
 */
import { createHash } from 'node:crypto';
import { app } from 'electron';
import { harnessToolsFor } from '../harness/tools';
import type { ToolContext } from '../harness/types';
import {
  CATALOG_DESC_CHARS,
  CATALOG_MAX_CHARS,
  SKILLS_CATALOG_INTRO,
  SKILLS_COMPACT_NOTE_TEMPLATE,
  SKILLS_TRUNCATION_NOTE_TEMPLATE,
} from '../skills/catalog';
import {
  MEMORY_SECTION_PREFIX,
  WORKSPACE_MEMORY_RULES,
  WORKSPACE_PLAN_RULES,
  WORKSPACE_ROOT_LINE_TEMPLATE,
  WORKSPACE_RULES_HEADER,
} from '../workspace-memory';

/**
 * 指纹输入各段之间的分隔符。
 * 用 NUL 而不是换行：模板文案里本来就有换行，用换行当分隔符会让
 * 「段 A 末尾换行 + 段 B」与「段 A + 段 B 开头换行」撞成同一串输入。
 */
const PART_SEPARATOR = '\u0000';

/**
 * 统一的短哈希：sha256 十六进制前 8 位。
 * @param text 待哈希文本（按 utf8 编码）
 */
export function sha8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

/**
 * 问题指纹：先归一化再哈希。
 * 归一化 = 去首尾空白 + 连续空白折叠为单个空格 —— 同一个问题多打了两个空格，
 * 不该被算成两条不同的 case（否则按 questionHash 分组统计会碎成一片）。
 * @param question 用户提问原文
 */
export function computeQuestionHash(question: string): string {
  const normalized = question.trim().replace(/\s+/g, ' ');
  return sha8(normalized);
}

/**
 * promptVersion 的哈希输入（按固定顺序拼接的模板文案全文）。
 *
 * 单独导出是为了让 prompt 快照可以「逐字节复算」：落盘的
 * `judge-prompts/<promptVersion>.txt` 内容就等于本函数的返回值。
 *
 * 🔴 这里**只允许**出现手写模板常量：
 * - 不含技能列表内容（装了哪些技能）—— 那是数据不是模板；
 * - 不含记忆正文 —— 记忆每轮都在变；
 * - 不含工作区绝对路径 —— 模板里用 `<root>` 占位；
 * - 不含任何时间戳。
 */
export function buildPromptVersionSource(): string {
  return [
    // ① 工作区约定：抬头 + 根目录声明模板 + 常驻条款 + 记忆条款
    WORKSPACE_RULES_HEADER,
    WORKSPACE_ROOT_LINE_TEMPLATE,
    ...WORKSPACE_PLAN_RULES,
    ...WORKSPACE_MEMORY_RULES,
    // ② 记忆区前缀（长期记忆段落之前的固定说明）
    MEMORY_SECTION_PREFIX,
    // ③ 技能清单：抬头 + 截断声明 + 紧凑档说明 + 两个预算阈值
    SKILLS_CATALOG_INTRO,
    SKILLS_TRUNCATION_NOTE_TEMPLATE,
    SKILLS_COMPACT_NOTE_TEMPLATE,
    `catalogMaxChars=${CATALOG_MAX_CHARS}`,
    `catalogDescChars=${CATALOG_DESC_CHARS}`,
  ].join(PART_SEPARATOR);
}

/** system prompt 模板指纹 */
export function computePromptVersion(): string {
  return sha8(buildPromptVersionSource());
}

/**
 * 工具集指纹：取本次生成实际暴露的工具名，**排序后**再哈希。
 *
 * 必须排序：`harnessToolsFor` 的返回顺序是注册表顺序，将来插入一个工具就会让
 * 全部历史指纹失效；排序后只有「增删工具」才会改变指纹。
 * 记忆开关会摘掉 append_daily_note，所以同一份配置下开关状态不同 → 指纹不同（符合预期）。
 *
 * @param toolContext 本次生成的工具执行上下文（决定工具集合）
 */
export function computeToolSetHash(toolContext: ToolContext): string {
  // define() 是纯字符串拼接，只为拿 name；此处不执行任何工具
  const names = harnessToolsFor(toolContext).map((tool) => tool.define(toolContext).name);
  // sort 原地排序的是 map 新建出来的数组，不会影响工具注册表
  return sha8(names.sort().join('\n'));
}

/**
 * 当前应用版本（来自 package.json 的 version，由 electron 提供）。
 * 读不到时回退 'unknown'：指纹字段缺失不该让整轮收尾失败。
 */
export function getAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}
