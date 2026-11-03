/**
 * 全局状态：会话 / 消息 / 流式缓冲 / loading / error / 配置 / 主题。
 *
 * 流式不串流的关键：所有流式状态按 requestId 隔离存放；
 * 切换会话时把进行中的流标记为 discarded，后续 delta 直接丢弃，
 * 天然实现「切会话后旧流不再渲染」。
 */
import { create } from 'zustand';
import type {
  AuthState,
  ChatSendResponse,
  ConfigSaveInput,
  ContextStatsResponse,
  ConversationSummary,
  ListModelsDraft,
  SkillDeleteResult,
  SkillImportResult,
  SkillOpenDirResult,
  SkillSummary,
} from '../../shared/ipc-channels';
import {
  AUTH_ERROR_TEXT,
  sortConversationsByPinned,
  type ErrorCode,
  type FinishReason,
  type JudgeSummary,
  type Message,
  type MessageAttachment,
  type ModelInfo,
  type ProviderId,
  type PublicConfig,
  type ThemeMode,
  type PlanStep,
  type ToolStep,
  type Verdict,
} from '../../shared/types';
import {
  abortChat,
  clearLocalData as apiClearLocalData,
  createConversation as apiCreateConversation,
  createRequestId,
  deleteConversation as apiDeleteConversation,
  getAuthState as apiGetAuthState,
  getConfig,
  getContextStats,
  getJudgeSummary,
  listConversations,
  getConversation,
  listJudgeCases,
  listModels,
  runJudge as apiRunJudge,
  saveConfig,
  sendChat,
  setJudgeFeedback,
  signIn as apiSignIn,
  signOut as apiSignOut,
  signUp as apiSignUp,
  pickWorkspace as apiPickWorkspace,
  renameConversation as apiRenameConversation,
  resumeChat,
  setConversationPinned as apiSetConversationPinned,
  setConversationWorkspace as apiSetConversationWorkspace,
  deleteSkill as apiDeleteSkill,
  importSkills as apiImportSkills,
  listSkills as apiListSkills,
  openSkillsDir as apiOpenSkillsDir,
} from '../lib/api';
import { applyTheme, resolveTheme } from '../lib/theme';

/** 评测失败红叉的展示时长（毫秒）：由 store 自己起 timer 清除，组件只读状态 */
const JUDGE_ERROR_FLASH_MS = 1500;

/** 汇总窗口（天）：设置页「近 N 天」与 IPC 请求共用同一个值，避免两处各写一个 30 */
export const JUDGE_SUMMARY_DAYS = 30;

/**
 * 判断当前 Provider 是否已完成配置（渲染层视角）。
 * 只看脱敏后的 PublicConfig，不接触任何密钥。
 */
export function isProviderConfigured(config: PublicConfig | null): boolean {
  if (!config) {
    return false;
  }
  if (config.activeProviderId === 'deepseek') {
    const settings = config.providers.deepseek;
    return settings.hasApiKey && settings.model.trim().length > 0;
  }
  if (config.activeProviderId === 'custom') {
    const settings = config.providers.custom;
    // 自定义服务可能免密钥（本地 vLLM / Ollama 的 /v1）：Base URL 与模型填了就算可用
    return settings.baseUrl.trim().length > 0 && settings.model.trim().length > 0;
  }
  return config.providers.ollama.model.trim().length > 0;
}

/**
 * 登录态是否「可用」（渲染层视角）。
 *
 * authenticated 与 expired 都放行：
 * - expired 表示本机存有登录态、但续期时网络不可达；离线优先策略下仍进主界面，
 *   避免一断网就被踢回登录页（凭据真正失效时主进程会推 unauthenticated）。
 * - null（尚未读取）与 unauthenticated 均视为不可用。
 */
export function isAuthed(state: AuthState | null): boolean {
  return state?.state === 'authenticated' || state?.state === 'expired';
}

/** 右侧主区当前展示的视图：会话聊天 / 技能管理 */
export type MainView = 'chat' | 'skills';

/**
 * 评测集索引项：界面只需要「评过没有」与「用户评价」两件事。
 * 刻意不存分数 —— 分数只在设置页汇总里出现（PRD P5：对话界面不显示分数）。
 */
export interface JudgeIndexEntry {
  /** 是否已有至少一次成功评测 */
  hasRun: boolean;
  /** 用户评价（赞 / 踩）；未评价时不写 */
  verdict?: Verdict;
}

/** 一轮进行中的流式状态 */
export interface StreamState {
  requestId: string;
  conversationId: string;
  assistantMessageId: string;
  /** 已累积的文本 */
  text: string;
  /** 工具调用步骤（全量快照，按 step.id 覆盖）；无工具调用时为空数组 */
  steps: ToolStep[];
  /** 本轮计划清单（全量快照，每次整份覆盖）；模型没建计划时为空数组 */
  plan: PlanStep[];
  /** 是否已被丢弃（切换会话 / 卸载后置为 true，后续 delta 不再上屏） */
  discarded: boolean;
}

/** store 的完整形态 */
export interface AppState {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  messages: Message[];
  /** requestId → 流式状态 */
  streams: Record<string, StreamState>;
  /** 当前正在生成的 requestId */
  activeRequestId: string | null;
  loading: boolean;
  error: string | null;
  /** 已跑完但用户还没看过的会话 id 集合（内存态，不持久化；驱动侧栏的未读圆点） */
  unreadConversations: Record<string, true>;
  config: PublicConfig | null;
  settingsOpen: boolean;
  /** 右侧主区视图（内存态，不持久化） */
  mainView: MainView;
  /** 当前会话绑定的工作区根目录；为 null 时表示使用默认工作区 */
  activeWorkspaceRoot: string | null;
  /** 当前登录态（脱敏：仅 state / email / userId）；null 表示尚未从主进程取到 */
  auth: AuthState | null;
  /** 是否已完成首次登录态读取；false 时界面停在启动态，避免登录页/主界面闪烁 */
  authChecked: boolean;
  /** 已安装技能（技能页用）；进入技能页时才拉取 */
  skills: SkillSummary[];
  /** 当前会话的上下文用量（主进程按真实装配口径估算）；null 表示尚未取到 */
  contextStats: ContextStatsResponse | null;
  /** 正在评测中的 assistant 消息 id（驱动气泡上的转圈图标，同时用于挡住重复点击） */
  judgingMessageIds: string[];
  /** messageId → 评测索引（评过没有 + 用户评价）；切换会话时整体替换 */
  judgeIndex: Record<string, JudgeIndexEntry>;
  /** 设置页「质量」分组的汇总；null 表示尚未拉取 */
  judgeSummary: JudgeSummary | null;
  /** 最近一次评测失败的提示（气泡上的红叉 + 文案）；null 表示当前无错误 */
  judgeError: { messageId: string; text: string } | null;

