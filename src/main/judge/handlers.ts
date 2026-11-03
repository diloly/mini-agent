/**
 * judge IPC 接线：注册 4 个 `judge:*` handler（setFeedback / run / list / summary）。
 *
 * 纪律（与 skills/handlers.ts 同款）：
 * - 每个 handler 整体 try/catch，异常也返回结构化结果，**绝不让 invoke reject** ——
 *   渲染层一旦收不到 resolve，就会永久卡在「评测中」；
 * - 无账号时静默：不落盘、不抛，返回空结果或静默成功；
 * - `judge:run` 用模块级 `inflight` 去重：同一条消息并发点两次只跑一次模型调用，
 *   否则用户连点会白烧两份 token，还会写入两条几乎相同的 run。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  CHANNELS,
  type ChannelName,
  type JudgeListRequest,
  type JudgeListResult,
  type JudgeRunRequest,
  type JudgeRunResult,
  type JudgeSetFeedbackRequest,
  type JudgeSetFeedbackResult,
  type JudgeSummaryRequest,
  type JudgeSummaryResult,
} from '../../shared/ipc-channels';
import {
  JUDGE_CASE_LIMIT,
  type GenerationFingerprint,
  type JudgeCase,
  type Verdict,
} from '../../shared/types';
import { getActiveAccountId, mutateConversations, readConversations } from '../storage';
import { readableJudgeError } from './errors';
import { buildPromptVersionSource } from './fingerprint';
import { evaluateCase } from './run';
import { buildCaseFromMessage } from './snapshot';
import {
  appendRun,
  emptySummary,
  getCaseByMessage,
  listCases,
  setVerdict,
  summarize,
  toCaseSummary,
  upsertCase,
  writePromptSnapshot,
} from './store';

/** 列表缺省返回条数 */
const LIST_DEFAULT_LIMIT = 50;

/** 汇总缺省窗口（天） */
const SUMMARY_DEFAULT_DAYS = 30;

/** 正在评测中的 messageId：去重，避免连点造成重复模型调用 */
const inflight = new Set<string>();

/**
 * 只有「回退到当前模板」的指纹才写快照：消息自带的是历史版本指纹，
 * 我们手上只有当前模板全文，硬写会让文件名与内容永久不符。
 * 写失败不影响主流程（快照只是审计辅助，缺了不影响评测）。
 */
async function ensurePromptSnapshot(generation: GenerationFingerprint): Promise<void> {
  if (generation.promptVersionSource !== 'current') {
    return;
  }
  await writePromptSnapshot(generation.promptVersion, buildPromptVersionSource()).catch(
    () => undefined,
  );
}

/**
 * 取 case；不存在则按需补建（点赞即建 case 的兜底路径）。
 *
 * @returns 建不出来（消息不存在 / 报错轮次 / 找不到提问）时返回 undefined
 */
async function ensureCase(
  conversationId: string,
  messageId: string,
): Promise<JudgeCase | undefined> {
  const existing = await getCaseByMessage(messageId);
  if (existing) {
    // 快照可能已过期：用户在 case 建立后点了「继续」，同一个 messageId 的正文被补全了。
    // 命中时对齐到当前正文，否则评测的是半截回答，而用户看到的是完整回答。
    const conversations = await readConversations();
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation) {
      return existing;
    }
    const refreshed = buildCaseFromMessage(conversation, messageId);
    if (!refreshed) {
      // 消息可能已被删或变成报错轮次：保留旧 case，不清空已有评测结果
      return existing;
    }
    // 只比正文与轨迹：指纹字段允许随时间变化（appVersion 升级不该触发重写）
    const unchanged =
      refreshed.answer === existing.answer &&
      JSON.stringify(refreshed.steps) === JSON.stringify(existing.steps);
    if (unchanged) {
      return existing;
    }
    await upsertCase(refreshed);
    await ensurePromptSnapshot(refreshed.generation);
    // 返回与落盘一致的形态：身份字段与历史结果沿用旧 case
    return {
      ...refreshed,
      id: existing.id,
      createdAt: existing.createdAt,
      runs: existing.runs,
      ...(existing.verdict !== undefined ? { verdict: existing.verdict } : {}),
    };
  }
  const conversations = await readConversations();
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) {
    return undefined;
  }
  const created = buildCaseFromMessage(conversation, messageId);
  if (!created) {
    return undefined;
  }
  await upsertCase(created);
  await ensurePromptSnapshot(created.generation);
  return created;
}

