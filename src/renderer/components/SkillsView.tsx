/**
 * 技能页：右侧主区在「技能」视图下的内容。
 *
 * 从设置弹窗里搬出来的（用户要求：技能不该藏在设置里，应像 WorkBuddy 那样放在左侧栏入口）。
 * 只读 store，不直接触碰 IPC；所有数据变更都走 store action。
 *
 * 安全约定：导入技能 = 允许其中脚本在本机运行，故页面顶部常驻「来源可信」告知。
 * 语义约定：导入的「部分成功」按 imported / skipped 分别回显，绝不整份报成失败；
 * 错误（红）与回显（中性）分开两处渲染，不互相覆盖。
 */
import { Alert, Button, Input } from '@heroui/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SkillSummary } from '../../shared/ipc-channels';
import { useAppStore } from '../store/useAppStore';
import ConfirmDialog from './ConfirmDialog';

/** 工具样式图标基座（照抄 Sidebar 的 StrokeIcon 模式：24 视图盒、1.75 描边、随 currentColor） */
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

/** 四角星（技能标识） */
function SparkIcon(): ReactNode {
  return (
    <StrokeIcon className="h-4 w-4">
      <path d="M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7z" />
      <path d="M18.5 15.4l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
    </StrokeIcon>
  );
}

/** 垃圾桶（删除技能） */
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

/** 左箭头（从套件二级页返回） */
function BackIcon(): ReactNode {
  return (
    <StrokeIcon className="h-3.5 w-3.5">
      <path d="M15 18l-6-6 6-6" />
    </StrokeIcon>
  );
}

