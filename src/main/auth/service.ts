/**
 * AuthService：账号体系的业务门面。
 *
 * 职责：restore / getState / signUp / signIn / signOut / resetPassword / deleteAccount。
 * 纪律：
 * - 所有返回值**脱敏**（只含 state / email / userId，绝不含 token）；
 * - 登录 / 登出成功后通过 `deps.onAccountChanged` 通知存储层切换 activeAccount；
 * - 邮箱格式**本地先校验**（不打网络）；
 * - 所有异常都翻译为 AUTH_ERROR_TEXT 的中文文案，不透英文原文。
 */
import type {
  AuthResult,
  AuthState,
  ResetPasswordRequest,
  SignInRequest,
  SignUpRequest,
  SignUpResult,
} from '../../shared/ipc-channels';
import { AUTH_ERROR_TEXT, type AuthErrorCode } from '../../shared/types';
import { getSupabase } from './client';
import { toAuthErrorCode } from './errors';
import { clearPersistedSession, isPersistenceEnabled, setPersistence } from './session-store';

/** AuthService 的构造依赖 */
export interface AuthServiceDeps {
  /** 账号切换回调：由存储层实现（设置 / 清空 activeAccount） */
  onAccountChanged: (accountId: string | null) => Promise<void>;
}

/** 简化的邮箱格式校验（登录前本地拦截，避免无谓网络请求） */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** access token 剩余有效期低于该值时视为「将过期」，启动时尝试续期（毫秒） */
const REFRESH_MARGIN_MS = 60_000;

export class AuthService {
  /** 最近一次已知的登录态（脱敏） */
  private state: AuthState = { state: 'unauthenticated' };

  constructor(private readonly deps: AuthServiceDeps) {}

  /** 同步读取当前登录态 */
  getState(): AuthState {
    return this.state;
  }

  /**
   * 启动恢复：读本机 session → 必要时续期并 setActiveAccount。
   * 断网且本机有登录态 → 'expired'（仍放行，离线优先）；凭据失效 → 'unauthenticated'。
   */
  async restore(): Promise<AuthState> {
    const client = getSupabase();
    if (!client) {
      this.state = { state: 'unauthenticated' };
      await this.deps.onAccountChanged(null);
      return this.state;
    }

    const { data } = await client.auth.getSession();
    const session = data.session;
    const user = session?.user;
    if (!session || !user) {
      this.state = { state: 'unauthenticated' };
      await this.deps.onAccountChanged(null);
      return this.state;
    }

    // 仅在临近过期时才续期：token 有效时绝不打网络，保证首帧不被网络拖慢
    if (isNearExpiry(session.expires_at)) {
      const { data: refreshed, error: refreshError } = await client.auth.refreshSession();
      if (refreshError || !refreshed.session) {
        // 断网 → 保留登录态，标 expired（离线放行）
        if (toAuthErrorCode(refreshError) === 'NETWORK') {
          await this.deps.onAccountChanged(user.id);
          this.state = { state: 'expired', email: user.email ?? undefined, userId: user.id };
          return this.state;
        }
        // 凭据失效（refresh token 过期 / 被撤销）→ 清登录态
        await client.auth.signOut().catch(() => undefined);
        this.state = { state: 'unauthenticated' };
        await this.deps.onAccountChanged(null);
        return this.state;
      }
    }

    await this.deps.onAccountChanged(user.id);
    this.state = { state: 'authenticated', email: user.email ?? undefined, userId: user.id };
    return this.state;
  }

  /** 注册：邮箱格式本地先校验；成功但需邮箱确认时返回 needsEmailConfirm=true */
  async signUp(req: SignUpRequest): Promise<SignUpResult> {
    const email = req.email.trim();
    if (!EMAIL_PATTERN.test(email)) {
      return {
        ok: false,
        needsEmailConfirm: false,
        code: 'INVALID_EMAIL',
        message: AUTH_ERROR_TEXT.INVALID_EMAIL,
      };
    }
    const client = getSupabase();
    if (!client) {
      return {
        ok: false,
        needsEmailConfirm: false,
        code: 'SERVICE_UNAVAILABLE',
        message: AUTH_ERROR_TEXT.SERVICE_UNAVAILABLE,
      };
    }
    // 注册流程没有「记住我」概念，显式恢复默认（true）：否则此前一次 remember=false
    // 的登录尝试会把开关留在 false，导致「注册即登录」的 token 只进内存、重启即失效。
    setPersistence(true);
    try {
      const { data, error } = await client.auth.signUp({ email, password: req.password });
      if (error) {
        const code = toAuthErrorCode(error);
        return { ok: false, needsEmailConfirm: false, code, message: AUTH_ERROR_TEXT[code] };
      }
      // 有 session 说明邮箱确认未开启，注册即登录
      if (data.session && data.user) {
        await this.deps.onAccountChanged(data.user.id);
        this.state = {
          state: 'authenticated',
          email: data.user.email ?? email,
          userId: data.user.id,
        };
        return { ok: true, needsEmailConfirm: false };
      }
      // 无 session：需去邮箱点确认链接
      return { ok: true, needsEmailConfirm: true };
    } catch (error) {
      const code = toAuthErrorCode(error);
      return { ok: false, needsEmailConfirm: false, code, message: AUTH_ERROR_TEXT[code] };
    }
  }

