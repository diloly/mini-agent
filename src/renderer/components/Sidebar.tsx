/**
 * 左侧会话栏：会话列表 + 新建 / 删除 + 底部账号入口与设置入口（合并为同一行）。
 *
 * 只读取 store，不直接触碰 IPC；所有数据变更都走 store action。
 * 账号菜单用本地 state + 绝对定位浮层实现（浮层相对底部容器向上弹），
 * 点击浮层外部即关闭；颜色只用语义类。
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { useAppStore } from '../store/useAppStore';

export default function Sidebar() {
  const conversations = useAppStore((state) => state.conversations);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const createConversation = useAppStore((state) => state.createConversation);
  const removeConversation = useAppStore((state) => state.removeConversation);
  const selectConversation = useAppStore((state) => state.selectConversation);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const auth = useAppStore((state) => state.auth);
  const signOut = useAppStore((state) => state.signOut);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const email = auth?.email ?? '已登录';
  const initial = email.slice(0, 1).toUpperCase();

  // 点击浮层外部关闭菜单；菜单关闭时不挂监听
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function handleDocumentMouseDown(event: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [menuOpen]);

  return (
    <div className="flex h-full w-full flex-col bg-background-secondary">
      {/* 顶部：标题 + 新建 */}
      <div className="flex h-12 shrink-0 items-center justify-between px-3">
        <span className="text-[13px] text-muted">会话（{conversations.length}）</span>
        <Button size="sm" variant="ghost" onPress={() => void createConversation()}>
          ＋ 新建
        </Button>
      </div>

      {/* 列表：选中项用 surface-selected，悬停用 surface-secondary */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-3 text-[13px] text-muted">还没有会话</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {conversations.map((item) => {
              const selected = item.id === activeConversationId;
              return (
                <li key={item.id}>
                  <div
                    className={[
                      'flex items-center gap-1 rounded-[8px] px-2 py-2',
                      selected ? 'bg-surface-selected' : 'hover:bg-surface-secondary',
                    ].join(' ')}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 cursor-pointer text-left"
                      onClick={() => void selectConversation(item.id)}
                    >
                      <span className="block truncate text-[13px] text-fg">{item.title}</span>
                      <span className="block truncate text-[12px] text-muted">
                        {item.model ? item.model : '未选择模型'} · {item.messageCount} 条
                      </span>
                    </button>
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer rounded-[6px] px-1 text-[12px] text-muted hover:text-fg"
                      onClick={() => void removeConversation(item.id)}
                    >
                      删除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 底部：账号入口 + 设置入口，合并为同一行（设置按钮在账号占位右侧） */}
      <div className="relative shrink-0 px-2 py-2" ref={menuRef}>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[8px] px-2 py-2 text-left hover:bg-surface-secondary"
            title={email}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-[11px] text-muted">
              {initial}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{email}</span>
          </button>

          <button
            type="button"
            className="shrink-0 cursor-pointer rounded-[8px] p-2 text-muted hover:bg-surface-secondary hover:text-fg"
            title="设置"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 shrink-0"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>

        {/* left-2 不能省：绝对定位的包含块是父级 padding edge（不含 px-2 的 8px），
            left-0 会让浮层贴到侧栏最左边缘，与账号按钮左边缘错开 8px。 */}
        {menuOpen ? (
          <div className="absolute bottom-full left-2 z-10 mb-1 w-[200px] rounded-[8px] border border-line bg-overlay p-1 shadow-none">
            <div className="px-2 py-2">
              <p className="truncate text-[12px] text-fg">{email}</p>
              <p className="mt-0.5 text-[11px] text-muted">已登录</p>
            </div>
            <button
              type="button"
              className="block w-full cursor-pointer rounded-[6px] px-2 py-1.5 text-left text-[12px] text-fg hover:bg-surface-secondary"
              onClick={() => {
                setMenuOpen(false);
                setSettingsOpen(true);
              }}
            >
              账号设置
            </button>
            <button
              type="button"
              className="block w-full cursor-pointer rounded-[6px] px-2 py-1.5 text-left text-[12px] text-danger hover:bg-surface-secondary"
              onClick={() => {
                setMenuOpen(false);
                void signOut();
              }}
            >
              退出登录
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
