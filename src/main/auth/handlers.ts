/**
 * 账号 IPC 接线：注册 `auth:*` 通道 + 推送 `auth:changed` 事件。
 *
 * 纪律：
 * - `AuthService` 为**单例**（getAuthService）：index.ts 的 `restore()` 与本处 handlers
 *   共用同一实例，否则 `getState()` 与实际登录态会分裂；
 * - 每个 handler 都 try/catch 包裹，异常也返回结构化结果，**绝不让 invoke reject**
 *   （安全底线：渲染层永不卡在 loading）；
 * - 事件 payload 只允许 `AuthState`（脱敏），不得出现 session / access_token / refresh_token。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  CHANNELS,
  type AuthResult,
  type AuthState,
  type ChannelName,
  type ClearLocalDataRequest,
  type ClearLocalDataResult,
  type ResetPasswordRequest,
  type SignInRequest,
  type SignUpRequest,
  type SignUpResult,
} from '../../shared/ipc-channels';
import { AUTH_ERROR_TEXT } from '../../shared/types';
import { migrateLegacyConversations } from '../account-migration';
import {
  getActiveAccountId,
  mutateAccountMeta,
  readConversations,
  setActiveAccount,
  writeConversations,
} from '../storage';
import { getSupabase } from './client';
import { AuthService } from './service';

/** 事件推送函数：由 ipc.ts 的 `emit` 注入（全仓唯一 emit 实现） */
type AuthEmit = (channel: ChannelName, payload: unknown) => void;

/**
 * 账号切换：切换存储分区 + 首个账号一次性迁移老数据。
 * 迁移函数幂等（源文件已消费时直接早退），重复调用零成本。
 */
async function onAccountChanged(accountId: string | null): Promise<void> {
  await setActiveAccount(accountId);
  if (accountId) {
    await migrateLegacyConversations(accountId);
  }
}

/** AuthService 单例（index.ts 与 handlers 共用） */
let service: AuthService | null = null;

/** 获取 AuthService 单例（懒构造：首次调用时创建并缓存） */
export function getAuthService(): AuthService {
  if (!service) {
    service = new AuthService({ onAccountChanged });
  }
  return service;
}

/** 把 supabase session 脱敏为 AuthState（只取 state / email / userId，绝不外传 token） */
function toAuthState(
  session: { user?: { id: string; email?: string | null } | null } | null,
): AuthState {
  const user = session?.user;
  if (!user) {
    return { state: 'unauthenticated' };
  }
  return { state: 'authenticated', email: user.email ?? undefined, userId: user.id };
}

/**
 * 注册全部 `auth:*` handler。
 * @param emit 向渲染层推送事件的函数（复用 ipc.ts 的实现，不另造广播）
 */
export function registerAuthHandlers(emit: AuthEmit): void {
  const auth = getAuthService();

  /** 注册单个 invoke 通道；先 removeHandler 再 handle，开发期热重载不报重复注册 */
  function handle<TArgs extends unknown[], TResult>(
    channel: ChannelName,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult>,
  ): void {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
  }

  handle(CHANNELS.AUTH_GET_STATE, async (): Promise<AuthState> => {
    try {
      return auth.getState();
    } catch {
      return { state: 'unauthenticated' };
    }
  });

  handle(CHANNELS.AUTH_SIGN_UP, async (_event, req: SignUpRequest): Promise<SignUpResult> => {
    try {
      return await auth.signUp(req);
    } catch {
      return {
        ok: false,
        needsEmailConfirm: false,
        code: 'UNKNOWN',
        message: AUTH_ERROR_TEXT.UNKNOWN,
      };
    }
  });

  handle(CHANNELS.AUTH_SIGN_IN, async (_event, req: SignInRequest): Promise<AuthResult> => {
    try {
      const result = await auth.signIn(req);
      if (result.ok) {
        emit(CHANNELS.AUTH_CHANGED, result.state);
      }
      return result;
    } catch {
      return { ok: false, state: auth.getState(), code: 'UNKNOWN', message: AUTH_ERROR_TEXT.UNKNOWN };
    }
  });

  handle(CHANNELS.AUTH_SIGN_OUT, async (): Promise<AuthResult> => {
    try {
      const result = await auth.signOut();
      if (result.ok) {
        emit(CHANNELS.AUTH_CHANGED, result.state);
      }
      return result;
    } catch {
      return { ok: false, state: auth.getState(), code: 'UNKNOWN', message: AUTH_ERROR_TEXT.UNKNOWN };
    }
  });

  handle(
    CHANNELS.AUTH_RESET_PASSWORD,
    async (_event, req: ResetPasswordRequest): Promise<AuthResult> => {
      try {
        return await auth.resetPassword(req);
      } catch {
        return {
          ok: false,
          state: auth.getState(),
          code: 'UNKNOWN',
          message: AUTH_ERROR_TEXT.UNKNOWN,
        };
      }
    },
  );

  handle(CHANNELS.AUTH_DELETE_ACCOUNT, async (): Promise<AuthResult> => {
    try {
      const result = await auth.deleteAccount();
      if (result.ok) {
        emit(CHANNELS.AUTH_CHANGED, result.state);
      }
      return result;
    } catch {
      return { ok: false, state: auth.getState(), code: 'UNKNOWN', message: AUTH_ERROR_TEXT.UNKNOWN };
    }
  });

  handle(
    CHANNELS.AUTH_CLEAR_LOCAL_DATA,
    async (_event, req: ClearLocalDataRequest): Promise<ClearLocalDataResult> => {
      try {
        // 二次确认由渲染层负责；未确认一律拒绝
        if (!req?.confirm) {
          return { ok: false, removedCount: 0 };
        }
        const removedCount = (await readConversations()).length;
        // 无激活账号时会静默忽略（storage 的既有语义）
        await writeConversations([]);
        // 会话已清空，恢复目标随之失效。不重置的话下次启动会拿这个悬空 id 去找会话 ——
        // hydrate 能兜底，但会白跑一次，且 meta 里留着脏值。
        await mutateAccountMeta((meta) => {
          meta.lastConversationId = undefined;
        });
        return { ok: true, removedCount };
      } catch {
        return { ok: false, removedCount: 0 };
      }
    },
  );

  // 订阅 supabase 登录态变化（token 刷新 / 被登出 / 跨窗口同步），脱敏后推给渲染层
  const client = getSupabase();
  if (client) {
    client.auth.onAuthStateChange((_event, session) => {
      // 官方明确警告：回调内不得 await 任何 supabase 调用（会死锁）。只做同步脱敏 + emit。
      const next = toAuthState(session);
      emit(CHANNELS.AUTH_CHANGED, next);
      // 外部登出（如 token 被撤销）：主进程仍停在旧账号 → 收敛登录态并切回无分区。
      // 仅在「确有激活账号」时才动，规避 supabase 初始化时的首帧 null 事件误触发。
      if (next.state === 'unauthenticated' && getActiveAccountId()) {
        void auth.applyExternalSignOut();
      }
    });
  }
}