  /** 登录：先按「记住我」设置持久化开关，再走密码登录 */
  async signIn(req: SignInRequest): Promise<AuthResult> {
    const email = req.email.trim();
    if (!EMAIL_PATTERN.test(email)) {
      return this.failure('INVALID_EMAIL');
    }
    const client = getSupabase();
    if (!client) {
      return this.failure('SERVICE_UNAVAILABLE');
    }
    // 「记住我」开关必须在登录**之前**设定：supabase 一旦登录成功会立刻通过
    // sessionStorage.setItem 保存 token，那时开关已经决定 token 落盘还是只留内存。
    // 但由此产生的副作用必须可回滚 —— 见下面两个失败出口。
    const previousPersistence = isPersistenceEnabled();
    setPersistence(req.remember);
    try {
      const { data, error } = await client.auth.signInWithPassword({
        email,
        password: req.password,
      });
      if (error || !data.user) {
        // 登录失败必须回滚开关：否则「不记住我」的开关残留，会污染下一次登录
        setPersistence(previousPersistence);
        const code = toAuthErrorCode(error);
        return { ok: false, state: this.state, code, message: AUTH_ERROR_TEXT[code] };
      }
      const user = data.user;
      // 仅在登录成功后清盘：失败必须无副作用，否则输错一次密码就会毁掉
      // 磁盘上另一个账号的免登录（开关此时已是 false，本次 token 只会进内存）。
      if (!req.remember) {
        await clearPersistedSession();
      }
      await this.deps.onAccountChanged(user.id);
      this.state = { state: 'authenticated', email: user.email ?? email, userId: user.id };
      return { ok: true, state: this.state };
    } catch (error) {
      // 同上：异常出口同样回滚开关，保证失败路径零副作用
      setPersistence(previousPersistence);
      const code = toAuthErrorCode(error);
      return { ok: false, state: this.state, code, message: AUTH_ERROR_TEXT[code] };
    }
  }

  /** 登出：只清登录态，**不清会话数据**（会话仍留在账号目录里） */
  async signOut(): Promise<AuthResult> {
    const client = getSupabase();
    if (client) {
      try {
        await client.auth.signOut();
      } catch {
        // 网络失败也要清本机登录态，否则用户被卡在已登录假象里
      }
    }
    await this.deps.onAccountChanged(null);
    this.state = { state: 'unauthenticated' };
    return { ok: true, state: this.state };
  }

  /**
   * 外部登出同步：当 supabase 在**本服务之外**结束了登录态（token 被撤销 / 刷新失败 /
   * 跨窗口 signOut）时，由 `onAuthStateChange` 回调触发，把主进程维护的账号态与存储分区
   * 一并对齐到「未登录」。
   *
   * 与 `signOut()` 的区别：**不再调用 supabase**（回调内已明确是外部变化，且回归调
   * supabase 会触发官方警告的死锁），只做本机状态收敛与存储分区切换。
   */
  async applyExternalSignOut(): Promise<void> {
    this.state = { state: 'unauthenticated' };
    await this.deps.onAccountChanged(null);
  }

  /** 忘记密码：发送重置邮件 */
  async resetPassword(req: ResetPasswordRequest): Promise<AuthResult> {
    const email = req.email.trim();
    if (!EMAIL_PATTERN.test(email)) {
      return this.failure('INVALID_EMAIL');
    }
    const client = getSupabase();
    if (!client) {
      return this.failure('SERVICE_UNAVAILABLE');
    }
    try {
      const { error } = await client.auth.resetPasswordForEmail(email);
      if (error) {
        return this.failure(toAuthErrorCode(error));
      }
      return { ok: true, state: this.state };
    } catch (error) {
      return this.failure(toAuthErrorCode(error));
    }
  }

  /**
   * 删除账号（P2）。
   *
   * 说明：真正的「服务端删除用户」需要 Supabase Edge Function / RPC（本设计批一
   * 完全不写云，未提供该端点）。此处只完成本机登出 + 清登录态，服务端删除留待
   * 后续批次接入；调用方需知晓当前语义为「本机退出该账号」。
   */
  async deleteAccount(): Promise<AuthResult> {
    const client = getSupabase();
    if (!client) {
      return this.failure('SERVICE_UNAVAILABLE');
    }
    try {
      await client.auth.signOut();
    } catch {
      // 同 signOut：网络失败也要清本机登录态
    }
    await this.deps.onAccountChanged(null);
    this.state = { state: 'unauthenticated' };
    return { ok: true, state: this.state };
  }

  /** 构造失败结果（保持当前登录态不变） */
  private failure(code: AuthErrorCode): AuthResult {
    return { ok: false, state: this.state, code, message: AUTH_ERROR_TEXT[code] };
  }
}

/** access token 是否临近过期（无 expires_at 时按「未过期」处理，不打网络） */
function isNearExpiry(expiresAt: number | undefined): boolean {
  if (typeof expiresAt !== 'number') {
    return false;
  }
  return expiresAt * 1000 - Date.now() < REFRESH_MARGIN_MS;
}
