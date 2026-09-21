/**
 * 输入区内的工作区快速切换器：无边框 chip + 自绘下拉。
 *
 * 设计取舍与 ModelPicker 一致：不使用 HeroUI 的 Select（trigger 自带边框、w-full，样式难控），
 * 这里用原生 button + 自绘浮层，外观完全受控。
 *
 * 行为：
 * - 展示当前会话绑定的工作区（activeWorkspaceRoot）；未绑定时回退到默认工作区（config.defaultWorkspaceRoot）。
 * - 下拉里可「选择文件夹」（弹系统目录框）或「恢复默认」（解绑，回到默认工作区）。
 * - 数据来源全部走 store（activeWorkspaceRoot / pickWorkspace / resetWorkspace），本组件不直接触碰 IPC。
 *
 * 颜色：只使用语义类（text-muted / text-fg / bg-overlay / border-line / hover:bg-surface-secondary），
 * 工具栏按钮不出现强调色，保持与 ModelPicker 一致的克制风格。
 */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';

/** 取路径最后一段目录名：兼容 / 与 \\ 两种分隔符（Windows 与 POSIX） */
function baseName(root: string): string {
  const parts = root.split(/[\\/]/).filter((part) => part.length > 0);
  // parts[parts.length - 1] 等价于「最后一段」；Array 索引是 ES2015，低于项目 lib 下限 ES2022
  return parts[parts.length - 1] ?? root;
}

export default function WorkspacePicker() {
  const config = useAppStore((state) => state.config);
  const activeWorkspaceRoot = useAppStore((state) => state.activeWorkspaceRoot);
  const pickWorkspace = useAppStore((state) => state.pickWorkspace);
  const resetWorkspace = useAppStore((state) => state.resetWorkspace);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 关闭：点击浮层外部 / 按 Escape；open 变化或卸载时移除两个监听
  useEffect(() => {
    if (!open) {
      return;
    }
    function handleMouseDown(event: MouseEvent): void {
      const node = containerRef.current;
      if (node && !node.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!config) {
    return null;
  }

  // 当前展示目录：会话绑定优先，否则落到默认工作区
  const effectiveRoot = activeWorkspaceRoot ?? config.defaultWorkspaceRoot;
  const isDefault = activeWorkspaceRoot === null;

  /** 选择文件夹：弹系统目录框，选中后写回当前会话工作区 */
  async function handlePick(): Promise<void> {
    await pickWorkspace();
    setOpen(false);
  }

  /** 恢复默认：解绑会话工作区，回退到默认工作区 */
  async function handleReset(): Promise<void> {
    await resetWorkspace();
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 rounded-[6px] px-2 py-1 text-[12px] text-muted hover:bg-surface-secondary hover:text-fg"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={effectiveRoot}
      >
        {/* 文件夹图标 */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          className="h-3.5 w-3.5"
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
        <span className="max-w-[160px] truncate">{baseName(effectiveRoot)}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          className="h-3 w-3"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-[260px] rounded-[8px] border border-line bg-overlay p-1">
          <div className="px-2 py-1 text-[11px] text-muted">
            {isDefault ? '默认工作区' : '当前工作区'}
          </div>
          <div className="break-all px-2 py-1.5 text-[12px] text-fg">{effectiveRoot}</div>
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-fg hover:bg-surface-secondary"
            onClick={() => void handlePick()}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              className="h-4 w-4"
            >
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
            </svg>
            选择文件夹…
          </button>
          {isDefault ? null : (
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-fg hover:bg-surface-secondary"
              onClick={() => void handleReset()}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                className="h-4 w-4"
              >
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v4h4" />
              </svg>
              恢复默认工作区
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
