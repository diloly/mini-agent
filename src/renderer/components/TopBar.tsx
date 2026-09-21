/**
 * 顶栏：当前会话标题 / 生成中指示 / 停止。
 *
 * 模型信息与设置入口已迁走：模型选择移入输入区（ModelPicker），设置入口移入左侧栏底部。
 */
import { Button } from '@heroui/react';
import { useAppStore } from '../store/useAppStore';

export default function TopBar() {
  const conversations = useAppStore((state) => state.conversations);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const loading = useAppStore((state) => state.loading);
  const abortActive = useAppStore((state) => state.abortActive);

  const current = conversations.find((item) => item.id === activeConversationId);

  return (
    <div className="flex h-full w-full items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-fg">
          {current ? current.title : '暂无会话'}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {loading ? (
          <>
            <span className="text-[12px] text-muted">生成中…</span>
            <Button size="sm" variant="secondary" onPress={() => void abortActive()}>
              停止
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
