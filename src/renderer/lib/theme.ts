/**
 * 主题应用层：全仓唯一往 DOM 写主题的地方。
 *
 * 约定：
 * - 偏好（ThemeMode）持久化在 config.json，实际主题（ResolvedTheme）只作用于 DOM；
 * - class 与 data-theme 两个钩子同时维护：HeroUI 的样式两处都看，theme.css 的选择器也是；
 * - 只碰 class 与 data-theme，绝不动 index.html 上的 data-reduce-motion。
 */
import {
  DEFAULT_THEME_MODE,
  isThemeMode,
  type ResolvedTheme,
  type ThemeMode,
} from '../../shared/types';

/** 系统深色偏好的媒体查询 */
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/** 系统当前是否偏好深色 */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

/** 把偏好解析成实际主题 */
export function resolveTheme(mode: ThemeMode | undefined): ResolvedTheme {
  const effective = isThemeMode(mode) ? mode : DEFAULT_THEME_MODE;
  if (effective === 'system') {
    return systemPrefersDark() ? 'dark' : 'light';
  }
  return effective;
}

/** 把实际主题写到 html 上（逐键赋值，不会冲掉 data-reduce-motion） */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  const isDark = theme === 'dark';
  root.classList.toggle('dark', isDark);
  root.classList.toggle('light', !isDark);
  root.dataset.theme = theme;
}

/** 订阅系统深浅色切换；返回取消订阅函数 */
export function watchSystemTheme(listener: () => void): () => void {
  const query = window.matchMedia(SYSTEM_DARK_QUERY);
  const handler = (): void => listener();
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
