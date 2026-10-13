/**
 * 技能根目录解析：技能包与脚本的落点（可写、非 asar）。
 *
 * 位置策略与 workspace.ts 的 getDefaultWorkspaceRoot() **完全一致**（技能包与工作区并排）：
 * - 开发期：项目目录的**上一级**下的 skills/（本项目即 E:\code\LocalAgent\skills），
 *   便于在 IDE 里直接放置 / 查看技能包；该位置在 git 仓库（根为 mini-agent/）**之外**，
 *   故无需加 .gitignore（与 workspace/ 同）；
 * - 打包后：app.asar 是只读归档、且用户机器上并不存在开发期那个路径，
 *   因此改放 userData 下的 skills/。
 * 开发期路径由 dirname(getAppPath()) 推导，**不硬编码盘符**，换机器 / 换目录都不用改代码。
 *
 * 为什么必须可写、不能进 asar 或 resources/：技能包由**用户导入**，写权限是硬要求；
 * asar 只读，resources/ 是安装目录（升级会被覆盖）。
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 技能根目录（绝对路径）：dev = <项目上级>/skills；打包 = <userData>/skills。技能包与其内脚本都必须落在此根之内。 */
export function skillsRoot(): string {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'skills');
  }
  return path.join(path.dirname(app.getAppPath()), 'skills');
}

/**
 * 确保技能根目录存在（按需创建，幂等）；返回其绝对路径，便于调用方链式使用。
 * 用 recursive: true —— 父目录已存在时不报错，且可安全重复调用。同步实现：
 * 该函数只在解析路径的调用点按需触发一次，不做重活，无需异步。
 */
export function ensureSkillsRoot(): string {
  const root = skillsRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}
