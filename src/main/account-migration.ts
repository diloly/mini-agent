/**
 * 老数据迁移：把设备级 `conversations.json` 归入首个登录账号的分区目录。
 *
 * 规则（见 AUTH-ARCHITECTURE §7.3）：
 * - `<userData>/conversations.json` 存在时，其内容并入 `accounts/<accountId>/conversations.json`；
 * - 再把源文件**改名**为 `conversations.legacy-backup-<ts>.json`（**永不删除**）；
 * - 幂等：靠「改名即消费」——源文件消失后，第二个账号登录时命中「不存在」分支，不会被误认领；
 * - 失败不阻塞登录：迁移异常只返回 `migrated:false`，账号仍可用（只是没有历史）。
 *
 * 本模块自带 tmp+rename 原子写，不依赖 storage 的模块态 activeAccountId，
 * 以便在账号激活时序之外也能安全执行（签名显式接收 accountId）。
 */
import { app } from 'electron';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Conversation } from '../shared/types';
import { accountDir, mutateConfig } from './storage';

/** 遗留会话文件名（设备级） */
const LEGACY_CONVERSATIONS_FILE = 'conversations.json';
/** 账号附加态文件名 */
const META_FILE = 'meta.json';
/** 配置文件名（读取旧 lastConversationId 用） */
const CONFIG_FILE = 'config.json';

/** 迁移结果：migrated 为假时可能因源文件不存在或迁移失败 */
export interface MigrationResult {
  migrated: boolean;
  count: number;
}

/** 原子写 JSON：先写临时文件再 rename，失败清理临时文件 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/** 目标文件是否已存在 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 首个登录账号登录成功后调用一次。
 * @param accountId Supabase user.id（文件系统安全）
 * @returns 是否发生迁移，以及并入的会话数
 */
export async function migrateLegacyConversations(accountId: string): Promise<MigrationResult> {
  const legacyPath = path.join(app.getPath('userData'), LEGACY_CONVERSATIONS_FILE);

  let raw: string;
  try {
    raw = await readFile(legacyPath, 'utf8');
  } catch {
    // 源文件不存在：已消费过 / 全新用户
    return { migrated: false, count: 0 };
  }

  // 解析（轻度校验；真正清洗由 storage.readConversations 的 normalizeConversations 负责）
  let content: Conversation[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      content = parsed as Conversation[];
    }
  } catch {
    content = [];
  }

  try {
    const dir = accountDir(accountId);
    const targetPath = path.join(dir, LEGACY_CONVERSATIONS_FILE);
    // 目标不存在才写：避免覆盖该账号已有数据（安全兜底）
    if (!(await fileExists(targetPath))) {
      await mkdir(dir, { recursive: true });
      await atomicWriteJson(targetPath, content);
    }

    // 消费源文件：改名备份（永不删除）
    const backupPath = path.join(
      app.getPath('userData'),
      `conversations.legacy-backup-${Date.now()}.json`,
    );
    await rename(legacyPath, backupPath);

    // 顺带把旧 lastConversationId 迁入本账号 meta，并打上迁移标记
    const finalized = await finalizeAccountMeta(accountId);
    if (finalized) {
      // meta 已就位后，config 里的旧字段就成了永久死字段，顺手清掉
      await clearLegacyLastConversationId();
    }

    return { migrated: true, count: content.length };
  } catch {
    // 迁移失败不阻塞登录；源文件仍在，下次登录可重试
    return { migrated: false, count: content.length };
  }
}

/** 打完迁移标记 + 迁移旧 lastConversationId（账号已有值则不覆盖）；返回 meta 是否写成功 */
async function finalizeAccountMeta(accountId: string): Promise<boolean> {
  try {
    const dir = accountDir(accountId);
    const metaPath = path.join(dir, META_FILE);

    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    } catch {
      meta = {};
    }

    meta.version = 1;
    meta.legacyMigrated = true;
    if (typeof meta.lastConversationId !== 'string' || meta.lastConversationId.length === 0) {
      const legacyLastId = await readLegacyLastConversationId();
      if (legacyLastId) {
        meta.lastConversationId = legacyLastId;
      }
    }

    await mkdir(dir, { recursive: true });
    await atomicWriteJson(metaPath, meta);
    return true;
  } catch {
    // 静默：迁移附加信息失败不影响主流程
    return false;
  }
}

/**
 * 清掉 config.json 里的 ui.lastConversationId（已迁入账号 meta，留着就是永久死字段）。
 * 走 storage 的 mutateConfig（enqueue + atomicWrite）；与迁移对 conversations/meta 的
 * 直写互不冲突（不同文件）。失败静默：清不掉也不影响功能。
 */
async function clearLegacyLastConversationId(): Promise<void> {
  try {
    await mutateConfig((config) => {
      delete config.ui.lastConversationId;
    });
  } catch {
    // 静默
  }
}

/** 读取 config.json 里的旧 lastConversationId（迁移前的设备级值）；无则返回 null */
async function readLegacyLastConversationId(): Promise<string | null> {
  try {
    const configPath = path.join(app.getPath('userData'), CONFIG_FILE);
    const rawConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
      ui?: { lastConversationId?: unknown };
    };
    const value = rawConfig?.ui?.lastConversationId;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
