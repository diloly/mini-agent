/**
 * 左侧会话栏：顶部「技能 / 新建会话」两行左对齐入口 + 会话列表（标题 + hover 出现的「…」菜单）+ 底部账号 / 设置入口。
 *
 * 只读取 store，不直接触碰 IPC；所有数据变更都走 store action。
 * 会话行：标题过长时 hover 横向滚动（见 styles/theme.css 的 .conv-title-*），hover 才显示
 * 「…」按钮，点击弹出「置顶 / 重命名 / 删除」浮层（带图标，删除为红字）。
 * 账号菜单与会话行菜单各用独立 ref 做「点击外部关闭」，避免互相把对方当成外部点击。
 * 颜色只用语义类，图标全部手绘内联 SVG（不引图标库）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../store/useAppStore';
import ConfirmDialog from './ConfirmDialog';

/** 「…」菜单宽度，必须与 className 里的 w-[132px] 保持一致 */
const ROW_MENU_WIDTH = 132;
/** 「…」菜单高度估算（3 项 × 28px + 上下 padding 8px），用于判定是否需要向上翻转 */
const ROW_MENU_HEIGHT = 96;
/** 菜单与触发按钮 / 视口边缘的间距 */
const ROW_MENU_GAP = 4;

/**
 * 图标基座：统一 24 视图盒、1.75 描边、颜色随 currentColor（照抄 MessageBubble 的 ActionIcon 模式）。
 * 手绘 SVG 而不引图标库 —— 只需要几个形状，装一个依赖不划算。
 */
function StrokeIcon({
  children,
  className = 'h-3.5 w-3.5',
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 加号 */
function PlusIcon(): ReactNode {
  return (
    <StrokeIcon>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </StrokeIcon>
  );
}

/** 四角星（技能入口） */
function SparkIcon(): ReactNode {
  return (
    <StrokeIcon>
      <path d="M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7z" />
      <path d="M18.5 15.4l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
    </StrokeIcon>
  );
}

/** 更多（竖三点）：实心圆点更清楚，故单独覆写 fill / stroke */
function MoreIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <circle cx="12" cy="5" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="12" cy="19" r="1.4" />
    </svg>
  );
}

/** 图钉（置顶 / 取消置顶） */
function PinIcon({ className = 'h-3.5 w-3.5' }: { className?: string }): ReactNode {
  return (
    <StrokeIcon className={className}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </StrokeIcon>
  );
}

/** 铅笔（重命名） */
function PencilIcon(): ReactNode {
  return (
    <StrokeIcon>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </StrokeIcon>
  );
}

/** 垃圾桶（删除） */
function TrashIcon(): ReactNode {
  return (
    <StrokeIcon>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </StrokeIcon>
  );
}

/**
 * 运行中：旋转的缺口圆弧（该会话正在生成）。尺寸与「…」图标一致，便于同槽位互斥显示。
 * className 是整体替换默认值（与 PinIcon / StrokeIcon 同款语义），调用方必须自带基类。
 */
function SpinnerIcon({
  className = 'h-3.5 w-3.5 shrink-0 animate-spin text-accent',
}: {
  className?: string;
}): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.57" />
    </svg>
  );
}

