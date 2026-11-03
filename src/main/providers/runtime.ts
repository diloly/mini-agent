/**
 * Provider 运行期配置的构造：把磁盘上的配置（含 safeStorage 密文）解成调用所需的形态。
 *
 * 从 `ipc.ts` 提取而来，供两处共用：
 * - `ipc.ts`：对话 / 续跑 / 模型列表等全部请求；
 * - `judge/run.ts`：评测调用（评测走的是同一个 Provider 层）。
 *
 * 🔴 全仓**只允许存在这一份实现**：两处各写一份，最容易出现的漂移是
 * 「评测忘了传 numCtx」或「解密方式不一致」，那类问题在界面上完全看不出来。
 *
 * 明文 Key 仅存在于主进程内存，绝不通过 IPC 外传。
 */
import type { AppConfig, ProviderId } from '../../shared/types';
import { loadSecret } from '../secret';
import type { ProviderConfig } from './types';

/**
 * 各 Provider 的通用配置片段。
 * DeepSeek / Custom 额外带 apiKeyEnc，Ollama 额外带 numCtx；
 * 用「宽类型 + 类型断言」取片段，避免对 providerId 做三处分支判断。
 */
export interface ProviderSettingsLike {
  baseUrl: string;
  model: string;
  apiKeyEnc?: string;
  numCtx?: number;
  /** deepseek / custom 的上下文窗口（仅用量统计用；ollama 走 numCtx） */
  contextWindow?: number;
}

/**
 * 取配置的某个 Provider 片段。
 * @param config 当前配置快照
 * @param providerId 目标 Provider
 */
export function getProviderSettings(config: AppConfig, providerId: ProviderId): ProviderSettingsLike {
  return config.providers[providerId] as ProviderSettingsLike;
}

/**
 * 构造运行期 Provider 配置，其中包含解密后的明文 Key。
 * @param config 当前配置快照
 * @param providerId 目标 Provider；缺省取当前激活的 Provider
 */
export function buildProviderConfig(
  config: AppConfig,
  providerId: ProviderId = config.activeProviderId,
): ProviderConfig {
  const settings = getProviderSettings(config, providerId);
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: loadSecret(providerId, settings.apiKeyEnc),
    numCtx: settings.numCtx,
  };
}
