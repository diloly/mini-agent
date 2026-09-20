/**
 * Provider 抽象层：LLMProvider 接口、ProviderConfig、ProviderError 与错误码映射。
 *
 * 本文件是「厂商差异 → 统一错误语义」的收敛点：
 * - ProviderError 统一携带 ErrorCode + 简体中文文案 + 是否可重试；
 * - toProviderError 把 fetch / 解析 / 中止等各类异常收敛为 ProviderError；
 * - unreachableMessage 由各 Provider 自行提供，从而把「Ollama 未启动」这类
 *   厂商专属文案留在 Provider 内，不污染共享层与 IPC 层。
 */
import type { ErrorCode, FinishReason, ModelInfo, ProviderId } from '../../shared/types';
import { ERROR_RETRYABLE, ERROR_TEXT } from '../../shared/types';

/** 暴露给模型的工具声明（JSON Schema，不引 zod） */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 模型请求调用的一次工具 */
export interface LlmToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串（未解析），执行前由 harness 解析 */
  arguments: string;
}

/** 发送给模型的一条消息 */
export interface LlmMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** assistant 消息携带的待执行工具调用 */
  toolCalls?: LlmToolCall[];
  /** role==='tool' 时对应的 tool call id */
  toolCallId?: string;
  /** role==='tool' 时的工具名 */
  name?: string;
}

/**
 * Provider 运行期配置。
 * apiKey 为解密后的明文，仅在主进程内存流转，禁止序列化进日志或落盘。
 */
export interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** 流式回调 */
export interface StreamCallbacks {
  /** 增量文本回调，delta 为本次新增片段（可能包含多个字符） */
  onDelta: (delta: string) => void;
  /** 正常结束回调 */
  onDone?: (result: { text: string; finishReason: FinishReason }) => void;
  /** 异常结束回调（抛出前一定先调用） */
  onError?: (error: ProviderError) => void;
  /** 模型开始请求某个工具时立即回调（用于 UI 立刻显示「正在调用」） */
  onToolCallStart?: (call: { id: string; name: string }) => void;
}

/** chatStream 入参 */
export interface ChatStreamParams {
  messages: LlmMessage[];
  signal: AbortSignal;
  /** 暴露给模型的工具声明；为空或省略时不带工具 */
  tools?: ToolDefinition[];
}

/** chatStream 返回值 */
export interface ChatStreamResult {
  text: string;
  finishReason: FinishReason;
  /** 模型本轮请求调用的工具（无工具调用时为空数组） */
  toolCalls?: LlmToolCall[];
}

/** 模型服务适配器接口 */
export interface LLMProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** 服务不可达时的专属提示文案（用于 UNREACHABLE 错误码） */
  readonly unreachableHint: string;
  /** 是否已具备可用配置，决定 UI 的「未配置态」 */
  isConfigured(config: ProviderConfig): boolean;
  /** 拉取可用模型；失败时抛 ProviderError，UI 允许手填兜底 */
  listModels(config: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]>;
  /** 流式对话：解析 SSE / NDJSON 并通过 onDelta 逐段回调 */
  chatStream(
    params: ChatStreamParams,
    config: ProviderConfig,
    callbacks: StreamCallbacks,
  ): Promise<ChatStreamResult>;
}

/** 统一的 Provider 异常 */
export class ProviderError extends Error {
  public readonly code: ErrorCode;
  public readonly userMessage: string;
  public readonly retryable: boolean;

  /**
   * @param code 面向 UI 的错误码
   * @param userMessage 已本地化的简体中文提示
   * @param retryable 是否可重试
   */
  constructor(code: ErrorCode, userMessage: string, retryable: boolean) {
    super(userMessage);
    this.name = 'ProviderError';
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = retryable;
  }
}

/** 取错误码对应的简体中文文案（文案本体定义在 shared/types.ts，全仓共用） */
export function errorMessage(code: ErrorCode): string {
  return ERROR_TEXT[code];
}

/** 取错误码的可重试标记 */
export function isRetryable(code: ErrorCode): boolean {
  return ERROR_RETRYABLE[code];
}

/**
 * 构造 ProviderError。
 * @param code 错误码
 * @param detail 可选的补充说明（会追加到默认文案后）
 */
export function newProviderError(code: ErrorCode, detail?: string): ProviderError {
  const base = ERROR_TEXT[code];
  const message = detail ? `${base}：${detail}` : base;
  return new ProviderError(code, message, ERROR_RETRYABLE[code]);
}