export default function Sidebar() {
  const conversations = useAppStore((state) => state.conversations);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const createConversation = useAppStore((state) => state.createConversation);
  const removeConversation = useAppStore((state) => state.removeConversation);
  const renameConversation = useAppStore((state) => state.renameConversation);
  const setConversationPinned = useAppStore((state) => state.setConversationPinned);
  const selectConversation = useAppStore((state) => state.selectConversation);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const mainView = useAppStore((state) => state.mainView);
  const setMainView = useAppStore((state) => state.setMainView);
  const auth = useAppStore((state) => state.auth);
  const signOut = useAppStore((state) => state.signOut);

  // 哪些会话正在生成：拼成字符串再比较，避免 selector 每次返回新数组导致无限重渲染
  // （zustand 用 Object.is 比较返回值，数组引用每次都是新的）。
  // 🔑 直接遍历 streams 的**全部**条目，不按 discarded 过滤：条目由「开跑」创建、只在
  // finishStream / failStream 的 omitStream 里删除 ⇒ 「在 streams 里」等价于「这一轮还没结束」。
  // discarded 只表示不再往界面推 delta，**不代表已结束**。所以切走之后圈圈仍留在该行，
  // 直到后台真正跑完才由 store 撤掉圈圈、改成未读圆点。
  const generatingKey = useAppStore((state) =>
    Object.values(state.streams)
      .map((stream) => stream.conversationId)
      .sort()
      .join('|'),
  );
  const generatingIds = useMemo(
    () => new Set(generatingKey ? generatingKey.split('|') : []),
    [generatingKey],
  );

  // 哪些会话「跑完但还没看过」；同样先拼字符串再比较，理由见上（zustand 用 Object.is 比返回值）。
  const unreadKey = useAppStore((state) => Object.keys(state.unreadConversations).sort().join('|'));
  const unreadIds = useMemo(() => new Set(unreadKey ? unreadKey.split('|') : []), [unreadKey]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  /** 菜单浮层的固定定位坐标（视口坐标系）；null 表示尚未计算 */
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  /** 正在等待二次确认删除的会话；非 null 时渲染删除确认弹窗 */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const menuRef = useRef<HTMLDivElement>(null);
  const rowMenuRef = useRef<HTMLDivElement>(null);
  // 编辑态的同步镜像：blur 与 Enter/Esc 可能在同一帧先后触发，用 ref 精确判定「是否仍在该行编辑」
  const editingIdRef = useRef<string | null>(null);

  const email = auth?.email ?? '已登录';
  const initial = email.slice(0, 1).toUpperCase();

  // 点击浮层外部关闭账号菜单；菜单关闭时不挂监听
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

  // 点击浮层外部关闭会话行「…」菜单；用独立 ref，避免被账号菜单的监听当成外部点击
  useEffect(() => {
    if (!openMenuId) {
      return;
    }
    function handleRowMouseDown(event: MouseEvent): void {
      const target = event.target;
      // 触发按钮自身不算「外部点击」：否则 mousedown 会先把菜单关掉、随后的 click
      // 读到的又是「未打开」的闭包值，于是把菜单重新打开 —— 表现为「点『…』关不掉」。
      if (target instanceof Element && target.closest('[data-row-menu-trigger]')) {
        return;
      }
      if (rowMenuRef.current && !rowMenuRef.current.contains(target as Node)) {
        setOpenMenuId(null);
      }
    }
    document.addEventListener('mousedown', handleRowMouseDown);
    return () => document.removeEventListener('mousedown', handleRowMouseDown);
  }, [openMenuId]);

  // 卸载时清掉编辑镜像引用，避免已卸载组件上的失焦回调触发提交
  useEffect(
    () => () => {
      editingIdRef.current = null;
    },
    [],
  );

  /** 关闭会话行「…」菜单 */
  function closeRowMenu(): void {
    setOpenMenuId(null);
  }

  /** 进入重命名态：把当前标题灌进草稿，并关掉「…」菜单 */
  function startRename(id: string, title: string): void {
    closeRowMenu();
    setRenameDraft(title);
    setEditingId(id);
    editingIdRef.current = id;
  }

  /** 结束重命名态（提交或取消共用） */
  function endRename(): void {
    editingIdRef.current = null;
    setEditingId(null);
  }

  /** 提交重命名：仅当仍处于该行编辑态才提交（防止 Esc 取消后被 blur 补交） */
  function submitRename(id: string): void {
    if (editingIdRef.current !== id) {
      return;
    }
    const next = renameDraft.trim();
    endRename();
    if (next.length === 0) {
      return;
    }
    const current = conversations.find((item) => item.id === id);
    if (current && current.title === next) {
      return;
    }
    void renameConversation(id, next);
  }

  return (
    <div className="flex h-full w-full flex-col bg-background-secondary">
      {/* 顶部入口：「技能」在上、「新建会话」在下（用户明确要求的顺序）。
          两行都是**内容左对齐**的全宽按钮：与底部账号行的文字共用同一条左基线
          （容器 px-2 + 行内 px-2 ⇒ 内容距侧栏左缘 16px），三处不齐会非常明显。

          这里刻意用原生 <button> 而不是 HeroUI 的按钮组件：后者出厂是内容居中，
          且 justify-center 出自 @heroui/styles 的**未分层**样式 —— 按本仓实测规律
          （未分层压过 @layer utilities），我们加 justify-start 也压不过它，左对齐无法可靠实现。
          底色直接用语义类：--default 与 --surface-secondary 在本仓两套主题下取值完全相同，
          所以视觉上仍是原来那个「实心灰底按钮」。 */}
      <div className="flex shrink-0 flex-col gap-1 px-2 pt-2">
        <button
          type="button"
          className={[
            'flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-2 text-left text-[13px]',
            mainView === 'skills'
              ? 'bg-surface-selected text-fg'
              : 'bg-surface-secondary text-fg hover:bg-surface-selected',
          ].join(' ')}
          onClick={() => setMainView('skills')}
        >
          <SparkIcon />
          技能
        </button>

        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] bg-surface-secondary px-2 py-2 text-left text-[13px] text-fg hover:bg-surface-selected"
          onClick={() => {
            // 新建会话是「回到对话」的动作：必须先把主区切回聊天，
            // 否则新会话建在了看不见的技能页后面，用户以为没生效。
            setMainView('chat');
            void createConversation();
          }}
        >
          <PlusIcon />
          新建会话
        </button>
      </div>

      {/* 列表：选中项用 surface-selected，悬停用 surface-secondary */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2"
        onScroll={() => {
          if (openMenuId) {
            closeRowMenu();
          }
        }}
      >
        {conversations.length === 0 ? (
          <p className="px-2 py-3 text-[13px] text-muted">还没有会话</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {conversations.map((item) => {
              const selected = item.id === activeConversationId;
              const menuOpenHere = openMenuId === item.id;
              const editing = editingId === item.id;
              // 状态指示的显隐：**只看 hover**。菜单已打开、或鼠标悬停在该行时，让位给「…」按钮。
              // 刻意不接任何 focus 变体：鼠标点一下会话标题会让标题按钮拿到 :focus，若用
              // group-focus-within，「…」就会常驻在选中的那一行上 —— 而它只应在 hover 时出现。
              const statusIndicatorClass = menuOpenHere
                ? 'opacity-0'
                : 'opacity-100 group-hover:opacity-0';
              return (
                <li key={item.id} className="relative">
                  {editing ? (
                    /* 重命名：行内输入，回车提交、Esc 取消、失焦也提交 */
                    <input
                      className="w-full rounded-[8px] border border-line bg-surface px-2 py-1.5 text-[13px] text-fg outline-none"
                      value={renameDraft}
                      autoFocus
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          submitRename(item.id);
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          endRename();
                        }
                      }}
                      onBlur={() => submitRename(item.id)}
                    />
                  ) : (
                    <div
                      className={[
                        'group flex items-center gap-1 rounded-[8px] px-2 py-1.5',
                        selected ? 'bg-surface-selected' : 'hover:bg-surface-secondary',
                      ].join(' ')}
                    >
                      {item.pinned === true ? (
                        /* 置顶标记：常驻显示（不随 hover 变化），未置顶不占位 */
                        <PinIcon className="h-3 w-3 shrink-0 text-muted" />
                      ) : null}
                      <button
                        type="button"
                        className="min-w-0 flex-1 cursor-pointer text-left"
                        onClick={() => {
                          closeRowMenu();
                          // 点会话 = 回到对话：否则会停在技能页，看不见刚点开的会话
                          setMainView('chat');
                          void selectConversation(item.id);
                        }}
                      >
                        <span className="conv-title-track block text-[13px] text-fg">
                          <span className="conv-title-text">{item.title}</span>
                        </span>
                      </button>
                      {/* 状态槽：状态指示与「…」按钮共用同一格。
                          边长 22px = 按钮原内边距 p-1(4px×2) + MoreIcon h-3.5(14px)，
                          所以槽位宽度恒定 ⇒ 标题不会因「运行中 ↔ 未读 ↔ 无」切换而位移。
                          「…」是 absolute inset-0 铺满槽位，hover 时盖在指示之上。 */}
                      <div className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center">
                        {generatingIds.has(item.id) ? (
                          /* 运行中：旋转圈圈。基类必须显式带上 —— SpinnerIcon 的 className 是整体替换 */
                          <SpinnerIcon
                            className={[
                              'h-3.5 w-3.5 shrink-0 animate-spin text-accent',
                              statusIndicatorClass,
                            ].join(' ')}
                          />
                        ) : unreadIds.has(item.id) ? (
                          /* 跑完但还没看过：主题色小圆点 */
                          <span
                            className={['h-1.5 w-1.5 rounded-full bg-accent', statusIndicatorClass].join(' ')}
                            aria-hidden="true"
                          />
                        ) : null}
                        <button
                          type="button"
                          data-row-menu-trigger
                          className={[
                            'absolute inset-0 flex cursor-pointer items-center justify-center rounded-[6px] text-muted hover:bg-surface-secondary hover:text-fg',
                            menuOpenHere
                              ? 'opacity-100'
                              : 'opacity-0 group-hover:opacity-100',
                          ].join(' ')}
                          aria-label="会话操作"
                          title="会话操作"
                          onClick={(event) => {
                            if (menuOpenHere) {
                              closeRowMenu();
                              return;
                            }
                            const rect = event.currentTarget.getBoundingClientRect();
                            // 默认向下展开；下方空间不足时向上翻转，避免被视口底部切掉。
                            // 外面再套 Math.max 兜住上界：窗口极矮且点第一行时翻转值可能为负，会被视口上缘切掉。
                            const spaceBelow = window.innerHeight - rect.bottom;
                            const top = Math.max(
                              ROW_MENU_GAP,
                              spaceBelow < ROW_MENU_HEIGHT + ROW_MENU_GAP
                                ? rect.top - ROW_MENU_HEIGHT - ROW_MENU_GAP
                                : rect.bottom + ROW_MENU_GAP,
                            );
                            // 右对齐到按钮右缘，并夹在视口内（左右各留 8px）
                            const left = Math.max(
                              8,
                              Math.min(rect.right - ROW_MENU_WIDTH, window.innerWidth - ROW_MENU_WIDTH - 8),
                            );
                            setMenuPos({ top, left });
                            setOpenMenuId(item.id);
                          }}
                        >
                          <MoreIcon />
                        </button>
                      </div>
                    </div>
                  )}

                  {menuOpenHere && !editing && menuPos
                    ? createPortal(
                        <div
                          className="fixed z-50 w-[132px] rounded-[8px] border border-line bg-overlay p-1"
                          style={{ top: menuPos.top, left: menuPos.left }}
                          ref={rowMenuRef}
                        >
                          <button
                            type="button"
                            className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12px] text-fg hover:bg-surface-secondary"
                            onClick={() => {
                              closeRowMenu();
                              void setConversationPinned(item.id, item.pinned !== true);
                            }}
                          >
                            <PinIcon />
                            {item.pinned === true ? '取消置顶' : '置顶'}
                          </button>
                          <button
                            type="button"
                            className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12px] text-fg hover:bg-surface-secondary"
                            onClick={() => startRename(item.id, item.title)}
                          >
                            <PencilIcon />
                            重命名
                          </button>
                          <button
                            type="button"
                            className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12px] text-danger hover:bg-surface-secondary"
                            onClick={() => {
                              closeRowMenu();
                              setPendingDelete({ id: item.id, title: item.title });
                            }}
                          >
                            <TrashIcon />
                            删除
                          </button>
                        </div>,
                        document.body,
                      )
                    : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 底部：账号入口 + 设置入口，合并为同一行（设置按钮在账号占位右侧） */}
      <div className="relative shrink-0 px-2 py-2" ref={menuRef}>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[8px] px-2 py-2 text-left hover:bg-surface-secondary"
            title={email}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-[11px] text-muted">
              {initial}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{email}</span>
          </button>

          <button
            type="button"
            className="shrink-0 cursor-pointer rounded-[8px] p-2 text-muted hover:bg-surface-secondary hover:text-fg"
            title="设置"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 shrink-0"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>

        {/* left-2 不能省：绝对定位的包含块是父级 padding edge（不含 px-2 的 8px），
            left-0 会让浮层贴到侧栏最左边缘，与账号按钮左边缘错开 8px。 */}
        {menuOpen ? (
          <div className="absolute bottom-full left-2 z-10 mb-1 w-[200px] rounded-[8px] border border-line bg-overlay p-1 shadow-none">
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

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除会话？"
        description="删除后，该会话及其全部消息将从本机移除，且无法恢复。"
        confirmLabel="删除"
        onConfirm={() => {
          if (pendingDelete) {
            void removeConversation(pendingDelete.id);
          }
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
