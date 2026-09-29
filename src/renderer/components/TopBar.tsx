/**
 * 顶栏：左侧当前会话标题 + 右侧账号入口（邮箱 + 下拉菜单）。
 *
 * 生成中指示与停止按钮已移除：输入区的发送按钮在生成时会切换为「停止」，
 * 顶栏再放一份属于重复信息（用户明确要求去掉）。
 * 模型信息与设置入口已迁走：模型选择移入输入区（ModelPicker），设置入口移入左侧栏底部。
 *
 * 账号菜单用本地 state + 绝对定位浮层实现（不引入未经确认的 HeroUI Menu 组件），
 * 点击浮层外部即关闭；颜色只用语义类。
 */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';

export default function TopBar() {
  const conversations = useAppStore((state) => state.conversations);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const auth = useAppStore((state) => state.auth);
  const signOut = useAppStore((state) => state.signOut);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const current = conversations.find((item) => item.id === activeConversationId);
  const email = auth?.email ?? '已登录';
  const initial = email.slice(0, 1).toUpperCase();

  // 点击浮层外部关闭菜单；菜单关闭时不挂监听
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function handleDocumentMouseDown(event: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [menuOpen]);

  return (
    <div className="flex h-full w-full items-center justify-between gap-3">
      <span className="block min-w-0 flex-1 truncate text-[13px] text-fg">
        {current ? current.title : '暂无会话'}
      </span>

      <div className="relative shrink-0" ref={menuRef}>
        <button
          type="button"
          className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 hover:bg-surface-secondary"
          title={email}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-[11px] text-muted">
            {initial}
          </span>
          <span className="max-w-[160px] truncate text-[12px] text-muted">{email}</span>
        </button>

        {menuOpen ? (
          <div className="absolute right-0 top-full z-10 mt-1 w-[200px] rounded-[8px] border border-line bg-overlay p-1 shadow-none">
            <div className="px-2 py-2">
              <p className="truncate text-[12px] text-fg">{email}</p>
              <p className="mt-0.5 text-[11px] text-muted">已登录</p>
            </div>
            <button
              type="button"
              className="block w-full cursor-pointer rounded-[6px] px-2 py-1.5 text-left text-[12px] text-fg hover:bg-surface-secondary"
              onClick={() => {
                setMenuOpen(false);
                setSettingsOpen(true);
              }}
            >
              账号设置
            </button>
            <button
              type="button"
              className="block w-full cursor-pointer rounded-[6px] px-2 py-1.5 text-left text-[12px] text-danger hover:bg-surface-secondary"
              onClick={() => {
                setMenuOpen(false);
                void signOut();
              }}
            >
              退出登录
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
