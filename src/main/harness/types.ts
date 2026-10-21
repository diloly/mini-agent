/**
 * harness 层共享类型：手写 agent loop 与工具的定义契约。
 *
 * 设计意图：
 * - 不引任何 agent 框架（不装 @openai/agents / langchain / zod），全部手写；
 * - HarnessTool 把「工具声明」与「执行函数」绑定在一起，loop 只认 define 与 execute；
 * - execute 必须自己吞掉异常并返回可读字符串，绝不向上抛，保证工具失败只回灌给模型、
 *   而不会让整轮生成走到 chat:error；
 * - 工具与 loop 都不认识 UI：没有「推给渲染层」的回调。update_plan 的清单更新
 *   由 ToolResult.plan 带回，loop 转成领域事件（events.ts）后外发，谁听谁转成 UI。
 */
import type { ToolDefinition } from '../providers/types';
import type { HarnessPlanStep } from './events';

/** 工具执行结果：ok 标识是否「业务成功」，text 是回灌给模型的文案 */
export interface ToolResult {
  ok: boolean;
  text: string;
  /**
   * 本条结果附带的计划清单快照（目前只有 update_plan 会带）：整份覆盖，非增量。
   * 工具只负责产出数据，何时、如何外发由 loop 决定——工具不直接触碰任何推送通道。
   */
  plan?: HarnessPlanStep[];
}

/**
 * 工具执行上下文：由 loop 逐层显式传递。
 *
 * 刻意不用模块级全局变量 —— 两个会话并发生成时，全局变量会被后启动的那一轮覆盖，
 * 结果是 A 会话的工具跑到 B 会话的工作区里去读写文件。
 *
 * 这里也**没有任何 UI 回调**：想知道「发生了什么」的调用方订阅 loop 的事件
 * （见 events.ts 的 HarnessEventSink），工具本身对渲染层一无所知。
 */
export interface ToolContext {
  /** 本次生成所属会话的工作区根目录（绝对路径） */
  workspaceRoot: string;
  /** 备份根目录（绝对路径） */
  backupRoot: string;
  /** 会话 id，用于给备份分目录 */
  conversationId: string;
  /**
   * 记忆功能是否开启。关闭时不暴露 append_daily_note —— 它写入的正是被关闭的
   * `.agent/memory/` 目录，留着只会白占一份 tool schema 的 token。
   */
  memoryEnabled: boolean;
  /**
   * 技能根目录（绝对路径）：<userData>/skills。
   * 与 workspaceRoot 同层下发 —— 「脚本只能跑在技能目录内」这条围栏需要一个可信的根，
   * 而它既不能从 relative path 推出来，也不能放模块级全局（两个会话并发生成会互相覆盖）。
   */
  skillsRoot: string;
}

/** 一个可被模型调用的工具：声明 + 执行函数 */
export interface HarnessTool {
  /**
   * 生成暴露给模型的工具声明。
   *
   * 做成方法而不是静态字段，原因有两层：
   * 1. 工作区绝对路径只有运行时才知道，静态字面量写不进去；
   * 2. 这段 description 是模型能直接读到的**唯一环境事实**——模型对「我在哪、我能碰什么」
   *    的全部认知都来自工具声明。声明里不写真实路径，模型缺事实时就会用先验补全，
   *    编出「虚拟工作区／需要上传文件」这类说法（实测出现过）。
   */
  define: (context: ToolContext) => ToolDefinition;
  /**
   * 执行工具。
   * - 必须自己吞掉异常、不要向上抛；
   * - 返回结构化结果：ok 表示是否业务成功（如被安全边界拒绝则为 false），
   *   text 无论 ok 与否都要回灌给模型，让模型自己解释失败原因；
   * - status 的 ✓ / ✕ 由 loop 依据 ok 决定。
   */
  execute: (rawArgs: string, signal: AbortSignal, context: ToolContext) => Promise<ToolResult>;
}
