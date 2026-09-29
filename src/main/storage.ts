/**
 * 本地持久化：conversations.json 与 config.json 两个物理分离的文件，
 * 落在 Electron userData 目录；写入一律走「临时文件 + rename」的原子替换。
 *
 * 所有变更操作通过 mutateConversations / mutateConfig 串行执行，
 * 保证「读—改—写」之间不会因为并发的异步流程（如两轮并发生成）而互相覆盖。
 */
import { app } from 'electron';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONVERSATION_TITLE,
  DEFAULT_MODEL,
  DEFAULT_THEME_MODE,
  isThemeMode,
  type AppConfig,
  type Conversation,
  type ProviderId,
} from '../shared/types';

/** 会话数据文件名 */
const CONVERSATIONS_FILE = 'conversations.json';
/** 配置文件名（含密钥密文，与会话分离，清历史不丢 Key） */
const CONFIG_FILE = 'config.json';
/** 账号数据根目录名：各账号在其下按 accountId 分区 */
const ACCOUNTS_DIR = 'accounts';
/** 账号附加态文件名（lastConversationId / 迁移标记等，按账号存放） */
const META_FILE = 'meta.json';
/** 默认激活的 Provider */
const DEFAULT_ACTIVE_PROVIDER_ID: ProviderId = 'deepseek';

/** 账号目录：<userData>/accounts/<accountId>/ */
export function accountDir(accountId: string): string {
  return path.join(app.getPath('userData'), ACCOUNTS_DIR, accountId);
}

/** 某账号的会话文件路径（account-aware；调用前须保证有 activeAccountId） */
function conversationsPath(accountId: string): string {
  return path.join(accountDir(accountId), CONVERSATIONS_FILE);
}

/** 某账号的 meta 文件路径 */
function accountMetaPath(accountId: string): string {
  return path.join(accountDir(accountId), META_FILE);
}

/** 配置文件路径（全局设备级，不随账号走） */
function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

/** 内存缓存：避免每次 IPC 都读盘 */
let conversationsCache: Conversation[] | null = null;
let configCache: AppConfig | null = null;

/** 当前激活账号；null = 未登录（此时会话读写一律返回空 / 静默忽略） */
let activeAccountId: string | null = null;

/** 会话变更观察者（供批二 SyncEngine 订阅；回传最新列表快照） */
type ConversationsListener = (list: Conversation[]) => void;
const conversationsListeners = new Set<ConversationsListener>();

/** 串行写队列：所有「读—改—写」操作的排队锚点 */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * 把任务串到写队列尾部执行。
 * @param task 待执行的异步任务
 * @returns 任务返回值
 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 原子写：先写临时文件，再 rename 覆盖目标文件。
 * 任何一步失败都不会留下半截的目标文件。
 */
async function atomicWrite(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** 读取并解析 JSON 文件；不存在或解析失败返回 undefined */
async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** 构造默认配置 */
export function createDefaultConfig(): AppConfig {
  return {
    version: 1,
    activeProviderId: DEFAULT_ACTIVE_PROVIDER_ID,
    providers: {
      deepseek: {
        baseUrl: DEFAULT_BASE_URL.deepseek,
        model: DEFAULT_MODEL.deepseek,
      },
      ollama: {
        baseUrl: DEFAULT_BASE_URL.ollama,
        model: DEFAULT_MODEL.ollama,
      },
    },
    memoryEnabled: true,
    ui: { theme: DEFAULT_THEME_MODE },
  };
}

/** 用默认值补齐残缺配置，容忍旧版本或手改过的文件 */
function normalizeConfig(raw: Partial<AppConfig> | undefined | null): AppConfig {
  const fallback = createDefaultConfig();
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }
  const rawProviders = (raw.providers ?? {}) as Partial<AppConfig['providers']>;
  return {
    version: 1,
    activeProviderId: raw.activeProviderId ?? fallback.activeProviderId,
    providers: {
      deepseek: {
        baseUrl: rawProviders.deepseek?.baseUrl ?? fallback.providers.deepseek.baseUrl,
        model: rawProviders.deepseek?.model ?? fallback.providers.deepseek.model,
        apiKeyEnc: rawProviders.deepseek?.apiKeyEnc,
      },
      ollama: {
        baseUrl: rawProviders.ollama?.baseUrl ?? fallback.providers.ollama.baseUrl,
        model: rawProviders.ollama?.model ?? fallback.providers.ollama.model,
      },
    },
    // 磁盘文件可被手改：只认真正的布尔值，缺字段 / 字符串 "false" / 非法值一律回退为默认（开启）
    memoryEnabled:
      typeof raw.memoryEnabled === 'boolean' ? raw.memoryEnabled : fallback.memoryEnabled,
    ui: {
      lastConversationId: raw.ui?.lastConversationId,
      // 磁盘文件可被手改，非法值必须退回默认，否则 data-theme 会落到两套变量都不命中的值
      theme: isThemeMode(raw.ui?.theme) ? raw.ui.theme : DEFAULT_THEME_MODE,
    },
  };
}

