/**
 * 登录态存放：supabase-js 的 `auth.storage` 适配器。
 *
 * 安全底线（与 secret.ts 的 API Key 纪律完全一致）：
 * - token **必须** `safeStorage.encryptString` 后 base64 落 `<userData>/auth/session.json`；
 * - `safeStorage.isEncryptionAvailable()` 为假时**只写内存 Map，绝不明文落盘**；
 * - 「记住我」关（`setPersistence(false)`）时同样只写内存，重启即失效。
 *
 * 明文 token 只存在于主进程内存，渲染层永远拿不到。
 */
import { app, safeStorage } from 'electron';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** supabase 需要的存储接口（值均为字符串） */
export interface SupportedStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

/** 不可加密 / 不记住我时的内存兜底：绝不明文落盘 */
const memoryStore = new Map<string, string>();
/** 「记住我」开关：false 时一律只写内存（重启即失效） */
let persistenceEnabled = true;

/**
 * 设置「记住我」。
 * - 开启：getItem / setItem 读写都走磁盘密文文件；
 * - 关闭：getItem / setItem 一律只走内存（重启即失效）。
 *
 * 注意：关闭时调用方**必须同时**调用 `clearPersistedSession()` 清掉磁盘历史密文，
 * 否则本次仅内存持有 token，而磁盘仍留着上一次（可能是另一个账号）的密文，
 * 重启后会被 restore() 读出来静默登入旧账号。
 */
export function setPersistence(enabled: boolean): void {
  persistenceEnabled = enabled;
}

/** 读取当前「记住我」开关；供登录失败时回滚副作用 */
export function isPersistenceEnabled(): boolean {
  return persistenceEnabled;
}

/**
 * 清掉磁盘上的历史密文（不动 memoryStore）。
 * 「不记住我」时必须调用：否则本次仅内存持有 token，磁盘仍留着上一次
 * （可能是另一个账号）的密文，重启后会被 restore() 读出来静默登入旧账号。
 */
export async function clearPersistedSession(): Promise<void> {
  try {
    await unlink(sessionPath());
  } catch {
    // 文件不存在是正常路径：一律吞掉
  }
}

/** session.json 路径 */
function sessionPath(): string {
  return path.join(app.getPath('userData'), 'auth', 'session.json');
}

/** 当前环境是否支持安全存储（异常一律视为不支持） */
function encAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 读取磁盘上的「key → base64 密文」映射；不存在 / 解析失败返回空对象 */
async function readMap(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(sessionPath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** 原子写：先写临时文件再 rename，任何一步失败都不留半截目标文件 */
async function writeMap(map: Record<string, string>): Promise<void> {
  const dir = path.dirname(sessionPath());
  await mkdir(dir, { recursive: true });
  const tmp = `${sessionPath()}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(map), 'utf8');
    await rename(tmp, sessionPath());
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/** supabase-js 使用的存储适配器 */
export const sessionStorage: SupportedStorage = {
  async getItem(key) {
    // 不可加密或不持久化：只在内存里找
    if (!encAvailable() || !persistenceEnabled) {
      return memoryStore.get(key) ?? null;
    }
    const map = await readMap();
    const cipher = map[key];
    if (!cipher) {
      return memoryStore.get(key) ?? null;
    }
    try {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    } catch {
      // 换机 / 系统钥匙串变更：解不开就当没有 → 重新登录
      return null;
    }
  },
  async setItem(key, value) {
    // 不可加密或不持久化：只进内存，绝不落盘
    if (!encAvailable() || !persistenceEnabled) {
      memoryStore.set(key, value);
      return;
    }
    memoryStore.set(key, value);
    const map = await readMap();
    map[key] = safeStorage.encryptString(value).toString('base64');
    await writeMap(map);
  },
  async removeItem(key) {
    memoryStore.delete(key);
    // 无论能否加密都尝试清理磁盘：磁盘上可能残留「上次能加密时」写入的密文，
    // 换机后 isEncryptionAvailable() 可能变假；若在此早退，孤儿密文会永远留在盘上。
    try {
      const map = await readMap();
      if (key in map) {
        delete map[key];
        await writeMap(map);
      }
    } catch {
      // 静默：磁盘清理失败不影响内存中已删除的登录态
    }
  },
};
