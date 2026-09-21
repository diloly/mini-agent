/**
 * 输入区内的模型快速切换器：无边框 chip + 自绘下拉。
 *
 * 设计取舍：不使用 HeroUI 的 Select —— 它的 trigger 是表单控件外观（带边框、w-full），
 * 嵌进输入卡片后需要覆写的样式过多；这里用原生 button + 自绘浮层，外观完全受控。
 *
 * 数据来源：全部走 store（config / switchModel / refreshModels），本组件不直接触碰 IPC。
 */
import { useEffect, useRef, useState } from 'react';
import { PROVIDER_LABELS, type ModelInfo, type ProviderId } from '../../shared/types';
import { useAppStore } from '../store/useAppStore';

/** 下拉内每组的展示顺序（固定，不依赖对象键顺序） */
const PROVIDER_ORDER: ProviderId[] = ['deepseek', 'ollama'];

export default function ModelPicker() {
  const config = useAppStore((state) => state.config);
  const switchModel = useAppStore((state) => state.switchModel);
  const refreshModels = useAppStore((state) => state.refreshModels);

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

  const activeModel = config.providers[config.activeProviderId].model;

  /** 取某个服务的候选列表：为空时用当前已选模型兜底成单条，保证下拉至少能显示并复选当前值 */
  function optionsFor(providerId: ProviderId): ModelInfo[] {
    if (!config) {
      return [];
    }
    const list = config.models[providerId] ?? [];
    if (list.length > 0) {
      return list;
    }
    const current = config.providers[providerId].model;
    return current ? [{ id: current, label: current }] : [];
  }

  /** 选中某个模型：先落盘，再关面板 */
  async function handleSelect(providerId: ProviderId, model: string): Promise<void> {
    await switchModel(providerId, model);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 rounded-[6px] px-2 py-1 text-[12px] text-muted hover:bg-surface-secondary hover:text-fg"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="切换模型"
      >
        <span className="max-w-[200px] truncate">{activeModel || '选择模型'}</span>
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
        <div className="absolute bottom-full left-0 z-20 mb-2 max-h-[280px] w-[280px] overflow-y-auto rounded-[8px] border border-line bg-overlay p-1">
          {PROVIDER_ORDER.map((providerId) => {
            const options = optionsFor(providerId);
            return (
              <div key={providerId}>
                <div className="px-2 py-1 text-[11px] text-muted">{PROVIDER_LABELS[providerId]}</div>
                {options.length === 0 ? (
                  <div className="px-2 py-1.5 text-[12px] text-muted">暂无候选，请到设置中填写</div>
                ) : (
                  options.map((item) => {
                    const selected =
                      providerId === config.activeProviderId &&
                      item.id === config.providers[providerId].model;
                    return (
                      <button
                        key={`${providerId}:${item.id}`}
                        type="button"
                        className={[
                          'block w-full cursor-pointer truncate rounded-[6px] px-2 py-1.5 text-left text-[13px]',
                          selected
                            ? 'bg-surface-selected text-fg'
                            : 'text-fg hover:bg-surface-secondary',
                        ].join(' ')}
                        onClick={() => void handleSelect(providerId, item.id)}
                      >
                        {item.label}
                      </button>
                    );
                  })
                )}
              </div>
            );
          })}

          <div className="my-1 border-t border-line" />
          <button
            type="button"
            className="block w-full cursor-pointer rounded-[6px] px-2 py-1.5 text-left text-[12px] text-muted hover:bg-surface-secondary hover:text-fg"
            onClick={() => void refreshModels(config.activeProviderId)}
          >
            刷新列表
          </button>
        </div>
      ) : null}
    </div>
  );
}
