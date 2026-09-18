/**
 * IPC 契约的唯一定义源：通道名常量 + 全部请求 / 响应 / 事件负载类型。
 *
 * 命名规范：域:动作（小写冒号分隔）。主进程、preload、渲染层三方只从本文件 import，
 * 仓库内禁止出现任何硬编码的通道字符串。
 */
import type { ErrorCode, FinishReason, ModelInfo, ProviderId } from './types';

/** 全部 IPC 通道名 */
export const CHANNELS = {
  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_GET: 'conversation:get',
  CONVERSATION_DELETE: 'conversation:delete',
  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_CHUNK: 'chat:chunk',
  CHAT_END: 'chat:end',
  CHAT_ERROR: 'chat:error',
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  MODELS_LIST: 'models:list',
  APP_OPEN_SETTINGS: 'app:openSettings',
  /** 用系统默认浏览器打开外链（协议白名单在主进程侧卡死） */
  APP_OPEN_EXTERNAL: 'app:openExternal',
} as const;

/** 通道名联合类型 */
export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/** 会话列表项（不含全量消息，避免列表接口过重） */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  providerId: ProviderId;
  model: string;
  messageCount: number;
}

/** 通用成功应答 */
export interface OkResult {
  ok: true;
}

/** 按 id 取单个会话 */
export interface GetConversationRequest {
  id: string;
}

/** 删除会话 */
export interface DeleteConversationRequest {
  id: string;
}

/** 发起一轮流式对话：requestId 由渲染层生成，用于多路复用与停止生成 */
export interface ChatSendRequest {
  requestId: string;
  conversationId: string;
  content: string;
}

/** chat:send 立即返回（不等待模型响应结束） */
export interface ChatSendResponse {
  requestId: string;
  userMessageId: string;
  assistantMessageId: string;
}

/** 停止某轮生成 */
export interface AbortChatRequest {
  requestId: string;
}

/** 增量文本推送（高频） */
export interface ChatChunkEvent {
  requestId: string;
  messageId: string;
  delta: string;
}

/** 正常结束或被用户中止 */
export interface ChatEndEvent {
  requestId: string;
  messageId: string;
  content: string;
  finishReason: FinishReason;
}

/** 异常结束 */
export interface ChatErrorEvent {
  requestId: string;
  messageId: string;
  code: ErrorCode;
  message: string;
}

/** 拉取候选模型 */
export interface ListModelsRequest {
  providerId: ProviderId;
}

/**
 * 保存配置的入参：字段均为可选，apiKey 只进不出（保存后仅回传 hasApiKey）。
 */
export interface ConfigSaveInput {
  activeProviderId?: ProviderId;
  deepseek?: {
    baseUrl?: string;
    model?: string;
    /** 明文密钥，仅用于写入；空字符串表示清除 */
    apiKey?: string;
  };
  ollama?: {
    baseUrl?: string;
    model?: string;
  };
}

/** 请求用系统默认浏览器打开一个外链 */
export interface OpenExternalRequest {
  url: string;
}

/** 打开结果；ok 为假时 reason 说明被拒绝的原因（协议不在白名单内） */
export interface OpenExternalResult {
  ok: boolean;
  reason?: string;
}

/** 模型列表查询结果（models:list 的返回类型别名，便于扩展） */
export type ModelListResult = ModelInfo[];