/** HTTP 状态码 → ProviderError（仅处理已归类的状态码，其余走 UNKNOWN） */
export function providerErrorFromStatus(status: number, detail?: string): ProviderError {
  if (status === 401 || status === 403) {
    return newProviderError('AUTH', detail);
  }
  if (status === 429) {
    return newProviderError('RATE_LIMIT', detail);
  }
  if (status >= 500) {
    return newProviderError('SERVER', `HTTP ${status}${detail ? ` ${detail}` : ''}`);
  }
  if (status >= 400) {
    return newProviderError('BAD_RESPONSE', `HTTP ${status}${detail ? ` ${detail}` : ''}`);
  }
  return newProviderError('UNKNOWN', `HTTP ${status}${detail ? ` ${detail}` : ''}`);
}

/** 读取响应体文本用于错误提示（截断避免日志过长） */
export async function readResponseText(response: {
  text: () => Promise<string>;
}): Promise<string> {
  try {
    const text = await response.text();
    return text.trim().slice(0, 200);
  } catch {
    return '';
  }
}

/** 拼接 API 地址：兼容 Base URL 结尾带斜杠的写法 */
export function joinApiPath(baseUrl: string, apiPath: string): string {
  const normalized = (baseUrl ?? '').trim().replace(/\/+$/, '');
  return `${normalized}/${apiPath.replace(/^\/+/, '')}`;
}

/** 判断异常是否为用户中止 */
export function isAbortError(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    (error as { name?: string }).name === 'AbortError'
  );
}

/** 从异常及其 cause 链上提取底层错误码（如 ECONNREFUSED） */
function extractErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== 'object') {
      return undefined;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** 连接被拒：服务进程未启动 */
const REFUSED_CODES = new Set(['ECONNREFUSED']);
/** 网络类错误：DNS、重置、超时、不可达等 */
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * 把任意异常收敛为 ProviderError。
 * @param error 原始异常
 * @param options.unreachableMessage 该 Provider 的「服务不可达」专属文案
 */
export function toProviderError(
  error: unknown,
  options: { unreachableMessage: string },
): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  if (isAbortError(error)) {
    return new ProviderError('ABORTED', ERROR_TEXT.ABORTED, false);
  }
  const code = extractErrorCode(error);
  if (code && REFUSED_CODES.has(code)) {
    return new ProviderError('UNREACHABLE', options.unreachableMessage, true);
  }
  if (code && NETWORK_CODES.has(code)) {
    return newProviderError('NETWORK', code);
  }
  if (error instanceof TypeError) {
    // fetch 失败在 Node / Electron 中统一抛 TypeError，此处归为网络问题
    return newProviderError('NETWORK');
  }
  if (error instanceof Error && error.message) {
    return newProviderError('UNKNOWN', error.message.slice(0, 120));
  }
  return newProviderError('UNKNOWN');
}

/**
 * 把内部 LlmMessage 映射为 OpenAI 兼容协议的请求体消息。
 *
 * 关键字段名差异（最容易写错的点）：
 * - 内部用 `toolCallId`，协议要求 `tool_call_id`；
 * - assistant 携带工具调用时，协议要求 `tool_calls: [{ id, type:'function', function:{ name, arguments } }]`；
 * - content 在仅有 tool_calls 时传 null，避免部分厂商拒绝空字符串。
 *
 * 这一步必须在发请求前完成，绝不能直接把内部结构 JSON 化发出去。
 */
export function toWireMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'tool') {
      const wire: Record<string, unknown> = {
        role: 'tool',
        content: message.content,
        // 协议字段名是 tool_call_id，不是内部的 toolCallId
        tool_call_id: message.toolCallId ?? '',
      };
      if (typeof message.name === 'string' && message.name.length > 0) {
        wire.name = message.name;
      }
      return wire;
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

/**
 * 把内部 ToolDefinition[] 映射为 OpenAI 兼容协议的 tools 字段。
 *
 * 协议要求每个工具包成 `{ type: 'function', function: { name, description, parameters } }`，
 * 而内部 ToolDefinition 是扁平的 { name, description, parameters }，必须在发请求前包一层。
 * 与 toWireMessages 同理：不能直接把内部结构 JSON 化发出去。
 */
export function toWireTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** 把 JSON 字符串解析为 Ollama 要求的对象；非法或非对象一律回退空对象 */
function parseArgsObject(raw: string): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 把内部 LlmMessage 映射为 Ollama /api/chat 的原生消息格式。
 * 注意：Ollama 不是 OpenAI 协议，不能复用 toWireMessages。
 * - tool 消息用 `tool_name` 关联结果（无 tool_call_id）
 * - assistant 的 function.arguments 必须是对象（不是字符串）
 * - assistant 的 tool_calls 元素无 id / 无 type，content 用原值（通常为空串，而非 null）
 */
export function toOllamaMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        // Ollama 用 tool_name 关联工具结果，而非 OpenAI 的 tool_call_id
        tool_name: message.name ?? '',
      };
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content,
        // Ollama 的 tool_calls 无 id / 无 type 包装，function.arguments 必须是对象
        tool_calls: message.toolCalls.map((call) => ({
          function: {
            name: call.name,
            arguments: parseArgsObject(call.arguments),
          },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}
