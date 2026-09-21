/**
 * 输入区：模型选择器 + 多行输入框 + 发送 / 停止。
 *
 * 交互约定：
 * - Enter 发送，Shift + Enter 换行；输入法组合态下不触发发送
 * - 生成中按钮切换为「停止」
 * - 没有当前会话时先自动新建，再发送
 *
 * 外观：外层 .composer-box 统一负责卡片边框；内层输入框与底部工具条共享同一张卡片。
 * 边框与主按钮都不使用强调色 —— 聚焦不变色（由 theme.css ①′ 段兜底），
 * 主按钮走「前景色底 + 背景色图标」，随浅色 / 深色主题自然反转。
 */
import { Button, TextArea } from '@heroui/react';
import { useState, type KeyboardEvent } from 'react';
import ModelPicker from './ModelPicker';
import WorkspacePicker from './WorkspacePicker';
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

  /**
   * Enter 发送 / Shift + Enter 换行；组合态（中文输入法）不拦截。
   *
   * 必须限定「事件源是输入框」：本处理器挂在外层容器上，而底部工具条（模型选择、发送按钮）
   * 同样在容器内，若不判断 target，在模型下拉里按 Enter 选模型会顺带把草稿发出去。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if ((event.target as HTMLElement).tagName !== 'TEXTAREA') {
      return;
    }
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

      {/* 输入卡片：边框恒定，聚焦不变色 */}
      <div className="composer-box flex flex-col rounded-[12px] border border-line bg-surface">
        <TextArea
          className="min-h-[56px] w-full resize-none px-3 pt-3 pb-1 text-[13px]"
          variant="secondary"
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={loading ? '生成中…' : '输入消息，Enter 发送，Shift + Enter 换行'}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1">
            <WorkspacePicker />
            <ModelPicker />
          </div>
          {loading ? (
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-fg text-background"
              onClick={() => void abortActive()}
              aria-label="停止生成"
              title="停止生成"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                <rect x="7" y="7" width="10" height="10" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-fg text-background disabled:cursor-not-allowed disabled:bg-surface-secondary disabled:text-muted"
              disabled={!canSend}
              onClick={() => void handleSend()}
              aria-label="发送"
              title="发送"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
              >
                <path d="M12 19V5" />
                <path d="M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <p className="mt-2 text-center text-[12px] text-muted">内容仅保存在本机，不会上传到任何第三方</p>
    </div>
  );
}
