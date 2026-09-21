/**
 * 单条消息气泡。
 *
 * - 用户消息：右对齐纯文本（不渲染 Markdown，避免把用户输入当富文本解释），
 *   支持「修改」（改完交给上层截断并重新生成）与「复制」
 * - 助手消息：左对齐，走 react-markdown + remark-gfm + rehype-highlight，
 *   全程不使用 dangerouslySetInnerHTML，支持「复制」
 * - 错误态：在气泡下方追加 Alert，按 ERROR_RETRYABLE 决定是否给「重试」入口
 *
 * 操作按钮：用户消息的按钮挂在气泡**下方**（右对齐，跟着气泡右边缘）——
 * 塞进气泡会挤压正文，挂在左侧又离正文太远；助手消息没有气泡容器，
 * 操作行同样落在正文下方即可。两者都用图标而非文字。
 *
 * 横向溢出：工具步骤行渲染的是 `${name}(${args})`，args 是紧凑 JSON，可能很长
 * 且不含空格。flex 子项默认 min-width: auto 不会收缩，会把行撑宽、进而顶出
 * 横向滚动条。故这里逐层加 min-w-0，并让参数文本 break-all 换行。
 */
import { Alert, Button } from '@heroui/react';
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { ERROR_RETRYABLE, ERROR_TEXT, type Message, type ToolStep, type ToolStepStatus } from '../../shared/types';
import { openExternal } from '../lib/api';

/** 工具步骤状态对应的纯文字图标（不引入图片资源，保持简约） */
const STEP_ICON: Record<ToolStepStatus, string> = {
  running: '◐',
  done: '✓',
  error: '✕',
};

/** 复制结果反馈的展示时长（毫秒） */
const COPY_FEEDBACK_MS = 1500;

/**
 * 操作图标按钮的统一样式：无边框无底色，hover 出浅底。
 * 刻意不含文字颜色 —— 复制失败时需要换成 text-danger，若这里也写死 text-muted，
 * 两者是特异性相同的工具类，谁生效取决于生成顺序（不稳定）。颜色一律由调用处给出。
 */
const ACTION_BUTTON_CLASS =
  'flex h-6 w-6 cursor-pointer items-center justify-center rounded-[4px] hover:bg-surface-secondary hover:text-fg';

/**
 * 操作行的显隐控制：默认隐形，鼠标移入整条消息或键盘聚焦时显形。
 * 用 pointer-events 同步切换，避免透明状态下误点到看不见的按钮。
 */
const ACTION_ROW_VISIBILITY =
  'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-events-none group-hover:pointer-events-auto focus-within:pointer-events-auto';

/**
 * 操作按钮图标：统一 24 视图盒、1.75 描边、颜色随 currentColor。
 * 手绘 SVG 而不引图标库 —— 只需要 3 个形状，装一个依赖不划算。
 */
