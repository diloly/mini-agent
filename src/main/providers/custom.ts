/**
 * 自定义 Provider：OpenAI 兼容协议（Base URL 与 API Key 均由用户自填）。
 * - 对话：POST {baseUrl}/chat/completions，SSE 流式，delta 取 choices[0].delta.content
 * - 模型列表：GET {baseUrl}/models，失败或空列表一律返回空数组（不造假回退）
 *
 * 与 DeepSeek Provider 的两处关键差异（改这个文件前先读 deepseek.ts，其余逻辑同源）：
 * 1. API Key 可选 —— 本地 OpenAI 兼容服务（vLLM / Ollama 的 /v1 / LM Studio）常免密钥，
 *    因此 isConfigured 不判 key；请求头也只在真的持有非空 key 时才带 Authorization，
 *    绝不发一个空 Bearer 出去（部分服务会因畸形鉴权头直接 401）。
 * 2. 模型列表不造假 —— DeepSeek 的兜底列表是它的真模型，自定义服务没有可回退的真值，
 *    拉不到就回空数组，让设置页提示用户手填模型名。
 *
 * 注意：明文 apiKey 只在本文件运行期间存在于 ProviderConfig 中，绝不落盘、绝不跨进程传递。
 */
import { PROVIDER_LABELS, type ModelInfo } from '../../shared/types';
import { combineSignals, parseSse } from './sse';
import {
  ProviderError,
  joinApiPath,
  newProviderError,
  providerErrorFromStatus,
  readResponseText,
  toProviderError,
  toWireMessages,
  toWireTools,
  type ChatStreamParams,
  type ChatStreamResult,
  type LlmToolCall,
  type LLMProvider,
  type ProviderConfig,
  type StreamCallbacks,
} from './types';

/** 请求超时（毫秒）：流式生成耗时较长，给足余量 */
const REQUEST_TIMEOUT_MS = 120_000;
/** 拉取模型列表超时（毫秒） */
const MODELS_TIMEOUT_MS = 8_000;

/** 服务不可达时的专属提示文案 */
const UNREACHABLE_MESSAGE = '无法连接模型服务，请检查 Base URL 是否正确';

/** SSE 中单个 chunk 的结构（只声明用到的字段） */
interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string;
      // 流式 tool_calls 是分片：同一 index 的 arguments 会跨多个 chunk 累加，流结束前不是合法 JSON
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; code?: string };
}

/** 流式聚合中的单个工具调用暂存结构 */
interface ToolCallAcc {
  id: string;
  name: string;
  /** arguments 分片累加后的完整字符串 */
  argsText: string;
}

/** 模型列表响应结构 */
interface ModelListResponse {
  data?: Array<{ id?: string }>;
}

/**
 * 非流式错误的 HTTP 状态处理。
 * @param response fetch 响应
 */
async function throwIfNotOk(response: { ok: boolean; status: number; text: () => Promise<string> }): Promise<void> {
  if (response.ok) {
    return;
  }
  const detail = await readResponseText(response);
  throw providerErrorFromStatus(response.status, detail);
}

/**
 * 配置完备性判据：Base URL 与模型都已填写即视为可用。
 * 刻意不判 apiKey —— 本地服务常免密钥，key 只影响要不要发 Authorization 头。
 * 定义为独立函数（而非依赖 this），避免解构调用时丢失上下文。
 */
function isConfigured(config: ProviderConfig): boolean {
  return config.baseUrl.trim().length > 0 && config.model.trim().length > 0;
}

/**
 * 按需构造鉴权头：只在真的持有非空 key 时才带 Authorization。
 * @param apiKey 明文密钥（可能为 undefined）
 */
function authHeaders(apiKey: string | undefined): Record<string, string> {
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return { Authorization: `Bearer ${apiKey}` };
  }
  return {};
}

