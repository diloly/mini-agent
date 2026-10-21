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
import { copyFile, mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import { dialog, ipcMain, shell } from 'electron';
import {
  CHANNELS,
  type AbortChatRequest,
  type AttachFilesRequest,
  type AttachFilesResult,
  type AttachedFile,
  type ChannelName,
  type ChatResumeRequest,
  type ChatResumeResponse,
  type ChatSendRequest,
  type ChatSendResponse,
  type ChatStepEvent,
  type ChatPlanEvent,
  type ConfigSaveInput,
  type ContextStatsRequest,
  type ContextStatsResponse,
  type ConversationSummary,
  type DeleteConversationRequest,
  type GetConversationRequest,
  type ListModelsRequest,
  type OkResult,
  type OpenExternalRequest,
  type OpenExternalResult,
  type PickWorkspaceResult,
  type RenameConversationRequest,
  type SetConversationPinnedRequest,
  type SetConversationWorkspaceRequest,
} from '../shared/ipc-channels';
import {
  CONTEXT_MESSAGE_LIMIT,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_CONVERSATION_TITLE,
  DEFAULT_NUM_CTX,
  DEFAULT_THEME_MODE,
  ERROR_TEXT,
  isThemeMode,
  isValidContextWindow,
  isValidNumCtx,
  sortConversationsByPinned,
  TITLE_MAX_LENGTH,
  type AppConfig,
  type Conversation,
  type ErrorCode,
  type FinishReason,
  type Message,
  type MessageAttachment,
  type ModelInfo,
  type PlanStep,
  type ProviderId,
  type PublicConfig,
  type ToolStep,
} from '../shared/types';
import { estimateTokens } from '../shared/tokens';
import { getProvider, isProviderId } from './providers';
import { combineSignals } from './providers/sse';
import { errorMessage, toProviderError, type LlmMessage, type LLMProvider } from './providers/types';
import { runAgentLoop, type HarnessEvent, type ToolContext } from './harness';
import { getBackupRoot, getDefaultWorkspaceRoot, resolveWorkspaceRoot } from './workspace';
import { exportConversationMarkdown } from './conversation-export';
import { buildMemorySystemMessage, buildWorkspaceRulesMessage, extractWorkspaceMemory, readWorkspaceMemory } from './workspace-memory';
import { hasSecret, isEncryptionAvailable, loadSecret, saveSecret } from './secret';
import {
  getActiveAccountId,
  mutateAccountMeta,
  mutateConfig,
  mutateConversations,
  readAccountMeta,
  readConfig,
  readConversations,
} from './storage';
import * as checkpoint from './checkpoint';
import { registerAuthHandlers } from './auth/handlers';
import { skillsRoot } from './skills/paths';
import { listSkills } from './skills/registry';
import { buildSkillsCatalogMessage } from './skills/catalog';
import { registerSkillHandlers } from './skills/handlers';

/** 拉取模型列表的统一超时（毫秒） */
const MODELS_TIMEOUT_MS = 8_000;

/** 允许交给系统浏览器打开的协议白名单（其余一律拒绝，防止 file:// / 自定义协议提权） */
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

/** 附件上传目录名（相对工作区） */
const UPLOADS_DIR = 'uploads';

/** 单附件大小上限（50 MB）：超出拒收，避免把巨型文件复制进工作区拖垮 IO 与后续检索 */
const ATTACH_MAX_BYTES = 50 * 1024 * 1024;

/** 安全文件名的最大长度（不含时间戳前缀） */
const ATTACH_NAME_MAX_CHARS = 80;

/** Windows 文件名非法字符（含控制字符）；统一替换为下划线 */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * 续跑说明：注入 convo 末尾的 system 消息，告诉模型「这是接着中断前的上下文继续」。
 * 重点是已经做完的步骤不要重复执行——否则模型会把中断前已完成的工具调用再跑一遍。
 * 由 harness loop 在半截工具批次补全完成后追加（保证 assistant(tool_calls) 与
 * tool 消息的协议相邻性不被破坏）。
 */
const RESUME_NOTE =
  '系统提示：这是续跑。你上一轮的执行被中断（用户主动停止或进程意外退出），以上上下文是中断前的完整状态。上一批工具调用中未落盘的结果已补跑完成。请接着完成原任务：已经做完的步骤不要重复执行，直接从当前状态继续。';

/**
 * 把任意文件名收敛为安全的 basename：
 * 只取最后一段（防路径穿越）→ 替换 Windows 非法字符 → 去首尾点与空格 → 截断 → 空值兜底。
 * 用户上传的文件名完全不可信（可能含 `..`、绝对路径、控制字符），必须收敛后再落盘。
 */
function sanitizeAttachmentName(rawName: string): string {
  const base = path.basename(rawName.trim());
  const cleaned = base.replace(ILLEGAL_NAME_CHARS, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  const truncated =
    cleaned.length > ATTACH_NAME_MAX_CHARS ? cleaned.slice(0, ATTACH_NAME_MAX_CHARS) : cleaned;
  return truncated.length > 0 ? truncated : 'file';
}

/**
 * 清洗 IPC 传来的附件列表：三项（name / path / size）俱全才保留，
 * 路径统一成正斜杠相对形式，且不接受绝对路径与 `..` 段。
 * 渲染层数据同样不可信——脏 path 落盘后会永久污染消息数据。
 */
function normalizeAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const collected: MessageAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const { name, path: relPath, size } = item as Partial<MessageAttachment>;
    if (typeof name !== 'string' || typeof relPath !== 'string' || typeof size !== 'number') {
      continue;
    }
    const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalized.length === 0 || normalized.split('/').includes('..')) {
      continue;
    }
    collected.push({
      name: name.slice(0, 200),
      path: normalized,
      size: Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0,
    });
  }
  return collected;
}

