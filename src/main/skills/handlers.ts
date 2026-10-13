/**
 * 技能导入 IPC 接线：注册 4 个 `skill:*` handler（list / openDir / import / delete）。
 *
 * 这是 `skills/` 目录下**唯一**允许 import electron 的模块（除既有 `paths.ts` 外），
 * 因为要用 `dialog`（目录选择框）与 `shell`（在系统文件管理器中打开目录）。
 *
 * 纪律：
 * - 每个 handler 都 try/catch 包裹，异常也返回结构化结果，**绝不让 invoke reject**
 *   （安全底线：渲染层永不卡在 loading）；
 * - 目录选择框以主窗口为父窗口（照抄 ipc.ts 的 handleWorkspacePick：窗口存在且未销毁才带父窗口）。
 */
import {
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron';
import {
  CHANNELS,
  type ChannelName,
  type SkillDeleteRequest,
  type SkillDeleteResult,
  type SkillImportResult,
  type SkillOpenDirResult,
  type SkillSummary,
} from '../../shared/ipc-channels';
import { deleteSkill, importSkillsFrom } from './install';
import { ensureSkillsRoot, skillsRoot } from './paths';
import { listSkills, type SkillMeta } from './registry';

/** 事件推送函数：由 ipc.ts 注入（本批暂未用到事件，保留以便将来推「技能列表已变化」） */
type SkillEmit = (channel: ChannelName, payload: unknown) => void;

/** registerSkillHandlers 的依赖 */
export interface SkillHandlerDeps {
  /** 事件推送（保留参数，本批不使用） */
  emit: SkillEmit;
  /** 主窗口访问器，用作目录选择框的父窗口（与 ipc.ts 的 IpcRouterDeps.getMainWindow 同源） */
  getMainWindow: () => BrowserWindow | null;
}

/** SkillMeta → 渲染层可见的摘要（只取元数据，不含本地路径） */
function toSummary(meta: SkillMeta): SkillSummary {
  return {
    dirName: meta.dirName,
    displayName: meta.displayName,
    description: meta.description,
    hasScripts: meta.hasScripts,
    ...(meta.suite !== undefined ? { suite: meta.suite } : {}),
  };
}

/** 注册全部 `skill:*` handler。每个 handler 自行 try/catch，绝不 reject。 */
export function registerSkillHandlers(deps: SkillHandlerDeps): void {
  /** 注册单个 invoke 通道；先 removeHandler 再 handle，开发期热重载不报重复注册 */
  function handle<TArgs extends unknown[], TResult>(
    channel: ChannelName,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult>,
  ): void {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
  }

  handle(CHANNELS.SKILL_LIST, async (): Promise<SkillSummary[]> => {
    try {
      return (await listSkills(skillsRoot())).map(toSummary);
    } catch {
      return [];
    }
  });

  handle(CHANNELS.SKILL_OPEN_DIR, async (): Promise<SkillOpenDirResult> => {
    try {
      const root = ensureSkillsRoot();
      // shell.openPath 在无文件管理器 / 系统调用失败时返回错误字符串（不抛）；据实回传
      const failure = await shell.openPath(root);
      return failure ? { ok: false, reason: failure } : { ok: true };
    } catch {
      return { ok: false, reason: '打开技能目录失败' };
    }
  });

  handle(CHANNELS.SKILL_IMPORT, async (): Promise<SkillImportResult> => {
    try {
      ensureSkillsRoot();
      const options: OpenDialogOptions = {
        title: '选择技能包文件夹',
        buttonLabel: '导入此文件夹',
        properties: ['openDirectory'],
      };
      const window = deps.getMainWindow();
      const result =
        window && !window.isDestroyed()
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true, imported: [], skipped: [] };
      }
      return await importSkillsFrom(skillsRoot(), result.filePaths[0]);
    } catch {
      return { ok: false, canceled: false, imported: [], skipped: [], error: '导入失败' };
    }
  });

  handle(
    CHANNELS.SKILL_DELETE,
    async (_event, req: SkillDeleteRequest): Promise<SkillDeleteResult> => {
      try {
        return await deleteSkill(skillsRoot(), req?.dirName ?? '', req?.confirm === true);
      } catch {
        return { ok: false, error: '删除失败' };
      }
    },
  );
}