/** 清洗会话数据，剔除结构异常的记录 */
function normalizeConversations(raw: unknown): Conversation[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is Conversation => {
    return (
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as Conversation).id === 'string' &&
      Array.isArray((item as Conversation).messages)
    );
  });
}

/**
 * 账号附加态（按账号存放在 `accounts/<id>/meta.json`）。
 * 白名单式重建，纪律与 normalizeConfig 相同：新增字段必须同步加入 normalizeAccountMeta。
 */
export interface AccountMeta {
  version: 1;
  /** 该账号「上次查看的会话」；从 config.ui.lastConversationId 迁移而来 */
  lastConversationId?: string;
  /** 老 conversations.json 是否已归入本账号 */
  legacyMigrated?: boolean;
  /** 批二用：上次成功同步时间戳 */
  lastSyncedAt?: number;
}

/** 白名单式重建账号 meta；非法值一律丢弃，避免手改文件污染内存 */
export function normalizeAccountMeta(raw: Partial<AccountMeta> | undefined | null): AccountMeta {
  if (!raw || typeof raw !== 'object') {
    return { version: 1 };
  }
  return {
    version: 1,
    lastConversationId:
      typeof raw.lastConversationId === 'string' ? raw.lastConversationId : undefined,
    legacyMigrated: raw.legacyMigrated === true ? true : undefined,
    lastSyncedAt: typeof raw.lastSyncedAt === 'number' ? raw.lastSyncedAt : undefined,
  };
}

/** 读取当前激活账号 id；null = 未登录 */
export function getActiveAccountId(): string | null {
  return activeAccountId;
}

/**
 * 登录 / 登出时切换激活账号。
 * 必须清空 conversationsCache：否则会跨账号读到上一账号的会话缓存（串号）。
 */
export async function setActiveAccount(accountId: string | null): Promise<void> {
  activeAccountId = accountId;
  conversationsCache = null;
  if (accountId) {
    await mkdir(accountDir(accountId), { recursive: true });
  }
}

/** 读取当前账号的附加态；无账号时返回默认 meta（不抛错） */
export async function readAccountMeta(): Promise<AccountMeta> {
  const accountId = activeAccountId;
  if (!accountId) {
    return { version: 1 };
  }
  return normalizeAccountMeta(await readJsonFile<Partial<AccountMeta>>(accountMetaPath(accountId)));
}

/**
 * 串行地「读最新 meta → 修改 → 原子写回」。
 * 无账号时仅在默认 meta 上执行（不落盘、不抛错），与 mutateConversations 同一纪律。
 */
export async function mutateAccountMeta<T>(mutator: (meta: AccountMeta) => T): Promise<T> {
  const accountId = activeAccountId;
  if (!accountId) {
    return mutator({ version: 1 });
  }
  return enqueue(async () => {
    const meta = normalizeAccountMeta(
      await readJsonFile<Partial<AccountMeta>>(accountMetaPath(accountId)),
    );
    const result = mutator(meta);
    await mkdir(accountDir(accountId), { recursive: true });
    await atomicWrite(accountMetaPath(accountId), meta);
    return result;
  });
}

