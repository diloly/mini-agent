/**
 * 评测集存储：`<账号目录>/judge-cases.json`（与 conversations.json 同级，账号分区）。
 *
 * 设计要点（与架构 §2-F / §2-G、§5 一致）：
 * - **单文件 + 500 条上限**：分片会让跨片汇总与按 questionHash 分组查询复杂化，
 *   而写入只发生在用户手点（点赞 / 评测）而非循环路径，全量重写可接受；
 * - **自己的串行链**：与 `storage.enqueue` 是两条不同的链（管两个不同的文件），
 *   互不等待，因此不存在「A 等 B、B 等 A」的死锁；
 * - **读盘不做逐字段重建**：只做数组项级宽松校验，否则将来给 case 加字段会被静默丢弃
 *   （本项目历史上被 config 的白名单咬过一次）；
 * - **无账号静默**：未登录时写操作直接返回、读返回空，绝不抛。
 */
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  JUDGE_CASE_LIMIT,
  JUDGE_RUN_LIMIT,
  type JudgeCase,
  type JudgeCaseSummary,
  type JudgeRun,
  type JudgeScores,
  type JudgeSummary,
  type Verdict,
} from '../../shared/types';
import { accountDir, atomicWrite, getActiveAccountId } from '../storage';

/** 评测集文件名 */
const CASES_FILE = 'judge-cases.json';
/** prompt 快照目录名（与 cases 文件同级） */
const PROMPTS_DIR = 'judge-prompts';
/** 文件格式版本号 */
const STORE_VERSION = 1;
/** 列表项里提问的截断长度 */
const QUESTION_PREVIEW_CHARS = 60;
/** 汇总里「踩的样本」条数上限 */
const DOWN_SAMPLE_LIMIT = 20;
/** 一天的毫秒数（用于 days 窗口） */
const DAY_MS = 86_400_000;
/** 四个维度的固定顺序（求和与找最弱维都按它，保证结果稳定） */
const DIMENSION_KEYS = ['relevance', 'faithfulness', 'completeness', 'clarity'] as const;

/** 磁盘上的文件形态 */
interface JudgeStoreFile {
  version: 1;
  cases: JudgeCase[];
}

/** 内存缓存（首次读盘后复用；账号切换时自动失效） */
let cache: JudgeCase[] | null = null;
/** 缓存对应的账号 id：换账号必须重新读盘，否则会串号 */
let cacheAccountId: string | null = null;

/**
 * 缓存世代号：`resetJudgeCache` 每次自增。
 * `loadCases` 是唯一不在 `enqueue` 链上的读路径（放进链里会与 `upsertCase` 内层的
 * `loadCases` 自我等待死锁），所以它的 `await readStoreFile` 可能跨越一次「清除数据」——
 * 删除前读到的旧内容会在删除后写回缓存，且 `cacheAccountId` 与当前账号一致，
 * 之后所有读都返回已删数据，永不自我纠正。世代号用来识别「读的过程中被重置过」。
 */
let cacheEpoch = 0;

/** 本模块的串行链（独立于 storage 的写队列，两个文件两条链，互不等待） */
let chain: Promise<unknown> = Promise.resolve();

/**
 * 把任务串到本模块写队列尾部执行。
 * @param task 待执行的异步任务
 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 某账号的评测集文件路径 */
function casesPath(accountId: string): string {
  return path.join(accountDir(accountId), CASES_FILE);
}

/** 某账号的 prompt 快照目录 */
function promptsDir(accountId: string): string {
  return path.join(accountDir(accountId), PROMPTS_DIR);
}

/**
 * 宽松校验：只要求是带 id / messageId / runs 的对象。
 * 刻意**不**逐字段重建 —— 逐字段重建等于给 case 加一道白名单，新增字段读盘即丢。
 */
function normalizeCases(raw: unknown): JudgeCase[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is JudgeCase => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    const candidate = item as JudgeCase;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.messageId === 'string' &&
      Array.isArray(candidate.runs)
    );
  });
}

