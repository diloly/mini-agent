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
  type AuthResult,
  type AuthState,
  type ChatChunkEvent,
  type ChatEndEvent,
  type ChatErrorEvent,
  type ChatSendRequest,
  type ChatSendResponse,
  type ChatStepEvent,
  type ClearLocalDataRequest,
  type ClearLocalDataResult,
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
  type PickWorkspaceResult,
  type ResetPasswordRequest,
  type SetConversationWorkspaceRequest,
  type SignInRequest,
  type SignUpRequest,
  type SignUpResult,
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
  /** 弹系统目录选择框，返回用户选中的工作区；用户取消时 canceled 为 true */
  pickWorkspace: (): Promise<PickWorkspaceResult> =>
    ipcRenderer.invoke(CHANNELS.WORKSPACE_PICK),
  /** 设置某个会话的工作区（root 传 null 表示恢复默认工作区） */
  setConversationWorkspace: (id: string, root: string | null): Promise<OkResult> =>
    ipcRenderer.invoke(
      CHANNELS.CONVERSATION_SET_WORKSPACE,
      { id, root } satisfies SetConversationWorkspaceRequest,
    ),

  // ---- 外链 ----
  /** 用系统默认浏览器打开 http/https 链接；协议白名单由主进程卡死 */
  openExternal: (url: string): Promise<OpenExternalResult> =>
    ipcRenderer.invoke(CHANNELS.APP_OPEN_EXTERNAL, { url } satisfies OpenExternalRequest),

  // ---- 账号 ----
  /** 读取当前登录态（脱敏：仅 state / email / userId，绝不含 token） */
  getAuthState: (): Promise<AuthState> => ipcRenderer.invoke(CHANNELS.AUTH_GET_STATE),
  /** 注册；needsEmailConfirm 为真表示需去邮箱点确认链接 */
  signUp: (request: SignUpRequest): Promise<SignUpResult> =>
    ipcRenderer.invoke(CHANNELS.AUTH_SIGN_UP, request),
  /** 登录；remember=false 时 session 仅内存持有，不落盘 */
  signIn: (request: SignInRequest): Promise<AuthResult> =>
    ipcRenderer.invoke(CHANNELS.AUTH_SIGN_IN, request),
  /** 登出（只清登录态，不清会话数据） */
  signOut: (): Promise<AuthResult> => ipcRenderer.invoke(CHANNELS.AUTH_SIGN_OUT),
  /** 忘记密码：发送重置邮件 */
  resetPassword: (request: ResetPasswordRequest): Promise<AuthResult> =>
    ipcRenderer.invoke(CHANNELS.AUTH_RESET_PASSWORD, request),
  /** 清除本账号本地数据（会话）；confirm 为真才执行 */
  clearLocalData: (request: ClearLocalDataRequest): Promise<ClearLocalDataResult> =>
    ipcRenderer.invoke(CHANNELS.AUTH_CLEAR_LOCAL_DATA, request),
  /** 订阅登录态变化（token 刷新 / 被登出 / 跨窗口）；返回取消订阅函数 */
  onAuthChanged: (listener: EventListener<AuthState>): (() => void) =>
    subscribe<AuthState>(CHANNELS.AUTH_CHANGED, listener),
} as const;

contextBridge.exposeInMainWorld('api', api);
