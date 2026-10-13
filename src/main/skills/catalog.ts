/**
 * 技能清单 → 一级注入用的 system 消息。
 *
 * 设计来源：docs/SKILL-LOADING-DESIGN.md（§2.4 / §4.5 / §5）。
 *
 * 语义：
 * - 这是**每轮都常驻**的 system 消息，必须控量（`CATALOG_MAX_CHARS`）；对小上下文本地模型尤其敏感；
 * - 无技能 → 返回 `null`（调用方据此跳过注入）——空清单只会白占 token，还可能让模型以为技能系统坏了；
 * - 🔴 **dirName 永不截断、description 才可截断**：`read_skill` / `run_skill_script` 靠 dirName 寻址，
 *   dirName 不在清单里模型就**根本不知道有这个技能**，所以宁可砍 description，绝不能砍 dirName；
 * - 本模块为纯逻辑：不读盘、不含宿主桌面框架依赖（技能列表由调用方传入）。
 */
import type { LlmMessage } from '../providers/types';
import { SKILLS_MAX_COUNT, type SkillMeta } from './registry';

/** 一级清单总字符预算（含说明文字与全部技能行）；整条消息超出即降级为「只列目录名」 */
const CATALOG_MAX_CHARS = 2_000;
/** 完整档下每条 description 的截断长度 */
const CATALOG_DESC_CHARS = 80;

/** 清单抬头：必须讲清「清单是可用技能 / skill 填技能标识符 / 先 read_skill 再动手」三件事 */
function buildIntro(): string {
  return (
    '【可用技能】\n' +
    '下面这些技能已安装，都是可选能力。当任务与某个技能相关时，先用 read_skill 读取它的 SKILL.md ' +
    '说明书（里面写了适用场景、用法、以及有哪些脚本），再决定是否用 run_skill_script 运行其中的脚本。' +
    '不要仅凭技能名猜测用法。skill 参数一律填**技能标识符**（即下面每行开头的标识；' +
    '成套技能形如 `套件名/技能名`）。'
  );
}

/**
 * 截断声明：仅当技能数达到上限（`SKILLS_MAX_COUNT`）时返回非空字符串。
 *
 * 🔴 为什么必须有：清单最多只列 50 个，若不声明，模型会把「只列出的这些」当成全集，
 * 进而对第 51 个技能**向用户断言「不存在」**——这正是本项目最忌讳的「把不确定性讲成确定性」。
 * 这句必须让模型知道「这不是全集」，并要求它不要据此断言「没有某技能」。
 */
function buildTruncationNote(count: number): string {
  if (count < SKILLS_MAX_COUNT) {
    return '';
  }
  return (
    `⚠ 已达到清单上限：以下**可能不是全部技能**（最多列出 ${SKILLS_MAX_COUNT} 个）。` +
    `若你认为某个技能本该存在却没出现在这里，**不要据此断言「没有该技能」或「该技能不存在」**` +
    `——它可能只是没有被列出；可以请用户到「设置 → 技能」查看完整列表。`
  );
}

/**
 * 归一 description 为单行并截断；空描述标「（无描述）」。
 * 必须压平空白：frontmatter 的块标量（`|`）会带换行，若原样拼进清单会破坏「一条技能占一行」的格式。
 */
function describeSkill(meta: SkillMeta): string {
  const flat = meta.description.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) {
    return '（无描述）';
  }
  if (flat.length <= CATALOG_DESC_CHARS) {
    return flat;
  }
  return `${flat.slice(0, CATALOG_DESC_CHARS)}…`;
}

/** 单条技能完整档文本：`- <dirName>[（<displayName>）]：<description>` */
function fullSkillLine(meta: SkillMeta): string {
  const label =
    meta.displayName.length > 0 && meta.displayName !== meta.dirName
      ? `${meta.dirName}（${meta.displayName}）`
      : meta.dirName;
  return `- ${label}：${describeSkill(meta)}`;
}

/**
 * 把技能清单包装成一条注入用的 system 消息。
 * - 无技能时返回 `null`（调用方据此跳过注入）；
 * - **完整档**：每条 `- dirName[（displayName）]：description(≤80)`；整条消息超过 `CATALOG_MAX_CHARS` 则降级；
 * - **紧凑档**：只列 dirName（每行一个），附一句「技能较多，此处只列名称」。
 *   dirName 永不截断。
 */
export function buildSkillsCatalogMessage(skills: SkillMeta[]): LlmMessage | null {
  if (skills.length === 0) {
    return null;
  }
  const intro = buildIntro();
  const truncationNote = buildTruncationNote(skills.length);
  const prefix = truncationNote.length > 0 ? `${intro}\n\n${truncationNote}` : intro;

  // 完整档：带 description。整条消息（含抬头）不超预算就直接用。
  const fullLines = skills.map(fullSkillLine);
  const fullContent = `${prefix}\n\n${fullLines.join('\n')}`;
  if (fullContent.length <= CATALOG_MAX_CHARS) {
    return { role: 'system', content: fullContent };
  }

  // 紧凑档：超预算 ⇒ 砍掉全部 description，只留 dirName（dirName 永不截断）。
  const compactLines = skills.map((meta) => `- ${meta.dirName}`);
  const compactContent =
    `${prefix}\n\n技能较多（共 ${skills.length} 个），此处只列名称；` +
    `需要时用 read_skill 读取某个技能的说明书（SKILL.md 正文）。\n\n${compactLines.join('\n')}`;
  return { role: 'system', content: compactContent };
}
