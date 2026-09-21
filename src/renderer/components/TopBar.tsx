/**
 * 顶栏：当前会话标题。
 *
 * 生成中指示与停止按钮已移除：输入区的发送按钮在生成时会切换为「停止」，
 * 顶栏再放一份属于重复信息（用户明确要求去掉）。
 *
 * 模型信息与设置入口已迁走：模型选择移入输入区（ModelPicker），设置入口移入左侧栏底部。
 */
import { useAppStore } from '../store/useAppStore';

export default function TopBar() {
  const conversations = useAppStore((state) => state.conversations);
  const activeConversationId = useAppStore((state) => state.activeConversationId);

  const current = conversations.find((item) => item.id === activeConversationId);

  return (
    <div className="flex h-full w-full items-center">
      <span className="block min-w-0 flex-1 truncate text-[13px] text-fg">
        {current ? current.title : '暂无会话'}
      </span>
    </div>
  );
}
