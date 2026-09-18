/**
 * DeepSeek Provider：OpenAI 兼容协议。
 * - 对话：POST {baseUrl}/chat/completions，SSE 流式，delta 取 choices[0].delta.content
 * - 模型列表：GET {baseUrl}/models（需要 Bearer 鉴权），失败时回退到内置静态列表
 *
 * 注意：明文 apiKey 只在本文件运行期间存在于 ProviderConfig 中，绝不落盘、绝不跨进程传递。
 */
import { DEFAULT_BASE_URL, DEFAULT_MODEL, PROVIDER_LABELS, type ModelInfo } from '../../shared/types';
import { combineSignals, parseSse } from './sse';
import {
  ProviderError,
  joinApiPath,
  newProviderError,
  providerErrorFromStatus,
  readResponseText,
  toProviderError,
  type ChatStreamParams,
  type ChatStreamResult,
  type LLMProvider,
  type ProviderConfig,
  type StreamCallbacks,
} from './types';

/** 请求超时（毫秒）：流式生成耗时较长，给足余量 */
const REQUEST_TIMEOUT_MS = 120_000;
/** 拉取模型列表超时（毫秒） */
const MODELS_TIMEOUT_MS = 8_000;

/** 服务不可达时的专属提示文案 */
const UNREACHABLE_MESSAGE = '无法连接模型服务，请检查网络或 Base URL 配置';

/** DeepSeek 公开模型的兜底列表（网络拉取失败时使用） */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'deepseek-chat', label: 'DeepSeek Chat' },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
];

/** SSE 中单个 chunk 的结构（只声明用到的字段） */
interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { role?: string; content?: string };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; code?: string };
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
 * 配置完备性判据：是否持有可用的 API Key。
 * 定义为独立函数（而非依赖 this），避免解构调用时丢失上下文。
 */
function isConfigured(config: ProviderConfig): boolean {
  return typeof config.apiKey === 'string' && config.apiKey.trim().length > 0;
}

export const deepseekProvider: LLMProvider = {
  id: 'deepseek',
  label: PROVIDER_LABELS.deepseek,
  unreachableHint: UNREACHABLE_MESSAGE,

  /** DeepSeek 的配置完备性取决于是否持有可用的 API Key */
  isConfigured,

  /**
   * 拉取模型列表；失败时回退内置列表，保证 UI 始终有可选项。
   * @param config Provider 配置
   * @param signal 可选中止信号
   */
  async listModels(config: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
    // 未配置 Key 时也回退内置列表，保证 UI 的模型选择框始终有可选项
    if (!isConfigured(config)) {
      return FALLBACK_MODELS;
    }
    const combined = combineSignals([signal], MODELS_TIMEOUT_MS);
    try {
      const response = await fetch(joinApiPath(config.baseUrl || DEFAULT_BASE_URL.deepseek, 'models'), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.apiKey ?? ''}`,
          Accept: 'application/json',
        },
        signal: combined.signal,
      });
      if (!response.ok) {
        // 模型列表属于辅助能力，失败不应打断主流程
        return FALLBACK_MODELS;
      }
      const payload = (await response.json()) as ModelListResponse;
      const models = (payload.data ?? [])
        .filter((item): item is { id: string } => typeof item?.id === 'string' && item.id.length > 0)
        .map<ModelInfo>((item) => ({ id: item.id, label: item.id }));
      return models.length > 0 ? models : FALLBACK_MODELS;
    } catch {
      return FALLBACK_MODELS;
    } finally {
      combined.dispose();
    }
  },

  /**
   * 发起流式对话。
   * @param params 上下文消息与中止信号
   * @param config Provider 配置（含明文 apiKey）
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

    try {
      const response = await fetch(joinApiPath(config.baseUrl || DEFAULT_BASE_URL.deepseek, 'chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey ?? ''}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: config.model || DEFAULT_MODEL.deepseek,
          messages: params.messages,
          stream: true,
        }),
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
            const delta = chunk.choices?.[0]?.delta?.content ?? '';
            if (delta.length > 0) {
              text += delta;
              callbacks.onDelta(delta);
            }
            const reason = chunk.choices?.[0]?.finish_reason;
            if (reason === 'length') {
              finishReason = 'length';
            } else if (reason === 'stop') {
              finishReason = 'stop';
            }
          },
        },
        combined.signal,
      );

      const result: ChatStreamResult = { text, finishReason };
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
