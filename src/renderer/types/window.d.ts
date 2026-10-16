/**
 * 渲染层全局类型声明：window.api 的形状。
 *
 * 注意：这里只做类型声明，不含任何实现；
 * 实现由 src/preload/index.ts 通过 contextBridge 注入。
 */
import type {
  AuthResult,
  AuthState,
  AttachFilesResult,
  ChatChunkEvent,
  ChatEndEvent,
  ChatErrorEvent,
  ChatSendRequest,
  ChatSendResponse,
  ChatStepEvent,
  ChatPlanEvent,
  ClearLocalDataRequest,
  ClearLocalDataResult,
  ConfigSaveInput,
  Conversation,
  ConversationSummary,
  ListModelsDraft,
  OkResult,
  OpenExternalResult,
  PickWorkspaceResult,
  ResetPasswordRequest,
  SignInRequest,
  SignUpRequest,
  SignUpResult,
  SkillDeleteRequest,
  SkillDeleteResult,
  SkillImportResult,
  SkillOpenDirResult,
  SkillSummary,
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
  /** 重命名会话 */
  renameConversation(id: string, title: string): Promise<OkResult>;
  /** 置顶 / 取消置顶会话 */
  setConversationPinned(id: string, pinned: boolean): Promise<OkResult>;
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
  /** 订阅本轮计划清单更新（全量快照） */
  onChatPlan(listener: (event: ChatPlanEvent) => void): () => void;
  /** 读取脱敏配置 */
  getConfig(): Promise<PublicConfig>;
  /** 保存配置（apiKey 只进不出） */
  saveConfig(input: ConfigSaveInput): Promise<PublicConfig>;
  /**
   * 拉取候选模型。
   * draft 为设置页表单的未保存现值（Base URL / 新密钥）：传入即按草稿拉取，不落盘；
   * 不传则按已保存配置拉取。历史密钥对渲染层不可见，draft.apiKey 留空即表示沿用已存密钥。
   */
  listModels(providerId: ProviderId, draft?: ListModelsDraft): Promise<ModelInfo[]>;
  /** 订阅「打开设置」引导事件 */
  onOpenSettings(listener: () => void): () => void;
  /** 弹系统目录选择框：用户选中后返回绝对路径，取消时 canceled 为 true */
  pickWorkspace(): Promise<PickWorkspaceResult>;
  /** 弹系统文件选择框，把选中的文件复制进指定工作区的 uploads/，回传相对路径清单 */
  attachFiles(workspaceRoot: string): Promise<AttachFilesResult>;
  /** 设置某个会话的工作区（root 传 null 表示恢复默认工作区） */
  setConversationWorkspace(id: string, root: string | null): Promise<OkResult>;
  /** 用系统默认浏览器打开外链（http/https 白名单在主进程侧） */
  openExternal(url: string): Promise<OpenExternalResult>;
  /** 读取当前登录态（脱敏：仅 state / email / userId） */
  getAuthState(): Promise<AuthState>;
  /** 注册；needsEmailConfirm 为真表示需去邮箱点确认链接 */
  signUp(request: SignUpRequest): Promise<SignUpResult>;
  /** 登录；remember=false 时 session 仅内存持有 */
  signIn(request: SignInRequest): Promise<AuthResult>;
  /** 登出（只清登录态，不清会话数据） */
  signOut(): Promise<AuthResult>;
  /** 忘记密码：发送重置邮件 */
  resetPassword(request: ResetPasswordRequest): Promise<AuthResult>;
  /** 清除本账号本地数据（会话）；confirm 为真才执行 */
  clearLocalData(request: ClearLocalDataRequest): Promise<ClearLocalDataResult>;
  /** 订阅登录态变化（token 刷新 / 被登出 / 跨窗口）；返回取消订阅函数 */
  onAuthChanged(listener: (state: AuthState) => void): () => void;
  /** 列出已安装技能 */
  listSkills(): Promise<SkillSummary[]>;
  /** 在系统文件管理器中打开技能根目录 */
  openSkillsDir(): Promise<SkillOpenDirResult>;
  /** 从文件夹导入技能（主进程弹目录选择框） */
  importSkills(): Promise<SkillImportResult>;
  /** 删除一个技能（confirm 为真才执行） */
  deleteSkill(request: SkillDeleteRequest): Promise<SkillDeleteResult>;
}

declare global {
  interface Window {
    api: MiniAgentApi;
  }
}
