/**
 * 渲染层访问主进程的唯一出口：对 window.api 做类型化封装。
 *
 * 约定：
 * - 所有 IPC 调用都必须经过本文件，组件不得直接触碰 window.api；
 * - requestId 统一由 createRequestId() 生成（crypto.randomUUID，带降级实现）。
 */
import type {
  ChatChunkEvent,
  ChatEndEvent,
  ChatErrorEvent,
  ChatSendRequest,
  ChatSendResponse,
  ConfigSaveInput,
  Conversation,
  ConversationSummary,
  OkResult,
  OpenExternalResult,
} from '../../shared/ipc-channels';
import type { ModelInfo, ProviderId, PublicConfig } from '../../shared/types';
import type { MiniAgentApi } from '../types/window';

/** 取 preload 注入的 API；未就绪时给出明确报错，便于定位 preload 加载失败 */
function ensureApi(): MiniAgentApi {
  const bridge = window.api;
  if (!bridge) {
    throw new Error('window.api 未就绪：请确认 preload 已正确加载');
  }
  return bridge;
}

/** UUID v4 的十六进制字符表 */
const HEX_ALPHABET = '0123456789abcdef';

/**
 * 生成本次请求的唯一标识。
 * 优先使用 crypto.randomUUID；在缺少该 API 的环境下退化为 getRandomValues 手工拼装 v4。
 */
export function createRequestId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let id = '';
    for (let index = 0; index < 16; index += 1) {
      const value = bytes[index];
      id += HEX_ALPHABET[value >>> 4] + HEX_ALPHABET[value & 0x0f];
      if (index === 3 || index === 5 || index === 7 || index === 9) {
        id += '-';
      }
    }
    return id;
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 会话列表 */
export function listConversations(): Promise<ConversationSummary[]> {
  return ensureApi().listConversations();
}

/** 新建会话 */
export function createConversation(): Promise<Conversation> {
  return ensureApi().createConversation();
}

/** 取单个会话 */
export function getConversation(id: string): Promise<Conversation | null> {
  return ensureApi().getConversation(id);
}

/** 删除会话 */
export function deleteConversation(id: string): Promise<OkResult> {
  return ensureApi().deleteConversation(id);
}

/** 发起一轮流式对话 */
export function sendChat(request: ChatSendRequest): Promise<ChatSendResponse> {
  return ensureApi().sendChat(request);
}

/** 停止生成 */
export function abortChat(requestId: string): Promise<OkResult> {
  return ensureApi().abortChat(requestId);
}

/** 读取脱敏配置 */
export function getConfig(): Promise<PublicConfig> {
  return ensureApi().getConfig();
}

/** 保存配置 */
export function saveConfig(input: ConfigSaveInput): Promise<PublicConfig> {
  return ensureApi().saveConfig(input);
}

/** 拉取候选模型 */
export function listModels(providerId: ProviderId): Promise<ModelInfo[]> {
  return ensureApi().listModels(providerId);
}

/** 订阅增量文本；返回取消订阅函数 */
export function onChatChunk(listener: (event: ChatChunkEvent) => void): () => void {
  return ensureApi().onChatChunk(listener);
}

/** 订阅正常 / 中止结束；返回取消订阅函数 */
export function onChatEnd(listener: (event: ChatEndEvent) => void): () => void {
  return ensureApi().onChatEnd(listener);
}

/** 订阅异常结束；返回取消订阅函数 */
export function onChatError(listener: (event: ChatErrorEvent) => void): () => void {
  return ensureApi().onChatError(listener);
}

/** 订阅「打开设置」引导；返回取消订阅函数 */
export function onOpenSettings(listener: () => void): () => void {
  return ensureApi().onOpenSettings(listener);
}

/** 用系统默认浏览器打开外链；非 http/https 会被主进程拒绝，返回 ok:false */
export function openExternal(url: string): Promise<OpenExternalResult> {
  return ensureApi().openExternal(url);
}