  hydrate: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  /**
   * 刷新当前会话的上下文用量。
   * 会话切换、一轮生成结束、消息定稿时调用；生成中的增量不逐字刷新（浪费 IPC）。
   */
  refreshContextStats: () => Promise<void>;
  /**
   * 拉取某会话的评测索引，写成 messageId → { hasRun, verdict }。
   * 切会话后调用；结果回显 conversationId，切走后才回来的过期结果直接丢弃。
   * 失败静默 —— 索引只是图标状态，不能打断主流程。
   */
  refreshJudgeIndex: (conversationId: string) => Promise<void>;
  /**
   * 设置 / 取消某条消息的用户评价。
   * 先本地乐观更新（图标立刻变），IPC 返回 ok=false 或抛错时回滚到改动前的条目。
   */
  setFeedback: (messageId: string, verdict: Verdict | null) => Promise<void>;
  /**
   * 对某条消息跑一次评测。
   * 同一消息不并发；成功只点亮「已评测」（不写分数，PRD P5），
   * 失败把红叉文案写入 judgeError 并在 1.5s 后自动清除。
   */
  runJudge: (messageId: string) => Promise<void>;
  /** 拉取设置页「质量」分组的汇总（近 JUDGE_SUMMARY_DAYS 天）；失败静默 */
  refreshJudgeSummary: () => Promise<void>;
  selectConversation: (id: string | null) => Promise<void>;
  /**
   * 新建会话并选中。
   * **幂等**：当前已经是「空会话」（已选中且没有任何消息）时不再新建，直接返回。
   * **合并重入**：已有一次新建在飞时，等它完成而不是再发一次 —— 连点不再堆出多个空会话，
   * 且调用方 await 之后一定能拿到可用的会话。
   */
  createConversation: () => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
  /** 重命名会话（先本地乐观更新，IPC 失败回滚） */
  renameConversation: (id: string, title: string) => Promise<void>;
  /** 置顶 / 取消置顶（先本地乐观更新并重排，IPC 失败回滚） */
  setConversationPinned: (id: string, pinned: boolean) => Promise<void>;
  /**
   * 发送消息；传 replaceMessageId 表示「编辑重发」，先丢弃该消息及其之后的全部消息。
   * attachments 为随消息发送的文件附件（已由主进程复制进工作区，只带相对路径元数据）；
   * 只有文件、没有文字时也允许发送（content 为空串）。
   */
  sendMessage: (
    content: string,
    replaceMessageId?: string,
    attachments?: MessageAttachment[],
  ) => Promise<void>;
  /** 续跑：接着一条被中止的 assistant 消息从 checkpoint 继续跑（不建新消息，复用目标消息） */
  resumeChat: (assistantMessageId: string) => Promise<void>;
  abortActive: () => Promise<void>;
  appendDelta: (requestId: string, delta: string) => void;
  /** 覆盖式写入某个工具步骤（step.id 相同则替换） */
  upsertStep: (requestId: string, step: ToolStep) => void;
  /** 覆盖式写入本轮计划清单（整份替换，不是增量） */
  upsertPlan: (requestId: string, plan: PlanStep[]) => void;
  finishStream: (requestId: string, content: string, finishReason: FinishReason, resumable?: boolean) => void;
  failStream: (requestId: string, code: ErrorCode, message: string, resumable?: boolean) => void;
  remapOptimisticIds: (
    requestId: string,
    localUserMessageId: string,
    remoteUserMessageId: string,
    localAssistantMessageId: string,
    remoteAssistantMessageId: string,
  ) => void;
  /** 拉取候选模型并写进 config.models；返回值供调用方取模型自带的窗口信息（失败回空数组） */
  refreshModels: (providerId: ProviderId, draft?: ListModelsDraft) => Promise<ModelInfo[]>;
  saveAppConfig: (input: ConfigSaveInput) => Promise<void>;
  /** 在输入区快速切换模型服务 / 模型，不打开设置弹层 */
  switchModel: (providerId: ProviderId, model: string) => Promise<void>;
  /** 弹系统目录框，把选中的目录绑定到当前会话（取消则不改变） */
  pickWorkspace: () => Promise<void>;
  /** 解绑当前会话的工作区，回退到默认工作区 */
  resetWorkspace: () => Promise<void>;
  /** 在 React 挂载前调用：只取主题落到 DOM，避免首帧先浅后深 */
  initTheme: () => Promise<void>;
  /** 切换主题偏好并持久化 */
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  /** 切换「记忆功能」开关并持久化（关闭后本轮起不再提炼、不注入、不暴露每日笔记工具） */
  setMemoryEnabled: (enabled: boolean) => Promise<void>;
  /** 启动前读取登录态；必须在 React 挂载前 await（决定首帧显示登录页还是主界面） */
  initAuth: () => Promise<void>;
  /** 收敛一次登录态：跨账号切换时清残留、置 authChecked；auth:changed 与各 action 共用 */
  applyAuthState: (next: AuthState) => void;
  /** 登录；成功返回 null，失败返回中文错误文案 */
  signIn: (email: string, password: string, remember: boolean) => Promise<string | null>;
  /** 注册；返回错误文案（成功为 null）与是否需要邮箱确认 */
  signUp: (
    email: string,
    password: string,
  ) => Promise<{ error: string | null; needsEmailConfirm: boolean }>;
  /** 登出（只清登录态，不清会话数据） */
  signOut: () => Promise<void>;
  /** 清除本账号本地会话数据；返回被移除的会话数，失败返回 null */
  clearLocalData: () => Promise<number | null>;
  /** 拉取技能列表；失败静默（面板保留上次结果，不弹错） */
  refreshSkills: () => Promise<void>;
  /** 从文件夹导入技能；结果原样返回给面板回显 imported / skipped */
  importSkills: () => Promise<SkillImportResult>;
  /** 删除一个技能（二次确认由面板负责，这里始终带 confirm=true 下发） */
  deleteSkill: (dirName: string) => Promise<SkillDeleteResult>;
  /** 在系统文件管理器中打开技能根目录 */
  openSkillsDir: () => Promise<SkillOpenDirResult>;
  /** 切换右侧主区视图 */
  setMainView: (view: MainView) => void;
  setSettingsOpen: (open: boolean) => void;
  setError: (error: string | null) => void;
}

/**
 * 判断某会话此刻是否「正被用户注视着」。
 * 两个条件都要满足：它是当前选中的会话，且窗口处于焦点态（切走 / 最小化 ⇒ hasFocus() 为 false）。
 * 只有「不在此处」的会话跑完时，才需要在侧栏点一个未读圆点。
 */
function isConversationFocused(
  conversationId: string,
  activeConversationId: string | null,
): boolean {
  if (conversationId !== activeConversationId) {
    return false;
  }
  return typeof document !== 'undefined' && document.hasFocus();
}