export const customProvider: LLMProvider = {
  id: 'custom',
  label: PROVIDER_LABELS.custom,
  unreachableHint: UNREACHABLE_MESSAGE,

  isConfigured,

  /**
   * 拉取模型列表；任何失败都返回空数组（不造假回退，UI 允许手填）。
   * @param config Provider 配置
   * @param signal 可选中止信号
   */
  async listModels(config: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
    if (!isConfigured(config)) {
      return [];
    }
    const combined = combineSignals([signal], MODELS_TIMEOUT_MS);
    try {
      const response = await fetch(joinApiPath(config.baseUrl, 'models'), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...authHeaders(config.apiKey),
        },
        signal: combined.signal,
      });
      if (!response.ok) {
        // 模型列表属于辅助能力，失败不应打断主流程
        return [];
      }
      const payload = (await response.json()) as ModelListResponse;
      // 与 DeepSeek 不同：这里没有 FALLBACK_MODELS 可回退，空列表就老实返回空
      return (payload.data ?? [])
        .filter((item): item is { id: string } => typeof item?.id === 'string' && item.id.length > 0)
        .map<ModelInfo>((item) => ({ id: item.id, label: item.id }));
    } catch {
      return [];
    } finally {
      combined.dispose();
    }
  },

  /**
   * 发起流式对话。
   * @param params 上下文消息与中止信号
   * @param config Provider 配置（含明文 apiKey，可能为空）
   * @param callbacks 增量 / 结束 / 异常回调
   */
  async chatStream(
    params: ChatStreamParams,
    config: ProviderConfig,
    callbacks: StreamCallbacks,
  ): Promise<ChatStreamResult> {
    const combined = combineSignals([params.signal], REQUEST_TIMEOUT_MS);
    let text = '';
    let finishReason: ChatStreamResult['finishReason'] = 'stop';
    // 流式 tool_calls 聚合：按 delta.tool_calls[].index 暂存，流结束后再转成 LlmToolCall[]
    const toolCallAcc = new Map<number, ToolCallAcc>();

    try {
      // 构造请求体：内部 LlmMessage 必须先映射成 OpenAI 协议格式（字段名 tool_call_id 等）
      const body: Record<string, unknown> = {
        // 自定义服务不回退默认模型：空模型会被 isConfigured 拦在上游
        model: config.model,
        messages: toWireMessages(params.messages),
        stream: true,
      };
      if (params.tools && params.tools.length > 0) {
        // 内部 ToolDefinition 是扁平的，发请求前包成 OpenAI 的 { type:'function', function:{...} }
        body.tools = toWireTools(params.tools);
        body.tool_choice = 'auto';
      }

      const response = await fetch(joinApiPath(config.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...authHeaders(config.apiKey),
        },
        body: JSON.stringify(body),
        signal: combined.signal,
      });

      await throwIfNotOk(response);

      if (!response.body) {
        throw newProviderError('BAD_RESPONSE', '响应体为空');
      }

      await parseSse(
        response.body,
        {
          onData: (data) => {
            if (data === '[DONE]') {
              return;
            }
            let chunk: ChatCompletionChunk;
            try {
              chunk = JSON.parse(data) as ChatCompletionChunk;
            } catch {
              throw newProviderError('BAD_RESPONSE', 'SSE 数据解析失败');
            }
            if (chunk.error) {
              throw newProviderError('SERVER', chunk.error.message ?? '模型服务返回错误');
            }
            const choice = chunk.choices?.[0];
            const delta = choice?.delta?.content ?? '';
            if (delta.length > 0) {
              text += delta;
              callbacks.onDelta(delta);
            }
            // 聚合流式 tool_calls：按 index 累加，arguments 是分片字符串，流结束前不是合法 JSON
            const toolCallDeltas = choice?.delta?.tool_calls;
            if (toolCallDeltas) {
              for (const tc of toolCallDeltas) {
                const idx = tc.index;
                const entry = toolCallAcc.get(idx) ?? { id: '', name: '', argsText: '' };
                // id 通常只在首个分片出现，后续分片不带，不能覆盖成 undefined
                if (typeof tc.id === 'string' && tc.id.length > 0) {
                  entry.id = tc.id;
                }
                const fnName = tc.function?.name;
                const fnArgs = tc.function?.arguments;
                if (typeof fnName === 'string' && fnName.length > 0) {
                  const isFirstTime = entry.name.length === 0;
                  entry.name = fnName;
                  // 仅在首次拿到工具名时通知 UI「正在调用」，避免每个分片都触发
                  if (isFirstTime) {
                    callbacks.onToolCallStart?.({ id: entry.id, name: fnName });
                  }
                }
                // arguments 必须累加（是分片），不能直接赋值
                if (typeof fnArgs === 'string') {
                  entry.argsText += fnArgs;
                }
                toolCallAcc.set(idx, entry);
              }
            }
            const reason = choice?.finish_reason;
            // finish_reason 为 tool_calls 仍按正常结束（stop）处理，不要当成异常
            if (reason === 'length') {
              finishReason = 'length';
            } else if (reason === 'stop' || reason === 'tool_calls') {
              finishReason = 'stop';
            }
          },
        },
        combined.signal,
      );

      // 流结束后，按 index 升序把暂存结构转成 LlmToolCall[]
      const toolCalls: LlmToolCall[] = [...toolCallAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([idx, entry]) => ({
          id: entry.id || `call-${idx}`,
          name: entry.name,
          arguments: entry.argsText,
        }))
        .filter((call) => call.name.length > 0);

      const result: ChatStreamResult = { text, finishReason, toolCalls };
      callbacks.onDone?.(result);
      return result;
    } catch (error) {
      // 超时由内部信号触发，与用户主动中止区分开
      const providerError = combined.isTimeout()
        ? new ProviderError('NETWORK', '请求超时，请检查网络后重试', true)
        : toProviderError(error, { unreachableMessage: UNREACHABLE_MESSAGE });
      // 用户主动停止不算错误，不触发 onError
      if (providerError.code !== 'ABORTED') {
        callbacks.onError?.(providerError);
      }
      throw providerError;
    } finally {
      combined.dispose();
    }
  },
};