/** 读盘（解析失败 / 文件不存在一律当空集，不抛） */
async function readStoreFile(accountId: string): Promise<JudgeCase[]> {
  try {
    const raw = await readFile(casesPath(accountId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return [];
    }
    return normalizeCases((parsed as { cases?: unknown }).cases);
  } catch {
    return [];
  }
}

/** 取缓存；首次读盘或账号变化时重新加载 */
async function loadCases(accountId: string): Promise<JudgeCase[]> {
  if (cache !== null && cacheAccountId === accountId) {
    return cache;
  }
  const epoch = cacheEpoch;
  const cases = await readStoreFile(accountId);
  // 读盘期间被 resetJudgeCache 重置过：这份内容可能是删除前的旧快照，
  // 只作为本次调用的返回值，绝不写回缓存（否则会变成常驻的假数据）
  if (epoch === cacheEpoch) {
    cache = cases;
    cacheAccountId = accountId;
  }
  return cases;
}

/** 原子落盘（复用 storage 的 atomicWrite：临时文件 + rename） */
async function persist(accountId: string, cases: JudgeCase[]): Promise<void> {
  await mkdir(accountDir(accountId), { recursive: true });
  await atomicWrite(casesPath(accountId), { version: STORE_VERSION, cases } satisfies JudgeStoreFile);
}

/**
 * 取「最新一次成功 run」：runs 里最后一个带 scores 的。
 * 失败的 run 只有 error 没有 scores，因此天然不计入分数统计。
 */
function latestScoredRun(item: JudgeCase): JudgeRun | undefined {
  for (let index = item.runs.length - 1; index >= 0; index -= 1) {
    const run = item.runs[index];
    if (run.scores !== undefined) {
      return run;
    }
  }
  return undefined;
}

/** 取四维里分数最低的那一维（并列时取固定顺序中的第一个） */
function weakestDimension(scores: JudgeScores): keyof JudgeScores {
  let weakest: keyof JudgeScores = DIMENSION_KEYS[0];
  for (const key of DIMENSION_KEYS) {
    if (scores[key] < scores[weakest]) {
      weakest = key;
    }
  }
  return weakest;
}

/** 保留 1 位小数 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * JudgeCase → 列表摘要（不含 answer / steps）。
 * 导出是为了让 handlers 的 list 通道与 summarize 的 downSamples 用同一份转换逻辑。
 */
export function toCaseSummary(item: JudgeCase): JudgeCaseSummary {
  const latest = latestScoredRun(item);
  const latestScores = latest?.scores;
  const summary: JudgeCaseSummary = {
    id: item.id,
    conversationId: item.conversationId,
    messageId: item.messageId,
    createdAt: item.createdAt,
    question: item.question.slice(0, QUESTION_PREVIEW_CHARS),
    hasRun: latest !== undefined,
  };
  if (item.verdict !== undefined) {
    summary.verdict = item.verdict;
  }
  if (latest !== undefined && latestScores !== undefined) {
    if (latest.overall !== undefined) {
      summary.overall = latest.overall;
    }
    summary.weakest = weakestDimension(latestScores);
  }
  const lastRun = item.runs.length > 0 ? item.runs[item.runs.length - 1] : undefined;
  const lastError = lastRun?.error;
  if (lastError !== undefined) {
    summary.error = lastError;
  }
  return summary;
}

/** 空汇总（无账号 / 读盘失败 / 一条 case 都没有时的形态） */
export function emptySummary(): JudgeSummary {
  return {
    total: 0,
    evaluated: 0,
    window30d: 0,
    cappedCount: 0,
    avgOverall: null,
    dims: { relevance: null, faithfulness: null, completeness: null, clarity: null },
    downCount: 0,
    downSamples: [],
  };
}

/**
 * 500 条上限淘汰（原地修改传入数组，因为它是缓存本体）。
 * 顺序：先淘汰「无 run 且无 verdict」的最旧 case，不够再淘汰最旧的（按 createdAt）。
 *
 * @param cases 全量 case（缓存本体）
 * @param protectedMessageId 刚写入的那条 case 的 messageId —— **绝不淘汰它**：
 *   否则「已有 500 条且全都有 run」时，新来的第 501 条自身正是唯一的「无 run 且无 verdict」
 *   候选，会被立刻删掉，用户点了半天什么也没留下。
 */
function enforceCaseLimit(cases: JudgeCase[], protectedMessageId: string): void {
  const overflow = cases.length - JUDGE_CASE_LIMIT;
  if (overflow <= 0) {
    return;
  }
  const byAge = (a: JudgeCase, b: JudgeCase): number => a.createdAt - b.createdAt;
  const drop = new Set<JudgeCase>();
  const candidates = cases.filter((item) => item.messageId !== protectedMessageId);

  const idle = candidates
    .filter((item) => item.runs.length === 0 && item.verdict === undefined)
    .sort(byAge);
  for (const item of idle) {
    if (drop.size >= overflow) {
      break;
    }
    drop.add(item);
  }
  if (drop.size < overflow) {
    const rest = candidates.filter((item) => !drop.has(item)).sort(byAge);
    for (const item of rest) {
      if (drop.size >= overflow) {
        break;
      }
      drop.add(item);
    }
  }
  if (drop.size === 0) {
    return;
  }
  const kept = cases.filter((item) => !drop.has(item));
  cases.splice(0, cases.length, ...kept);
}

/** 全部 case（浅拷贝数组，避免调用方 push / splice 污染缓存） */
export async function listCases(): Promise<JudgeCase[]> {
  const accountId = getActiveAccountId();
  if (!accountId) {
    return [];
  }
  try {
    return (await loadCases(accountId)).slice();
  } catch {
    return [];
  }
}

/** 按 messageId 取 case（messageId 是幂等键：同一条消息只有一条 case） */
export async function getCaseByMessage(messageId: string): Promise<JudgeCase | undefined> {
  const accountId = getActiveAccountId();
  if (!accountId) {
    return undefined;
  }
  try {
    const cases = await loadCases(accountId);
    return cases.find((item) => item.messageId === messageId);
  } catch {
    return undefined;
  }
}

/**
 * 按 messageId 幂等写入一条 case。
 *
 * 已存在时**保留原有的 `runs` 与 `verdict`**，只刷新内容快照字段 ——
 * 用户重复点赞 / 编辑重发后再点踩，都不该把历次评测结果和评价清空。
 * `id` 与 `createdAt` 同样沿用旧值：case 的身份与归档时间不该因为重新快照而变。
 */
export async function upsertCase(next: JudgeCase): Promise<void> {
  const accountId = getActiveAccountId();
  if (!accountId) {
    return;
  }
  await enqueue(async () => {
    const cases = await loadCases(accountId);
    const index = cases.findIndex((item) => item.messageId === next.messageId);
    if (index >= 0) {
      const existing = cases[index];
      cases[index] = {
        ...next,
        id: existing.id,
        createdAt: existing.createdAt,
        runs: existing.runs,
        ...(existing.verdict !== undefined ? { verdict: existing.verdict } : {}),
      };
    } else {
      cases.push(next);
    }
    enforceCaseLimit(cases, next.messageId);
    await persist(accountId, cases);
  });
}

/**
 * 设置 / 取消用户评价。
 * `verdict === null` 用 `delete` 删字段，而不是写 undefined ——
 * 落盘后 JSON 里就不该出现 `"verdict": null` 这种第三态。
 */
export async function setVerdict(messageId: string, verdict: Verdict | null): Promise<void> {
  const accountId = getActiveAccountId();
  if (!accountId) {
    return;
  }
  await enqueue(async () => {
    const cases = await loadCases(accountId);
    const target = cases.find((item) => item.messageId === messageId);
    if (!target) {
      return;
    }
    if (verdict === null) {
      delete target.verdict;
    } else {
      target.verdict = verdict;
    }
    await persist(accountId, cases);
  });
}

/**
 * 追加一次评测运行；超过 JUDGE_RUN_LIMIT 时丢弃最旧的（含失败记录）。
 * 失败的 run 同样保留：它记录了「这次为什么没评成」，是排查依据。
 */
export async function appendRun(messageId: string, run: JudgeRun): Promise<void> {
  const accountId = getActiveAccountId();
  if (!accountId) {
    return;
  }
  await enqueue(async () => {
    const cases = await loadCases(accountId);
    const target = cases.find((item) => item.messageId === messageId);
    if (!target) {
      return;
    }
    target.runs.push(run);
    if (target.runs.length > JUDGE_RUN_LIMIT) {
      target.runs.splice(0, target.runs.length - JUDGE_RUN_LIMIT);
    }
    await persist(accountId, cases);
  });
}

/**
 * 汇总统计（设置页「质量」分组用）。
 *
 * 口径：**每条 case 只取最新一次成功 run**，失败的 run 不进分母 ——
 * 否则「重评成功一次」不会拉高分数，而「重评失败一次」却会稀释掉旧分数。
 *
 * @param days 「最近 N 天」窗口，缺省 30
 */
export async function summarize(days = 30): Promise<JudgeSummary> {
  const accountId = getActiveAccountId();
  if (!accountId) {
    return emptySummary();
  }
  let cases: JudgeCase[];
  try {
    cases = await loadCases(accountId);
  } catch {
    return emptySummary();
  }

  const windowDays = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 30;
  const windowStart = Date.now() - windowDays * DAY_MS;

  let evaluated = 0;
  let window30d = 0;
  let cappedCount = 0;
  const overalls: number[] = [];
  const dimTotals: Record<keyof JudgeScores, number> = {
    relevance: 0,
    faithfulness: 0,
    completeness: 0,
    clarity: 0,
  };
  const dimCounts: Record<keyof JudgeScores, number> = {
    relevance: 0,
    faithfulness: 0,
    completeness: 0,
    clarity: 0,
  };
  const down: JudgeCase[] = [];

  for (const item of cases) {
    if (item.createdAt >= windowStart) {
      window30d += 1;
    }
    const latest = latestScoredRun(item);
    const latestScores = latest?.scores;
    if (latest !== undefined && latestScores !== undefined) {
      evaluated += 1;
      if (latest.overall !== undefined) {
        overalls.push(latest.overall);
      }
      if (latest.capped === true) {
        cappedCount += 1;
      }
      for (const key of DIMENSION_KEYS) {
        dimTotals[key] += latestScores[key];
        dimCounts[key] += 1;
      }
    }
    if (item.verdict === 'down') {
      down.push(item);
    }
  }

  const dims: Record<keyof JudgeScores, number | null> = {
    relevance: dimCounts.relevance > 0 ? round1(dimTotals.relevance / dimCounts.relevance) : null,
    faithfulness:
      dimCounts.faithfulness > 0 ? round1(dimTotals.faithfulness / dimCounts.faithfulness) : null,
    completeness:
      dimCounts.completeness > 0 ? round1(dimTotals.completeness / dimCounts.completeness) : null,
    clarity: dimCounts.clarity > 0 ? round1(dimTotals.clarity / dimCounts.clarity) : null,
  };

  const overallSum = overalls.reduce((sum, value) => sum + value, 0);
  const downSamples = down
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, DOWN_SAMPLE_LIMIT)
    .map(toCaseSummary);

  return {
    total: cases.length,
    evaluated,
    window30d,
    cappedCount,
    avgOverall: overalls.length > 0 ? round1(overallSum / overalls.length) : null,
    dims,
    downCount: down.length,
    downSamples,
  };
}

