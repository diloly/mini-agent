/**
 * 全局状态：会话 / 消息 / 流式缓冲 / loading / error / 配置 / 主题。
 *
 * 流式不串流的关键：所有流式状态按 requestId 隔离存放；
 * 切换会话时把进行中的流标记为 discarded，后续 delta 直接丢弃，
 * 天然实现「切会话后旧流不再渲染」。
 */
import { create } from 'zustand';
import type {
  ChatSendResponse,
  ConfigSaveInput,
  ConversationSummary,
} from '../../shared/ipc-channels';
import type {
  ErrorCode,
  FinishReason,
  Message,
  ModelInfo,
  ProviderId,
  PublicConfig,
  ThemeMode,
  ToolStep,
} from '../../shared/types';
import {
  abortChat,
  createConversation as apiCreateConversation,
  createRequestId,
  deleteConversation as apiDeleteConversation,
  getConfig,
  listConversations,
  getConversation,
  listModels,
  saveConfig,
  sendChat,
} from '../lib/api';
import { applyTheme, resolveTheme } from '../lib/theme';

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
  return config.providers.ollama.model.trim().length > 0;
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
  config: PublicConfig | null;
  settingsOpen: boolean;

  hydrate: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  selectConversation: (id: string | null) => Promise<void>;
  createConversation: () => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  abortActive: () => Promise<void>;
  appendDelta: (requestId: string, delta: string) => void;
  /** 覆盖式写入某个工具步骤（step.id 相同则替换） */
  upsertStep: (requestId: string, step: ToolStep) => void;
  finishStream: (requestId: string, content: string, finishReason: FinishReason) => void;
  failStream: (requestId: string, code: ErrorCode, message: string) => void;
  remapOptimisticIds: (
    requestId: string,
    localUserMessageId: string,
    remoteUserMessageId: string,
    localAssistantMessageId: string,
    remoteAssistantMessageId: string,
  ) => void;
  refreshModels: (providerId: ProviderId) => Promise<void>;
  saveAppConfig: (input: ConfigSaveInput) => Promise<void>;
  /** 在输入区快速切换模型服务 / 模型，不打开设置弹层 */
  switchModel: (providerId: ProviderId, model: string) => Promise<void>;
  /** 在 React 挂载前调用：只取主题落到 DOM，避免首帧先浅后深 */
  initTheme: () => Promise<void>;
  /** 切换主题偏好并持久化 */
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  setSettingsOpen: (open: boolean) => void;
  setError: (error: string | null) => void;
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
}): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    providerId: conversation.providerId,
    model: conversation.model,
    messageCount: conversation.messages.length,
  };
}

