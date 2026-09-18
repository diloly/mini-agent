/**
 * 左侧会话栏：会话列表 + 新建 / 删除。
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
    </div>
  );
}
