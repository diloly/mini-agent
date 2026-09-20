/**
 * 应用根组件：三区布局骨架 + 初始化水合 + 流式事件接管 + 设置弹层挂载点。
 *
 * 布局：左侧会话栏（固定 260px）+ 右侧主区（顶栏 48px / 消息区自适应 / 输入区）。
 * 本文件只负责编排，具体交互都下沉到 components 下的各个组件。
 */
import { useEffect, useRef } from 'react';
import Composer from './components/Composer';
import MessageList from './components/MessageList';
import SettingsDialog from './components/SettingsDialog';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import { onChatChunk, onChatEnd, onChatError, onChatStep, onOpenSettings } from './lib/api';
import { useAppStore } from './store/useAppStore';

export default function App() {
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
    const unsubscribeOpenSettings = onOpenSettings(() => {
      useAppStore.getState().setSettingsOpen(true);
    });

    return () => {
      unsubscribeChunk();
      unsubscribeEnd();
      unsubscribeError();
      unsubscribeStep();
      unsubscribeOpenSettings();
    };
  }, []);

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-fg">
      {/* ① 左侧会话栏：固定 260px */}
      <aside className="w-[260px] shrink-0 border-r border-line">
        <Sidebar />
      </aside>

      {/* ② 右侧主区：顶栏 + 消息区 + 输入区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：固定 48px */}
        <header className="h-12 shrink-0 border-b border-line px-4">
          <TopBar />
        </header>

        {/* 消息区：占据剩余高度 */}
        <main className="min-h-0 flex-1 overflow-hidden">
          <MessageList />
        </main>

        {/* 输入区 */}
        <footer className="shrink-0 border-t border-line px-4 py-3">
          <Composer />
        </footer>
      </div>

      {/* ③ 设置弹层：常驻挂载，开合由 store.settingsOpen 控制 */}
      {settingsOpen ? <SettingsDialog /> : null}
    </div>
  );
}
