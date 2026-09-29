/**
 * electron-vite 环境变量的类型声明（主进程侧）。
 *
 * 前缀 `MAIN_VITE_` 由 electron-vite 约定暴露给主进程（`import.meta.env.MAIN_VITE_*`）。
 * 本文件为全局声明脚本（无 import / export），供 `src/main/**` 识别 `import.meta.env`。
 */
interface ImportMetaEnv {
  /** Supabase 项目 URL；未配置时为 undefined */
  readonly MAIN_VITE_SUPABASE_URL?: string;
  /** Supabase publishable key（可公开，受 RLS 约束）；未配置时为 undefined */
  readonly MAIN_VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