export default function SkillsView() {
  const skills = useAppStore((state) => state.skills);
  const refreshSkills = useAppStore((state) => state.refreshSkills);
  const importSkills = useAppStore((state) => state.importSkills);
  const deleteSkill = useAppStore((state) => state.deleteSkill);
  const openSkillsDir = useAppStore((state) => state.openSkillsDir);

  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SkillSummary | null>(null);
  /** 当前打开的套件名；null 表示停留在一级列表 */
  const [openedSuite, setOpenedSuite] = useState<string | null>(null);

  // 本页在切换视图时整体挂载 / 卸载 ⇒ 每次进来都会重新拉一次，天然拿到最新列表
  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  const keyword = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (keyword.length === 0) {
      return skills;
    }
    // 技能数量有限，纯前端过滤即可，不必回主进程
    return skills.filter(
      (item) =>
        item.displayName.toLowerCase().includes(keyword) ||
        item.dirName.toLowerCase().includes(keyword) ||
        item.description.toLowerCase().includes(keyword),
    );
  }, [skills, keyword]);

  /** 是否处于搜索态：搜索时直接平铺命中的技能，不再套一层套件卡 */
  const searching = keyword.length > 0;

  /**
   * 一级列表的渲染单元：套件卡 + 未分组技能卡混排。
   * 只按 `visible`（已过滤）分组 ⇒ 未被命中的成员不会把套件卡单独带出来。
   */
  const layout = useMemo(() => {
    const bySuite = new Map<string, SkillSummary[]>();
    const loose: SkillSummary[] = [];
    for (const item of visible) {
      const suite = item.suite;
      if (suite === undefined || suite.length === 0) {
        loose.push(item);
        continue;
      }
      const members = bySuite.get(suite);
      if (members === undefined) {
        bySuite.set(suite, [item]);
      } else {
        members.push(item);
      }
    }
    const suites = Array.from(bySuite.entries()).map(([name, items]) => ({ name, items }));
    // 套件按名字升序（码点比较即可，只求顺序确定）：不让列表顺序取决于 Map 的插入顺序。
    // 注意：这里排的是**套件名**，与 registry 按技能 dirName 的 localeCompare 排序无关。
    suites.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { suites, loose };
  }, [visible]);

  /** 二级页的成员：取全量 skills（二级页不做搜索过滤，搜索是顶层的事） */
  const openedMembers = useMemo(
    () => (openedSuite === null ? [] : skills.filter((item) => item.suite === openedSuite)),
    [skills, openedSuite],
  );

  // 在二级页里把最后一个成员删掉后，套件已不存在 ⇒ 自动退回一级，避免停在空白页
  useEffect(() => {
    if (openedSuite !== null && openedMembers.length === 0) {
      setOpenedSuite(null);
    }
  }, [openedSuite, openedMembers.length]);

  /** 从文件夹导入：成功回显 imported / skipped 明细，部分成功绝不整份报失败 */
  async function handleImport(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await importSkills();
      // 用户在选择框点了取消：不算失败，也不改任何回显（保持上一次结果）
      if (result.canceled) {
        return;
      }
      if (!result.ok && result.error) {
        setError(result.error);
      }
      const parts: string[] = [];
      if (result.imported.length > 0) {
        parts.push(`已导入 ${result.imported.length} 个技能：${result.imported.join('、')}`);
      }
      if (result.skipped.length > 0) {
        const detail = result.skipped.map((item) => `${item.name}（${item.reason}）`).join('；');
        parts.push(`已跳过 ${result.skipped.length} 个：${detail}`);
      }
      // 「结果可能不完整」的提示必须原样透出，绝不能让它看起来像「就这么多」
      if (result.note) {
        parts.push(result.note);
      }
      if (parts.length > 0) {
        setNotice(parts.join('；'));
      }
    } finally {
      setBusy(false);
    }
  }

  /** 在系统文件管理器中打开技能根目录 */
  async function handleOpenDir(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await openSkillsDir();
      if (!result.ok) {
        setError(result.reason ?? '打开技能目录失败');
      }
    } finally {
      setBusy(false);
    }
  }

  /** 确认删除：先关弹窗再执行，避免失败时弹窗残留挡住错误提示 */
  async function handleConfirmDelete(): Promise<void> {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await deleteSkill(target.dirName);
      if (!result.ok) {
        setError(result.error ?? '删除失败，请重试');
      } else {
        setNotice(`已删除技能「${target.displayName}」`);
      }
    } finally {
      setBusy(false);
    }
  }

  /** 技能卡：一级的未分组卡与二级的套件成员卡共用同一份渲染 */
  function renderSkillCard(item: SkillSummary): ReactNode {
    return (
      <div
        key={item.dirName}
        className="flex min-h-[112px] flex-col gap-2 rounded-[8px] border border-line bg-surface p-3"
      >
        <div className="flex items-start gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-surface-secondary text-fg">
            <SparkIcon />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-fg">{item.displayName}</p>
            <p className="truncate text-[12px] text-muted">
              {item.dirName}
              {item.hasScripts ? ' · 含脚本' : ''}
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 cursor-pointer rounded-[6px] p-1 text-muted hover:bg-surface-secondary hover:text-danger"
            aria-label={`删除技能 ${item.displayName}`}
            title="删除"
            onClick={() => {
              setError(null);
              setNotice(null);
              setPendingDelete(item);
            }}
          >
            <TrashIcon />
          </button>
        </div>
        <p className="line-clamp-2 text-[12px] leading-5 text-muted">
          {item.description || '（无描述）'}
        </p>
      </div>
    );
  }

  /** 套件卡：点进去才是该套件下每个技能的详细卡 */
  function renderSuiteCard(suite: { name: string; items: SkillSummary[] }): ReactNode {
    return (
      <button
        type="button"
        key={`suite:${suite.name}`}
        className="flex min-h-[112px] w-full cursor-pointer flex-col gap-2 rounded-[8px] border border-line bg-surface p-3 text-left hover:bg-surface-secondary"
        aria-label={`打开套件 ${suite.name}`}
        onClick={() => setOpenedSuite(suite.name)}
      >
        <div className="flex items-start gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-surface-secondary text-fg">
            <SparkIcon />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-fg">{suite.name}</p>
            <p className="truncate text-[12px] text-muted">套件 · {suite.items.length} 个技能</p>
          </div>
        </div>
        <p className="line-clamp-2 text-[12px] leading-5 text-muted">
          {suite.items.map((item) => item.displayName).join('、')}
        </p>
      </button>
    );
  }

  /**
   * 主区内容：二级页 / 空态 / 无匹配 / 搜索平铺 / 一级分组列表。
   * 用变量而不是深层嵌套三元 —— 三元分支的圆括号里不能放 JSX 注释（会被解析成空对象）。
   */
  let body: ReactNode;
  if (openedSuite !== null) {
    body = (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {openedMembers.map(renderSkillCard)}
      </div>
    );
  } else if (skills.length === 0) {
    body = (
      <p className="py-10 text-center text-[13px] text-muted">
        还没有导入任何技能。点右上「添加技能」从文件夹导入，或「打开技能目录」手动放置。
      </p>
    );
  } else if (visible.length === 0) {
    body = (
      <p className="py-10 text-center text-[13px] text-muted">没有匹配「{query.trim()}」的技能</p>
    );
  } else if (searching) {
    body = (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map(renderSkillCard)}
      </div>
    );
  } else {
    body = (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {layout.suites.map(renderSuiteCard)}
        {layout.loose.map(renderSkillCard)}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* JSX 注释只能放在 JSX 子节点位置；三元分支的圆括号里绝对不能放注释 */}
      {openedSuite === null ? (
        <header className="h-12 shrink-0 px-4">
          {/* 与消息区 / 输入区共用同一套三档内容宽度（逐字一致，不要改写成别的刻度） */}
          <div className="mx-auto flex h-full w-full max-w-[720px] items-center gap-3 xl:max-w-[960px] 2xl:max-w-[1120px]">
            <span className="shrink-0 text-[13px] text-fg">技能</span>
            <span className="shrink-0 text-[12px] text-muted">已安装 {skills.length}</span>
            {/* 搜索框自己包一层定宽父级：不要给 HeroUI 的 Input 直接加 w-[…]，
                它与出厂的宽度类属于同属性并存，结果未定义 */}
            <div className="ml-auto w-[180px] shrink-0">
              <Input
                variant="secondary"
                fullWidth
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索技能"
              />
            </div>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onPress={() => void handleOpenDir()}
            >
              打开技能目录
            </Button>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onPress={() => void handleImport()}
            >
              添加技能
            </Button>
          </div>
        </header>
      ) : (
        <header className="h-12 shrink-0 px-4">
          <div className="mx-auto flex h-full w-full max-w-[720px] items-center gap-3 xl:max-w-[960px] 2xl:max-w-[1120px]">
            <button
              type="button"
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] px-2 py-1 text-[13px] text-muted hover:bg-surface-secondary hover:text-fg"
              onClick={() => setOpenedSuite(null)}
            >
              <BackIcon />
              返回
            </button>
            <span className="shrink-0 text-[13px] text-fg">{openedSuite}</span>
            <span className="shrink-0 text-[12px] text-muted">{openedMembers.length} 个技能</span>
          </div>
        </header>
      )}

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 xl:max-w-[960px] 2xl:max-w-[1120px]">
          {/* 安全告知：硬要求，顶部常驻（导入 = 允许其脚本在本机运行）；仅一级页展示 */}
          {openedSuite === null ? (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>导入前请确认来源可信</Alert.Title>
                <Alert.Description>
                  导入技能会把它复制到本机技能目录，其中的脚本可由模型调用并在你的电脑上运行。
                  只导入你信任的来源。
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          {error ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{error}</Alert.Title>
              </Alert.Content>
            </Alert>
          ) : null}

          {notice ? (
            <p className="rounded-[6px] border border-line bg-surface-secondary px-3 py-2 text-[12px] text-fg">
              {notice}
            </p>
          ) : null}

          {body}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除技能？"
        description={
          pendingDelete
            ? `将删除技能「${pendingDelete.displayName}」（${pendingDelete.dirName}）及其全部文件，此操作不可恢复。`
            : ''
        }
        confirmLabel="删除"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
