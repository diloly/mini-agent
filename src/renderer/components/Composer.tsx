/**
 * 输入区：多行输入框 + 发送 / 停止。
 *
 * 交互约定：
 * - Enter 发送，Shift + Enter 换行；输入法组合态下不触发发送
 * - 生成中按钮切换为「停止」
 * - 没有当前会话时先自动新建，再发送
 */
import { Button, TextArea } from '@heroui/react';
import { useState, type KeyboardEvent } from 'react';
import { useAppStore, isProviderConfigured } from '../store/useAppStore';

export default function Composer() {
  const [draft, setDraft] = useState('');
  const loading = useAppStore((state) => state.loading);
  const config = useAppStore((state) => state.config);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const createConversation = useAppStore((state) => state.createConversation);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const abortActive = useAppStore((state) => state.abortActive);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);

  const configured = isProviderConfigured(config);
  const canSend = draft.trim().length > 0 && !loading;

  /** 发送；无当前会话时先补一个 */
  async function handleSend(): Promise<void> {
    const text = draft.trim();
    if (!text || loading) {
      return;
    }
    if (!activeConversationId) {
      await createConversation();
    }
    if (!useAppStore.getState().activeConversationId) {
      return;
    }
    setDraft('');
    await sendMessage(text);
  }

  /** Enter 发送 / Shift + Enter 换行；组合态（中文输入法）不拦截 */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    if (event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (canSend) {
      void handleSend();
    }
  }

  return (
    <div className="mx-auto w-full max-w-[720px]" onKeyDown={handleKeyDown}>
      {!configured ? (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-[8px] border border-line bg-surface-secondary px-3 py-2">
          <span className="text-[12px] text-muted">尚未完成模型配置，发送前请先到设置中填写</span>
          <Button size="sm" variant="secondary" onPress={() => setSettingsOpen(true)}>
            去设置
          </Button>
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <TextArea
          className="min-h-[64px] flex-1 resize-none"
          variant="secondary"
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={loading ? '生成中…' : '输入消息，Enter 发送，Shift + Enter 换行'}
        />
        {loading ? (
          <Button variant="secondary" onPress={() => void abortActive()}>
            停止
          </Button>
        ) : (
          <Button variant="primary" isDisabled={!canSend} onPress={() => void handleSend()}>
            发送
          </Button>
        )}
      </div>

      <p className="mt-2 text-[12px] text-muted">内容仅保存在本机，不会上传到任何第三方</p>
    </div>
  );
}