export const useAppStore = create<AppState>()((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  streams: {},
  activeRequestId: null,
  loading: false,
  error: null,
  config: null,
  settingsOpen: false,

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

  /** 切换会话：重绑定进行中的流，再拉取该会话的全量消息 */
  selectConversation: async (id) => {
    if (!id) {
      set((state) => ({
        activeConversationId: null,
        messages: [],
        streams: discardAll(state.streams),
        loading: false,
        activeRequestId: null,
        // 离开会话时一并清掉全局错误横幅，避免错误提示残留在空态页上
        error: null,
      }));
      return;
    }
    // 目标会话的进行中流复位为「可见」，其余会话的流标记为已丢弃
    set((state) => ({
      activeConversationId: id,
      messages: [],
      streams: rebindStreams(state.streams, id),
      error: null,
      // 必须同时退出「生成中」：否则旧流的 requestId 会残留在 activeRequestId 上，
      // 结果是输入框被锁死、点「停止」还会停到已经切走的旧流上
      loading: false,
      activeRequestId: null,
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
            return live ? { ...message, content: live.text } : message;
          });
          // 取「最后一条」仍未丢弃的本会话流作为恢复目标。
          // 注意：findLast 属于 ES2023，本项目 lib 锁在 ES2022，故用等价的 filter(...).at(-1)
          // （Array.prototype.at 是 ES2022），二者语义一致——都返回最后一个匹配元素。
          const resumed = Object.values(state.streams)
            .filter((item) => !item.discarded && item.conversationId === id)
            .at(-1);
          return {
            messages,
            // 切回仍在生成的会话：重新挂上「生成中」态与可被停止的 requestId
            activeRequestId: resumed ? resumed.requestId : state.activeRequestId,
            loading: resumed ? true : state.loading,
          };
        });
      }
    } catch {
      set({ error: '读取会话失败，请重试' });
    }
  },

  /** 新建会话并立即选中 */
  createConversation: async () => {
    try {
      const conversation = await apiCreateConversation();
      set((state) => ({
        conversations: [toSummary(conversation), ...state.conversations.filter((item) => item.id !== conversation.id)],
      }));
      await get().selectConversation(conversation.id);
    } catch {
      set({ error: '新建会话失败，请重试' });
    }
  },

  /** 删除会话；若删的是当前会话则顺位选中第一条 */
  removeConversation: async (id) => {
    try {
      await apiDeleteConversation(id);
      set((state) => ({ conversations: state.conversations.filter((item) => item.id !== id) }));
      if (get().activeConversationId === id) {
        // 主进程侧已负责清空 ui.lastConversationId（见 handleConversationDelete）
        const nextId = get().conversations[0]?.id ?? null;
        await get().selectConversation(nextId);
      }
    } catch {
      set({ error: '删除会话失败，请重试' });
    }
  },

  /**
   * 发送一条消息：先乐观插入本地消息，再调 IPC。
   * 主进程返回权威 id 后，用 remapOptimisticIds 把本地临时 id 换成正式 id。
   */
  sendMessage: async (content) => {
    const text = content.trim();
    const conversationId = get().activeConversationId;
    // 准入门按「当前会话是否已有未丢弃的进行中流」判定，而非全局 loading。
    // 否则在 selectConversation 的 await 窗口内（此时 loading 已短暂复位为 false）
    // 同会话可能再发起一条失控流，造成并发双流。
    const hasActiveStream =
      conversationId !== null &&
      Object.values(get().streams).some(
        (stream) => stream.conversationId === conversationId && !stream.discarded,
      );
    if (!text || !conversationId || hasActiveStream) {
      return;
    }

    const requestId = createRequestId();
    const userMessageId = createRequestId();
    const assistantMessageId = createRequestId();
    const now = Date.now();

    set((state) => ({
      messages: [
        ...state.messages,
        { id: userMessageId, conversationId, role: 'user', content: text, createdAt: now },
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
        [requestId]: { requestId, conversationId, assistantMessageId, text: '', steps: [], discarded: false },
      },
      activeRequestId: requestId,
      loading: true,
      error: null,
    }));

    try {
      const response: ChatSendResponse = await sendChat({ requestId, conversationId, content: text });
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

  /** 正常 / 中止结束：写回全文与结束状态 */
  finishStream: (requestId, content, finishReason) => {
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
                    meta: { ...(message.meta ?? {}), finishReason, steps: stream.steps },
                  }
                : message,
            )
          : state.messages,
        loading: state.activeRequestId === requestId ? false : state.loading,
        activeRequestId: state.activeRequestId === requestId ? null : state.activeRequestId,
        error: null,
      };
    });
    if (stream && stream.discarded && stream.conversationId === get().activeConversationId) {
      // 流曾被丢弃但最终内容已落盘：重新拉取当前会话以拿到最终结果
      void get().selectConversation(stream.conversationId);
    } else if (stream) {
      void get().refreshConversations();
    }
  },

  /** 异常结束：在消息上标记错误码，供错误块展示与重试 */
  failStream: (requestId, code, message) => {
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
                    },
                  }
                : item,
            )
          : state.messages,
        loading: state.activeRequestId === requestId ? false : state.loading,
        activeRequestId: state.activeRequestId === requestId ? null : state.activeRequestId,
        error: message,
      };
    });
    if (stream && stream.discarded && stream.conversationId === get().activeConversationId) {
      void get().selectConversation(stream.conversationId);
    } else if (stream) {
      void get().refreshConversations();
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

  /** 拉取某个 Provider 的候选模型 */
  refreshModels: async (providerId) => {
    try {
      const models: ModelInfo[] = await listModels(providerId);
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
    } catch {
      // 模型列表失败不影响主流程，UI 允许手填
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

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  setError: (error) => set({ error }),
}));