/** 从未读集合中移除一个会话；不存在时原样返回，避免无谓重渲染 */
function clearUnread(
  unread: Record<string, true>,
  conversationId: string,
): Record<string, true> {
  if (!unread[conversationId]) {
    return unread;
  }
  const next = { ...unread };
  delete next[conversationId];
  return next;
}

/** 把现有流全部标记为已丢弃（切会话 / 卸载时调用） */
function discardAll(streams: Record<string, StreamState>): Record<string, StreamState> {
  const next: Record<string, StreamState> = {};
  for (const [key, value] of Object.entries(streams)) {
    next[key] = { ...value, discarded: true };
  }
  return next;
}

/** 切换会话时重绑定流状态：属于目标会话的流复位为「可见」，其余标记为已丢弃。
 *  这样切回正在生成的会话时打字机效果能续上，而不是永久停在切走前的旧文本上。 */
function rebindStreams(
  streams: Record<string, StreamState>,
  conversationId: string,
): Record<string, StreamState> {
  const next: Record<string, StreamState> = {};
  for (const [key, value] of Object.entries(streams)) {
    next[key] = { ...value, discarded: value.conversationId !== conversationId };
  }
  return next;
}

/** 从 streams 中移除指定 requestId */
function omitStream(
  streams: Record<string, StreamState>,
  requestId: string,
): Record<string, StreamState> {
  const next = { ...streams };
  delete next[requestId];
  return next;
}

/** 会话摘要构造（本地乐观更新时用） */
function toSummary(conversation: {
  id: string;
  title: string;
  updatedAt: number;
  providerId: ProviderId;
  model: string;
  messages: Message[];
  pinned?: boolean;
}): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    providerId: conversation.providerId,
    model: conversation.model,
    messageCount: conversation.messages.length,
    pinned: conversation.pinned === true,
  };
}

/**
 * 进行中的那次「新建会话」；null 表示当前没有。
 * 用 Promise 而不是布尔：连点时后来者**等这一次**，而不是被丢弃 ——
 * 否则 Composer 的发送链路（无会话时先补建再发送）会被静默吞掉一次发送。
 */
let creatingConversation: Promise<void> | null = null;

/** 评测失败红叉的自动清除定时器；同一时刻只留一个（新错误直接顶掉旧错误） */
let judgeErrorTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 写入评测失败提示，并在 JUDGE_ERROR_FLASH_MS 后自动清除。
 * 定时器由 store 自己持有：组件只读 judgeError，卸载 / 重渲染都不会漏掉清除，
 * 也不会在组件里各起一个 timer 互相踩。
 */
function flashJudgeError(messageId: string, text: string): void {
  if (judgeErrorTimer !== null) {
    clearTimeout(judgeErrorTimer);
    judgeErrorTimer = null;
  }
  useAppStore.setState({ judgeError: { messageId, text } });
  judgeErrorTimer = setTimeout(() => {
    judgeErrorTimer = null;
    useAppStore.setState({ judgeError: null });
  }, JUDGE_ERROR_FLASH_MS);
}