/**
 * 清空内存缓存。
 * 本地数据被删除、或账号切换后必须调用：缓存里还留着刚被删掉的 case，
 * 不失效的话「清除数据 → 打开质量面板」会把已删内容原样读回来。
 */
export function resetJudgeCache(): void {
  cache = null;
  cacheAccountId = null;
  cacheEpoch += 1;
}

/**
 * 删除某账号的全部评测数据（cases 文件 + prompt 快照目录）。
 * 单个删除失败不影响另一个，整体不抛 —— 清理是尽力而为，调用方不该因此失败。
 */
export async function clearJudgeData(accountId: string): Promise<void> {
  // 必须排在已入队的写入之后：否则「清除数据」与「点赞触发的 upsertCase」
  // 并发时，那次 persist 会落在删除之后，把刚清掉的 judge-cases.json 重建出来
  await enqueue(async () => {
    resetJudgeCache();
    await unlink(casesPath(accountId)).catch(() => undefined);
    await rm(promptsDir(accountId), { recursive: true, force: true }).catch(() => undefined);
  });
}

/**
 * 写 prompt 快照：`<账号目录>/judge-prompts/<promptVersion>.txt`。
 *
 * 只按 promptVersion 去重（存在即跳过）：只有哈希能分组不能回溯，
 * 每条 case 各存一份又会让文件数量爆炸。内容就是 `buildPromptVersionSource()`
 * 的返回值，与哈希输入逐字节一致，可随时复算校验。
 *
 * @param promptVersion sha8 指纹（8 位十六进制）
 * @param source 哈希输入全文
 */
export async function writePromptSnapshot(promptVersion: string, source: string): Promise<void> {
  const accountId = getActiveAccountId();
  if (!accountId) {
    return;
  }
  // 指纹本应是 8 位十六进制；仍做一次白名单校验，防止将来调用方传进带路径分隔符的字符串
  if (!/^[0-9a-f]{8}$/.test(promptVersion)) {
    return;
  }
  const dir = promptsDir(accountId);
  const filePath = path.join(dir, `${promptVersion}.txt`);
  const exists = await access(filePath).then(
    () => true,
    () => false,
  );
  if (exists) {
    return;
  }
  await mkdir(dir, { recursive: true });
  // 先写临时文件再 rename：若直接写目标文件且中途失败，留下半截文件后
  // 上面的「存在即跳过」会永久跳过它，快照就再也不会被修正。
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, source, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
