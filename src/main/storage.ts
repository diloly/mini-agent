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
/** 默认激活的 Provider */
const DEFAULT_ACTIVE_PROVIDER_ID: ProviderId = 'deepseek';

/** 会话数据文件路径 */
function conversationsPath(): string {
  return path.join(app.getPath('userData'), CONVERSATIONS_FILE);
}

/** 配置文件路径 */
function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

/** 内存缓存：避免每次 IPC 都读盘 */
let conversationsCache: Conversation[] | null = null;
let configCache: AppConfig | null = null;

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
 * 启动时调用：确保两个数据文件存在且可解析，并填充内存缓存。
 * 必须在 app.whenReady() 之后调用（依赖 app.getPath）。
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

  const storedConversations = await readJsonFile<Conversation[]>(conversationsPath());
  if (storedConversations) {
    conversationsCache = normalizeConversations(storedConversations);
  } else {
    conversationsCache = [];
    await atomicWrite(conversationsPath(), conversationsCache);
  }
}

/** 读取全部会话（内存缓存；首次调用会保证缓存已就绪） */
export async function readConversations(): Promise<Conversation[]> {
  if (!conversationsCache) {
    await ensureStorageReady();
  }
  return conversationsCache ?? [];
}

/** 整体覆盖写入会话列表 */
export async function writeConversations(list: Conversation[]): Promise<void> {
  conversationsCache = list;
  await enqueue(() => atomicWrite(conversationsPath(), list));
}

/**
 * 串行地「读最新数据 → 修改 → 原子写回」。
 * @param mutator 原地修改会话列表，可返回任意值作为本次操作的结果
 * @returns mutator 的返回值
 */
export async function mutateConversations<T>(
  mutator: (list: Conversation[]) => T,
): Promise<T> {
  return enqueue(async () => {
    const list = normalizeConversations(await readJsonFile<Conversation[]>(conversationsPath()));
    const result = mutator(list);
    conversationsCache = list;
    await atomicWrite(conversationsPath(), list);
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
