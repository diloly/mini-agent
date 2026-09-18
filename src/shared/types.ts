/**
 * 跨进程共享的类型与常量：消息 / 会话 / 配置 / 模型 / 错误码。
 *
 * 约束：本文件零依赖，禁止 import 任何 node、electron 或浏览器专有模块；
 * 主进程、preload、渲染层三方均可安全引用。
 */

/** 已接入的模型服务标识 */
export type ProviderId = 'deepseek' | 'ollama';

/** 消息角色 */
export type Role = 'user' | 'assistant' | 'system';

/** 一轮生成结束的原因 */
export type FinishReason = 'stop' | 'length' | 'aborted' | 'error';

/**
 * 面向用户的错误码。
 * - NOT_CONFIGURED：未配置 Key / 未选模型
 * - AUTH：401 / 403 鉴权失败
 * - RATE_LIMIT：429 限流
 * - NETWORK：DNS / 超时 / 断网
 * - UNREACHABLE：本地服务连接被拒（如 Ollama 未启动）
 * - SERVER：5xx 服务端异常
 * - BAD_RESPONSE：响应体解析失败
 * - ABORTED：用户主动停止（非错误）
 * - UNKNOWN：兜底
 */
export type ErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'UNREACHABLE'
  | 'SERVER'
  | 'BAD_RESPONSE'
  | 'ABORTED'
  | 'UNKNOWN';

/** 消息的附加信息，仅 assistant 消息会写入 provider / model / 结束状态 */
export interface MessageMeta {
  providerId?: ProviderId;
  model?: string;
  finishReason?: FinishReason;
  errorCode?: ErrorCode;
  errorText?: string;
}

/** 单条消息；流式期间 content 为「已累积的完整文本」 */
export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: number;
  meta?: MessageMeta;
}

/** 会话：元数据 + 内嵌全量消息，列表按 updatedAt 倒序 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId: ProviderId;
  model: string;
  messages: Message[];
}

/** DeepSeek 配置：apiKeyEnc 为 safeStorage 加密后的 base64 密文，永不出主进程 */
export interface DeepSeekProviderSettings {
  baseUrl: string;
  model: string;
  apiKeyEnc?: string;
}

/** Ollama 配置：本地服务无需密钥 */
export interface OllamaProviderSettings {
  baseUrl: string;
  model: string;
}

/** 应用配置（与会话数据物理分离，清历史不丢 Key） */
export interface AppConfig {
  version: 1;
  activeProviderId: ProviderId;
  providers: {
    deepseek: DeepSeekProviderSettings;
    ollama: OllamaProviderSettings;
  };
  ui: {
    lastConversationId?: string;
  };
}

/** 候选模型 */
export interface ModelInfo {
  id: string;
  label: string;
}

/**
 * 渲染层唯一可见的配置形态：密钥一律脱敏为 hasApiKey 布尔值，
 * 任何 *Enc 字段都不得出现在这里。
 */
export interface PublicConfig {
  activeProviderId: ProviderId;
  providers: {
    deepseek: { baseUrl: string; model: string; hasApiKey: boolean };
    ollama: { baseUrl: string; model: string };
  };
  models: Record<ProviderId, ModelInfo[]>;
  safeStorageAvailable: boolean;
  /** 界面态：不涉密，用于重启后恢复上次查看的会话 */
  ui?: {
    lastConversationId?: string;
  };
}

/** 各 Provider 的展示名（渲染层通过 PROVIDER_LABELS[providerId] 取值，避免在组件里出现分支判断） */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
};

/** 各 Provider 的默认 Base URL */
export const DEFAULT_BASE_URL: Record<ProviderId, string> = {
  deepseek: 'https://api.deepseek.com',
  ollama: 'http://127.0.0.1:11434',
};

/** 各 Provider 的默认模型（Ollama 无默认，需用户选择或手填） */
export const DEFAULT_MODEL: Record<ProviderId, string> = {
  deepseek: 'deepseek-chat',
  ollama: '',
};

/** 会话标题回退值 */
export const DEFAULT_CONVERSATION_TITLE = '新会话';

/** 单次请求携带的历史消息条数上限 */
export const CONTEXT_MESSAGE_LIMIT = 20;

/** 会话标题截断长度 */
export const TITLE_MAX_LENGTH = 20;

/**
 * 错误码 → 面向用户的简体中文文案。
 *
 * 全仓唯一来源：主进程（Provider 层构造 ProviderError）与渲染层（错误块展示）
 * 共用这一张表，保证同一句话只有一处定义。
 */
export const ERROR_TEXT: Record<ErrorCode, string> = {
  NOT_CONFIGURED: '尚未配置模型，请先到设置中填写',
  AUTH: 'API Key 无效或已失效（401/403）',
  RATE_LIMIT: '请求过于频繁，请稍后再试（429）',
  NETWORK: '网络连接失败，请检查网络后重试',
  UNREACHABLE: '无法连接模型服务，请确认服务已经启动',
  SERVER: '模型服务暂时不可用（5xx）',
  BAD_RESPONSE: '模型返回内容解析失败',
  ABORTED: '已停止生成',
  UNKNOWN: '发生未知错误',
};

/**
 * 错误码 → 是否可重试（决定是否渲染「重试」按钮）。
 *
 * 注意 UNREACHABLE 这里的文案是**通用兜底**：厂商专属提示
 * （如 Ollama 的「请确认已启动 ollama serve」）由 LLMProvider.unreachableHint
 * 提供，主进程在构造 ProviderError 时用 hint 覆盖此处的通用文案。
 */
export const ERROR_RETRYABLE: Record<ErrorCode, boolean> = {
  NOT_CONFIGURED: false,
  AUTH: true,
  RATE_LIMIT: true,
  NETWORK: true,
  UNREACHABLE: true,
  SERVER: true,
  BAD_RESPONSE: true,
  ABORTED: false,
  UNKNOWN: true,
};
