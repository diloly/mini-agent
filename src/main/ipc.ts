/**
 * 主进程 IPC 路由与流式编排。
 *
 * chat:send 的编排顺序（固定，不得调整）：
 *   1. 校验 isConfigured；未配置则落盘一条带错误标记的消息并 emit chat:error
 *   2. 追加 user 消息 + 占位 assistant 消息并落盘
 *   3. 取上下文：最近 20 条（若切片首条是 assistant 则丢弃该条）
 *   4. running.set(requestId, controller)
 *   5. 立即 return {requestId}（invoke 不 await 完整响应）
 *   6. 解密 Key → chatStream → 每个 delta 立刻 emit chat:chunk
 *   7. 正常结束：落盘全文 + 生成会话标题 → emit chat:end
 *   8. 异常：落盘 errorCode → emit chat:error
 *   9. finally：从 Map 删除 requestId
 *  10. chat:abort：abort() → 已生成内容照常落盘 → emit chat:end{finishReason:'aborted'}
 *
 * 编辑重发：request.replaceMessageId 存在时，第 2 步先截断该条消息及其之后的全部消息，
 * 再追加本轮消息 —— 复用同一条 chat:send 通道，不额外新增 IPC。
 */
import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import { dialog, ipcMain, shell } from 'electron';
import {
  CHANNELS,
  type AbortChatRequest,
  type ChannelName,
  type ChatSendRequest,
  type ChatSendResponse,
  type ChatStepEvent,
  type ConfigSaveInput,
  type ConversationSummary,
  type DeleteConversationRequest,
  type GetConversationRequest,
  type ListModelsRequest,
  type OkResult,
  type OpenExternalRequest,
  type OpenExternalResult,
  type PickWorkspaceResult,
  type SetConversationWorkspaceRequest,
} from '../shared/ipc-channels';
import {
  CONTEXT_MESSAGE_LIMIT,
  DEFAULT_CONVERSATION_TITLE,
  DEFAULT_THEME_MODE,
  ERROR_TEXT,
  isThemeMode,
  TITLE_MAX_LENGTH,
  type AppConfig,
  type Conversation,
  type ErrorCode,
  type FinishReason,
  type Message,
  type ModelInfo,
  type ProviderId,
  type PublicConfig,
  type ToolStep,
} from '../shared/types';
import { getProvider, isProviderId } from './providers';
import { combineSignals } from './providers/sse';
import { errorMessage, toProviderError, type LlmMessage, type LLMProvider } from './providers/types';
import { runAgentLoop, type ToolContext } from './harness';
import { getBackupRoot, getDefaultWorkspaceRoot, resolveWorkspaceRoot } from './workspace';
import { exportConversationMarkdown } from './conversation-export';
import { buildMemorySystemMessage, buildWorkspaceRulesMessage, extractWorkspaceMemory, readWorkspaceMemory } from './workspace-memory';
import { hasSecret, isEncryptionAvailable, loadSecret, saveSecret } from './secret';
import {
  mutateConfig,
  mutateConversations,
  readConfig,
  readConversations,
} from './storage';

/** 拉取模型列表的统一超时（毫秒） */
const MODELS_TIMEOUT_MS = 8_000;

/** 允许交给系统浏览器打开的协议白名单（其余一律拒绝，防止 file:// / 自定义协议提权） */
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

/** 创建路由所需的外部依赖 */
export interface IpcRouterDeps {
  /** 取当前主窗口；窗口未创建或已销毁时返回 null */
  getMainWindow: () => BrowserWindow | null;
}

/** 一轮进行中的生成任务 */
interface ChatSession {
  requestId: string;
  conversationId: string;
  assistantMessageId: string;
  controller: AbortController;
  /** 主进程侧累积的全文：流式期间不落盘，仅在 end / error / abort 时写一次 */
  text: string;
}

/** requestId → 进行中的生成任务 */
const running = new Map<string, ChatSession>();

/** 各 Provider 的通用配置片段（DeepSeek 额外带 apiKeyEnc） */
interface ProviderSettingsLike {
  baseUrl: string;
  model: string;
  apiKeyEnc?: string;
}

/** 取配置的某个 Provider 片段（用类型断言避免对 providerId 做分支判断） */
function getProviderSettings(config: AppConfig, providerId: ProviderId): ProviderSettingsLike {
  return config.providers[providerId] as ProviderSettingsLike;
}

