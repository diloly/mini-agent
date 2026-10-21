/**
 * harness 领域事件：agent loop 与外界之间**唯一**的通道。
 *
 * 设计意图（2026-10-20，参照 DSH 的 live 事件域；明确**不建事件总线**）：
 * - loop 只陈述「发生了什么」，不关心谁在听、听者长什么样子；
 * - 事件里没有任何 UI 专属字段：没有 requestId / messageId 这类传输信封，
 *   没有展示态枚举，也没有渲染层才关心的 contentOffset —— 正文与工具的时间线
 *   交错由消费方自己折算（旧口径：该步开始时正文已累积的字符数）；
 * - 落盘时机同样不在 loop 的职责里：conversation-snapshot 是一条中性事实，
 *   是否落盘、落在哪个文件，由消费方自行决定。loop 因此不再 import 任何
 *   checkpoint / storage，工具与 loop 也再也拿不到「推给渲染层」的通道。
 *
 * 对照 DSH（docs/DSH-MIRROR.md §4）：它把同一思路推到极致 —— append-only
 * session log 作为唯一事实源，UI 从 session/event 渲染，实时增量走
 * agent/assistant-stream。我们的约束（单进程 Electron、单人维护、353 行 loop）
 * 撑不起那套基础设施，因此只取「事件契约」这一层：UI 不再依赖 loop 的回调形状，
 * loop 也不再依赖 UI 的概念。将来若要做上下文压缩 / 回放，消费方直接在事件上挂，
 * loop 一行不用改。
 */
import type { LlmMessage } from '../providers/types';

/** 一条计划步骤（语义来源：update_plan 工具的参数；结构与渲染层的 PlanStep 一致，但此处不引用它） */
export interface HarnessPlanStep {
  /** 这一步要做什么，简洁的纯文本 */
  title: string;
  /** pending 待开始 / in_progress 进行中 / done 已完成 */
  status: 'pending' | 'in_progress' | 'done';
}

/**
 * 一次工具调用的事实记录（harness 口径）。
 *
 * 刻意**不含** contentOffset：那是渲染层按正文分段交错的参数，由消费方在收到
 * 事件时自行推算（它自己知道此刻看到多少正文）。旧数据里这个字段仍存在于
 * 持久结构 shared/types.ts 的 ToolStep 上，由适配层负责写上，读取口径不变。
 */
export interface HarnessToolCallRecord {
  id: string;
  name: string;
  /** 模型给出的原始参数 JSON 文本（tool-call-start 时仍在流式累加，故该事件不带此字段） */
  args: string;
  status: 'running' | 'done' | 'error';
  /** 回灌文案的截断摘要（成功为结果前若干字，失败为错误文案） */
  result?: string;
  /** 执行耗时（毫秒）；status 为 running 时无此字段 */
  elapsedMs?: number;
}

/** loop 产出的领域事件全集 */
export type HarnessEvent =
  /** 正文增量（流式） */
  | { type: 'text'; delta: string }
  /**
   * 模型宣布要调用某个工具，或工具即将执行前。
   *
   * 两个时机会广播这条事件：
   * - 流式期间（provider 刚拿到工具名）：参数还在分片累加，**不带** arguments；
   * - 执行前（loop 准备跑这个工具）：参数已流完，**带**完整 arguments。
   * 消费方据此把 running 占位从「空参数」刷新成「完整参数」（长耗时工具执行期间
   * 界面能显示模型到底要它干什么）。同一条 call 的两条事件 id 相同。
   */
  | { type: 'tool-call-start'; id: string; name: string; arguments?: string }
  /**
   * 一次工具调用执行完毕：ok 标识业务成功（被安全边界拒绝、参数非法为 false），
   * preview 是回灌文案的截断摘要。结果已回填进上下文的 tool 消息。
   */
  | {
      type: 'tool-call-end';
      id: string;
      name: string;
      /** 模型给出的完整参数 JSON 文本（到 tool-call-end 时已流完，可用） */
      arguments: string;
      ok: boolean;
      /** 回灌文案的截断摘要 */
      preview: string;
      elapsedMs: number;
    }
  /** 计划清单被整份覆盖更新（update_plan 工具的结果） */
  | { type: 'plan-updated'; steps: HarnessPlanStep[] }
  /**
   * 会话上下文的完整快照：每个工具结果回填后发布一次（含续跑起点兜底）。
   * 这是中性事实，不是 UI 事件——是否需要它来落盘（如「可续跑态」checkpoint）
   * 完全由消费方决定。loop 不感知任何持久化机制。
   */
  | { type: 'conversation-snapshot'; convo: LlmMessage[]; turn: number };

/** loop 的事件出口：同步函数，绝不 await（loop 不做任何投递保障之外的承诺） */
export type HarnessEventSink = (event: HarnessEvent) => void;