/** 注册全部 `judge:*` handler。每个 handler 自行 try/catch，绝不 reject。 */
export function registerJudgeHandlers(): void {
  /** 注册单个 invoke 通道；先 removeHandler 再 handle，开发期热重载不报重复注册 */
  function handle<TArgs extends unknown[], TResult>(
    channel: ChannelName,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult>,
  ): void {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
  }

  handle(
    CHANNELS.JUDGE_SET_FEEDBACK,
    async (_event, req: JudgeSetFeedbackRequest): Promise<JudgeSetFeedbackResult> => {
      try {
        const conversationId = typeof req?.conversationId === 'string' ? req.conversationId : '';
        const messageId = typeof req?.messageId === 'string' ? req.messageId : '';
        const rawVerdict = req?.verdict;
        // 只有 'up' / 'down' 是有效评价，其余（含 undefined）一律按「取消」处理
        const verdict: Verdict | null = rawVerdict === 'up' || rawVerdict === 'down' ? rawVerdict : null;
        if (conversationId.length === 0 || messageId.length === 0) {
          return { ok: false, error: '参数缺失：conversationId 与 messageId 必填' };
        }
        // 未登录：静默成功，不落盘（与 storage 其余写路径同口径）
        if (!getActiveAccountId()) {
          return verdict === null ? { ok: true } : { ok: true, verdict };
        }

        // ① 先写 meta：反馈绝不能因为后面的 case 写失败而丢
        const metaWritten = await mutateConversations<boolean>((list) => {
          const conversation = list.find((item) => item.id === conversationId);
          if (!conversation) {
            return false;
          }
          const message = conversation.messages.find((item) => item.id === messageId);
          if (!message || message.role !== 'assistant') {
            return false;
          }
          const meta = message.meta ?? {};
          if (verdict === null) {
            // 取消评价：删字段，不留 `"feedback": null` 这种第三态
            delete meta.feedback;
            delete meta.feedbackAt;
          } else {
            meta.feedback = verdict;
            meta.feedbackAt = Date.now();
          }
          message.meta = meta;
          return true;
        });
        if (!metaWritten) {
          return { ok: false, error: '找不到要评价的消息' };
        }

        // ② 再维护 case：失败也只降级为「带 error 的成功」，不推翻已落盘的反馈
        let caseId: string | undefined;
        let caseError: string | undefined;
        try {
          const target = await ensureCase(conversationId, messageId);
          if (target) {
            caseId = target.id;
            await setVerdict(messageId, verdict);
          } else {
            caseError = '该回答不能建立评测记录（报错或没有对应提问的回答不参与评测）';
          }
        } catch (error) {
          caseError = readableJudgeError(error, '评测记录写入失败');
        }

        return {
          ok: true,
          ...(verdict !== null ? { verdict } : {}),
          ...(caseId !== undefined ? { caseId } : {}),
          ...(caseError !== undefined ? { error: caseError } : {}),
        };
      } catch (error) {
        return {
          ok: false,
          error: readableJudgeError(error, '保存评价失败'),
        };
      }
    },
  );

  handle(
    CHANNELS.JUDGE_RUN,
    async (_event, req: JudgeRunRequest): Promise<JudgeRunResult> => {
      try {
        const conversationId = typeof req?.conversationId === 'string' ? req.conversationId : '';
        const messageId = typeof req?.messageId === 'string' ? req.messageId : '';
        if (conversationId.length === 0 || messageId.length === 0) {
          return { ok: false, error: '参数缺失：conversationId 与 messageId 必填' };
        }
        if (inflight.has(messageId)) {
          return { ok: false, error: '正在评测中，请稍候' };
        }
        if (!getActiveAccountId()) {
          return { ok: false, error: '未登录，无法保存评测结果' };
        }

        inflight.add(messageId);
        try {
          const target = await ensureCase(conversationId, messageId);
          if (!target) {
            return { ok: false, error: '该回答不能建立评测记录（报错或没有对应提问的回答不参与评测）' };
          }
          const run = await evaluateCase(target);
          await appendRun(messageId, run);
          return {
            ok: run.error === undefined,
            ...(run.error !== undefined ? { error: run.error } : {}),
            run,
          };
        } finally {
          inflight.delete(messageId);
        }
      } catch (error) {
        return {
          ok: false,
          error: readableJudgeError(error, '评测失败'),
        };
      }
    },
  );

  handle(
    CHANNELS.JUDGE_LIST,
    async (_event, req: JudgeListRequest): Promise<JudgeListResult> => {
      try {
        const request = req ?? {};
        const all = await listCases();
        const conversationId =
          typeof request.conversationId === 'string' ? request.conversationId : '';
        const filtered =
          conversationId.length > 0
            ? all.filter((item) => item.conversationId === conversationId)
            : all;
        const requested =
          typeof request.limit === 'number' && Number.isInteger(request.limit) && request.limit > 0
            ? request.limit
            : 0;
        const limit = requested > 0 ? Math.min(requested, JUDGE_CASE_LIMIT) : LIST_DEFAULT_LIMIT;
        // 按创建时间倒序（最近的 case 先看），再截断；摘要不含 answer / steps
        return filtered
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit)
          .map(toCaseSummary);
      } catch {
        return [];
      }
    },
  );

  handle(
    CHANNELS.JUDGE_SUMMARY,
    async (_event, req: JudgeSummaryRequest): Promise<JudgeSummaryResult> => {
      try {
        const request = req ?? {};
        const days =
          typeof request.days === 'number' && Number.isInteger(request.days) && request.days > 0
            ? request.days
            : SUMMARY_DEFAULT_DAYS;
        return await summarize(days);
      } catch {
        // 汇总通道的返回类型是结构体而非 {ok}，失败时给空态（界面显示「暂无数据」）
        return emptySummary();
      }
    },
  );
}