function ActionIcon({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 气泡属性 */
export interface MessageBubbleProps {
  message: Message;
  /** 该条消息是否正在流式输出 */
  streaming: boolean;
  /** 重试入口；未提供则不渲染重试按钮 */
  onRetry?: () => void;
  /** 打开设置弹层 */
  onOpenSettings: () => void;
  /**
   * 修改这条用户消息并重新生成。未提供时不渲染「修改」入口
   * （生成中由调用方传 undefined 来禁止编辑，避免与进行中的流冲突）。
   */
  onEdit?: (messageId: string, content: string) => void;
}

/**
 * 处理 Markdown 里的链接点击：一律拦下默认跳转（否则会把整个窗口导航到外站），
 * 改为交给系统默认浏览器打开；非 http/https 会被主进程拒绝。
 */
function handleMarkdownClick(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement | null;
  const anchor = target ? target.closest('a') : null;
  if (!anchor) {
    return;
  }
  event.preventDefault();
  const href = anchor.getAttribute('href') ?? '';
  if (href.length === 0) {
    return;
  }
  void openExternal(href).catch(() => undefined);
}

/**
 * 复制文本到系统剪贴板。
 * 直接走 Web 的 navigator.clipboard：Electron 渲染进程的 localhost / file://
 * 都属于安全上下文，无需为此新增一条 IPC 通道。
 * @returns 是否复制成功（失败时界面给出可见反馈，不静默）
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function MessageBubble(props: MessageBubbleProps) {
  const { message, streaming, onRetry, onOpenSettings, onEdit } = props;
  const isUser = message.role === 'user';
  const content = message.content;
  const errorCode = message.meta?.errorCode;
  const aborted = message.meta?.finishReason === 'aborted';
  // 工具步骤统一从 message.meta.steps 读取（流式期间也由 upsertStep 写入），无需新增 prop
  const steps = message.meta?.steps;
  const visibleSteps: ToolStep[] = !isUser && Array.isArray(steps) ? steps : [];

  // 编辑态：仅有用户消息会进入
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  // 复制按钮的瞬时反馈：idle / done / failed
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');

  /** 复制正文到剪贴板，并在按钮上短暂反馈结果 */
  async function handleCopy(): Promise<void> {
    const ok = await writeClipboard(content);
    setCopyState(ok ? 'done' : 'failed');
    window.setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS);
  }

  /** 进入编辑态：把当前正文灌进草稿 */
  function startEdit(): void {
    setEditDraft(content);
    setEditing(true);
  }

  /** 提交编辑：交给上层截断并重新生成 */
  function submitEdit(): void {
    const next = editDraft.trim();
    if (!next || !onEdit) {
      return;
    }
    setEditing(false);
    onEdit(message.id, next);
  }

  /** Esc 退出编辑（不保存） */
  function handleEditKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
    }
  }

  /* 操作按钮的可见条件：有正文、且不在编辑态。
     提成独立变量，是为了让「挂载按钮的外层容器」也复用同一条件 ——
     否则编辑态下会留下一个空容器，被 flex 的 gap 撑出一段多余空白。 */
  const showActions = content.length > 0 && !editing;

  /* 操作按钮组：用户消息渲染在气泡下方，助手消息渲染在正文下方。
     图标而非文字 —— 图标语义足够明确，且不打扰阅读（用户要求）。 */
  const actionButtons = showActions ? (
      <>
        {isUser && onEdit ? (
          <button
            type="button"
            className={`${ACTION_BUTTON_CLASS} text-muted`}
            onClick={startEdit}
            aria-label="修改"
            title="修改"
          >
            {/* 铅笔 */}
            <ActionIcon>
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </ActionIcon>
          </button>
        ) : null}
        <button
          type="button"
          className={`${ACTION_BUTTON_CLASS} ${copyState === 'failed' ? 'text-danger' : 'text-muted'}`}
          onClick={() => void handleCopy()}
          aria-label={copyState === 'done' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}
          title={copyState === 'done' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}
        >
          {/* 复制成功 → 对勾；失败 → 叉；常态 → 两层方块 */}
          {copyState === 'done' ? (
            <ActionIcon>
              <path d="M20 6L9 17l-5-5" />
            </ActionIcon>
          ) : copyState === 'failed' ? (
            <ActionIcon>
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </ActionIcon>
          ) : (
            <ActionIcon>
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </ActionIcon>
          )}
        </button>
      </>
    ) : null;

  return (
    /* 纵向排列：用户消息是「气泡 + 下方操作行」，助手消息是「正文 + 下方操作行」，
       两者结构一致，操作行都落在内容下方。用户侧用 items-end 保持气泡右对齐
       （交叉轴对齐，纵向主轴上 gap-1.5 给气泡与操作行之间留 6px）。 */
    <div className={`group flex w-full flex-col ${isUser ? 'items-end gap-1.5' : ''}`}>
      <div className={`${isUser ? 'max-w-[80%] rounded-[8px] bg-surface-selected px-3 py-2' : 'w-full'}`}>
        {visibleSteps.length > 0 ? (
          <div className="mb-2 flex min-w-0 flex-col gap-1 border-l-2 border-line pl-2">
            {visibleSteps.map((step) => (
              <div
                key={step.id}
                className={`flex min-w-0 items-center gap-1.5 text-[12px] font-mono ${step.status === 'error' ? 'text-danger' : 'text-muted'}`}
                title={step.result}
              >
                <span className="shrink-0">{STEP_ICON[step.status]}</span>
                <span className="min-w-0 break-all">
                  {`${step.name}(${step.args})`}
                  {step.status === 'done' && step.elapsedMs != null ? ` · ${step.elapsedMs}ms` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {isUser ? (
          editing ? (
            /* 编辑态：边框恒定、聚焦不变色，与输入区保持同一套视觉语言 */
            <div className="flex w-full flex-col gap-2">
              <textarea
                className="w-full resize-none bg-transparent p-0 text-[13px] leading-[1.6] text-fg outline-none"
                value={editDraft}
                rows={2}
                autoFocus
                onChange={(event) => setEditDraft(event.target.value)}
                onKeyDown={handleEditKeyDown}
              />
              {/* 提示与按钮同一行：左侧说明这次编辑的后果，右侧是操作按钮 */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted">编辑后将从此处重新开始对话</span>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className="cursor-pointer rounded-[6px] px-2 py-1 text-[12px] text-muted hover:text-fg"
                    onClick={() => setEditing(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer rounded-[6px] bg-fg px-2 py-1 text-[12px] text-background disabled:cursor-not-allowed disabled:bg-surface-secondary disabled:text-muted"
                    disabled={editDraft.trim().length === 0}
                    onClick={submitEdit}
                  >
                    发送
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap break-words text-[13px] text-fg">{content}</p>
          )
        ) : content.length > 0 ? (
          <div className="markdown-body break-words" onClick={handleMarkdownClick}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {content}
            </ReactMarkdown>
            {streaming ? (
              <span className="ml-[2px] inline-block h-[13px] w-[6px] translate-y-[1px] bg-muted" />
            ) : null}
          </div>
        ) : streaming ? (
          <p className="text-[13px] text-muted">思考中…</p>
        ) : (
          <p className="text-[13px] text-muted">（本轮没有返回内容）</p>
        )}

        {aborted && content.length > 0 ? (
          <p className="mt-1 text-[12px] text-muted">已停止生成</p>
        ) : null}

        {!isUser && showActions ? (
          <div className={`mt-1.5 flex items-center gap-1 ${ACTION_ROW_VISIBILITY}`}>
            {actionButtons}
          </div>
        ) : null}

        {errorCode ? (
          <Alert status="danger" className="mt-2 flex items-start gap-2">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>
                {message.meta?.errorText ? message.meta.errorText : ERROR_TEXT[errorCode]}
              </Alert.Title>
              <Alert.Description>
                {errorCode === 'NOT_CONFIGURED' ? '完成配置后即可继续对话。' : '可以稍后重试这一轮。'}
              </Alert.Description>
            </Alert.Content>
            <div className="flex shrink-0 items-center gap-2">
              {errorCode === 'NOT_CONFIGURED' ? (
                <Button size="sm" variant="secondary" onPress={onOpenSettings}>
                  去设置
                </Button>
              ) : null}
              {ERROR_RETRYABLE[errorCode] && onRetry ? (
                <Button size="sm" variant="secondary" onPress={() => onRetry()}>
                  重试
                </Button>
              ) : null}
            </div>
          </Alert>
        ) : null}
      </div>
      {isUser && showActions ? (
        <div className={`flex items-center gap-1 ${ACTION_ROW_VISIBILITY}`}>
          {actionButtons}
        </div>
      ) : null}
    </div>
  );
}
