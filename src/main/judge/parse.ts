/**
 * judge 输出的防御式解析 + overall 计算。
 *
 * 为什么不用 zod / response_format：Ollama 不支持 response_format，而引 zod 违反「零新增依赖」。
 * 于是策略是「纯 prompt 约束 + 防御式解析」：模型一定会不听话（加解释、包代码块、
 * 给小数或字符串），解析器负责把能救的救回来，救不回来的明确判失败 —— **绝不静默修正**。
 *
 * 静默修正（clamp / 四舍五入 / 补默认值）是最坏的选择：它会把「模型没按格式输出」
 * 伪装成「一次成功的评测」，让分数悄悄失真且无从发现。所以校验失败一律返回 null，
 * 由上层重试一次，再失败就记 error。
 */
import {
  JUDGE_CAP_OVERALL,
  JUDGE_SCORE_MAX,
  JUDGE_SCORE_MIN,
  type JudgeScores,
} from '../../shared/types';

/** reason 的字符上限（rubric 里也声明了 120 字） */
const REASON_MAX_CHARS = 120;

/** 四个维度键的固定顺序（求和、找最弱维都按这个顺序，保证结果稳定） */
const SCORE_KEYS = ['relevance', 'faithfulness', 'completeness', 'clarity'] as const;

/**
 * 剥掉整段包裹的代码块围栏。
 * 只处理「整段被包裹」这一种情况（``` 或 ```json），不做通用 markdown 解析；
 * 模型在围栏前后加话的情况交给后面的「首 { 到末 }」兜。
 */
function stripFence(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('```')) {
    return text;
  }
  const firstNewline = text.indexOf('\n');
  if (firstNewline < 0) {
    return text;
  }
  let body = text.slice(firstNewline + 1).trim();
  if (body.endsWith('```')) {
    body = body.slice(0, body.length - 3).trim();
  }
  return body;
}

/**
 * 取首个 `{` 到末个 `}` 的子串。
 * 模型常见的「好的，这是我的评分：{...} 希望对你有帮助」就靠这一步救回来。
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

/**
 * 读一个维度分：必须是 1-5 的整数。
 * 字符串 `"4"`、小数 `4.5`、越界 `7`、缺字段 undefined 一律视为非法（不修正）。
 */
function readScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null;
  }
  if (value < JUDGE_SCORE_MIN || value > JUDGE_SCORE_MAX) {
    return null;
  }
  return value;
}

/**
 * 解析 judge 的一次输出。
 *
 * @param text 模型返回的原始文本
 * @returns 四个维度分 + 理由；任何一处不合法返回 null（由上层重试）
 */
export function parseJudgeOutput(text: string): { scores: JudgeScores; reason: string } | null {
  const jsonText = extractJsonObject(stripFence(text));
  if (!jsonText) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const scores: JudgeScores = { relevance: 0, faithfulness: 0, completeness: 0, clarity: 0 };
  for (const key of SCORE_KEYS) {
    const value = readScore(record[key]);
    if (value === null) {
      return null;
    }
    scores[key] = value;
  }

  const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, REASON_MAX_CHARS) : '';
  return { scores, reason };
}

/**
 * 计算 overall 与「忠实度硬否决」标记。
 *
 * - 四维等权均值（不加权：小样本下加权没有统计意义，只多出一堆参数）；
 * - 保留 1 位小数；
 * - 忠实度 ≤ 2 时把 overall 封顶到 JUDGE_CAP_OVERALL（默认 2）：只标记不改分的话，
 *   「编造」会被另外三维的高分抹平，与「唯一硬否决」的产品语义矛盾；
 * - 封顶后可能得到整数 2（而非 2.0），展示侧自行格式化，这里不补小数位。
 *
 * @param scores 四维分数（1-5 整数）
 */
export function computeOverall(scores: JudgeScores): { overall: number; capped: boolean } {
  const mean = (scores.relevance + scores.faithfulness + scores.completeness + scores.clarity) / 4;
  const rounded = Math.round(mean * 10) / 10;
  if (scores.faithfulness <= JUDGE_CAP_OVERALL) {
    return { overall: Math.min(rounded, JUDGE_CAP_OVERALL), capped: true };
  }
  return { overall: rounded, capped: false };
}
