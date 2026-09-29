/**
 * Supabase 客户端单例（仅主进程持有）。
 *
 * 关键纪律：
 * - `createClient` 只调一次：库自身持有 auth 状态与自动刷新定时器，
 *   多实例会导致刷新竞争与状态分裂。
 * - URL / publishable key 经 electron-vite 注入（`import.meta.env.MAIN_VITE_*`）；
 *   缺失时返回 null，上层短路为 `SERVICE_UNAVAILABLE`，绝不崩溃。
 * - 只允许 publishable key；任何高权限密钥永不进仓库与安装包。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sessionStorage } from './session-store';

/** 进程级单例；只在首次成功创建时赋值一次 */
let client: SupabaseClient | null = null;

/** 读取 Supabase 环境变量（electron-vite 注入；缺失时为 undefined） */
export function readSupabaseEnv(): { url?: string; key?: string } {
  return {
    url: import.meta.env.MAIN_VITE_SUPABASE_URL,
    key: import.meta.env.MAIN_VITE_SUPABASE_PUBLISHABLE_KEY,
  };
}

/** 是否已配置登录服务（URL 与 key 都存在） */
export function isAuthConfigured(): boolean {
  const { url, key } = readSupabaseEnv();
  return Boolean(url && key);
}

/**
 * 获取 Supabase 客户端单例；未配置环境变量时返回 null。
 *
 * `auth.storage` 使用自定义适配器（safeStorage 加密落盘），
 * 不落 localStorage（渲染层也没有）；`detectSessionInUrl:false` 是桌面端必须——
 * 否则 PKCE 隐式流会在无 URL 场景下误触发。
 */
export function getSupabase(): SupabaseClient | null {
  if (client) {
    return client;
  }
  const { url, key } = readSupabaseEnv();
  if (!url || !key) {
    return null;
  }
  client = createClient(url, key, {
    auth: {
      storage: sessionStorage,
      storageKey: 'mini-agent-auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
  });
  return client;
}
