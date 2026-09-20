/**
 * 手写 agent loop：带 tools 反复调用模型，直到模型不再请求工具或达到轮数上限。
 *
 * 流程：
 *   用户提问 → 带 tools 调模型 → 有 tool_calls？→ 本地串行执行 → 结果回填 → 再调模型（最多 8 轮）
 *                                                  └ 无 tool_calls → 输出文本，结束
 *
 * 关键约定：
 * - 工具执行失败绝不让整轮走到 chat:error——失败文案同样作为 tool 消息回灌给模型，由其自行解释；
 * - text 跨轮累积，最终返回完整全文；
 * - 每轮开头检查 signal.aborted，已中止立即抛 createAbortError()，让上层按 ABORTED 收尾；
 * - 工具并行执行不做（MVP 串行，顺序更利于 UI 展示）。
 */
import type { FinishReason, ToolStep } from '../../shared/types';
import type {
  LLMProvider,
  LlmMessage,
  LlmToolCall,
  ProviderConfig,
} from '../providers/types';
import { createAbortError } from '../providers/sse';
import { HARNESS_TOOLS, findTool } from './tools';
import type { ToolResult } from './types';

/** agent loop 的最大轮数：超过则强制收尾，避免模型无限调用工具 */
const MAX_TURNS = 8;

/** 工具结果回显给模型前的最大长度，超出部分截断 */
const TOOL_RESULT_PREVIEW_LIMIT = 200;

/** 模型开始请求某个工具时的即时通知（用于 UI 立刻显示「正在调用」） */
interface ToolCallStartInfo {
  id: string;
  name: string;
}

/** loop 向调用方的回调：文本增量 + 工具步骤快照 */
export interface HarnessCallbacks {
  onDelta: (delta: string) => void;
  onStep: (step: ToolStep) => void;
}

/** loop 的最终产物 */
export interface HarnessResult {
  text: string;
  finishReason: FinishReason;
  /** 实际消耗的轮数 */
  turns: number;
  /** 全部工具步骤（含 running / done / error 的最终态） */
  steps: ToolStep[];
}

/**
 * 执行单个工具调用，并把结果回填进上下文。
 * 不抛异常：工具不存在、执行异常都转成可读字符串，照常回灌给模型。
 */
async function executeToolCall(
  call: LlmToolCall,
  convo: LlmMessage[],
  steps: ToolStep[],
  callbacks: HarnessCallbacks,
  signal: AbortSignal,
): Promise<void> {
  // 执行前刷新一次 running 步骤，把模型给出的参数展示出来（覆盖 onToolCallStart 时建的那个空参数步骤）
  callbacks.onStep({
    id: call.id,
    name: call.name,
    args: call.arguments,
    status: 'running',
  });

  const start = Date.now();
  const tool = findTool(call.name);

  let result: ToolResult;
  try {
    if (!tool) {
      // 模型请求了一个不存在的工具：结构化失败，但照常回灌，不中断整轮
      result = { ok: false, text: `未知工具：${call.name}` };
    } else {
      // execute 自行负责解析参数与吞掉异常，返回 { ok, text }
      result = await tool.execute(call.arguments, signal);
    }
  } catch (error) {
    // execute 约定不抛异常，但以防万一漏网，这里兜底，绝不让整轮走到 chat:error
    result = { ok: false, text: `工具执行异常：${error instanceof Error ? error.message : String(error)}` };
  }

  const elapsedMs = Date.now() - start;
  const resultPreview = result.text.slice(0, TOOL_RESULT_PREVIEW_LIMIT);

  // 无论 ok 与否都把结果回填为 tool 消息，让模型自己解释失败原因
  convo.push({
    role: 'tool',
    content: result.text,
    toolCallId: call.id,
    name: call.name,
  });

  const step: ToolStep = {
    id: call.id,
    name: call.name,
    args: call.arguments,
    // ✓ / ✕ 由 ok 决定：被安全边界拒绝、参数非法等都显示红叉
    status: result.ok ? 'done' : 'error',
    result: resultPreview,
    elapsedMs,
  };
  steps.push(step);
  // 推送最终态步骤（与在先的 running 步骤同 id，渲染层按 id 覆盖）
  callbacks.onStep(step);
}

/**
 * 运行手写 agent loop。
 * @param provider 模型适配器
 * @param providerConfig 运行期配置（含明文 Key）
 * @param messages 已含本轮 user 提问的上下文
 * @param signal 中止信号
 * @param callbacks 文本增量与工具步骤回调
 */
export async function runAgentLoop(params: {
  provider: LLMProvider;
  providerConfig: ProviderConfig;
  messages: LlmMessage[];
  signal: AbortSignal;
  callbacks: HarnessCallbacks;
}): Promise<HarnessResult> {
  const { provider, providerConfig, messages, signal, callbacks } = params;
  // 复制一份上下文，loop 内部会不断追加 assistant / tool 消息，不能污染入参
  const convo: LlmMessage[] = [...messages];

  let text = '';
  const steps: ToolStep[] = [];

  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    // 每轮开头先检查中止：用户点停止后尽快退出，避免再发一次请求烧 token
    if (signal.aborted) {
      throw createAbortError();
    }

    const result = await provider.chatStream(
      {
        messages: convo,
        tools: HARNESS_TOOLS.map((tool) => tool.definition),
        signal,
      },
      providerConfig,
      {
        onDelta: (delta) => {
          // text 跨轮累积，最终返回完整全文
          text += delta;
          callbacks.onDelta(delta);
        },
        onToolCallStart: (call: ToolCallStartInfo) => {
          // 模型刚宣布要调工具：立刻推一个 running 步骤，让 UI 显示「正在调用」
          callbacks.onStep({
            id: call.id,
            name: call.name,
            args: '',
            status: 'running',
          });
        },
      },
    );

    // 模型没再要工具 → 这轮就是最终答案
    const toolCalls = result.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return { text, finishReason: result.finishReason, turns: turn, steps };
    }

    // 把 assistant 这轮的发言（含它想调的工具）原样存回上下文
    convo.push({
      role: 'assistant',
      content: result.text,
      toolCalls,
    });

    // 依次串行执行每个工具，结果回填——顺序执行更利于 UI 逐步展示
    for (const call of toolCalls) {
      await executeToolCall(call, convo, steps, callbacks, signal);
    }
  }

  // 达到轮数上限：给模型一个收尾提示，避免界面「卡住」看起来像没结束
  const note = '\n（已达到工具调用轮数上限，停止进一步操作）';
  text += note;
  return { text, finishReason: 'length', turns: MAX_TURNS, steps };
}
