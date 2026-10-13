/**
 * 跨进程「技能」契约（主进程 ⇄ 渲染层共用）。
 *
 * 只放**数据结构**，不放任何实现；主进程与渲染层都从这里 import 类型，保证两侧形状一致。
 */

/** 一个已安装技能的渲染层可见形态（不含内容，只有元数据） */
export interface SkillSummary {
  /**
   * 技能标识符（相对技能根）：根下技能 = 目录名（如 `find-skills`），
   * 套件内技能 = `套件名/技能名`（如 `finance-data/westock-data`）。
   * 它同时是 read_skill / run_skill_script 的 skill 参数值。
   */
  dirName: string;
  /** frontmatter 里的展示名；缺失时等于 dirName */
  displayName: string;
  description: string;
  /** 是否含 scripts/ 目录（纯展示提示；实际可运行性由扩展名决定） */
  hasScripts: boolean;
  /**
   * 所属套件名；未分组时为 undefined。
   * 来源有两处（**路径优先**）：二级技能（`<套件>/<技能>`）取自一级目录名；
   * 一级技能（技能根下）回退查技能根下的 `.suites.json` 清单。
   * 可选 ⇒ preload / IPC 是整对象透传，无需改动契约层。
   */
  suite?: string;
}

/** 导入一个技能时被跳过的原因 */
export interface SkillImportSkip {
  name: string;
  reason: string;
}

/** 从文件夹导入的结果（canceled=true 表示用户取消了目录选择） */
export interface SkillImportResult {
  ok: boolean;
  canceled: boolean;
  imported: string[];
  skipped: SkillImportSkip[];
  /** ok=false 时的整体失败原因（如「没找到 SKILL.md」） */
  error?: string;
  /**
   * 附加提示：形如「遍历因触顶提前结束，结果可能不完整」。
   * 与 error 的区别：error 表示「这次没成功」，note 表示「成功了但结论有前提」，两者可同时为空。
   * 可选字段 ⇒ preload / IPC 是整对象透传，无需改动契约层。
   */
  note?: string;
}

/** 删除技能的请求（confirm 必须为真才执行） */
export interface SkillDeleteRequest {
  /** 技能标识符（同 SkillSummary.dirName，可为 `套件名/技能名`） */
  dirName: string;
  confirm: boolean;
}

/** 删除技能的结果 */
export interface SkillDeleteResult {
  ok: boolean;
  /** ok=false 且未识别为「不存在」时的原因文案 */
  error?: string;
}

/** 打开技能根目录（SKILL_OPEN_DIR）的返回；ok=false 时 reason 给出原因（shell.openPath 可能失败） */
export interface SkillOpenDirResult {
  ok: boolean;
  reason?: string;
}
