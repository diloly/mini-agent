/**
 * Provider 注册表：把 providerId 映射到具体适配器实例。
 * 新增一家厂商只需在此处登记，IPC 层与渲染层无需改动。
 */
import type { ProviderId } from '../../shared/types';
import { deepseekProvider } from './deepseek';
import { ollamaProvider } from './ollama';
import { ProviderError, type LLMProvider } from './types';

/** 注册表 */
const REGISTRY: Record<ProviderId, LLMProvider> = {
  deepseek: deepseekProvider,
  ollama: ollamaProvider,
};

/** 类型守卫：判断任意值是否为合法的 providerId */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REGISTRY, value);
}

/**
 * 取 Provider 实例。
 * @param id providerId
 * @throws ProviderError 传入未知标识时抛出 UNKNOWN
 */
export function getProvider(id: ProviderId): LLMProvider {
  const provider = REGISTRY[id];
  if (!provider) {
    throw new ProviderError('UNKNOWN', '未知的模型服务', false);
  }
  return provider;
}

/** 列出全部已注册的 Provider */
export function listProviders(): LLMProvider[] {
  return Object.values(REGISTRY);
}