/**
 * 用户消息的附件注记：把「工作区内文件清单」注入发给模型的 content。
 *
 * 模型对上传文件的**全部认知**来自这里——不注入，它就完全不知道用户发了文件。
 * 三个必须说清的事实：
 * ① 文件已存进工作区及相对路径（工具只认工作区内相对路径，绝对路径会被守卫拒绝）；
 * ② 文本文件可用 read_text_file 按上述路径直读；
 * ③ PDF 等二进制不要用 read_text_file 硬读（它按 utf8 读取只会得到乱码），
 *    应使用技能清单里对应的技能脚本处理（如 pdf 技能）。
 */
function withAttachmentNote(message: Message): string {
  const attachments =
    message.role === 'user' && Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length === 0) {
    return message.content;
  }
  const lines = attachments.map((item) => `- ${item.path}（${item.name}）`);
  const note =
    `（用户上传了 ${attachments.length} 个文件，已保存到当前工作区，相对路径如下：\n` +
    `${lines.join('\n')}\n` +
    `文本文件可用 read_text_file 按上述路径读取；` +
    `PDF 等二进制文件不要用 read_text_file 读取（按 utf8 读会得到乱码），` +
    `应使用技能清单中对应的技能脚本处理，例如 pdf 技能。）`;
  return message.content.length > 0 ? `${message.content}\n\n${note}` : note;
}

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
  /** 本轮计划清单（整份快照）；模型没调 update_plan 时为 undefined */
  plan?: PlanStep[];
}

/** requestId → 进行中的生成任务 */
const running = new Map<string, ChatSession>();

