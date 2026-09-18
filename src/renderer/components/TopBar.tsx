/**
 * 顶栏：当前会话标题 / 模型信息 / 生成中指示 / 停止 / 设置入口。
 */
import { Button } from '@heroui/react';
import { PROVIDER_LABELS } from '../../shared/types';
import { useAppStore } from '../store/useAppStore';

export default function TopBar() {
  const conversations = useAppStore((state) => state.conversations);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const config = useAppStore((state) => state.config);
  const loading = useAppStore((state) => state.loading);
  const abortActive = useAppStore((state) => state.abortActive);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);

  const current = conversations.find((item) => item.id === activeConversationId);
  const providerLabel = config ? PROVIDER_LABELS[config.activeProviderId] : '';
  const model = config
    ? config.providers[config.activeProviderId].model
    : '';

  return (
    <div className="flex h-full w-full items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-fg">
          {current ? current.title : '暂无会话'}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span className="text-[12px] text-muted">
          {providerLabel}
          {model ? ` · ${model}` : ' · 未选择模型'}
        </span>

        {loading ? (
          <>
            <span className="text-[12px] text-muted">生成中…</span>
            <Button size="sm" variant="secondary" onPress={() => void abortActive()}>
              停止
            </Button>
          </>
        ) : null}

        <Button size="sm" variant="ghost" onPress={() => setSettingsOpen(true)}>
          设置
        </Button>
      </div>
    </div>
  );
}
