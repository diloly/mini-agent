/**
 * Ollama Provider：本地模型服务，无需密钥。
 * - 对话：POST {baseUrl}/api/chat，响应为 NDJSON（每行一个完整 JSON）
 * - 模型列表：GET {baseUrl}/api/tags，模型名形如 qwen2.5:7b，直接作为 model id 使用
 */
import { DEFAULT_BASE_URL, PROVIDER_LABELS, type ModelInfo } from '../../shared/types';
import { combineSignals, parseNdjson } from './sse';
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

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 300_000;
/** 拉取模型列表超时（毫秒）：本地服务，超时窗口短一些 */
const MODELS_TIMEOUT_MS = 3_000;

/** 服务不可达时的专属提示文案（必须明确指向 ollama serve） */
const UNREACHABLE_MESSAGE = '无法连接本地 Ollama 服务，请确认已启动 ollama serve';

/** /api/chat 流式返回的每一行结构 */
interface OllamaChatChunk {
  model?: string;
  created_at?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  error?: string;
}

/** /api/tags 返回结构 */
interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

export const ollamaProvider: LLMProvider = {
  id: 'ollama',
  label: PROVIDER_LABELS.ollama,
  unreachableHint: UNREACHABLE_MESSAGE,

  /** Ollama 无需密钥，配置项完备性取决于是否选定了模型 */
  isConfigured(config: ProviderConfig): boolean {
    return typeof config.model === 'string' && config.model.trim().length > 0;
  },

  /**
   * 拉取本地已安装的模型列表。
   * @param config Provider 配置
   * @param signal 可选中止信号
   */
  async listModels(config: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
    const combined = combineSignals([signal], MODELS_TIMEOUT_MS);
    try {
      const response = await fetch(joinApiPath(config.baseUrl || DEFAULT_BASE_URL.ollama, 'api/tags'), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: combined.signal,
      });
      if (!response.ok) {
        throw providerErrorFromStatus(response.status, await readResponseText(response));
      }
      const payload = (await response.json()) as OllamaTagsResponse;
      const models = (payload.models ?? [])
        .map((item) => item.name ?? item.model ?? '')
        .filter((name): name is string => name.length > 0)
        .map<ModelInfo>((name) => ({ id: name, label: name }));
      return models;
    } finally {
      combined.dispose();
    }
  },

  /**
   * 发起流式对话（NDJSON）。
   * @param params 上下文消息与中止信号
   * @param config Provider 配置
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
      const response = await fetch(joinApiPath(config.baseUrl || DEFAULT_BASE_URL.ollama, 'api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({
          model: config.model,
          messages: params.messages,
          stream: true,
        }),
        signal: combined.signal,
      });

      if (!response.ok) {
        throw providerErrorFromStatus(response.status, await readResponseText(response));
      }
      if (!response.body) {
        throw newProviderError('BAD_RESPONSE', '响应体为空');
      }

      await parseNdjson(
        response.body,
        {
          onRecord: (record) => {
            const chunk = record as OllamaChatChunk;
            if (chunk.error) {
              throw newProviderError('SERVER', chunk.error);
            }
            const delta = chunk.message?.content ?? '';
            if (delta.length > 0) {
              text += delta;
              callbacks.onDelta(delta);
            }
            if (chunk.done === true) {
              finishReason = chunk.done_reason === 'length' ? 'length' : 'stop';
            }
          },
        },
        combined.signal,
      );

      const result: ChatStreamResult = { text, finishReason };
      callbacks.onDone?.(result);
      return result;
    } catch (error) {
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
