/**
 * Conversation + Message → JudgeCase 快照。
 *
 * 三个要点：
 * 1. **快照而非引用**：会话删除、消息编辑重发都不该改动已归档的评测数据，
 *    所以 question / answer / steps / 指纹全部在这里复制一份落进 case。
 * 2. **指纹优先取消息自带的**：`meta.promptVersion` / `meta.toolSetHash` 是生成那一刻
 *    由 finalize 写下的，才是「模型当时看到的形态」。缺失（老消息、未配置短路）时
 *    才回退现值，绝不因为缺字段就拒建 case。
 * 3. **报错轮次不建 case**（PRD Q5）：错误文案不是有效产出，让它进评测集会污染平均分。
 *    中止（aborted）允许建 —— 用户可能就是要评「为什么它停了」。
 */
import { randomUUID } from 'node:crypto';
import {
  JUDGE_ANSWER_MAX_CHARS,
  JUDGE_QUESTION_MAX_CHARS,
  JUDGE_STEP_ARGS_MAX_CHARS,
  type Conversation,
  type GenerationFingerprint,
  type JudgeCase,
  type Message,
  type ToolStep,
} from '../../shared/types';
import { TOOL_RESULT_PREVIEW_LIMIT } from '../harness';
import { isProviderId } from '../providers';
import { computePromptVersion, computeQuestionHash, getAppVersion } from './fingerprint';

/**
 * 从 assistant 消息往前找最近一条 user 消息，返回其正文。
 * 用倒序 for 循环而不是 ES2023 的 findLast（ES2022 锁死）。
 *
 * @param messages 会话全量消息
 * @param assistantIndex 被评测的 assistant 消息下标
 */
function findQuestion(messages: Message[], assistantIndex: number): string | null {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate.role === 'user') {
      return candidate.content;
    }
  }
  return null;
}

/**
 * 工具步骤快照：只留评测需要的字段。
 *
 * 刻意丢掉 `contentOffset`：它只服务于渲染层的时间线交错，与「模型看到了什么」无关。
 *
 * 两个长度上限都是**与 judge 输入侧共用的常量**，不是各写一个数字：
 * - result 用 harness 的 TOOL_RESULT_PREVIEW_LIMIT（200 字）；
 * - args 用 shared 的 JUDGE_STEP_ARGS_MAX_CHARS（500 字）。
 * 一旦两侧漂移，judge 就会按「模型没看到的全文」判忠实度，结论失真。
 *
 * args 必须落盘前就截断：`write_text_file` / `edit_text_file` 的 args 里装着整份文件正文
 * （工具侧上限 200_000 字符），而每次点赞 / 评测都会把整份 cases 全量重写一遍 ——
 * 一条 200KB 的 case 就足以让「点一下拇指」变得卡顿。
 */
function snapshotSteps(steps: ToolStep[] | undefined): ToolStep[] {
  if (!steps || steps.length === 0) {
    return [];
  }
  return steps.map((step) => {
    const copy: ToolStep = {
      id: step.id,
      name: step.name,
      args:
        step.args.length > JUDGE_STEP_ARGS_MAX_CHARS
          ? step.args.slice(0, JUDGE_STEP_ARGS_MAX_CHARS)
          : step.args,
      status: step.status,
    };
    if (step.result !== undefined) {
      copy.result = step.result.slice(0, TOOL_RESULT_PREVIEW_LIMIT);
    }
    if (step.elapsedMs !== undefined) {
      copy.elapsedMs = step.elapsedMs;
    }
    return copy;
  });
}

/**
 * 由会话与 assistant 消息 id 构造一条 case 快照。
 *
 * @param conversation 该消息所属会话（只读，不会被修改）
 * @param messageId 被评测的 assistant 消息 id（同时是幂等键）
 * @returns 可落盘的 case；消息不存在 / 不是 assistant / 报错轮次 / 找不到提问时返回 null
 */
export function buildCaseFromMessage(
  conversation: Conversation,
  messageId: string,
): JudgeCase | null {
  const index = conversation.messages.findIndex((item) => item.id === messageId);
  if (index < 0) {
    return null;
  }
  const message = conversation.messages[index];
  if (message.role !== 'assistant') {
    return null;
  }

  const meta = message.meta;
  // 报错轮次不建 case：errorCode 存在或 finishReason 为 error 都算
  if (meta?.finishReason === 'error' || meta?.errorCode !== undefined) {
    return null;
  }

  const fullQuestion = findQuestion(conversation.messages, index);
  if (fullQuestion === null) {
    return null;
  }

  // 提问同样设上限：用户粘贴长文档时，question 会让单条 case 无上限膨胀。
  // questionHash 必须用截断后的文本算 —— 否则同一份截断内容会有两个哈希。
  const question =
    fullQuestion.length > JUDGE_QUESTION_MAX_CHARS
      ? fullQuestion.slice(0, JUDGE_QUESTION_MAX_CHARS)
      : fullQuestion;

  const fullAnswer = message.content;
  const answerTruncated = fullAnswer.length > JUDGE_ANSWER_MAX_CHARS;
  const answer = answerTruncated ? fullAnswer.slice(0, JUDGE_ANSWER_MAX_CHARS) : fullAnswer;

  // meta 可能整个缺失（老消息），先把要用的值取出来，避免在分支里反复做空值推导
  const metaProviderId = meta?.providerId;
  const providerId = isProviderId(metaProviderId) ? metaProviderId : conversation.providerId;
  // 消息自带的是「生成那一刻」的指纹；缺失时（老消息 / 未配置短路）回退当前值，
  // 但必须记下来源 —— 回退值对应的模板全文只有我们手上这份，历史版本已无从复原。
  const recordedPromptVersion = meta?.promptVersion;
  const generation: GenerationFingerprint = {
    providerId,
    model: meta?.model ?? conversation.model,
    // toolSetHash 缺失时回退空串（空串明确表示「当时没记下来」，比编一个假指纹诚实）
    promptVersion: recordedPromptVersion ?? computePromptVersion(),
    promptVersionSource: recordedPromptVersion !== undefined ? 'message' : 'current',
    toolSetHash: meta?.toolSetHash ?? '',
    appVersion: getAppVersion(),
  };
  const turns = meta?.turns;
  if (turns !== undefined) {
    generation.turns = turns;
  }

  const finishReason = meta?.finishReason;
  return {
    id: randomUUID(),
    conversationId: conversation.id,
    messageId: message.id,
    createdAt: Date.now(),
    question,
    questionHash: computeQuestionHash(question),
    answer,
    answerTruncated,
    steps: snapshotSteps(meta?.steps),
    ...(finishReason !== undefined ? { finishReason } : {}),
    generation,
    runs: [],
  };
}
