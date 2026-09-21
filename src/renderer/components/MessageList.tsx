/**
 * 消息区：空态 / 未配置态 / 错误横幅 / 消息列表 + 自动滚底。
 *
 * 状态优先级：
 *   1. messages 为空且未配置 → 未配置态（给出「去设置」入口）
 *   2. messages 为空且已配置 → 空态
 *   3. 其余 → 消息列表；单条消息的错误由 MessageBubble 自己渲染
 * 全局 error 只在没有消息级错误时才升格为顶部横幅，避免同一句话出现两次。
 */
import { Alert, Button } from '@heroui/react';
import { useEffect, useMemo, useRef } from 'react';
import MessageBubble from './MessageBubble';
import { useAppStore, isProviderConfigured } from '../store/useAppStore';

export default function MessageList() {
  const messages = useAppStore((state) => state.messages);
  const error = useAppStore((state) => state.error);
  const activeRequestId = useAppStore((state) => state.activeRequestId);
  const streams = useAppStore((state) => state.streams);
  const config = useAppStore((state) => state.config);
  // 生成中禁止编辑：编辑会截断并重发，与进行中的流互斥
  const loading = useAppStore((state) => state.loading);
  const setError = useAppStore((state) => state.setError);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const sendMessage = useAppStore((state) => state.sendMessage);

  const streamingMessageId = activeRequestId
    ? streams[activeRequestId]?.assistantMessageId ?? null
    : null;
  // 工具步骤数量签名：步骤出现 / 变化时需要重新贴底，避免新行溢出可视区
  const stepsSignature = useMemo(
    () => messages.map((m) => m.meta?.steps?.length ?? 0).join(','),
    [messages],
  );
  const configured = isProviderConfigured(config);
  const hasMessageError = messages.some((item) => Boolean(item.meta?.errorCode));
  const showBanner = Boolean(error) && !hasMessageError;

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 消息条数变化或流式文本增长时贴底
  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages, streamingMessageId, stepsSignature]);

  /** 重试：把该条 assistant 消息之前最近的一条用户提问重新发一遍 */
  function handleRetry(index: number): void {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor].role === 'user') {
        void sendMessage(messages[cursor].content);
        return;
      }
    }
  }

  /** 编辑用户消息：交给 store 截断该条及其之后的全部消息，再用新内容重发 */
  function handleEdit(messageId: string, content: string): void {
    void sendMessage(content, messageId);
  }

  return (
    /* overflow-x-hidden 是必需的：只写 overflow-y-auto 时，按 CSS 规范
       overflow-x 会被隐式计算为 auto，消息内容一旦横向溢出，窗口底部就会冒出
       一条横向滚动条，并与右侧竖向滚动条在右下角交汇出一块白角（见 theme.css
       的 ::-webkit-scrollbar-corner）。这里显式关掉横向滚动。 */
    <div
      ref={scrollRef}
      className="h-full w-full overflow-x-hidden overflow-y-auto bg-background"
    >
      <div className="mx-auto flex min-h-full max-w-[720px] flex-col gap-4 px-4 py-6">
        {showBanner ? (
          <Alert status="danger" className="flex items-start gap-2">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>出错了</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
            <Button size="sm" variant="ghost" className="shrink-0" onPress={() => setError(null)}>
              关闭
            </Button>
          </Alert>
        ) : null}

        {!configured ? (
          <Alert status="warning" className="flex items-start gap-2">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>尚未完成模型配置</Alert.Title>
              <Alert.Description>
                先到设置里选择模型服务并填写必要信息（DeepSeek 需要 API Key），之后即可开始对话。
              </Alert.Description>
            </Alert.Content>
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0"
              onPress={() => setSettingsOpen(true)}
            >
              去设置
            </Button>
          </Alert>
        ) : null}

        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <p className="text-[15px] text-fg">开始一段新的对话</p>
            <p className="text-[13px] text-muted">
              在下方输入内容，Enter 发送，Shift + Enter 换行
            </p>
          </div>
        ) : (
          messages.map((message, index) => (
            <MessageBubble
              key={message.id}
              message={message}
              streaming={message.id === streamingMessageId}
              onRetry={() => handleRetry(index)}
              onOpenSettings={() => setSettingsOpen(true)}
              onEdit={loading ? undefined : handleEdit}
            />
          ))
        )}
      </div>
    </div>
  );
}
