/**
 * 应用根组件：账号门禁 + 三区布局骨架 + 初始化水合 + 流式事件接管 + 设置弹层挂载点 + 主题监听。
 *
 * 顶层 App 只做「登录态门禁」：未读取完成 → 启动态；未登录 → 登录页；已登录 → MainLayout。
 * 布局（左侧会话栏 / 顶栏 / 消息区 / 输入区）与聊天事件订阅全部下沉到 MainLayout，
 * 这样登出时 MainLayout 会整体卸载、登录后重新挂载 —— 水合自然按新账号分区重跑一次。
 *
 * 分隔线约定：纵向只保留左侧栏那条竖线（border-r），横向分割线（顶栏 / 输入区）
 * 一律不加 —— 板块边界靠底色与留白区分。
 */
import { useEffect, useRef } from 'react';
import { DEFAULT_THEME_MODE } from '../shared/types';
import Composer from './components/Composer';
import LoginScreen from './components/LoginScreen';
import MessageList from './components/MessageList';
import SettingsDialog from './components/SettingsDialog';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import {
  onAuthChanged,
  onChatChunk,
  onChatEnd,
  onChatError,
  onChatStep,
  onChatPlan,
  onOpenSettings,
} from './lib/api';
import { applyTheme, resolveTheme, watchSystemTheme } from './lib/theme';
import { isAuthed, useAppStore } from './store/useAppStore';

export default function App() {
  const authChecked = useAppStore((state) => state.authChecked);
  const authed = useAppStore((state) => isAuthed(state.auth));

  // 订阅主进程推送的登录态变化（token 刷新 / 被登出 / 跨窗口同步）；卸载时取消订阅。
  // 放在顶层而非 MainLayout：登录页阶段也要能收到「被登出」之外的态变化。
  useEffect(() => {
    return onAuthChanged((next) => {
      useAppStore.getState().applyAuthState(next);
    });
  }, []);

  // 系统深浅色切换：仅在偏好为「跟随系统」时响应，固定浅/深色时不受影响
  useEffect(() => {
    return watchSystemTheme(() => {
      const mode = useAppStore.getState().config?.ui?.theme ?? DEFAULT_THEME_MODE;
      if (mode === 'system') {
        applyTheme(resolveTheme('system'));
      }
    });
  }, []);

  // 启动态：main.tsx 已在挂载前 await initAuth，正常不会停留在此；作为兜底避免闪现错误界面
  if (!authChecked) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background text-[13px] text-muted">
        正在启动…
      </div>
    );
  }

  if (!authed) {
    return <LoginScreen />;
  }

  return <MainLayout />;
}

/**
 * 登录后的主界面：三区布局 + 水合 + 聊天事件订阅。
 * 作为独立组件，登出时随门禁分支卸载、登录后重新挂载，hydratedRef 随之重置，
 * 保证每次进入主界面都按当前账号分区重新水合一次。
 */
function MainLayout() {
  const settingsOpen = useAppStore((state) => state.settingsOpen);

  const hydratedRef = useRef(false);

  // 初始化水合：拉取配置与会话列表，并按 ui.lastConversationId 恢复上次会话
  useEffect(() => {
    if (hydratedRef.current) {
      return;
    }
    hydratedRef.current = true;
    void useAppStore.getState().hydrate();
  }, []);

  // 订阅主进程推送；卸载时逐个取消订阅
  useEffect(() => {
    const unsubscribeChunk = onChatChunk(({ requestId, delta }) => {
      useAppStore.getState().appendDelta(requestId, delta);
    });
    const unsubscribeEnd = onChatEnd(({ requestId, content, finishReason }) => {
      useAppStore.getState().finishStream(requestId, content, finishReason);
    });
    const unsubscribeError = onChatError(({ requestId, code, message }) => {
      useAppStore.getState().failStream(requestId, code, message);
    });
    const unsubscribeStep = onChatStep(({ requestId, step }) => {
      useAppStore.getState().upsertStep(requestId, step);
    });
    const unsubscribePlan = onChatPlan(({ requestId, plan }) => {
      useAppStore.getState().upsertPlan(requestId, plan);
    });
    const unsubscribeOpenSettings = onOpenSettings(() => {
      useAppStore.getState().setSettingsOpen(true);
    });

    return () => {
      unsubscribeChunk();
      unsubscribeEnd();
      unsubscribeError();
      unsubscribeStep();
      unsubscribePlan();
      unsubscribeOpenSettings();
    };
  }, []);

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-fg">
      {/* ① 左侧会话栏：固定 260px。这条竖线是保留的（用户明确要求） */}
      <aside className="w-[260px] shrink-0 border-r border-line">
        <Sidebar />
      </aside>

      {/* ② 右侧主区：顶栏 + 消息区 + 输入区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：固定 48px；不加下边线，与消息区靠留白区分 */}
        <header className="h-12 shrink-0 px-4">
          <TopBar />
        </header>

        {/* 消息区：占据剩余高度 */}
        <main className="min-h-0 flex-1 overflow-hidden">
          <MessageList />
        </main>

        {/* 输入区：不加下边线 */}
        <footer className="shrink-0 px-4 py-3">
          <Composer />
        </footer>
      </div>

      {/* ③ 设置弹层：常驻挂载，开合由 store.settingsOpen 控制 */}
      {settingsOpen ? <SettingsDialog /> : null}
    </div>
  );
}