/** 各 Provider 的通用配置片段（DeepSeek / Custom 额外带 apiKeyEnc，Ollama 额外带 numCtx） */
interface ProviderSettingsLike {
  baseUrl: string;
  model: string;
  apiKeyEnc?: string;
  numCtx?: number;
  /** deepseek / custom 的上下文窗口（仅用量统计用；ollama 走 numCtx） */
  contextWindow?: number;
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
    numCtx: settings.numCtx,
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

/**
 * 把配置投影为渲染层可见的脱敏形态。
 * `lastConversationId` 现由**当前账号的 meta** 提供（不再是 config 的字段，见 §7.2）；
 * 保持同步实现，避免在 mutateConfig 之后引入额外的 async 时序。
 */
function toPublicConfig(config: AppConfig, lastConversationId: string | undefined): PublicConfig {
  const deepseek = getProviderSettings(config, 'deepseek');
  const ollama = getProviderSettings(config, 'ollama');
  const custom = getProviderSettings(config, 'custom');
  return {
    activeProviderId: config.activeProviderId,
    providers: {
      deepseek: {
        baseUrl: deepseek.baseUrl,
        model: deepseek.model,
        hasApiKey: hasSecret('deepseek', deepseek.apiKeyEnc),
        contextWindow: deepseek.contextWindow,
      },
      ollama: {
        baseUrl: ollama.baseUrl,
        model: ollama.model,
        numCtx: ollama.numCtx,
      },
      custom: {
        baseUrl: custom.baseUrl,
        model: custom.model,
        hasApiKey: hasSecret('custom', custom.apiKeyEnc),
        contextWindow: custom.contextWindow,
      },
    },
    models: { deepseek: [], ollama: [], custom: [] },
    safeStorageAvailable: isEncryptionAvailable(),
    defaultWorkspaceRoot: getDefaultWorkspaceRoot(),
    memoryEnabled: config.memoryEnabled,
    ui: { lastConversationId, theme: config.ui.theme ?? DEFAULT_THEME_MODE },
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
    pinned: conversation.pinned === true,
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
  // 「只有附件、没打字」的消息也算有效首条：正文为空时用第一个附件名派生标题，
  // 否则这类会话在侧栏会永远显示默认标题，用户分不出哪个会话传了什么文件。
  const firstUserMessage = conversation.messages.find(
    (message) =>
      message.role === 'user' &&
      (message.content.trim().length > 0 || (message.attachments?.length ?? 0) > 0),
  );
  conversation.title = firstUserMessage
    ? deriveTitle(firstUserMessage.content || firstUserMessage.attachments?.[0]?.name || '')
    : DEFAULT_CONVERSATION_TITLE;
}

/**
 * 构造发送给模型的上下文：取最近 N 条。
 * 过滤掉空内容的 assistant 消息（例如本轮占位消息），并保证切片首条不是 assistant。
 * 用户消息带附件时，由 withAttachmentNote 把工作区内文件清单注入 content。
 */
function buildContextMessages(messages: Message[], limit = CONTEXT_MESSAGE_LIMIT): LlmMessage[] {
  const meaningful = messages.filter(
    (message) => !(message.role === 'assistant' && message.content.length === 0),
  );
  const slice = meaningful.slice(-limit);
  const startIndex = slice.length > 0 && slice[0].role === 'assistant' ? 1 : 0;
  return slice.slice(startIndex).map((message) => ({
    role: message.role,
    content: withAttachmentNote(message),
  }));
}

/**
 * 解析某 Provider 的上下文窗口（token），作为「上下文用量」百分比的分母。
 * - ollama：用 numCtx —— 它就是请求体里真实生效的窗口
 * - deepseek / custom：用配置的 contextWindow，缺省回退 DEFAULT_CONTEXT_WINDOW
 *
 * 非法值一律回退默认：分母算错只会让百分比失真，绝不能让它把统计搞成 NaN 或 0 除。
 */
function resolveContextWindow(config: AppConfig, providerId: ProviderId): number {
  if (providerId === 'ollama') {
    return isValidNumCtx(config.providers.ollama.numCtx)
      ? config.providers.ollama.numCtx
      : DEFAULT_NUM_CTX;
  }
  const configured = getProviderSettings(config, providerId).contextWindow;
  return isValidContextWindow(configured) ? configured : DEFAULT_CONTEXT_WINDOW;
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
    return sortConversationsByPinned(list.map(toSummary));
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
    // lastConversationId 按账号存放（accounts/<id>/meta.json），不再写 config
    await mutateAccountMeta((meta) => {
      meta.lastConversationId = conversation.id;
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
    // 「查看即记忆」：每次读取会话都顺手把 lastConversationId 写进当前账号 meta。
    // 取舍（已知且接受）：渲染层只读、不写配置，省掉每次切会话一次 IPC 写往返；
    // 代价是「看过=记过」——用户只是扫一眼也会改变下次启动的恢复目标。
    if (conversation) {
      await mutateAccountMeta((meta) => {
        meta.lastConversationId = conversation.id;
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
    // 该会话上可能还有正在生成的任务：先中止（信号设置即生效，loop 在下一个检查点
    // 退出，runChatStream 的 finally 会清掉 running 里的 session）。
    for (const session of running.values()) {
      if (session.conversationId === id) {
        session.controller.abort();
      }
    }
    // 等待在飞任务真正退出后再删 checkpoint：否则 loop 的下一版快照可能在删除完成
    // 之后才写盘，留下「会话已删、文件还在」的孤儿 checkpoint（无法再定位删除，
    // 纯磁盘泄漏）。等待有 10s 上限——删会话本身绝不能被在飞的续跑任务挂住。
    const deadline = Date.now() + 10_000;
    while (
      [...running.values()].some((session) => session.conversationId === id) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 删会话连带清它的 checkpoint：续跑数据是会话级附属态，不应比会话活得更久。
    // best-effort：删除失败不影响删会话本身，残留文件的后果仅是「继续」找不到状态。
    const accountId = getActiveAccountId();
    if (accountId) {
      await checkpoint.deleteCheckpointsForConversation(accountId, id).catch(() => undefined);
    }
    await mutateAccountMeta((meta) => {
      if (meta.lastConversationId === id) {
        meta.lastConversationId = undefined;
      }
    });
    return { ok: true };
  }

  /**
   * 重命名会话。标题去首尾空白并把连续空白压成单空格；空标题视为非法，直接不改动
   * （渲染层已禁用空标题的确认按钮，这里只做兜底，避免脏数据落盘）。
   * 刻意**不更新 updatedAt**：改名不该把会话在时间序里顶到最前。
   */
  async function handleConversationRename(
    _event: IpcMainInvokeEvent,
    request: RenameConversationRequest,
  ): Promise<OkResult> {
    const id = typeof request?.id === 'string' ? request.id : '';
    const title = typeof request?.title === 'string' ? request.title.trim().replace(/\s+/g, ' ') : '';
    if (title.length === 0) {
      return { ok: true };
    }
    const nextTitle = title.length > TITLE_MAX_LENGTH ? title.slice(0, TITLE_MAX_LENGTH) : title;
    await mutateConversations((list) => {
      const conversation = list.find((item) => item.id === id);
      if (conversation) {
        conversation.title = nextTitle;
      }
    });
    return { ok: true };
  }

  /**
   * 置顶 / 取消置顶。同样**不动 updatedAt**：置顶只改分组，不改时间序。
   */
  async function handleConversationSetPinned(
    _event: IpcMainInvokeEvent,
    request: SetConversationPinnedRequest,
  ): Promise<OkResult> {
    const id = typeof request?.id === 'string' ? request.id : '';
    const pinned = request?.pinned === true;
    await mutateConversations((list) => {
      const conversation = list.find((item) => item.id === id);
      if (!conversation) {
        return;
      }
      // 置顶写 true，取消置顶删字段（而非写 false）：与 Conversation.pinned 的约定一致，
      // 「从未置顶」与「取消置顶」在盘上是同一形态，避免两种写法并存。
      if (pinned) {
        conversation.pinned = true;
      } else {
        delete conversation.pinned;
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
      plan?: PlanStep[];
      turns?: number;
      resumable?: boolean;
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
        // 无条件写（false 也写）：续跑成功完成时要清掉中止时写下的 true；
        // 老消息不受影响，只有被 finalize 的本轮消息会带上这个字段
        resumable: Boolean(meta.resumable),
        errorCode: meta.errorCode,
        errorText: meta.errorText,
        // 工具步骤与轮数仅在确实拿到时才写入，避免把 undefined 盖掉已有值
        ...(meta.steps !== undefined ? { steps: meta.steps } : {}),
        // 计划清单同样仅在确实拿到时写入，避免用 undefined 盖掉已有值
        ...(meta.plan !== undefined ? { plan: meta.plan } : {}),
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
    options?: {
      /** 续跑时中断前已生成的正文（首跑不传） */
      initialText?: string;
      /** 续跑起始轮号 = 中断时已消耗轮数 +1（首跑不传） */
      startTurn?: number;
      /** 续跑时预置的历史工具步骤（收尾落盘与 abort 时一并写回，界面不丢中断前的记录） */
      seedSteps?: ToolStep[];
      /** 续跑说明；loop 在半截工具批次补全完成后追加到 convo 末尾 */
      resumeNote?: string;
    },
  ): Promise<void> {
    // 取 Provider 与读配置必须留在 try 内：一旦抛错而 finally 不执行，
    // running 里就会永久残留一条 requestId，渲染层的 loading 再也退不出去
    let provider: LLMProvider | null = null;
    // 工具步骤按 id 去重收集，供所有收尾分支（成功 / 中止 / 异常）统一落盘
    const stepMap = new Map<string, ToolStep>();
    // 续跑 seed：把被中止消息 meta.steps 里的历史步骤预先灌进 stepMap，
    // 收尾时与续跑新产生的步骤合并写回——中断前的执行记录不会从界面上消失
    for (const seedStep of options?.seedSteps ?? []) {
      stepMap.set(seedStep.id, seedStep);
    }
    /**
     * harness 事件 → UI 信封 + 主进程持久化。
     *
     * 这是 harness 与渲染层之间**唯一**的适配层：loop 只发领域事实（events.ts），
     * 这里负责它不关心的三件事——
     * ① UI 信封：补 requestId / messageId，转成 CHAT_CHUNK / CHAT_STEP / CHAT_PLAN；
     * ② 展示字段：contentOffset（正文分界点）由本层按「事件到达时已看到多少正文」
     *    折算，running 与最终态共用一个值，渲染层据此把工具插到正文的正确位置；
     * ③ 落盘时机：conversation-snapshot 到达时写 checkpoint（可续跑态）。
     * 将来要给 UI 加新展示、或改持久化策略，只改本函数，loop 与工具一行不动。
     */
    const contentOffsets = new Map<string, number>();
    const emitHarness = (event: HarnessEvent): void => {
      switch (event.type) {
        case 'text': {
          if (!event.delta) {
            return;
          }
          session.text += event.delta;
          emit(CHANNELS.CHAT_CHUNK, {
            requestId: session.requestId,
            messageId: session.assistantMessageId,
            delta: event.delta,
          });
          return;
        }
        case 'tool-call-start': {
          // 模型刚宣布要调工具（流式期间）：建 running 占位，参数此刻不完整故留空；
          // 记住此刻的正文长度——最终态步骤会取回同一个分界点。
          const contentOffset = session.text.length;
          contentOffsets.set(event.id, contentOffset);
          const step: ToolStep = {
            id: event.id,
            name: event.name,
            args: event.arguments ?? '',
            status: 'running',
            contentOffset,
          };
          stepMap.set(step.id, step);
          emit(CHANNELS.CHAT_STEP, {
            requestId: session.requestId,
            messageId: session.assistantMessageId,
            step,
          } satisfies ChatStepEvent);
          return;
        }
        case 'tool-call-end': {
          // 按 id 覆盖 running 占位（渲染层同 id 覆盖为最终态）；分界点取 start 时记下的值
          const step: ToolStep = {
            id: event.id,
            name: event.name,
            args: event.arguments,
            status: event.ok ? 'done' : 'error',
            result: event.preview,
            elapsedMs: event.elapsedMs,
            contentOffset: contentOffsets.get(event.id),
          };
          contentOffsets.delete(event.id);
          stepMap.set(step.id, step);
          emit(CHANNELS.CHAT_STEP, {
            requestId: session.requestId,
            messageId: session.assistantMessageId,
            step,
          } satisfies ChatStepEvent);
          return;
        }
        case 'plan-updated': {
          // 计划清单整份覆盖：渲染层 CHAT_PLAN + 收尾落盘 meta.plan
          session.plan = event.steps;
          emit(CHANNELS.CHAT_PLAN, {
            requestId: session.requestId,
            messageId: session.assistantMessageId,
            plan: event.steps,
          } satisfies ChatPlanEvent);
          return;
        }
        case 'conversation-snapshot': {
          // 每个工具结果回填后落一版「可续跑态」：被动崩溃（进程被杀）时
          // 磁盘上仍有最近一次完整 convo，用户点「继续」才能接着中断前的上下文跑。
          // checkpoint 写失败绝不能打断生成，故只吞异常不重抛。
          void checkpoint
            .writeCheckpoint({
              version: 1,
              conversationId: session.conversationId,
              assistantMessageId: session.assistantMessageId,
              turn: event.turn,
              convo: event.convo,
              savedAt: Date.now(),
            })
            .catch(() => undefined);
          return;
        }
      }
    };
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
        initialText: options?.initialText,
        startTurn: options?.startTurn,
        resumeNote: options?.resumeNote,
        emit: emitHarness,
      });
      // 成功收尾：checkpoint 使命完成，先删再 finalize。
      // 无账号（未登录）时本就写不出 checkpoint 文件，直接跳过删除。
      const successAccountId = getActiveAccountId();
      if (successAccountId) {
        await checkpoint
          .deleteCheckpoint(successAccountId, session.conversationId, session.assistantMessageId)
          .catch(() => undefined);
      }
      await finalizeAssistantMessage(session, result.text, {
        finishReason: result.finishReason,
        steps: Array.from(stepMap.values()),
        plan: session.plan,
        turns: result.turns,
        resumable: false,
      });
      emit(CHANNELS.CHAT_END, {
        requestId: session.requestId,
        messageId: session.assistantMessageId,
        content: result.text,
        finishReason: result.finishReason,
        resumable: false,
      });
    } catch (error) {
      const providerError = toProviderError(error, {
        unreachableMessage: provider ? provider.unreachableHint : ERROR_TEXT.UNREACHABLE,
      });
      if (providerError.code === 'ABORTED') {
        // 用户主动停止：已生成内容照常落盘，不算错误（工具步骤也一并保留）。
        // resumable 按 checkpoint 是否存在判定：loop 的 conversation-snapshot 事件已在中止前
        // 被本层转成快照落盘（含半截批次补跑后的最新态），界面据此显示「继续」。
        const abortAccountId = getActiveAccountId();
        const resumable = abortAccountId
          ? (await checkpoint.readCheckpoint(
              abortAccountId,
              session.conversationId,
              session.assistantMessageId,
            )) !== null
          : false;
        await finalizeAssistantMessage(session, session.text, {
          finishReason: 'aborted',
          steps: Array.from(stepMap.values()),
          plan: session.plan,
          resumable,
        });
        emit(CHANNELS.CHAT_END, {
          requestId: session.requestId,
          messageId: session.assistantMessageId,
          content: session.text,
          finishReason: 'aborted',
          resumable,
        });
        return;
      }
      // 异常收尾：同样按 checkpoint 存在性判定 resumable——
      // 被动崩溃场景（如进程被杀前的最后一次 loop 回调已落盘）重启后也应能续跑
      const errorAccountId = getActiveAccountId();
      const errorResumable = errorAccountId
        ? (await checkpoint.readCheckpoint(
            errorAccountId,
            session.conversationId,
            session.assistantMessageId,
          )) !== null
        : false;
      await finalizeAssistantMessage(session, session.text, {
        finishReason: 'error',
        errorCode: providerError.code,
        errorText: providerError.userMessage,
        steps: Array.from(stepMap.values()),
        plan: session.plan,
        resumable: errorResumable,
      });
      emit(CHANNELS.CHAT_ERROR, {
        requestId: session.requestId,
        messageId: session.assistantMessageId,
        code: providerError.code,
        message: providerError.userMessage,
        resumable: errorResumable,
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
    // 附件清洗：只保留三项俱全、路径为工作区内相对形式的条目（脏数据直接丢弃，不报错）
    const attachments = normalizeAttachments(request.attachments);

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
      // 仅在真有附件时写：不给历史消息补空数组字段，落盘形态保持干净
      ...(attachments.length > 0 ? { attachments } : {}),
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
    // 编辑重发被丢弃消息中的 assistant id：mutator 是同步的、读不了盘，
    // 先在 mutator 内把 id 收集出来，checkpoint 的删除挪到 mutateConversations
    // 返回之后执行（见下方 removedAssistantIds 循环）
    const removedAssistantIds: string[] = [];
    const prepared = await mutateConversations<{
      messages: LlmMessage[];
      toolContext: ToolContext;
      removedAssistantIds: string[];
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
          // 被丢弃消息里的 assistant id：它们的 checkpoint 属于「基于旧提问的生成」，
          // 编辑重发后不能再可续跑，逐个记下待删
          for (const removed of conversation.messages.slice(index)) {
            if (removed.role === 'assistant') {
              removedAssistantIds.push(removed.id);
            }
          }
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
          // 技能根目录（<userData>/skills）：仅供后续 run_skill_script 的路径围栏使用。
          // 与本轮配置快照同层下发，保证同一轮内「工具集合」与「围栏根」取自同一时刻。
          skillsRoot: skillsRoot(),
        },
        removedAssistantIds,
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

    // 编辑重发丢掉的旧 assistant 消息：其 checkpoint 不能留。
    // 续跑入口按 assistantMessageId 定位检查点，残留文件会让「继续」复活一段
    // 已被用户主动抛弃的上下文。无账号时本就无 checkpoint，直接跳过。
    const discardAccountId = getActiveAccountId();
    if (discardAccountId) {
      for (const removedId of prepared.removedAssistantIds) {
        void checkpoint
          .deleteCheckpoint(discardAccountId, conversationId, removedId)
          .catch(() => undefined);
      }
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
    // 注入三类 system 消息：① 常驻的工作区约定（含每日笔记要求，每轮都要在）；
    // ② 技能清单（有技能才注入，见 skills/catalog.ts）；③ 工作区长期记忆（有内容才注入）。
    // prepared 的 mutator 是同步的、读不了盘，故在此处读盘。
    // 顺序刻意是「能力（技能）在前、历史（记忆）在后」——技能是「我能做什么」，记忆是「发生过什么」。
    // 记忆功能关闭时不含记忆相关消息，也不会去读记忆盘。
    const workspaceRoot = prepared.toolContext.workspaceRoot;
    const systemMessages: LlmMessage[] = [
      buildWorkspaceRulesMessage(workspaceRoot, config.memoryEnabled),
    ];
    // 技能清单：listSkills 内部有 mtime 缓存，常规路径很轻；无技能时 catalog 为 null，不注入。
    // 技能根取自本轮 ToolContext 快照（与围栏根同一时刻），不重新调用 skillsRoot()。
    const catalog = buildSkillsCatalogMessage(
      await listSkills(prepared.toolContext.skillsRoot),
    );
    if (catalog) {
      systemMessages.push(catalog);
    }
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

  /**
   * 续跑：接着一条被中止的 assistant 消息，用中断前落盘的 checkpoint 继续生成。
   * 与 chat:send 的关键差异：不追加任何消息、不新建占位——user 提问与被中止的
   * assistant 消息都已在会话里，本轮只是把那条 assistant 消息接着写完。
   *
   * 流程：校验入参 → 读 checkpoint → 校验 Provider 配置 → 只读取出会话与目标消息 →
   * 建 session（seed 计划与历史步骤）→ 以 cp.convo 为上下文起跑（startTurn = 中断轮数 +1）。
   */
  async function handleChatResume(
    _event: IpcMainInvokeEvent,
    request: ChatResumeRequest,
  ): Promise<ChatResumeResponse> {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    const conversationId = typeof request?.conversationId === 'string' ? request.conversationId : '';
    const assistantMessageId =
      typeof request?.assistantMessageId === 'string' ? request.assistantMessageId : '';
    // 三项参数缺一不可：checkpoint 按 conversationId__assistantMessageId 定位
    if (!requestId || !conversationId || !assistantMessageId) {
      emit(CHANNELS.CHAT_ERROR, {
        requestId,
        messageId: assistantMessageId,
        code: 'UNKNOWN',
        message: '续跑参数不完整',
      });
      return { requestId };
    }

    // 进程内并发门（纵深防御）：渲染层 resumeChat 已有同步门挡双击，但 IPC 层自身
    // 也要防「绕过渲染层」的路径（多窗口、devtools 手调、事件重放）——否则会双跑
    // loop：并发写同一 checkpoint 文件、并发 finalize 同一 assistant 消息。
    // 粒度与渲染层 sendMessage 的门一致：一个会话同时只允许一轮在飞。
    if ([...running.values()].some((session) => session.conversationId === conversationId)) {
      emit(CHANNELS.CHAT_ERROR, {
        requestId,
        messageId: assistantMessageId,
        code: 'UNKNOWN',
        message: '该会话正在生成中，请等待当前任务完成后再续跑',
      });
      return { requestId };
    }

    // 读 checkpoint：无账号（未登录）时不存在任何 checkpoint 文件
    const accountId = getActiveAccountId();
    const cp = accountId
      ? await checkpoint.readCheckpoint(accountId, conversationId, assistantMessageId)
      : null;
    // 双重校验：文件不存在，或文件内容与会话参数不一致（防串会话——文件名含两 id，
    // 但磁盘文件允许被手改，readCheckpoint 的校验管不了「文件名与内容的串号」）
    if (!cp || cp.conversationId !== conversationId || cp.assistantMessageId !== assistantMessageId) {
      emit(CHANNELS.CHAT_ERROR, {
        requestId,
        messageId: assistantMessageId,
        code: 'UNKNOWN',
        message:
          '没有找到这一轮的续跑状态（检查点已被清理或该轮本就无从续跑），请直接重新提问',
      });
      return { requestId };
    }

    const config = await readConfig();
    const providerId = config.activeProviderId;
    const provider = getProvider(providerId);
    const providerConfig = buildProviderConfig(config, providerId);
    if (!provider.isConfigured(providerConfig)) {
      // 与 chat:send 同口径：未配置时提示 + 顺带把设置弹层推给渲染层
      emit(CHANNELS.CHAT_ERROR, {
        requestId,
        messageId: assistantMessageId,
        code: 'NOT_CONFIGURED',
        message: errorMessage('NOT_CONFIGURED'),
      });
      emit<void>(CHANNELS.APP_OPEN_SETTINGS, undefined);
      return { requestId };
    }

    // 只读取出会话与目标 assistant 消息（与 chat:send 的 prepared 同构，但不 push 任何消息）
    const prepared = await mutateConversations<{
      partialText: string;
      toolContext: ToolContext;
      seedSteps: ToolStep[];
      plan?: PlanStep[];
    } | null>((list) => {
      const conversation = list.find((item) => item.id === conversationId);
      if (!conversation) {
        return null;
      }
      const targetMessage = conversation.messages.find((item) => item.id === assistantMessageId);
      if (!targetMessage || targetMessage.role !== 'assistant') {
        return null;
      }
      return {
        // 中断前已生成的正文：既作 loop 的 initialText，也作 session.text 的初值
        partialText: targetMessage.content,
        toolContext: {
          workspaceRoot: resolveWorkspaceRoot(conversation),
          backupRoot: getBackupRoot(),
          conversationId,
          memoryEnabled: config.memoryEnabled,
          skillsRoot: skillsRoot(),
        },
        // 历史工具步骤 seed：续跑收尾时与新一轮步骤合并落盘，界面不丢中断前的记录
        seedSteps: targetMessage.meta?.steps ?? [],
        // 计划清单 seed：上一轮 update_plan 维护的快照，随续跑沿续
        plan: targetMessage.meta?.plan,
      };
    });

    if (!prepared) {
      emit(CHANNELS.CHAT_ERROR, {
        requestId,
        messageId: assistantMessageId,
        code: 'UNKNOWN',
        message: '会话或消息不存在',
      });
      return { requestId };
    }

    const session: ChatSession = {
      requestId,
      conversationId,
      assistantMessageId,
      controller: new AbortController(),
      // 主进程侧累积全文同样以旧正文为初值：onDelta 只追加增量
      text: prepared.partialText,
    };
    running.set(requestId, session);

    // 计划清单 seed：中断前模型已建的计划先挂到 session，避免续跑中被空清单覆盖
    if (prepared.plan) {
      session.plan = prepared.plan;
    }

    // 以 checkpoint 的完整 convo 为上下文起跑；loop 内部会先补跑半截工具批次、
    // 再追加 resumeNote，然后从 cp.turn + 1 轮继续
    void runChatStream(session, cp.convo, providerId, prepared.toolContext, {
      initialText: prepared.partialText,
      startTurn: cp.turn + 1,
      seedSteps: prepared.seedSteps,
      resumeNote: RESUME_NOTE,
    }).catch(() => {
      // 兜底：编排逻辑自身异常时也要保证渲染层能退出 loading 态
      emit(CHANNELS.CHAT_ERROR, {
        requestId,
        messageId: assistantMessageId,
        code: 'UNKNOWN',
        message: errorMessage('UNKNOWN'),
      });
    });
    return { requestId };
  }

  /**
   * 上下文用量统计：按与真实请求完全相同的口径装配后估算 token。
   * 口径 = system（工作区规则 + 技能清单 + 记忆）+ buildContextMessages（最近 N 条），
   * 与 handleChatSend 里 contextMessages 的构造保持一致 —— 两处口径一旦漂移，
   * 用户看到的百分比就不再代表「下一轮实际会用掉多少」。
   *
   * 纯读操作：不落盘、不触发记忆提炼；listSkills 有 mtime 缓存，记忆是单个小文件，
   * 消息变化后调用一次的开销可以忽略。
   */
  async function handleContextStats(
    _event: IpcMainInvokeEvent,
    request: ContextStatsRequest,
  ): Promise<ContextStatsResponse> {
    const conversationId = typeof request?.conversationId === 'string' ? request.conversationId : '';
    const config = await readConfig();
    const contextWindow = resolveContextWindow(config, config.activeProviderId);
    const empty: ContextStatsResponse = {
      conversationId,
      tokens: 0,
      window: contextWindow,
      messageCount: 0,
      limit: CONTEXT_MESSAGE_LIMIT,
    };
    if (!conversationId) {
      return empty;
    }
    const list = await readConversations();
    const conversation = list.find((item) => item.id === conversationId);
    if (!conversation) {
      return empty;
    }
    const workspaceRoot = resolveWorkspaceRoot(conversation);
    const systemMessages: LlmMessage[] = [
      buildWorkspaceRulesMessage(workspaceRoot, config.memoryEnabled),
    ];
    const catalog = buildSkillsCatalogMessage(await listSkills(skillsRoot()));
    if (catalog) {
      systemMessages.push(catalog);
    }
    if (config.memoryEnabled) {
      const memory = await readWorkspaceMemory(workspaceRoot);
      if (memory.length > 0) {
        systemMessages.push(buildMemorySystemMessage(memory));
      }
    }
    const contextMessages = [...systemMessages, ...buildContextMessages(conversation.messages)];
    let tokens = 0;
    for (const message of contextMessages) {
      tokens += estimateTokens(message.content);
    }
    return {
      conversationId,
      tokens,
      window: contextWindow,
      messageCount: contextMessages.length,
      limit: CONTEXT_MESSAGE_LIMIT,
    };
  }

  async function handleConfigGet(_event: IpcMainInvokeEvent): Promise<PublicConfig> {
    const meta = await readAccountMeta();
    return toPublicConfig(await readConfig(), meta.lastConversationId);
  }

  async function handleConfigSave(
    _event: IpcMainInvokeEvent,
    input: ConfigSaveInput,
  ): Promise<PublicConfig> {
    const patch: ConfigSaveInput = input ?? {};
    const providerPatches: Array<{
      id: ProviderId;
      settings?: {
        baseUrl?: string;
        model?: string;
        apiKey?: string;
        numCtx?: number;
        contextWindow?: number | null;
      };
    }> = [
      { id: 'deepseek', settings: patch.deepseek },
      { id: 'ollama', settings: patch.ollama },
      { id: 'custom', settings: patch.custom },
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
        if (typeof entry.settings.numCtx === 'number' && isValidNumCtx(entry.settings.numCtx)) {
          // 只接受合法整数：与 storage.normalizeConfig 同一口径，非法值直接忽略不改动现值
          settings.numCtx = entry.settings.numCtx;
        }
        // 上下文窗口（仅用量统计的分母）：只认 deepseek / custom —— ollama 的窗口由
        // numCtx 单独管，两个字段同时存在会互相打架。非法值直接忽略；
        // null 表示清除（删字段，回退 DEFAULT_CONTEXT_WINDOW），与「从未配置」同一形态。
        if (entry.id === 'deepseek' || entry.id === 'custom') {
          if (entry.settings.contextWindow === null) {
            delete settings.contextWindow;
          } else if (
            typeof entry.settings.contextWindow === 'number' &&
            isValidContextWindow(entry.settings.contextWindow)
          ) {
            settings.contextWindow = entry.settings.contextWindow;
          }
        }
        if (typeof entry.settings.apiKey === 'string') {
          // 只进不出：返回密文交给配置落盘；不可用时返回 undefined，仅内存持有
          settings.apiKeyEnc = saveSecret(entry.id, entry.settings.apiKey.trim());
        }
      }
    });

    const meta = await readAccountMeta();
    return toPublicConfig(await readConfig(), meta.lastConversationId);
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
    const providerConfig = buildProviderConfig(config, providerId);
    // 草稿覆盖：只影响本次拉取，不触碰磁盘配置。
    // Base URL 无条件取表单现值（含空串）—— 用户清空字段就应该拉不到，
    // 而不是悄悄回落到旧值；apiKey 因为渲染层看不到历史密钥，留空才表示沿用已存值。
    const draft = request?.draft;
    if (draft) {
      if (typeof draft.baseUrl === 'string') {
        providerConfig.baseUrl = draft.baseUrl.trim();
      }
      if (typeof draft.apiKey === 'string' && draft.apiKey.trim().length > 0) {
        providerConfig.apiKey = draft.apiKey.trim();
      }
    }
    const combined = combineSignals([], MODELS_TIMEOUT_MS);
    try {
      return await provider.listModels(providerConfig, combined.signal);
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
   * 弹出系统文件选择框，把选中的文件复制进工作区 uploads/ 目录。
   *
   * 为什么必须在主进程复制：所有工具（read_text_file / list_dir / run_skill_script）的
   * 路径围栏都绑工作区，文件放在工作区外模型永远读不到；固定落到
   * `<workspaceRoot>/uploads/` 后，模型凭 list_dir 就能发现这些文件。
   * 用户取消对话框时不做任何复制，天然无需回滚。
   *
   * 文件名安全：原始文件名完全不可信，统一经 sanitizeAttachmentName 收敛，
   * 再加时间戳前缀防同批 / 跨批重名相互覆盖。
   */
  async function handleFileAttach(
    _event: IpcMainInvokeEvent,
    request: AttachFilesRequest,
  ): Promise<AttachFilesResult> {
    const root = typeof request?.workspaceRoot === 'string' ? request.workspaceRoot.trim() : '';
    // 绝对路径校验：相对路径的落点取决于主进程 cwd，不可预期
    if (root.length === 0 || !path.isAbsolute(root)) {
      return { canceled: false, files: [], error: '工作区路径无效，无法上传文件' };
    }
    const window = deps.getMainWindow();
    const options: OpenDialogOptions = {
      title: '选择要上传的文件',
      buttonLabel: '上传',
      properties: ['openFile', 'multiSelections'],
    };
    const result =
      window && !window.isDestroyed()
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, files: [] };
    }

    const uploadsDir = path.join(root, UPLOADS_DIR);
    const files: AttachedFile[] = [];
    const failures: string[] = [];
    // 本批已用名（小写比较，Windows 文件名不区分大小写）
    const usedNames = new Set<string>();
    await mkdir(uploadsDir, { recursive: true });

    for (const sourcePath of result.filePaths) {
      const displayName = path.basename(sourcePath);
      const stats = await stat(sourcePath).catch(() => null);
      if (!stats || !stats.isFile()) {
        failures.push(`${displayName}：无法读取该文件`);
        continue;
      }
      if (stats.size > ATTACH_MAX_BYTES) {
        failures.push(`${displayName}：超过 ${Math.floor(ATTACH_MAX_BYTES / (1024 * 1024))} MB 上限`);
        continue;
      }
      // 双重查重：本批已用名 + 磁盘已存在（跨批上传同名文件时时间戳通常已区分，这里兜底）
      const prefix = `${Date.now()}-`;
      let fileName = `${prefix}${sanitizeAttachmentName(displayName)}`;
      let duplicate = 2;
      while (
        usedNames.has(fileName.toLowerCase()) ||
        (await stat(path.join(uploadsDir, fileName)).then(
          () => true,
          () => false,
        ))
      ) {
        fileName = `${prefix}${duplicate}-${sanitizeAttachmentName(displayName)}`;
        duplicate += 1;
      }
      usedNames.add(fileName.toLowerCase());
      try {
        await copyFile(sourcePath, path.join(uploadsDir, fileName));
      } catch {
        failures.push(`${displayName}：复制失败`);
        continue;
      }
      files.push({
        name: displayName,
        // 相对工作区的 POSIX 风格路径：这里手工拼接，不经过 path.relative，天然就是正斜杠
        path: `${UPLOADS_DIR}/${fileName}`,
        size: stats.size,
      });
    }

    return {
      canceled: false,
      files,
      ...(failures.length > 0 ? { error: `以下文件未上传：${failures.join('；')}` } : {}),
    };
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
    registerHandler(CHANNELS.CONVERSATION_RENAME, handleConversationRename);
    registerHandler(CHANNELS.CONVERSATION_SET_PINNED, handleConversationSetPinned);
    registerHandler(CHANNELS.CHAT_SEND, handleChatSend);
    registerHandler(CHANNELS.CHAT_ABORT, handleChatAbort);
    registerHandler(CHANNELS.CHAT_RESUME, handleChatResume);
    registerHandler(CHANNELS.CONTEXT_STATS, handleContextStats);
    registerHandler(CHANNELS.CONFIG_GET, handleConfigGet);
    registerHandler(CHANNELS.CONFIG_SAVE, handleConfigSave);
    registerHandler(CHANNELS.MODELS_LIST, handleModelsList);
    registerHandler(CHANNELS.WORKSPACE_PICK, handleWorkspacePick);
    registerHandler(CHANNELS.FILE_ATTACH, handleFileAttach);
    registerHandler(CHANNELS.CONVERSATION_SET_WORKSPACE, handleConversationSetWorkspace);
    registerHandler(CHANNELS.APP_OPEN_EXTERNAL, handleOpenExternal);
    // 账号相关通道（auth:*）：复用本路由私有的 emit，保证全仓只有一处事件推送实现
    registerAuthHandlers(emit);
    // 技能导入通道（skill:*）：同样复用本路由私有的 emit + 主窗口访问器
    registerSkillHandlers({ emit, getMainWindow: deps.getMainWindow });
  }

  return { register };
}
