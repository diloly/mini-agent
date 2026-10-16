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
import { attachFiles } from '../lib/api';
import type { MessageAttachment } from '../../shared/types';

/** 人类可读体积（附件 chip 展示用） */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export default function Composer() {
  const [draft, setDraft] = useState('');
  // 待发送的附件（已由主进程复制进工作区，只带 name / path / size 元数据）
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const loading = useAppStore((state) => state.loading);
  const config = useAppStore((state) => state.config);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const activeWorkspaceRoot = useAppStore((state) => state.activeWorkspaceRoot);
  const createConversation = useAppStore((state) => state.createConversation);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const abortActive = useAppStore((state) => state.abortActive);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);

  const configured = isProviderConfigured(config);
  // 会话可绑定自己的工作区；未绑定时回退默认工作区（PublicConfig 里必填）
  const uploadRoot = activeWorkspaceRoot ?? config?.defaultWorkspaceRoot ?? '';
  const canSend = (draft.trim().length > 0 || attachments.length > 0) && !loading;

  /** 发送；无当前会话时先补一个 */
  async function handleSend(): Promise<void> {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || loading) {
      return;
    }
    if (!activeConversationId) {
      await createConversation();
    }
    if (!useAppStore.getState().activeConversationId) {
      return;
    }
    setDraft('');
    setAttachments([]);
    await sendMessage(text, undefined, attachments);
  }

  /** 选文件并复制进工作区；结果以 chip 形式挂在输入区上方，取消选择时不作任何变更 */
  async function handleAttach(): Promise<void> {
    if (attaching || loading) {
      return;
    }
    if (uploadRoot.length === 0) {
      setAttachError('工作区尚未就绪，请稍候再试');
      return;
    }
    setAttaching(true);
    setAttachError(null);
    try {
      const result = await attachFiles(uploadRoot);
      // 用户取消对话框：什么都不做（主进程也未复制任何文件）
      if (result.canceled) {
        return;
      }
      if (result.files.length > 0) {
        setAttachments((prev) => [...prev, ...result.files]);
      }
      // 部分文件太大 / 复制失败：成功的那部分照常入列，失败原因显式告知
      setAttachError(result.error ?? null);
    } catch {
      setAttachError('选择文件失败，请重试');
    } finally {
      setAttaching(false);
    }
  }

  /** 移除一个待发送附件（只影响待发列表，工作区里已复制的文件不删） */
  function removeAttachment(index: number): void {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
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
    <div className="mx-auto w-full max-w-[720px] xl:max-w-[960px] 2xl:max-w-[1120px]" onKeyDown={handleKeyDown}>
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
        {/* 待发送附件 chip：可逐个移除；文件本体已在工作区 uploads/ 下 */}
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.map((file, index) => (
              <span
                key={`${file.path}-${index}`}
                className="flex min-w-0 max-w-full items-center gap-1.5 rounded-[6px] border border-line bg-surface-secondary px-2 py-1 text-[12px] text-muted"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                <span className="min-w-0 truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  className="shrink-0 cursor-pointer text-muted hover:text-fg"
                  onClick={() => removeAttachment(index)}
                  aria-label={`移除附件 ${file.name}`}
                  title="移除"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    className="h-3 w-3"
                    aria-hidden="true"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {attachError ? <p className="px-3 pt-2 text-[12px] text-danger">{attachError}</p> : null}
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
            {/* 上传文件：主进程弹系统文件框并复制进工作区，结果以 chip 挂在输入区上方 */}
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-surface-secondary hover:text-fg disabled:cursor-not-allowed disabled:text-muted"
              disabled={attaching || loading}
              onClick={() => void handleAttach()}
              aria-label="上传文件"
              title="上传文件"
            >
              {attaching ? (
                <span className="text-[12px]">…</span>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              )}
            </button>
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