/** 订阅会话变更：每次成功写入后回调最新列表快照；返回取消订阅函数 */
export function subscribeConversations(listener: ConversationsListener): () => void {
  conversationsListeners.add(listener);
  return () => {
    conversationsListeners.delete(listener);
  };
}

/** 通知所有观察者最新列表快照；观察者异常不得影响写入主流程 */
function notifyConversations(list: Conversation[]): void {
  for (const listener of conversationsListeners) {
    try {
      listener(list);
    } catch {
      // 静默：观察者是附加能力（批二同步），失败不得反噬写入
    }
  }
}

/**
 * 启动时调用：确保 config.json 存在且可解析，并填充内存缓存。
 * 必须在 app.whenReady() 之后调用（依赖 app.getPath）。
 *
 * 注意：会话文件已改为 account-aware（`accounts/<id>/conversations.json`），
 * 启动时通常尚无激活账号，故此处**只保证 config.json**；会话在 setActiveAccount
 * 后按需懒加载。
 */
export async function ensureStorageReady(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });

  const storedConfig = await readJsonFile<Partial<AppConfig>>(configPath());
  if (storedConfig) {
    configCache = normalizeConfig(storedConfig);
  } else {
    configCache = createDefaultConfig();
    await atomicWrite(configPath(), configCache);
  }
}

/** 读取全部会话（内存缓存；无账号时返回空列表，首读按需从账号目录懒加载） */
export async function readConversations(): Promise<Conversation[]> {
  const accountId = activeAccountId;
  if (!accountId) {
    return [];
  }
  if (!conversationsCache) {
    conversationsCache = normalizeConversations(
      await readJsonFile<Conversation[]>(conversationsPath(accountId)),
    );
  }
  return conversationsCache ?? [];
}

/** 整体覆盖写入会话列表；无账号时静默忽略（不抛错） */
export async function writeConversations(list: Conversation[]): Promise<void> {
  const accountId = activeAccountId;
  if (!accountId) {
    return;
  }
  conversationsCache = list;
  await enqueue(() => atomicWrite(conversationsPath(accountId), list));
  notifyConversations(list);
}

/**
 * 串行地「读最新数据 → 修改 → 原子写回」。
 * 无账号时按空列表处理（不落盘、不抛错），避免调用点到处判空。
 * @param mutator 原地修改会话列表，可返回任意值作为本次操作的结果
 * @returns mutator 的返回值
 */
export async function mutateConversations<T>(
  mutator: (list: Conversation[]) => T,
): Promise<T> {
  const accountId = activeAccountId;
  if (!accountId) {
    return mutator([]);
  }
  return enqueue(async () => {
    const list = normalizeConversations(await readJsonFile<Conversation[]>(conversationsPath(accountId)));
    const result = mutator(list);
    conversationsCache = list;
    await atomicWrite(conversationsPath(accountId), list);
    notifyConversations(list);
    return result;
  });
}

/** 读取配置（内存缓存） */
export async function readConfig(): Promise<AppConfig> {
  if (!configCache) {
    await ensureStorageReady();
  }
  return configCache ?? createDefaultConfig();
}

/**
 * 串行地「读最新配置 → 修改 → 原子写回」。
 * @param mutator 原地修改配置，可返回任意值作为本次操作的结果
 * @returns mutator 的返回值
 */
export async function mutateConfig<T>(mutator: (config: AppConfig) => T): Promise<T> {
  return enqueue(async () => {
    const config = normalizeConfig(await readJsonFile<Partial<AppConfig>>(configPath()));
    const result = mutator(config);
    configCache = config;
    await atomicWrite(configPath(), config);
    return result;
  });
}

/** 新建会话的默认标题 */
export function defaultConversationTitle(): string {
  return DEFAULT_CONVERSATION_TITLE;
}
