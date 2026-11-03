/**
 * judge 的 rubric 与输入装配。
 *
 * 本文件是「评分标准」的唯一来源：
 * - `RUBRIC_VERSION` 是标准自身的版本号，维度定义或锚点改了就必须 +1，
 *   否则新旧分数会被当成同一把尺子；
 * - `JUDGE_SYSTEM_PROMPT` 必须自带 1 / 3 / 5 分锚点。judge 打不稳的根因就是没锚点，
 *   只写「请从 1-5 打分」会得到一堆互相不可比的中间分；
 * - 提示词只活在主进程，渲染层永不展示，故不进 shared。
 *
 * 不引 zod、不加 response_format：Ollama 不支持，纯 prompt 约束 + 防御式解析兜住一切。
 */
import {
  JUDGE_ANSWER_MAX_CHARS,
  JUDGE_STEP_ARGS_MAX_CHARS,
  type JudgeCase,
  type ToolStep,
} from '../../shared/types';
import { TOOL_RESULT_PREVIEW_LIMIT } from '../harness';

/** 评分标准版本：改了维度定义 / 锚点 / 硬约束就 +1 */
export const RUBRIC_VERSION = '1';

/**
 * judge 的系统提示词。
 *
 * 三段结构不可省：锚点表（让分数可比）、硬约束（封住已知的两类误判）、
 * 输出格式（让防御式解析有明确目标）。
 */
export const JUDGE_SYSTEM_PROMPT = `你是一个严格的回答质量评审员。你的唯一任务是给「助手回答」打分，并只输出一个 JSON 对象。

## 评分维度与锚点（1-5 分整数）
1. relevance（相关性：是否答了用户问的那件事）
   1 分：答非所问 / 拒答
   3 分：答了但漏主诉求
   5 分：正面命中，无跑题铺垫
2. faithfulness（忠实度：是否忠于工具结果与上下文，不编造）
   1 分：出现上下文中不存在的文件 / 数据 / 结论
   3 分：大体有据，个别细节无来源
   5 分：每个事实都能在工具结果或上下文里找到
3. completeness（完整性：是否覆盖全部要点）
   1 分：只答一半
   3 分：主要要点齐，次要缺失
   5 分：要点齐且给出可执行步骤
4. clarity（表达质量：结构、可读、无冗余）
   1 分：混乱 / 大段重复
   3 分：可读但有冗余
   5 分：结构清晰，结论先行
2 分与 4 分是相邻两档之间的过渡分，按更接近哪一档给分。

## 三条硬约束
1. 工具结果只给出前 200 字片段。若仅凭片段无法判断是否编造，忠实度按 3 分中性处理，不得因片段缺失判 1 分。
2. 若输入注明回答因长度被截断，不要因缺少结尾扣完整性分；仅当已给出部分明显缺要点时才扣。
3. 忠实度是硬否决维度：一旦判定出现编造（上下文 / 工具结果里没有的文件、数据、结论），必须给 2 分或更低。

## 输出格式
只输出一个 JSON 对象，不要代码块围栏、不要任何解释、不要前后缀文字。形如：
{"relevance":4,"faithfulness":5,"completeness":3,"clarity":4,"reason":"一句话指出最弱维度及原因"}
- 四个维度都是 1-5 的整数，不允许小数、不允许 0 分；
- reason 用简体中文，不超过 120 字，必须点名最弱的那一维及原因。`;

/** 单步工具调用的结果预览上限（与 harness 的 TOOL_RESULT_PREVIEW_LIMIT 同口径） */
const STEP_RESULT_PREVIEW_CHARS = TOOL_RESULT_PREVIEW_LIMIT;

/**
 * 单步工具调用的**参数**预览上限。
 *
 * 必须截断：`write_text_file` / `edit_text_file` 的 args 里可能装着整个文件正文（几 KB），
 * 5 个工具调用就能把 judge 输入顶到几十 KB —— 既费 token，也可能撑爆小模型的上下文。
 * 500 字足够看出「它读了哪个文件 / 写了哪一段」，再多对判分没有增量信息。
 *
 * 与落盘侧同一常量：两处一旦漂移，judge 就会按「落盘时已被砍掉的内容」判忠实度。
 */
const STEP_ARGS_PREVIEW_CHARS = JUDGE_STEP_ARGS_MAX_CHARS;

/** 工具步骤状态 → 中文（judge 读中文比读英文枚举准） */
function statusText(step: ToolStep): string {
  if (step.status === 'done') {
    return '成功';
  }
  if (step.status === 'error') {
    return '失败';
  }
  return '进行中';
}

/**
 * 把一条 case 装配成 judge 的 user 消息。
 *
 * 刻意只给「问题 / 回答 / 轨迹 / 模型名 + 轮数」：
 * - 不塞 `generation` 里的哈希 —— judge 看不懂也没法用，只会干扰判断；
 * - 轨迹里给出工具名 + 参数 + 结果前 200 字：编造的主要形态是「声称读了不存在的文件 /
 *   查了不存在的数据」，工具名与参数足以识别大半（见架构 §2-B 的降级取舍）。
 *
 * @param target 待评测的 case 快照
 */
export function buildJudgeInput(target: JudgeCase): string {
  const parts: string[] = ['【用户问题】', target.question, '', '【助手回答】'];

  if (target.answerTruncated) {
    // 原文总字数没有落盘（只存了截断后的正文），故只能声明「仅提供前 N 字、原文更长」；
    // 关键是让 judge 知道「结尾缺失不是我漏了」，否则完整性会被系统性扣分。
    parts.push(
      `（注：回答因长度被截断，仅提供前 ${target.answer.length} 字（上限 ${JUDGE_ANSWER_MAX_CHARS} 字），原文更长。` +
        `请勿因缺少结尾扣完整性分；仅当已给出的部分明显缺要点时才扣分。）`,
    );
  }
  parts.push(target.answer.length > 0 ? target.answer : '（空回答）');

  parts.push('', '【工具调用轨迹】');
  if (target.steps.length === 0) {
    parts.push('（本轮没有调用工具）');
  } else {
    for (const step of target.steps) {
      const rawArgs = step.args.length > 0 ? step.args : '{}';
      // 用 >= 而非 >：落盘侧已按同一上限截断，恰好等于上限时也可能已被砍过，
      // 必须让 judge 知道「这段参数可能不完整」，否则它会误判成模型传了畸形 JSON
      const args =
        rawArgs.length >= STEP_ARGS_PREVIEW_CHARS
          ? `${rawArgs.slice(0, STEP_ARGS_PREVIEW_CHARS)}…（参数已截断）`
          : rawArgs;
      const result =
        step.result !== undefined && step.result.length > 0
          ? step.result.slice(0, STEP_RESULT_PREVIEW_CHARS)
          : '无输出';
      parts.push(`- ${step.name}（${statusText(step)}）`);
      parts.push(`  参数：${args}`);
      parts.push(`  结果：${result}`);
    }
  }

  parts.push(
    '',
    '【生成信息】',
    `模型：${target.generation.model.length > 0 ? target.generation.model : '未知'}　轮数：${
      target.generation.turns ?? '未知'
    }`,
  );

  return parts.join('\n');
}