/**
 * 构造运行期 Provider 配置，其中包含解密后的明文 Key。
 * 明文 Key 仅存在于主进程内存，绝不通过 IPC 外传。
 */
function buildProviderConfig(config: AppConfig, providerId: ProviderId = config.activeProviderId) {
  const settings = getProviderSettings(config, providerId);
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: loadSecret(providerId, settings.apiKeyEnc),
  };
}

/**
 * 刷新工作区记忆：额外调一次模型把本轮对话提炼进 MEMORY.md。
 * 刻意做成 fire-and-forget：它不产生任何用户可见产物，失败也不得影响主流程。
 */
async function refreshWorkspaceMemory(conversation: Conversation): Promise<void> {
  try {
    const config = await readConfig();
    // 记忆功能关闭时直接返回：连读盘都不必，更不能发那次额外的模型调用
    if (!config.memoryEnabled) {
      return;
    }
    const providerId = isProviderId(conversation.providerId) ? conversation.providerId : config.activeProviderId;
    const provider = getProvider(providerId);
    const providerConfig = buildProviderConfig(config, providerId);
    if (!provider.isConfigured(providerConfig)) {
      return;
    }
    await extractWorkspaceMemory(conversation, { provider, config: providerConfig });
  } catch {
    // 记忆属附加能力：提炼失败静默跳过，下一轮会重新尝试
  }
}

/** 把配置投影为渲染层可见的脱敏形态 */
function toPublicConfig(config: AppConfig): PublicConfig {
  const deepseek = getProviderSettings(config, 'deepseek');
  const ollama = getProviderSettings(config, 'ollama');
  return {
    activeProviderId: config.activeProviderId,
    providers: {
      deepseek: {
        baseUrl: deepseek.baseUrl,
        model: deepseek.model,
        hasApiKey: hasSecret('deepseek', deepseek.apiKeyEnc),
      },
      ollama: {
        baseUrl: ollama.baseUrl,
        model: ollama.model,
      },
    },
    models: { deepseek: [], ollama: [] },
    safeStorageAvailable: isEncryptionAvailable(),
    defaultWorkspaceRoot: getDefaultWorkspaceRoot(),
    memoryEnabled: config.memoryEnabled,
    ui: { lastConversationId: config.ui.lastConversationId, theme: config.ui.theme ?? DEFAULT_THEME_MODE },
  };
}

/** 会话 → 列表摘要 */
function toSummary(conversation: Conversation): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    providerId: conversation.providerId,
    model: conversation.model,
    messageCount: conversation.messages.length,
  };
}

/** 由首条用户消息推导会话标题（截断 20 字，失败回退「新会话」） */
function deriveTitle(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) {
    return DEFAULT_CONVERSATION_TITLE;
  }
  return normalized.length > TITLE_MAX_LENGTH
    ? `${normalized.slice(0, TITLE_MAX_LENGTH)}…`
    : normalized;
}

/** 只有当标题仍是默认值时才更新，避免覆盖用户后续可能的手动命名 */
function ensureConversationTitle(conversation: Conversation): void {
  if (conversation.title && conversation.title !== DEFAULT_CONVERSATION_TITLE) {
    return;
  }
  const firstUserMessage = conversation.messages.find(
    (message) => message.role === 'user' && message.content.trim().length > 0,
  );
  conversation.title = firstUserMessage ? deriveTitle(firstUserMessage.content) : DEFAULT_CONVERSATION_TITLE;
}

/**
 * 构造发送给模型的上下文：取最近 N 条。
 * 过滤掉空内容的 assistant 消息（例如本轮占位消息），并保证切片首条不是 assistant。
 */
