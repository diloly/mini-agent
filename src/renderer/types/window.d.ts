/**
 * 渲染层全局类型声明：window.api 的形状。
 *
 * 注意：这里只做类型声明，不含任何实现；
 * 实现由 src/preload/index.ts 通过 contextBridge 注入。
 */
import type {
  ChatChunkEvent,
  ChatEndEvent,
  ChatErrorEvent,
  ChatSendRequest,
  ChatSendResponse,
  ChatStepEvent,
  ConfigSaveInput,
  Conversation,
  ConversationSummary,
  OkResult,
  OpenExternalResult,
} from '../../shared/ipc-channels';
import type { ModelInfo, ProviderId, PublicConfig } from '../../shared/types';

/** preload 暴露给渲染层的白名单 API */
export interface MiniAgentApi {
  /** 会话列表（按 updatedAt 倒序，仅摘要） */
  listConversations(): Promise<ConversationSummary[]>;
  /** 新建空会话 */
  createConversation(): Promise<Conversation>;
  /** 取单个会话（含全量消息） */
  getConversation(id: string): Promise<Conversation | null>;
  /** 删除会话 */
  deleteConversation(id: string): Promise<OkResult>;
  /** 发起一轮流式对话，立即返回 requestId 与两条消息的 id */
  sendChat(request: ChatSendRequest): Promise<ChatSendResponse>;
  /** 停止生成 */
  abortChat(requestId: string): Promise<OkResult>;
  /** 订阅增量文本 */
  onChatChunk(listener: (event: ChatChunkEvent) => void): () => void;
  /** 订阅正常 / 中止结束 */
  onChatEnd(listener: (event: ChatEndEvent) => void): () => void;
  /** 订阅异常结束 */
  onChatError(listener: (event: ChatErrorEvent) => void): () => void;
  /** 订阅工具调用步骤更新 */
  onChatStep(listener: (event: ChatStepEvent) => void): () => void;
  /** 读取脱敏配置 */
  getConfig(): Promise<PublicConfig>;
  /** 保存配置（apiKey 只进不出） */
  saveConfig(input: ConfigSaveInput): Promise<PublicConfig>;
  /** 拉取候选模型 */
  listModels(providerId: ProviderId): Promise<ModelInfo[]>;
  /** 订阅「打开设置」引导事件 */
  onOpenSettings(listener: () => void): () => void;
  /** 用系统默认浏览器打开外链（http/https 白名单在主进程侧） */
  openExternal(url: string): Promise<OpenExternalResult>;
}

declare global {
  interface Window {
    api: MiniAgentApi;
  }
}
