/**
 * IPC 契约的唯一定义源：通道名常量 + 全部请求 / 响应 / 事件负载类型。
 *
 * 命名规范：域:动作（小写冒号分隔）。主进程、preload、渲染层三方只从本文件 import，
 * 仓库内禁止出现任何硬编码的通道字符串。
 */
import type {
  AuthErrorCode,
  ErrorCode,
  FinishReason,
  ModelInfo,
  PlanStep,
  ProviderId,
  ThemeMode,
  ToolStep,
} from './types';

/** 全部 IPC 通道名 */
export const CHANNELS = {
  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_GET: 'conversation:get',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_RENAME: 'conversation:rename',
  CONVERSATION_SET_PINNED: 'conversation:setPinned',
  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_CHUNK: 'chat:chunk',
  CHAT_END: 'chat:end',
  CHAT_ERROR: 'chat:error',
  /** 工具调用步骤更新（全量快照，渲染层按 step.id 覆盖） */
  CHAT_STEP: 'chat:step',
  /** 计划清单更新（全量快照，渲染层整份覆盖上一版） */
  CHAT_PLAN: 'chat:plan',
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  MODELS_LIST: 'models:list',
  /** 弹出系统目录选择对话框，取用户选中的工作区目录 */
  WORKSPACE_PICK: 'workspace:pick',
  /** 设置某个会话的工作区（root 传 null 表示恢复默认） */
  CONVERSATION_SET_WORKSPACE: 'conversation:setWorkspace',
  APP_OPEN_SETTINGS: 'app:openSettings',
  /** 用系统默认浏览器打开外链（协议白名单在主进程侧卡死） */
  APP_OPEN_EXTERNAL: 'app:openExternal',
  /** 读取当前登录态（脱敏：仅 state / email / userId） */
  AUTH_GET_STATE: 'auth:getState',
  /** 注册 */
  AUTH_SIGN_UP: 'auth:signUp',
  /** 登录 */
  AUTH_SIGN_IN: 'auth:signIn',
  /** 登出（只清登录态，不清会话数据） */
  AUTH_SIGN_OUT: 'auth:signOut',
  /** 忘记密码（发送重置邮件） */
  AUTH_RESET_PASSWORD: 'auth:resetPassword',
  /** 删除账号 */
  AUTH_DELETE_ACCOUNT: 'auth:deleteAccount',
  /** 清除本账号本地数据（会话），confirm 为真才执行 */
  AUTH_CLEAR_LOCAL_DATA: 'auth:clearLocalData',
  /** 事件：主进程 → 渲染层，登录态变化（token 刷新 / 被登出） */
  AUTH_CHANGED: 'auth:changed',
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
  /** 是否置顶（列表项形态统一，故为必填；未置顶为 false） */
  pinned: boolean;
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

/** 重命名会话 */
export interface RenameConversationRequest {
  id: string;
  title: string;
}

/** 置顶 / 取消置顶会话 */
export interface SetConversationPinnedRequest {
  id: string;
  pinned: boolean;
}

/** 发起一轮流式对话：requestId 由渲染层生成，用于多路复用与停止生成 */
export interface ChatSendRequest {
  requestId: string;
  conversationId: string;
  content: string;
  /**
   * 编辑重发：若提供，主进程会先丢弃该 id 的消息及其之后的全部消息，
   * 再把本次 user / assistant 消息追加到会话末尾。
   * 缺省、或会话内找不到该消息时，退化为普通追加。
   */
  replaceMessageId?: string;
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

/** 工具步骤更新：全量快照（非增量），渲染层直接按 step.id 覆盖即可 */
export interface ChatStepEvent {
  requestId: string;
  messageId: string;
  step: ToolStep;
}

/** 计划清单更新：全量快照（非增量），渲染层直接整份覆盖上一版 */
export interface ChatPlanEvent {
  requestId: string;
  messageId: string;
  plan: PlanStep[];
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
  /** 记忆功能总开关；不传表示不改动 */
  memoryEnabled?: boolean;
  /** 界面偏好；目前只有主题，账户相关以后不放这里 */
  ui?: {
    theme?: ThemeMode;
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

/** 选择工作区目录的结果；用户取消时 canceled 为 true */
export interface PickWorkspaceResult {
  canceled: boolean;
  /** 用户选中的绝对路径；canceled 为 true 时无此字段 */
  path?: string;
}

/** 设置会话工作区；root 传 null 表示恢复默认工作区 */
export interface SetConversationWorkspaceRequest {
  id: string;
  root: string | null;
}

/**
 * 登录态三态；渲染层只拿到这三态 + 邮箱，永不接触 token。
 * - unauthenticated：从未登录 / 已登出（锁在登录页）
 * - authenticated：本机有有效登录态（进主界面）
 * - expired：本机有登录态但续期失败且离线（仍放行进主界面，离线优先）
 */
export type AuthStateKind = 'unauthenticated' | 'authenticated' | 'expired';

/** 渲染层可见的登录态（脱敏）：不含任何 token / session 字段 */
export interface AuthState {
  state: AuthStateKind;
  email?: string;
  /** Supabase user.id；仅用于内部/调试展示，不含任何凭据 */
  userId?: string;
}

/** 注册入参 */
export interface SignUpRequest {
  email: string;
  password: string;
}

/** 登录入参；remember=false 表示「不记住我」→ session 仅内存持有 */
export interface SignInRequest {
  email: string;
  password: string;
  remember: boolean;
}

/** 登录 / 登出 / 重置密码结果（脱敏：state 内无 token） */
export interface AuthResult {
  ok: boolean;
  state: AuthState;
  code?: AuthErrorCode;
  /** 已是中文（AUTH_ERROR_TEXT[code]） */
  message?: string;
}

/** 注册结果：needsEmailConfirm 为 true 表示需去邮箱点确认链接 */
export interface SignUpResult {
  ok: boolean;
  needsEmailConfirm: boolean;
  code?: AuthErrorCode;
  message?: string;
}

/** 忘记密码入参 */
export interface ResetPasswordRequest {
  email: string;
}

/** 清除本账号本地数据；confirm 为真才执行 */
export interface ClearLocalDataRequest {
  confirm: boolean;
}

/** 清除结果；removedCount 为被移除的会话数（用于二次确认后回显） */
export interface ClearLocalDataResult {
  ok: boolean;
  removedCount: number;
}