export const useAppStore = create<AppState>()((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  streams: {},
  activeRequestId: null,
  loading: false,
  error: null,
  unreadConversations: {},
  config: null,
  settingsOpen: false,
  mainView: 'chat',
  activeWorkspaceRoot: null,
  auth: null,
  authChecked: false,
  skills: [],
  contextStats: null,
  judgingMessageIds: [],
  judgeIndex: {},
  judgeSummary: null,
  judgeError: null,

  /** 启动时水合：拉配置 + 会话列表，并选中最近更新的会话 */
  hydrate: async () => {
    try {
      const [config, conversations] = await Promise.all([getConfig(), listConversations()]);
      set({ config, conversations });
      // 系统模式下启动也要走一次正确解析（此时系统可能是深色）
      applyTheme(resolveTheme(config.ui?.theme));
      // 优先恢复上次查看的会话；该会话已被删除时顺位取最近更新的一条
      const rememberedId = config.ui?.lastConversationId;
      const remembered = rememberedId
        ? conversations.find((item) => item.id === rememberedId)
        : undefined;
      const targetId = remembered?.id ?? conversations[0]?.id ?? null;
      if (targetId) {
        await get().selectConversation(targetId);
      } else {
        set({ activeConversationId: null, messages: [] });
      }
      await get().refreshModels(config.activeProviderId);
    } catch {
      set({ error: '初始化失败，请重启应用' });
    }
  },

  /** 刷新会话列表（标题 / 排序变化后调用） */
  refreshConversations: async () => {
    try {
      const conversations = await listConversations();
      set({ conversations });
    } catch {
      // 列表刷新属于次要能力，失败不打断交互
    }
  },

  /**
   * 刷新当前会话的上下文用量。
   * 主进程按真实装配口径（system + 最近 N 条）估算，渲染层只负责展示。
   * 结果回显 conversationId：切走后才回来的过期结果直接丢弃，避免把 A 会话的
   * 数字贴到 B 会话的输入框上。失败静默 —— 统计是辅助信息，不能打断主流程。
   */
  refreshContextStats: async () => {
    const conversationId = get().activeConversationId;
    if (!conversationId) {
      set({ contextStats: null });
      return;
    }
    try {
      const stats = await getContextStats(conversationId);
      if (get().activeConversationId === stats.conversationId) {
        set({ contextStats: stats });
      }
    } catch {
      // 统计失败：保留上一次的数字（总比闪成 0 好），不弹错误
    }
  },

  /**
   * 拉取某会话的评测索引。
   * 只取摘要里的 hasRun / verdict 两个字段：分数不进渲染层索引（PRD P5：对话界面不显示分数），
   * 也顺带避免把整份 JudgeCaseSummary 挂在每条消息上。
   */
  refreshJudgeIndex: async (conversationId) => {
    try {
      const cases = await listJudgeCases(conversationId);
      // 过期结果丢弃：切走后才回来的索引不能贴到新会话的消息上
      if (get().activeConversationId !== conversationId) {
        return;
      }
      const judgeIndex: Record<string, JudgeIndexEntry> = {};
      for (const item of cases) {
        const entry: JudgeIndexEntry = { hasRun: item.hasRun };
        if (item.verdict !== undefined) {
          entry.verdict = item.verdict;
        }
        judgeIndex[item.messageId] = entry;
      }
      set({ judgeIndex });
    } catch {
      // 索引属辅助信息：失败保留上一次结果，不弹错
    }
  },

  /** 切换会话：重绑定进行中的流，再拉取该会话的全量消息 */
  selectConversation: async (id) => {
    if (!id) {
      set((state) => ({
        activeConversationId: null,
        messages: [],
        streams: discardAll(state.streams),
        loading: false,
        activeRequestId: null,
        // 离开会话时工作区一并复位为「默认」
        activeWorkspaceRoot: null,
        // 离开会话时一并清掉全局错误横幅，避免错误提示残留在空态页上
        error: null,
        // 上下文用量是会话级信息：没有会话就没有可展示的数字
        contextStats: null,
        // 评测索引同样是会话级信息：清空，避免空态页残留上一条会话的图标状态
        judgeIndex: {},
        judgeError: null,
      }));
      return;
    }
    // 目标会话的进行中流复位为「可见」，其余会话的流标记为已丢弃
    set((state) => ({
      activeConversationId: id,
      messages: [],
      streams: rebindStreams(state.streams, id),
      error: null,
      // 换会话先清索引：新会话的索引还没回来，不能挂着上一个会话的「已评测」图标
      judgeIndex: {},
      judgeError: null,
      // 必须同时退出「生成中」：否则旧流的 requestId 会残留在 activeRequestId 上，
      // 结果是输入框被锁死、点「停止」还会停到已经切走的旧流上
      loading: false,
      activeRequestId: null,
      // 切到该会话即视为「看过最新的」：清掉它的未读圆点
      unreadConversations: clearUnread(state.unreadConversations, id),
    }));
    try {
      const conversation = await getConversation(id);
      // 防止慢请求回来时用户已经切走
      if (conversation && get().activeConversationId === id) {
        set((state) => {
          // 用进行中流的累积文本覆盖落盘内容，保证切回来时打字机效果能续上
          const messages = (conversation.messages ?? []).map((message) => {
            const live = Object.values(state.streams).find(
              (item) =>
                !item.discarded &&
                item.conversationId === id &&
                item.assistantMessageId === message.id,
            );
            if (!live) {
              return message;
            }
            // 进行中的消息：正文用流的累积文本，meta 同时清掉上一轮收尾写下的
            // 结束态字段（finishReason/errorCode/errorText/resumable）——否则错误框、
            // 「重试」「继续」按钮会挂在进行中的消息头上（磁盘 meta 是中断时的旧值）。
            // 与 resumeChat 种子同款处理：meta 是这些 UI 的唯一数据源。
            return {
              ...message,
              content: live.text,
              meta: {
                ...(message.meta ?? {}),
                finishReason: undefined,
                errorCode: undefined,
                errorText: undefined,
                resumable: undefined,
              },
            };
          });
          // 取「最后一条」仍未丢弃的本会话流作为恢复目标。
          // 注意：findLast 属于 ES2023，本项目 lib 锁在 ES2022，故用等价的 filter(...).at(-1)
          // （Array.prototype.at 是 ES2022），二者语义一致——都返回最后一个匹配元素。
          const resumed = Object.values(state.streams)
            .filter((item) => !item.discarded && item.conversationId === id)
            .at(-1);
          return {
            messages,
            // 会话绑定的工作区：有则用之，无则回退默认（null）
            activeWorkspaceRoot: conversation.workspaceRoot ?? null,
            // 切回仍在生成的会话：重新挂上「生成中」态与可被停止的 requestId
            activeRequestId: resumed ? resumed.requestId : state.activeRequestId,
            loading: resumed ? true : state.loading,
          };
        });
        // 会话切好、消息就位后刷新上下文用量（异步，不阻塞界面渲染）
        void get().refreshContextStats();
        // 评测索引与消息一一对应，必须等 messages 落定后再拉，否则图标无处可挂
        void get().refreshJudgeIndex(id);
      }
    } catch {
      set({ error: '读取会话失败，请重试' });
    }
  },

  /**
   * 新建会话并选中。
   *
   * 幂等：当前已是「空会话」（有选中会话且无任何消息）时直接返回，不再新建。
   * 合并重入：已有一次新建在飞时**等它完成**而不是再发一次 —— 连点不再堆积；
   *   调用方 await 之后一定能拿到可用的会话（否则 Composer 的发送链路会被静默吞掉）。
   * 调用方（Sidebar）负责把主区切回聊天；本 action **绝不**改 mainView。
   */
  createConversation: async () => {
    const { activeConversationId, messages } = get();
    if (activeConversationId !== null && messages.length === 0) {
      return;
    }
    const inFlight = creatingConversation;
    if (inFlight !== null) {
      // 已在新建中：等它结束即可。task 内部已吞掉异常 ⇒ 这里不会抛。
      await inFlight;
      return;
    }
    // task 内部自吞异常 ⇒ 它永不 reject，故上面 `await inFlight` 的调用方不必再兜一层
    const task = (async () => {
      try {
        const conversation = await apiCreateConversation();
        set((state) => ({
          conversations: sortConversationsByPinned([
            toSummary(conversation),
            ...state.conversations.filter((item) => item.id !== conversation.id),
          ]),
        }));
        await get().selectConversation(conversation.id);
      } catch {
        set({ error: '新建会话失败，请重试' });
      }
    })();
    creatingConversation = task;
    try {
      await task;
    } finally {
      creatingConversation = null;
    }
  },

  /** 删除会话；若删的是当前会话则顺位选中第一条 */
  removeConversation: async (id) => {
    try {
      await apiDeleteConversation(id);
      set((state) => ({
        conversations: state.conversations.filter((item) => item.id !== id),
        unreadConversations: clearUnread(state.unreadConversations, id),
      }));
      if (get().activeConversationId === id) {
        // 主进程侧已负责清空 ui.lastConversationId（见 handleConversationDelete）
        const nextId = get().conversations[0]?.id ?? null;
        await get().selectConversation(nextId);
      }
    } catch {
      set({ error: '删除会话失败，请重试' });
    }
  },

  /** 重命名会话：标题规范化后先本地乐观更新，失败回滚并报错 */
  renameConversation: async (id, title) => {
    const next = title.trim().replace(/\s+/g, ' ');
    if (next.length === 0) {
      return;
    }
    const previous = get().conversations;
    set((state) => ({
      conversations: state.conversations.map((item) =>
        item.id === id ? { ...item, title: next } : item,
      ),
    }));
    try {
      await apiRenameConversation(id, next);
    } catch {
      set({ conversations: previous, error: '重命名失败，请重试' });
    }
  },

  /** 置顶 / 取消置顶：先本地乐观更新并重排，失败回滚并报错 */
  setConversationPinned: async (id, pinned) => {
    const previous = get().conversations;
    set((state) => ({
      conversations: sortConversationsByPinned(
        state.conversations.map((item) => (item.id === id ? { ...item, pinned } : item)),
      ),
    }));
    try {
      await apiSetConversationPinned(id, pinned);
    } catch {
      set({ conversations: previous, error: '操作失败，请重试' });
    }
  },

  /**
   * 发送一条消息：先乐观插入本地消息，再调 IPC。
   * 主进程返回权威 id 后，用 remapOptimisticIds 把本地临时 id 换成正式 id。
   *
   * 传 replaceMessageId 时为「编辑重发」：本地先截断该条及其之后的全部消息（与主进程侧一致），
   * 再用新内容重发，从而让旧回复立刻从界面消失。
   *
   * attachments 随消息透传给主进程落盘；只有文件、没有正文时同样放行
   * （准入门改为「无正文且无附件」才拦截）。
   */
  sendMessage: async (content, replaceMessageId, attachments) => {
    const text = content.trim();
    // 附件列表归一：调用方可能传 undefined / null，统一成数组
    const files = Array.isArray(attachments) ? attachments : [];
    const conversationId = get().activeConversationId;
    // 准入门按「当前会话是否已有未丢弃的进行中流」判定，而非全局 loading。
    // 否则在 selectConversation 的 await 窗口内（此时 loading 已短暂复位为 false）
    // 同会话可能再发起一条失控流，造成并发双流。
    const hasActiveStream =
      conversationId !== null &&
      Object.values(get().streams).some(
        (stream) => stream.conversationId === conversationId && !stream.discarded,
      );
    if ((!text && files.length === 0) || !conversationId || hasActiveStream) {
      return;
    }

    const requestId = createRequestId();
    const userMessageId = createRequestId();
    const assistantMessageId = createRequestId();
    const now = Date.now();

    set((state) => {
      // 编辑重发：本地先丢弃被编辑的那条及其之后的全部消息，与主进程侧的截断保持一致。
      // 不做这一步的话，旧回复会残留在界面上，直到下一次拉取会话才消失。
      const cutIndex = replaceMessageId
        ? state.messages.findIndex((item) => item.id === replaceMessageId)
        : -1;
      const base = cutIndex >= 0 ? state.messages.slice(0, cutIndex) : state.messages;
      return {
        messages: [
          ...base,
          {
            id: userMessageId,
            conversationId,
            role: 'user',
            content: text,
            createdAt: now,
            // 仅在真有附件时写：与主进程落盘形态保持一致
            ...(files.length > 0 ? { attachments: files } : {}),
          },
          {
            id: assistantMessageId,
            conversationId,
            role: 'assistant',
            content: '',
            createdAt: now + 1,
            meta: {},
          },
        ],
        streams: {
          ...state.streams,
          [requestId]: { requestId, conversationId, assistantMessageId, text: '', steps: [], plan: [], discarded: false },
        },
        activeRequestId: requestId,
        loading: true,
        error: null,
      };
    });

    try {
      const response: ChatSendResponse = await sendChat({
        requestId,
        conversationId,
        content: text,
        // 空值不传：无意义地传空串会让主进程多走一次判断，语义也不清晰
        ...(files.length > 0 ? { attachments: files } : {}),
        ...(replaceMessageId ? { replaceMessageId } : {}),
      });
      get().remapOptimisticIds(
        requestId,
        userMessageId,
        response.userMessageId,
        assistantMessageId,
        response.assistantMessageId,
      );
    } catch {
      // 连 IPC 通道都没打通：直接把本轮标记为失败，避免输入框卡死
      get().failStream(requestId, 'NETWORK', '发送失败，请重试');
    }
  },

  /**
   * 续跑：接着一条被中止的 assistant 消息从 checkpoint 继续跑。
   * 不新建消息：复用目标 assistant 消息，正文在旧正文之后追加（chat:end 的整体覆盖语义
   * 由主进程保证——推回来的 content 是「旧正文 + 新正文」的完整全文）。
   */
  resumeChat: async (assistantMessageId) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    // 并发门与 sendMessage 同口径：按「当前会话是否有未丢弃的进行中流」判定
    const hasActiveStream = Object.values(get().streams).some(
      (stream) => stream.conversationId === conversationId && !stream.discarded,
    );
    if (hasActiveStream) return;
    // 目标消息必须存在、是 assistant、且带 resumable 标记（主进程写）
    const target = get().messages.find((item) => item.id === assistantMessageId);
    if (!target || target.role !== 'assistant' || !target.meta?.resumable) return;

    const requestId = createRequestId();
    set((state) => ({
      streams: {
        ...state.streams,
        [requestId]: {
          requestId,
          conversationId,
          assistantMessageId,
          // 种子取目标消息现值：正文衔接（新 delta 追加在后），steps/plan 延续旧值
          text: target.content,
          steps: target.meta?.steps ?? [],
          plan: target.meta?.plan ?? [],
          discarded: false,
        },
      },
      activeRequestId: requestId,
      loading: true,
      error: null,
      // 消息迁回「进行中」：清掉上一轮收尾写下的结束态字段（finishReason/errorCode/
      // errorText/resumable）——它们是红色错误框、「重试」「继续」按钮的唯一数据源，
      // 不清则这些元素会原样挂在新一轮头上（用户点「继续」后界面毫无变化）。
      // steps/plan 不动：种子已取，upsertStep/onPlan 会继续在其上叠加。
      messages: state.messages.map((message) =>
        message.id === assistantMessageId
          ? {
              ...message,
              meta: {
                ...(message.meta ?? {}),
                finishReason: undefined,
                errorCode: undefined,
                errorText: undefined,
                resumable: undefined,
              },
            }
          : message,
      ),
    }));

    try {
      await resumeChat({ requestId, conversationId, assistantMessageId });
    } catch {
      // 与 sendMessage 同口径：IPC 都没打通时用 NETWORK 码收尾，避免流卡住
      get().failStream(requestId, 'NETWORK', '续跑失败，请重试');
    }
  },

  /** 停止当前生成 */
  abortActive: async () => {
    const requestId = get().activeRequestId;
    if (!requestId) {
      return;
    }
    try {
      await abortChat(requestId);
    } catch {
      // 停止失败不改变 UI 状态，等待 chat:end / chat:error 自行收尾
    }
  },

  /** 追加一段流式文本；按 requestId 隔离，已丢弃的流直接忽略 */
  appendDelta: (requestId, delta) => {
    if (!delta) {
      return;
    }
    set((state) => {
      const stream = state.streams[requestId];
      if (!stream || stream.discarded) {
        return state;
      }
      const text = stream.text + delta;
      const isVisible = stream.conversationId === state.activeConversationId;
      return {
        streams: { ...state.streams, [requestId]: { ...stream, text } },
        messages: isVisible
          ? state.messages.map((message) =>
              message.id === stream.assistantMessageId ? { ...message, content: text } : message,
            )
          : state.messages,
      };
    });
  },

  /**
   * 覆盖式写入工具步骤：按 requestId 隔离，已丢弃的流直接忽略。
   * 同步把 steps 写进当前会话对应 assistant 消息的 meta.steps，
   * 这样 MessageBubble 无需新 prop 即可实时看到步骤（见 4.6）。
   */
  upsertStep: (requestId, step) => {
    set((state) => {
      const stream = state.streams[requestId];
      if (!stream || stream.discarded) {
        return state;
      }
      // 按 step.id 覆盖：已存在则替换，否则追加
      const steps = stream.steps.some((item) => item.id === step.id)
        ? stream.steps.map((item) => (item.id === step.id ? step : item))
        : [...stream.steps, step];
      const isVisible = stream.conversationId === state.activeConversationId;
      return {
        // 必须生成新的 messages 数组引用（map），否则步骤更新不会触发重渲染
        streams: { ...state.streams, [requestId]: { ...stream, steps } },
        messages: isVisible
          ? state.messages.map((message) =>
              message.id === stream.assistantMessageId
                ? { ...message, meta: { ...(message.meta ?? {}), steps } }
                : message,
            )
          : state.messages,
      };
    });
  },

  /**
   * 覆盖式写入本轮计划清单：按 requestId 隔离，已丢弃的流直接忽略。
   * 同步把 plan 写进当前会话对应 assistant 消息的 meta.plan，
   * 这样 MessageBubble 无需新 prop 即可实时看到计划。
   * 整份替换（非增量）：主进程每次推来的 ChatPlanEvent.plan 就是全量快照。
   */
  upsertPlan: (requestId, plan) => {
    set((state) => {
      const stream = state.streams[requestId];
      if (!stream || stream.discarded) {
        return state;
      }
      const isVisible = stream.conversationId === state.activeConversationId;
      return {
        // 必须生成新的 messages 数组引用（map），否则计划更新不会触发重渲染
        streams: { ...state.streams, [requestId]: { ...stream, plan } },
        messages: isVisible
          ? state.messages.map((message) =>
              message.id === stream.assistantMessageId
                ? { ...message, meta: { ...(message.meta ?? {}), plan } }
                : message,
            )
          : state.messages,
      };
    });
  },

  /** 正常 / 中止结束：写回全文与结束状态 */
  finishStream: (requestId, content, finishReason, resumable) => {
    const stream = get().streams[requestId];
    set((state) => {
      const shouldUpdateMessages =
        Boolean(stream) && !stream?.discarded && stream?.conversationId === state.activeConversationId;
      return {
        streams: omitStream(state.streams, requestId),
        messages: shouldUpdateMessages
          ? state.messages.map((message) =>
              message.id === stream?.assistantMessageId
                ? {
                    ...message,
                    content,
                    meta: {
                      ...(message.meta ?? {}),
                      finishReason,
                      steps: stream.steps,
                      // 仅当计划非空才写：避免用空数组盖掉已有值
                      ...(stream.plan.length > 0 ? { plan: stream.plan } : {}),
                      // 主进程按 checkpoint 存在性判定的可续跑标记：undefined（旧调用方/本地收尾）不写，
                      // 绝不覆盖消息上已有的 true/false
                      ...(resumable !== undefined ? { resumable } : {}),
                    },
                  }
                : message,
            )
          : state.messages,
        loading: state.activeRequestId === requestId ? false : state.loading,
        activeRequestId: state.activeRequestId === requestId ? null : state.activeRequestId,
        error: null,
        // 跑完时若用户没在看这个会话（切走了，或窗口不在焦点），点一个未读圆点
        unreadConversations:
          stream && !isConversationFocused(stream.conversationId, state.activeConversationId)
            ? { ...state.unreadConversations, [stream.conversationId]: true }
            : state.unreadConversations,
      };
    });
    if (stream && stream.discarded && stream.conversationId === get().activeConversationId) {
      // 流曾被丢弃但最终内容已落盘：重新拉取当前会话以拿到最终结果
      void get().selectConversation(stream.conversationId);
    } else if (stream) {
      void get().refreshConversations();
      // 一轮结束、正文定稿：上下文用量在此刻刷新一次（生成中不逐字刷新）
      void get().refreshContextStats();
    }
  },

  /** 异常结束：在消息上标记错误码，供错误块展示与重试 */
  failStream: (requestId, code, message, resumable) => {
    const stream = get().streams[requestId];
    set((state) => {
      const shouldUpdateMessages =
        Boolean(stream) && !stream?.discarded && stream?.conversationId === state.activeConversationId;
      return {
        streams: omitStream(state.streams, requestId),
        messages: shouldUpdateMessages
          ? state.messages.map((item) =>
              item.id === stream?.assistantMessageId
                ? {
                    ...item,
                    meta: {
                      ...(item.meta ?? {}),
                      finishReason: 'error' as FinishReason,
                      errorCode: code,
                      errorText: message,
                      steps: stream?.steps ?? [],
                      // 被动崩溃场景（checkpoint 仍在盘）也点亮「继续」：error 收尾与
                      // aborted 收尾的可续跑语义相同，仅结束原因不同
                      ...(resumable !== undefined ? { resumable } : {}),
                    },
                  }
                : item,
            )
          : state.messages,
        loading: state.activeRequestId === requestId ? false : state.loading,
        activeRequestId: state.activeRequestId === requestId ? null : state.activeRequestId,
        error: message,
        // 跑完时若用户没在看这个会话（切走了，或窗口不在焦点），点一个未读圆点
        unreadConversations:
          stream && !isConversationFocused(stream.conversationId, state.activeConversationId)
            ? { ...state.unreadConversations, [stream.conversationId]: true }
            : state.unreadConversations,
      };
    });
    if (stream && stream.discarded && stream.conversationId === get().activeConversationId) {
      void get().selectConversation(stream.conversationId);
    } else if (stream) {
      void get().refreshConversations();
      // 异常收尾同样是「消息定稿」：刷新一次上下文用量
      void get().refreshContextStats();
    }
  },

  /** 用主进程返回的权威 id 替换乐观插入时使用的临时 id */
  remapOptimisticIds: (
    requestId,
    localUserMessageId,
    remoteUserMessageId,
    localAssistantMessageId,
    remoteAssistantMessageId,
  ) => {
    if (!remoteUserMessageId || !remoteAssistantMessageId) {
      return;
    }
    set((state) => {
      const stream = state.streams[requestId];
      return {
        streams: stream
          ? {
              ...state.streams,
              [requestId]: { ...stream, assistantMessageId: remoteAssistantMessageId },
            }
          : state.streams,
        messages: state.messages.map((message) => {
          if (message.id === localUserMessageId) {
            return { ...message, id: remoteUserMessageId };
          }
          if (message.id === localAssistantMessageId) {
            return { ...message, id: remoteAssistantMessageId };
          }
          return message;
        }),
      };
    });
  },

  /** 拉取某个 Provider 的候选模型；draft 为表单未保存现值，主进程只对本次拉取应用、不落盘 */
  refreshModels: async (providerId, draft) => {
    try {
      const models: ModelInfo[] = await listModels(providerId, draft);
      set((state) =>
        state.config
          ? {
              config: {
                ...state.config,
                models: { ...state.config.models, [providerId]: models },
              },
            }
          : state,
      );
      // 回传列表：调用方（设置页）据此取模型自带的 contextWindow 自动填表
      return models;
    } catch {
      // 模型列表失败不影响主流程，UI 允许手填
      return [];
    }
  },

  /** 保存配置（返回的新配置已经是脱敏形态） */
  saveAppConfig: async (input) => {
    try {
      const config = await saveConfig(input);
      set({ config });
      await get().refreshModels(config.activeProviderId);
    } catch {
      set({ error: '保存配置失败，请重试' });
    }
  },

  /** 快速切换模型：只 patch 目标 provider 的 model 与 activeProviderId，其余字段不动 */
  switchModel: async (providerId, model) => {
    const trimmed = model.trim();
    if (!trimmed) {
      return;
    }
    const payload: ConfigSaveInput = { activeProviderId: providerId };
    if (providerId === 'deepseek') {
      payload.deepseek = { model: trimmed };
    } else if (providerId === 'custom') {
      payload.custom = { model: trimmed };
    } else {
      payload.ollama = { model: trimmed };
    }
    try {
      const config = await saveConfig(payload);
      set({ config, error: null });
      // 切到某个服务时它的候选列表可能还没拉过，后台补一次，不阻塞交互
      void get().refreshModels(providerId);
    } catch {
      set({ error: '切换模型失败，请重试' });
    }
  },

  /** 弹系统目录框，把选中的目录绑定到当前会话；用户取消则不改 */
  pickWorkspace: async () => {
    const id = get().activeConversationId;
    if (!id) {
      return;
    }
    try {
      const result = await apiPickWorkspace();
      // 用户取消或主进程未返回路径：不做任何变更
      if (result.canceled || !result.path) {
        return;
      }
      await apiSetConversationWorkspace(id, result.path);
      set({ activeWorkspaceRoot: result.path, error: null });
    } catch {
      set({ error: '选择工作区失败，请重试' });
    }
  },

  /** 解绑当前会话的工作区，回退到默认工作区 */
  resetWorkspace: async () => {
    const id = get().activeConversationId;
    if (!id) {
      return;
    }
    try {
      await apiSetConversationWorkspace(id, null);
      set({ activeWorkspaceRoot: null, error: null });
    } catch {
      set({ error: '恢复默认工作区失败，请重试' });
    }
  },

  /**
   * 首屏主题：必须在 createRoot().render() 之前 await。
   * 读配置失败时退回「跟随系统」，绝不阻断首屏。
   */
  initTheme: async () => {
    try {
      const config = await getConfig();
      applyTheme(resolveTheme(config.ui?.theme));
    } catch {
      applyTheme(resolveTheme(undefined));
    }
  },

  /** 切换主题：持久化后再落到 DOM，避免出现「界面变了但重启丢失」的假象 */
  setThemeMode: async (mode) => {
    try {
      const config = await saveConfig({ ui: { theme: mode } });
      set({ config });
      applyTheme(resolveTheme(config.ui?.theme));
    } catch {
      set({ error: '保存外观设置失败，请重试' });
    }
  },

  /** 切换记忆功能：把布尔开关下发给主进程持久化，成功后用回读的脱敏配置覆盖本地 */
  setMemoryEnabled: async (enabled) => {
    try {
      const config = await saveConfig({ memoryEnabled: enabled });
      set({ config });
    } catch {
      set({ error: '保存记忆设置失败，请重试' });
    }
  },

  /**
   * 首帧登录态：在 createRoot().render() 之前 await。
   * 读取失败一律按「未登录」处理（安全默认：宁可让用户重登，也不静默放行）；
   * 无论成败都要置 authChecked，否则界面会永久停在启动态。
   */
  initAuth: async () => {
    try {
      const auth = await apiGetAuthState();
      get().applyAuthState(auth);
    } catch {
      set({ auth: { state: 'unauthenticated' }, authChecked: true });
    }
  },

  /**
   * 收敛一次登录态：主进程推送的 auth:changed 与本地各 action 的成功结果都走这里，
   * 避免多处各自 set 造成状态分裂。
   *
   * 从「已登录」跨到「未登录」时，一并清空上一个账号的内存会话数据，防止登出后
   * 仍短暂看到上一账号的会话（跨账号泄漏）。config 为设备级（主题 / Provider /
   * 记忆开关），与账号无关，故保留不清；登录后的 hydrate 会按新分区重新拉取。
   */
  applyAuthState: (next) => {
    const wasAuthed = isAuthed(get().auth);
    const nowAuthed = isAuthed(next);
    if (wasAuthed && !nowAuthed) {
      set((state) => ({
        auth: next,
        authChecked: true,
        conversations: [],
        activeConversationId: null,
        messages: [],
        streams: discardAll(state.streams),
        activeRequestId: null,
        loading: false,
        activeWorkspaceRoot: null,
        // 关闭设置弹层：否则下次登录会被自动重新打开
        settingsOpen: false,
        // 回到会话视图：否则下次登录会被自动留在技能页
        mainView: 'chat',
        error: null,
        unreadConversations: {},
        // 跨账号：评测索引 / 汇总属于上一个账号的数据，必须一并清掉（主进程侧也按账号分目录）
        judgingMessageIds: [],
        judgeIndex: {},
        judgeSummary: null,
        judgeError: null,
      }));
      return;
    }
    set({ auth: next, authChecked: true });
  },

  /**
   * 登录。成功后立即乐观收敛（不等 auth:changed），保证界面即时切到主界面；
   * 主进程随后推送的同值事件由 applyAuthState 幂等吸收。
   */
  signIn: async (email, password, remember) => {
    try {
      const result = await apiSignIn({ email, password, remember });
      if (!result.ok) {
        return result.message ?? AUTH_ERROR_TEXT.UNKNOWN;
      }
      get().applyAuthState(result.state);
      return null;
    } catch {
      return AUTH_ERROR_TEXT.UNKNOWN;
    }
  },

  /**
   * 注册。
   * - needsEmailConfirm=false：注册即登录（主进程已置登录态），此处主动回读一次登录态
   *   （signUp 通道不推送 auth:changed），使界面立即进入主界面；
   * - needsEmailConfirm=true：需去邮箱点确认链接，登录态不变。
   */
  signUp: async (email, password) => {
    try {
      const result = await apiSignUp({ email, password });
      if (!result.ok) {
        return { error: result.message ?? AUTH_ERROR_TEXT.UNKNOWN, needsEmailConfirm: false };
      }
      if (!result.needsEmailConfirm) {
        try {
          const auth = await apiGetAuthState();
          get().applyAuthState(auth);
        } catch {
          // 回读失败不阻断注册成功：界面下次 initAuth/auth:changed 会自愈
        }
      }
      return { error: null, needsEmailConfirm: result.needsEmailConfirm };
    } catch {
      return { error: AUTH_ERROR_TEXT.UNKNOWN, needsEmailConfirm: false };
    }
  },

  /** 登出：乐观收敛到「未登录」，界面立即回登录页；主进程推送同值事件幂等吸收 */
  signOut: async () => {
    try {
      const result = await apiSignOut();
      get().applyAuthState(result.state);
    } catch {
      set({ error: AUTH_ERROR_TEXT.UNKNOWN });
    }
  },

  /**
   * 清除本账号本地会话数据。二次确认由调用方负责，这里始终带 confirm=true 下发。
   * 成功后清空本地会话切片（磁盘数据已由主进程删除），返回被移除的会话数。
   */
  clearLocalData: async () => {
    try {
      const result = await apiClearLocalData({ confirm: true });
      if (!result.ok) {
        return null;
      }
      set((state) => ({
        conversations: [],
        activeConversationId: null,
        messages: [],
        streams: discardAll(state.streams),
        activeRequestId: null,
        loading: false,
        activeWorkspaceRoot: null,
        unreadConversations: {},
        // 评测数据已由主进程一并删除：内存里的索引 / 汇总 / 错误提示全部复位
        judgingMessageIds: [],
        judgeIndex: {},
        judgeSummary: null,
        judgeError: null,
      }));
      return result.removedCount;
    } catch {
      return null;
    }
  },

  /** 拉取技能列表；失败静默（技能列表属次要能力，不打断交互） */
  refreshSkills: async () => {
    try {
      const skills = await apiListSkills();
      set({ skills });
    } catch {
      // 静默：面板保留上一次结果
    }
  },

  /** 从文件夹导入技能；只要有导入成功就刷新列表，结构化结果原样返回 */
  importSkills: async () => {
    try {
      const result = await apiImportSkills();
      if (result.imported.length > 0) {
        await get().refreshSkills();
      }
      return result;
    } catch {
      return { ok: false, canceled: false, imported: [], skipped: [], error: '导入失败，请重试' };
    }
  },

  /** 删除一个技能；成功后刷新列表 */
  deleteSkill: async (dirName) => {
    try {
      const result = await apiDeleteSkill({ dirName, confirm: true });
      if (result.ok) {
        await get().refreshSkills();
      }
      return result;
    } catch {
      return { ok: false, error: '删除失败，请重试' };
    }
  },

  /** 打开技能根目录；失败信息原样返回给面板展示 */
  openSkillsDir: async () => {
    try {
      return await apiOpenSkillsDir();
    } catch {
      return { ok: false, reason: '打开技能目录失败' };
    }
  },

  /**
   * 设置 / 取消某条消息的评价。
   *
   * 乐观更新：先改本地索引让图标立刻响应，再发 IPC；
   * IPC 返回 ok=false 或抛错时回滚到「改动前的那一条」——
   * 若改动前根本没有条目，则整条删掉，不留半成品。
   */
  setFeedback: async (messageId, verdict) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) {
      return;
    }
    // 显式标注 | undefined：tsconfig 未开 noUncheckedIndexedAccess，索引访问的类型不含 undefined
    const previous: JudgeIndexEntry | undefined = get().judgeIndex[messageId];
    // 第一步：乐观更新（只动 verdict，hasRun 保持原值 —— 评价不代表评过分）
    set((state) => {
      const current: JudgeIndexEntry | undefined = state.judgeIndex[messageId];
      const next: JudgeIndexEntry = { hasRun: current?.hasRun ?? false };
      if (verdict !== null) {
        next.verdict = verdict;
      }
      return { judgeIndex: { ...state.judgeIndex, [messageId]: next } };
    });
    try {
      const result = await setJudgeFeedback(conversationId, messageId, verdict);
      if (!result.ok) {
        throw new Error(result.error ?? '评价失败');
      }
      // 以主进程落盘结果为准：取消评价时 verdict 缺省 ⇒ 字段被删掉（不留第三态）
      set((state) => {
        const current: JudgeIndexEntry | undefined = state.judgeIndex[messageId];
        const next: JudgeIndexEntry = { hasRun: current?.hasRun ?? false };
        if (result.verdict !== undefined) {
          next.verdict = result.verdict;
        }
        return { judgeIndex: { ...state.judgeIndex, [messageId]: next } };
      });
    } catch {
      // 回滚：失败不弹横幅，图标自己翻回去就是最直接的反馈
      set((state) => {
        const judgeIndex = { ...state.judgeIndex };
        if (previous === undefined) {
          delete judgeIndex[messageId];
        } else {
          judgeIndex[messageId] = previous;
        }
        return { judgeIndex };
      });
    }
  },

  /**
   * 对某条消息跑一次评测。
   * 失败**不**点亮「已评测」—— 红叉闪 1.5s 并给出主进程的原始文案，
   * 让用户能区分「模型答得差」与「judge 没跑起来」。
   */
  runJudge: async (messageId) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) {
      return;
    }
    // 同一消息不并发：连点会白烧一次 judge 调用，也会让图标状态互相打架
    if (get().judgingMessageIds.includes(messageId)) {
      return;
    }
    set((state) => ({ judgingMessageIds: [...state.judgingMessageIds, messageId] }));
    try {
      const result = await apiRunJudge(conversationId, messageId);
      const run = result.run;
      if (result.ok && run?.scores !== undefined) {
        // 用户可能已切走会话：此时写进去的键永远等不到 refreshJudgeIndex 来清，
        // 会在 judgeIndex 里留下一条孤儿记录（不会串号，但白占内存且难排查）
        if (get().activeConversationId !== conversationId) {
          return;
        }
        // 成功：只点亮「已评测」，分数一律不写进 judgeIndex（PRD P5）
        set((state) => {
          const current: JudgeIndexEntry | undefined = state.judgeIndex[messageId];
          const entry: JudgeIndexEntry = { hasRun: true };
          if (current?.verdict !== undefined) {
            entry.verdict = current.verdict;
          }
          return { judgeIndex: { ...state.judgeIndex, [messageId]: entry } };
        });
        return;
      }
      flashJudgeError(messageId, result.error ?? run?.error ?? '评测失败，请重试');
    } catch {
      flashJudgeError(messageId, '评测失败，请重试');
    } finally {
      // 无论成功失败都要摘掉「评测中」，否则图标会永久转圈
      set((state) => ({
        judgingMessageIds: state.judgingMessageIds.filter((id) => id !== messageId),
      }));
    }
  },

  /** 拉取「质量」分组汇总；失败静默（设置页保留上一次的数字好过闪成空态） */
  refreshJudgeSummary: async () => {
    try {
      const summary = await getJudgeSummary(JUDGE_SUMMARY_DAYS);
      set({ judgeSummary: summary });
    } catch {
      // 静默：面板保留上一次结果
    }
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  setMainView: (view) => set({ mainView: view }),

  setError: (error) => set({ error }),
}));