function buildContextMessages(messages: Message[], limit = CONTEXT_MESSAGE_LIMIT): LlmMessage[] {
  const meaningful = messages.filter(
    (message) => !(message.role === 'assistant' && message.content.length === 0),
  );
  const slice = meaningful.slice(-limit);
  const startIndex = slice.length > 0 && slice[0].role === 'assistant' ? 1 : 0;
  return slice.slice(startIndex).map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

/**
 * 创建 IPC 路由。
 * @param deps 依赖（主窗口访问器）
 */
export function createIpcRouter(deps: IpcRouterDeps) {
  /** 向渲染层推送事件；窗口不存在或已销毁时静默丢弃 */
  function emit<T>(channel: ChannelName, payload: T): void {
    const window = deps.getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }

  async function handleConversationList(_event: IpcMainInvokeEvent): Promise<ConversationSummary[]> {
    const list = await readConversations();
    return list.map(toSummary).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function handleConversationCreate(_event: IpcMainInvokeEvent): Promise<Conversation> {
    const config = await readConfig();
    const providerId = config.activeProviderId;
    const now = Date.now();
    const conversation: Conversation = {
      id: randomUUID(),
      title: DEFAULT_CONVERSATION_TITLE,
      createdAt: now,
      updatedAt: now,
      providerId,
      model: getProviderSettings(config, providerId).model,
      messages: [],
    };
    await mutateConversations((list) => {
      list.push(conversation);
    });
    await mutateConfig((current) => {
      current.ui.lastConversationId = conversation.id;
    });
    return conversation;
  }

  async function handleConversationGet(
    _event: IpcMainInvokeEvent,
    request: GetConversationRequest,
  ): Promise<Conversation | null> {
    const id = typeof request?.id === 'string' ? request.id : '';
    const list = await readConversations();
    const conversation = list.find((item) => item.id === id) ?? null;
    // 「查看即记忆」：每次读取会话都顺手把 lastConversationId 落盘。
    // 取舍（已知且接受）：渲染层只读、不写配置，省掉每次切会话一次 IPC 写往返；
    // 代价是「看过=记过」——用户只是扫一眼也会改变下次启动的恢复目标。
    if (conversation) {
      await mutateConfig((config) => {
        config.ui.lastConversationId = conversation.id;
      });
    }
    return conversation;
  }

  async function handleConversationDelete(
    _event: IpcMainInvokeEvent,
    request: DeleteConversationRequest,
  ): Promise<OkResult> {
    const id = typeof request?.id === 'string' ? request.id : '';
    await mutateConversations((list) => {
      const index = list.findIndex((conversation) => conversation.id === id);
      if (index >= 0) {
        list.splice(index, 1);
      }
    });
    // 该会话上可能还有正在生成的任务：一并中止，避免继续烧 token 并往已删会话里落盘
    for (const session of running.values()) {
      if (session.conversationId === id) {
        session.controller.abort();
      }
    }
    await mutateConfig((config) => {
      if (config.ui.lastConversationId === id) {
        config.ui.lastConversationId = undefined;
      }
    });
    return { ok: true };
  }

  /** 把 user 消息与 assistant 占位消息写入会话（未配置态会把错误标记一并写入） */
  async function persistMessagePair(
    conversationId: string,
    userMessage: Message,
    assistantMessage: Message,
  ): Promise<Conversation | null> {
    return mutateConversations<Conversation | null>((list) => {
      const conversation = list.find((item) => item.id === conversationId);
      if (!conversation) {
        return null;
      }
      conversation.messages.push(userMessage, assistantMessage);
      conversation.updatedAt = Date.now();
      ensureConversationTitle(conversation);
      return conversation;
    });
  }

  /** 收尾落盘：把最终全文与结束状态写进 assistant 消息 */
  async function finalizeAssistantMessage(
    session: ChatSession,
    content: string,
    meta: {
      finishReason: FinishReason;
      errorCode?: ErrorCode;
      errorText?: string;
      steps?: ToolStep[];
      turns?: number;
    },
  ): Promise<void> {
    const exportedConversation = await mutateConversations<Conversation | null>((list) => {
      const conversation = list.find((item) => item.id === session.conversationId);
      if (!conversation) {
        return null;
      }
      const message = conversation.messages.find((item) => item.id === session.assistantMessageId);
      if (!message) {
        return null;
      }
      message.content = content;
      message.meta = {
        ...(message.meta ?? {}),
        finishReason: meta.finishReason,
        errorCode: meta.errorCode,
        errorText: meta.errorText,
        // 工具步骤与轮数仅在确实拿到时才写入，避免把 undefined 盖掉已有值
        ...(meta.steps !== undefined ? { steps: meta.steps } : {}),
        ...(meta.turns !== undefined ? { turns: meta.turns } : {}),
      };
      conversation.updatedAt = Date.now();
      ensureConversationTitle(conversation);
      return conversation;
    });
    // 每轮收尾刷新外部 Markdown 镜像（成功 / 中止 / 异常三条路径都走这里）
    if (exportedConversation) {
      await exportConversationMarkdown(exportedConversation);
      // 记忆提炼：额外一次模型调用，fire-and-forget，绝不拖住 chat:end。
      // 失败轮次（finishReason 为 error）跳过：它的正文是错误文案，提炼只会污染记忆，
      // 且真实原因（网络不通、Key 失效）会让这次提炼多半也失败，纯属白花钱。
      // 注意 'length'（达到工具轮数上限而收尾）不算失败 —— 正文仍是有效产出，照常提炼。
      if (meta.finishReason !== 'error') {
        void refreshWorkspaceMemory(exportedConversation);
      }
    }
  }

  /** 流式生成主流程（不阻塞 IPC 返回） */
  async function runChatStream(
    session: ChatSession,
    messages: LlmMessage[],
    providerId: ProviderId,
    toolContext: ToolContext,
  ): Promise<void> {
    // 取 Provider 与读配置必须留在 try 内：一旦抛错而 finally 不执行，
    // running 里就会永久残留一条 requestId，渲染层的 loading 再也退不出去
    let provider: LLMProvider | null = null;
    // 工具步骤按 id 去重收集，供所有收尾分支（成功 / 中止 / 异常）统一落盘
    const stepMap = new Map<string, ToolStep>();
    try {
      provider = getProvider(providerId);
      const config = await readConfig();
      const providerConfig = buildProviderConfig(config, providerId);
      // 换成手写 agent loop：带 tools 反复调模型，直到不再请求工具或轮数耗尽
      const result = await runAgentLoop({
        provider,
        providerConfig,
        messages,
        signal: session.controller.signal,
        toolContext,
        callbacks: {
          onDelta: (delta) => {
            if (!delta) {
              return;
            }
            session.text += delta;
            emit(CHANNELS.CHAT_CHUNK, {
              requestId: session.requestId,
              messageId: session.assistantMessageId,
              delta,
            });
          },
          onStep: (step) => {
            // 按 id 覆盖式写入：running → done/error 同一 id 会刷新为最终态
            stepMap.set(step.id, step);
            emit(CHANNELS.CHAT_STEP, {
              requestId: session.requestId,
              messageId: session.assistantMessageId,
              step,
            } satisfies ChatStepEvent);
          },
        },
      });
      await finalizeAssistantMessage(session, result.text, {
        finishReason: result.finishReason,
        steps: Array.from(stepMap.values()),
        turns: result.turns,
      });
      emit(CHANNELS.CHAT_END, {
        requestId: session.requestId,
        messageId: session.assistantMessageId,
        content: result.text,
        finishReason: result.finishReason,
      });
    } catch (error) {
      const providerError = toProviderError(error, {
        unreachableMessage: provider ? provider.unreachableHint : ERROR_TEXT.UNREACHABLE,
      });
      if (providerError.code === 'ABORTED') {
        // 用户主动停止：已生成内容照常落盘，不算错误（工具步骤也一并保留）
        await finalizeAssistantMessage(session, session.text, {
          finishReason: 'aborted',
          steps: Array.from(stepMap.values()),
        });
        emit(CHANNELS.CHAT_END, {
          requestId: session.requestId,
          messageId: session.assistantMessageId,
          content: session.text,
          finishReason: 'aborted',
        });
        return;
      }
      await finalizeAssistantMessage(session, session.text, {
        finishReason: 'error',
        errorCode: providerError.code,
        errorText: providerError.userMessage,
        steps: Array.from(stepMap.values()),
      });
      emit(CHANNELS.CHAT_ERROR, {
        requestId: session.requestId,
        messageId: session.assistantMessageId,
        code: providerError.code,
        message: providerError.userMessage,
      });
    } finally {
      running.delete(session.requestId);
    }
  }

  async function handleChatSend(
    _event: IpcMainInvokeEvent,
    request: ChatSendRequest,
  ): Promise<ChatSendResponse> {
    const requestId = typeof request?.requestId === 'string' && request.requestId ? request.requestId : randomUUID();
    const conversationId = typeof request?.conversationId === 'string' ? request.conversationId : '';
    const content = typeof request?.content === 'string' ? request.content.trim() : '';
    const replaceMessageId = typeof request?.replaceMessageId === 'string' ? request.replaceMessageId : '';

    const config = await readConfig();
    const providerId = config.activeProviderId;
    const provider = getProvider(providerId);
    const providerConfig = buildProviderConfig(config, providerId);

    const now = Date.now();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const userMessage: Message = {
      id: userMessageId,
      conversationId,
      role: 'user',
      content,
      createdAt: now,
    };
    const assistantMessage: Message = {
      id: assistantMessageId,
      conversationId,
      role: 'assistant',
      content: '',
      createdAt: now + 1,
      meta: { providerId, model: providerConfig.model },
    };

    // 1) 校验配置：未配置时短路，仅落盘一条带 NOT_CONFIGURED 标记的消息
    if (!provider.isConfigured(providerConfig)) {
      const message = errorMessage('NOT_CONFIGURED');
      assistantMessage.meta = {
        ...assistantMessage.meta,
        finishReason: 'error',
        errorCode: 'NOT_CONFIGURED',
        errorText: message,
      };
      const persistedConversation = await persistMessagePair(conversationId, userMessage, assistantMessage);
      if (!persistedConversation) {
        emit(CHANNELS.CHAT_ERROR, {
          requestId,
          messageId: assistantMessageId,
          code: 'UNKNOWN',
          message: '会话不存在，请新建会话',
        });
        return { requestId, userMessageId, assistantMessageId };
      }
      // 未配置这一路也算一轮：落盘后刷新外部 Markdown 镜像
      await exportConversationMarkdown(persistedConversation);
      emit(CHANNELS.CHAT_ERROR, {
        requestId,
        messageId: assistantMessageId,
        code: 'NOT_CONFIGURED',
        message,
      });
      // 顺带把设置弹层推给渲染层，省掉用户自己找入口的一次点击
      emit<void>(CHANNELS.APP_OPEN_SETTINGS, undefined);
      return { requestId, userMessageId, assistantMessageId };
    }

    // 2) 追加 user 消息与 assistant 占位消息并落盘，同时取出上下文与工具执行上下文
    const prepared = await mutateConversations<{
      messages: LlmMessage[];
      toolContext: ToolContext;
    } | null>((list) => {
      const conversation = list.find((item) => item.id === conversationId);
      if (!conversation) {
        return null;
      }
      // 编辑重发：截断被编辑的这条及其之后的全部消息 —— 它们都是基于旧提问生成的，
      // 留在上下文里会自相矛盾。会话内找不到该消息时（数据不一致）退化为普通追加，
      // 不报错，避免用户在界面上点了「保存」却什么都发生不了。
      if (replaceMessageId) {
        const index = conversation.messages.findIndex((item) => item.id === replaceMessageId);
        if (index >= 0) {
          conversation.messages.splice(index);
          // 首条用户消息可能被一起丢弃，标题需要重新派生：
          // ensureConversationTitle 只在标题仍是 DEFAULT_CONVERSATION_TITLE 时才动作，
          // 故必须先重置，否则编辑第一条消息后标题会停留在旧内容上。
          conversation.title = DEFAULT_CONVERSATION_TITLE;
        }
      }
      conversation.messages.push(userMessage, assistantMessage);
      conversation.providerId = providerId;
      conversation.model = providerConfig.model;
      conversation.updatedAt = Date.now();
      ensureConversationTitle(conversation);
      return {
        // 3) 上下文：最近 20 条（含本次提问）
        messages: buildContextMessages(conversation.messages),
        // 工具执行上下文：会话可以指定自己的工作区，未指定时回退到默认工作区。
        // 逐层显式传参而不是用模块级全局变量 —— 两个会话并发生成时全局变量会互相覆盖。
        toolContext: {
          workspaceRoot: resolveWorkspaceRoot(conversation),
          backupRoot: getBackupRoot(),
          conversationId,
          // 本轮是否启用记忆功能，取自本次请求开头读到的配置快照：
          // 生成过程中改开关不影响本轮，下一轮生效（保证同一轮内工具集合与注入一致）
          memoryEnabled: config.memoryEnabled,
        },
      };
    });

    if (!prepared) {
      emit(CHANNELS.CHAT_ERROR, {
        requestId,
        messageId: assistantMessageId,
        code: 'UNKNOWN',
        message: '会话不存在，请新建会话',
      });
      return { requestId, userMessageId, assistantMessageId };
    }

    // 4) 登记中止控制器
    const session: ChatSession = {
      requestId,
      conversationId,
      assistantMessageId,
      controller: new AbortController(),
      text: '',
    };
    running.set(requestId, session);

    // 5) 立即返回，不等待模型响应
    // 注入两类 system 消息：① 常驻的工作区约定（含每日笔记要求，每轮都要在）；
    // ② 工作区长期记忆（有内容才注入）。prepared 的 mutator 是同步的、读不了盘，故在此处读盘。
    // 记忆功能关闭时两者都不注入，也不会去读盘。
    const workspaceRoot = prepared.toolContext.workspaceRoot;
    const systemMessages: LlmMessage[] = [
      buildWorkspaceRulesMessage(workspaceRoot, config.memoryEnabled),
    ];
    if (config.memoryEnabled) {
      const memory = await readWorkspaceMemory(workspaceRoot);
      if (memory.length > 0) {
        systemMessages.push(buildMemorySystemMessage(memory));
      }
    }
    const contextMessages = [...systemMessages, ...prepared.messages];
    void runChatStream(session, contextMessages, providerId, prepared.toolContext).catch(() => {
      // 兜底：编排逻辑自身异常时也要保证渲染层能退出 loading 态
      emit(CHANNELS.CHAT_ERROR, {
        requestId,
        messageId: assistantMessageId,
        code: 'UNKNOWN',
        message: errorMessage('UNKNOWN'),
      });
    });
    return { requestId, userMessageId, assistantMessageId };
  }

  async function handleChatAbort(
    _event: IpcMainInvokeEvent,
    request: AbortChatRequest,
  ): Promise<OkResult> {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    const session = running.get(requestId);
    if (session) {
      // 实际的落盘与 chat:end 推送由 runChatStream 的 ABORTED 分支统一负责
      session.controller.abort();
    }
    return { ok: true };
  }

  async function handleConfigGet(_event: IpcMainInvokeEvent): Promise<PublicConfig> {
    return toPublicConfig(await readConfig());
  }

  async function handleConfigSave(
    _event: IpcMainInvokeEvent,
    input: ConfigSaveInput,
  ): Promise<PublicConfig> {
    const patch: ConfigSaveInput = input ?? {};
    const providerPatches: Array<{
      id: ProviderId;
      settings?: { baseUrl?: string; model?: string; apiKey?: string };
    }> = [
      { id: 'deepseek', settings: patch.deepseek },
      { id: 'ollama', settings: patch.ollama },
    ];

    await mutateConfig((config) => {
      if (patch.activeProviderId && isProviderId(patch.activeProviderId)) {
        config.activeProviderId = patch.activeProviderId;
      }
      // 记忆功能开关：仅接受布尔值（缺省 / 非法值一律忽略，不改动现值）
      if (typeof patch.memoryEnabled === 'boolean') {
        config.memoryEnabled = patch.memoryEnabled;
      }
      // 主题偏好：非法值直接忽略（不覆写），避免把 data-theme 写成两套变量都不命中的值
      if (patch.ui && isThemeMode(patch.ui.theme)) {
        config.ui.theme = patch.ui.theme;
      }
      for (const entry of providerPatches) {
        if (!entry.settings) {
          continue;
        }
        const settings = getProviderSettings(config, entry.id);
        if (typeof entry.settings.baseUrl === 'string' && entry.settings.baseUrl.trim()) {
          settings.baseUrl = entry.settings.baseUrl.trim();
        }
        if (typeof entry.settings.model === 'string') {
          settings.model = entry.settings.model.trim();
        }
        if (typeof entry.settings.apiKey === 'string') {
          // 只进不出：返回密文交给配置落盘；不可用时返回 undefined，仅内存持有
          settings.apiKeyEnc = saveSecret(entry.id, entry.settings.apiKey.trim());
        }
      }
    });

    return toPublicConfig(await readConfig());
  }

  async function handleModelsList(
    _event: IpcMainInvokeEvent,
    request: ListModelsRequest,
  ): Promise<ModelInfo[]> {
    const providerId = request?.providerId;
    if (!isProviderId(providerId)) {
      return [];
    }
    const config = await readConfig();
    const provider = getProvider(providerId);
    const combined = combineSignals([], MODELS_TIMEOUT_MS);
    try {
      return await provider.listModels(buildProviderConfig(config, providerId), combined.signal);
    } catch {
      // 模型列表是辅助能力：失败时返回空数组，UI 允许用户手填模型名
      return [];
    } finally {
      combined.dispose();
    }
  }

  /**
   * 用系统默认浏览器打开外链（供 Markdown 里的链接使用）。
   * 安全底线：只放行 http / https，其余协议一律拒绝；不做任何 URL 拼接或任意跳转。
   */
  async function handleOpenExternal(
    _event: IpcMainInvokeEvent,
    request: OpenExternalRequest,
  ): Promise<OpenExternalResult> {
    const raw = typeof request?.url === 'string' ? request.url.trim() : '';
    if (raw.length === 0) {
      return { ok: false, reason: '链接为空' };
    }
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return { ok: false, reason: '不是合法的链接' };
    }
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(target.protocol)) {
      return { ok: false, reason: `仅允许打开 http/https 链接（收到 ${target.protocol}）` };
    }
    // shell.openExternal 在无默认浏览器 / 系统调用失败时会 reject：
    // 必须兜住，否则异常会穿透到 invoke，渲染层拿不到结构化的 OpenExternalResult
    try {
      await shell.openExternal(target.toString());
    } catch {
      return { ok: false, reason: '系统浏览器打开失败' };
    }
    return { ok: true };
  }

  /**
   * 弹出系统目录选择对话框，把用户选中的目录交给渲染层。
   * 主进程只负责「选目录」这一件事，不落盘 —— 落盘由 conversation:setWorkspace 负责，
   * 这样「取消选择」天然不需要任何回滚。
   */
  async function handleWorkspacePick(_event: IpcMainInvokeEvent): Promise<PickWorkspaceResult> {
    const options: OpenDialogOptions = {
      title: '选择工作区目录',
      buttonLabel: '选择此目录',
      properties: ['openDirectory', 'createDirectory'],
    };
    const window = deps.getMainWindow();
    const result =
      window && !window.isDestroyed()
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return { canceled: false, path: result.filePaths[0] };
  }

  /**
   * 设置某个会话的工作区；root 为 null / 空串表示恢复默认工作区。
   * 刻意不更新 updatedAt：工作区是配置属性而非内容变更，
   * 更新它会让侧栏会话列表无谓地跳到最前。
   */
  async function handleConversationSetWorkspace(
    _event: IpcMainInvokeEvent,
    request: SetConversationWorkspaceRequest,
  ): Promise<OkResult> {
    const id = typeof request?.id === 'string' ? request.id : '';
    const raw = typeof request?.root === 'string' ? request.root.trim() : '';
    await mutateConversations((list) => {
      const conversation = list.find((item) => item.id === id);
      if (!conversation) {
        return;
      }
      if (raw.length > 0) {
        conversation.workspaceRoot = raw;
      } else {
        // 存 undefined 而不是空串：这样 resolveWorkspaceRoot 与界面都能正确回退到默认工作区
        delete conversation.workspaceRoot;
      }
    });
    return { ok: true };
  }

  /**
   * 注册单个 invoke 通道。
   * 开发期主进程可能重载，先移除旧处理器避免重复注册报错。
   */
  function registerHandler<TArgs extends unknown[], TResult>(
    channel: ChannelName,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult>,
  ): void {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
  }

  /** 注册全部 ipcMain 处理器 */
  function register(): void {
    registerHandler(CHANNELS.CONVERSATION_LIST, handleConversationList);
    registerHandler(CHANNELS.CONVERSATION_CREATE, handleConversationCreate);
    registerHandler(CHANNELS.CONVERSATION_GET, handleConversationGet);
    registerHandler(CHANNELS.CONVERSATION_DELETE, handleConversationDelete);
    registerHandler(CHANNELS.CHAT_SEND, handleChatSend);
    registerHandler(CHANNELS.CHAT_ABORT, handleChatAbort);
    registerHandler(CHANNELS.CONFIG_GET, handleConfigGet);
    registerHandler(CHANNELS.CONFIG_SAVE, handleConfigSave);
    registerHandler(CHANNELS.MODELS_LIST, handleModelsList);
    registerHandler(CHANNELS.WORKSPACE_PICK, handleWorkspacePick);
    registerHandler(CHANNELS.CONVERSATION_SET_WORKSPACE, handleConversationSetWorkspace);
    registerHandler(CHANNELS.APP_OPEN_EXTERNAL, handleOpenExternal);
  }

  return { register };
}
