/**
 * 预加载层：通过 contextBridge 向渲染层暴露白名单 API。
 *
 * 安全约束：
 * - 只暴露 invoke 封装与事件订阅，绝不暴露 fetch / require / fs / 任何 node 能力；
 * - 通道名全部来自 shared/ipc-channels，不存在动态通道或任意通道转发；
 * - 事件订阅统一返回 unsubscribe，供渲染层在卸载时清理。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  CHANNELS,
  type AbortChatRequest,
  type ChatChunkEvent,
  type ChatEndEvent,
  type ChatErrorEvent,
  type ChatSendRequest,
  type ChatSendResponse,
  type ChatStepEvent,
  type ConfigSaveInput,
  type Conversation,
  type ConversationSummary,
  type DeleteConversationRequest,
  type GetConversationRequest,
  type ListModelsRequest,
  type ModelListResult,
  type OkResult,
  type OpenExternalRequest,
  type OpenExternalResult,
} from '../shared/ipc-channels';
import type { ProviderId, PublicConfig } from '../shared/types';

/** 事件监听器 */
type EventListener<T> = (payload: T) => void;

/**
 * 订阅主进程推送事件。
 * @param channel 通道名（来自共享常量）
 * @param listener 事件处理器
 * @returns 取消订阅函数
 */
function subscribe<T>(channel: string, listener: EventListener<T>): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

/** 暴露给渲染层的白名单 API */
const api = {
  // ---- 会话 ----
  listConversations: (): Promise<ConversationSummary[]> =>
    ipcRenderer.invoke(CHANNELS.CONVERSATION_LIST),
  createConversation: (): Promise<Conversation> =>
    ipcRenderer.invoke(CHANNELS.CONVERSATION_CREATE),
  getConversation: (id: string): Promise<Conversation | null> =>
    ipcRenderer.invoke(CHANNELS.CONVERSATION_GET, { id } satisfies GetConversationRequest),
  deleteConversation: (id: string): Promise<OkResult> =>
    ipcRenderer.invoke(CHANNELS.CONVERSATION_DELETE, { id } satisfies DeleteConversationRequest),

  // ---- 对话（流式） ----
  sendChat: (request: ChatSendRequest): Promise<ChatSendResponse> =>
    ipcRenderer.invoke(CHANNELS.CHAT_SEND, request),
  abortChat: (requestId: string): Promise<OkResult> =>
    ipcRenderer.invoke(CHANNELS.CHAT_ABORT, { requestId } satisfies AbortChatRequest),
  onChatChunk: (listener: EventListener<ChatChunkEvent>): (() => void) =>
    subscribe<ChatChunkEvent>(CHANNELS.CHAT_CHUNK, listener),
  onChatEnd: (listener: EventListener<ChatEndEvent>): (() => void) =>
    subscribe<ChatEndEvent>(CHANNELS.CHAT_END, listener),
  onChatError: (listener: EventListener<ChatErrorEvent>): (() => void) =>
    subscribe<ChatErrorEvent>(CHANNELS.CHAT_ERROR, listener),
  onChatStep: (listener: EventListener<ChatStepEvent>): (() => void) =>
    subscribe<ChatStepEvent>(CHANNELS.CHAT_STEP, listener),

  // ---- 配置与模型 ----
  getConfig: (): Promise<PublicConfig> => ipcRenderer.invoke(CHANNELS.CONFIG_GET),
  saveConfig: (input: ConfigSaveInput): Promise<PublicConfig> =>
    ipcRenderer.invoke(CHANNELS.CONFIG_SAVE, input),
  listModels: (providerId: ProviderId): Promise<ModelListResult> =>
    ipcRenderer.invoke(CHANNELS.MODELS_LIST, { providerId } satisfies ListModelsRequest),
  onOpenSettings: (listener: () => void): (() => void) =>
    subscribe<void>(CHANNELS.APP_OPEN_SETTINGS, () => listener()),

  // ---- 外链 ----
  /** 用系统默认浏览器打开 http/https 链接；协议白名单由主进程卡死 */
  openExternal: (url: string): Promise<OpenExternalResult> =>
    ipcRenderer.invoke(CHANNELS.APP_OPEN_EXTERNAL, { url } satisfies OpenExternalRequest),
} as const;

contextBridge.exposeInMainWorld('api', api);
