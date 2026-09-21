/**
 * 左侧会话栏：会话列表 + 新建 / 删除 + 底部账户占位与设置入口。
 *
 * 只读取 store，不直接触碰 IPC；所有数据变更都走 store action。
 */
import { Button } from '@heroui/react';
import { useAppStore } from '../store/useAppStore';

export default function Sidebar() {
  const conversations = useAppStore((state) => state.conversations);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const createConversation = useAppStore((state) => state.createConversation);
  const removeConversation = useAppStore((state) => state.removeConversation);
  const selectConversation = useAppStore((state) => state.selectConversation);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);

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

      {/* 底部：账户占位 + 设置入口（后续账户登录落在这里） */}
      <div className="shrink-0 px-2 py-2">
        <button
          type="button"
          className="flex w-full cursor-default items-center gap-2 rounded-[8px] px-2 py-2 text-left"
          title="账户登录功能后续接入"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-[11px] text-muted">
            客
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted">未登录</span>
          <span className="shrink-0 text-[11px] text-muted">待接入</span>
        </button>

        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2 py-2 text-left hover:bg-surface-secondary"
          onClick={() => setSettingsOpen(true)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 shrink-0 text-muted"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="text-[13px] text-fg">设置</span>
        </button>
      </div>
    </div>
  );
}
