/**
 * 工作区路径解析：默认工作区推导 + 会话级回退 + 备份目录。
 *
 * 默认工作区的位置策略（原实现在 harness/tools.ts，本次搬到这里统一维护）：
 * - 开发期：项目目录的**上一级**下的 workspace/（本项目即 E:\code\LocalAgent\workspace），
 *   便于在 IDE 里直接看到测试文件，且与代码仓库解耦（无需加 .gitignore）；
 * - 打包后：app.asar 是只读归档、且用户机器上并不存在开发期那个路径，
 *   因此改放 userData 下的 workspace/。
 * 开发期路径由 dirname(getAppPath()) 推导，**不硬编码盘符**，换机器 / 换目录都不用改代码。
 */
import { app } from 'electron';
import * as path from 'node:path';
import type { Conversation } from '../shared/types';

/** 默认工作区根目录（会话未指定工作区时回退到这里） */
export function getDefaultWorkspaceRoot(): string {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'workspace');
  }
  return path.join(path.dirname(app.getAppPath()), 'workspace');
}

/**
 * 解析某个会话实际使用的工作区根目录。
 * 会话可以指定自己的工作区；未指定（或存了空串）时回退到默认工作区。
 */
export function resolveWorkspaceRoot(conversation: Conversation | undefined): string {
  const configured = conversation?.workspaceRoot?.trim();
  return configured && configured.length > 0 ? configured : getDefaultWorkspaceRoot();
}

/**
 * 备份根目录：写工具覆盖已有文件前，会把原内容复制到这里。
 * 刻意放在 userData 而不是工作区内 —— 既不污染工作区内容，
 * 也不会被 read_text_file 与模型的目录感知看到。
 */
export function getBackupRoot(): string {
  return path.join(app.getPath('userData'), 'backups');
}
