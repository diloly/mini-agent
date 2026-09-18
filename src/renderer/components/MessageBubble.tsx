/**
 * 单条消息气泡。
 *
 * - 用户消息：右对齐纯文本（不渲染 Markdown，避免把用户输入当富文本解释）
 * - 助手消息：左对齐，走 react-markdown + remark-gfm + rehype-highlight，
 *   全程不使用 dangerouslySetInnerHTML
 * - 错误态：在气泡下方追加 Alert，按 ERROR_RETRYABLE 决定是否给「重试」入口
 */
import { Alert, Button } from '@heroui/react';
import type { MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { ERROR_RETRYABLE, ERROR_TEXT, type Message } from '../../shared/types';
import { openExternal } from '../lib/api';

/** 气泡属性 */
export interface MessageBubbleProps {
  message: Message;
  /** 该条消息是否正在流式输出 */
  streaming: boolean;
  /** 重试入口；未提供则不渲染重试按钮 */
  onRetry?: () => void;
  /** 打开设置弹层 */
  onOpenSettings: () => void;
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

export default function MessageBubble(props: MessageBubbleProps) {
  const { message, streaming, onRetry, onOpenSettings } = props;
  const isUser = message.role === 'user';
  const content = message.content;
  const errorCode = message.meta?.errorCode;
  const aborted = message.meta?.finishReason === 'aborted';

  return (
    <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`${isUser ? 'max-w-[80%] rounded-[8px] bg-surface-selected px-3 py-2' : 'w-full'}`}>
        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-[13px] text-fg">{content}</p>
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
    </div>
  );
}
