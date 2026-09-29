/**
 * supabase 错误 → AuthErrorCode 映射。
 *
 * 不把 supabase 英文原文透给用户：只按 message 子串 + HTTP status 归类，
 * 文案统一由 shared/types.ts 的 AUTH_ERROR_TEXT 提供。
 */
import type { AuthErrorCode } from '../../shared/types';

/** 把 supabase 错误（message + status）映射为 AuthErrorCode；未知一律 UNKNOWN */
export function toAuthErrorCode(error: unknown): AuthErrorCode {
  const raw = error as { message?: string; status?: number } | null;
  const msg = (raw?.message ?? '').toLowerCase();
  const status = raw?.status ?? 0;
  if (msg.includes('invalid login credentials')) {
    return 'INVALID_CREDENTIALS';
  }
  if (msg.includes('email not confirmed')) {
    return 'EMAIL_NOT_CONFIRMED';
  }
  if (msg.includes('already registered') || msg.includes('already been registered')) {
    return 'EMAIL_ALREADY_REGISTERED';
  }
  if (msg.includes('password should be at least') || msg.includes('weak password')) {
    return 'WEAK_PASSWORD';
  }
  if (msg.includes('unable to validate email') || msg.includes('invalid email')) {
    return 'INVALID_EMAIL';
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many')) {
    return 'RATE_LIMIT';
  }
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('timeout')) {
    return 'NETWORK';
  }
  return 'UNKNOWN';
}
