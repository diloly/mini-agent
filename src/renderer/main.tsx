// React 入口：全工程唯一 import './index.css' 的位置。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useAppStore } from './store/useAppStore';
import './index.css';

/**
 * 先定主题、取登录态，再挂载 React。
 * index.html 里的静态 class="light" 只是占位；若等 React 起来、hydrate 回来再切主题，
 * 首帧会先铺浅色再翻成深色，视觉上闪一下。
 * body 不设背景色，空白期透出的是窗口自身的 backgroundColor（主进程已按主题设好）。
 *
 * 登录态与主题并行取：两者互不依赖，串行会白白拉长首帧；
 * initAuth 完成后 authChecked 为真，App 才能一次性决定显示登录页还是主界面（避免闪一下）。
 *
 * 注：#root 的查找与判空放在本函数内（而非模块顶层），使 container 的窄化发生在同一函数体内，
 * 不依赖「闭包中保留窄化」（对提升的函数声明不总是成立），无 tsc 反馈时更稳。
 */
async function bootstrap(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('未找到 #root 挂载节点');
  }
  await Promise.all([useAppStore.getState().initTheme(), useAppStore.getState().initAuth()]);
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
