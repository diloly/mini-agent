/**
 * harness 层共享类型：手写 agent loop 与工具的定义契约。
 *
 * 设计意图：
 * - 不引任何 agent 框架（不装 @openai/agents / langchain / zod），全部手写；
 * - HarnessTool 把「工具声明」与「执行函数」绑定在一起，loop 只认 define 与 execute；
 * - execute 必须自己吞掉异常并返回可读字符串，绝不向上抛，保证工具失败只回灌给模型、
 *   而不会让整轮生成走到 chat:error。
 */
import type { ToolDefinition } from '../providers/types';

/** 工具执行结果：ok 标识是否「业务成功」，text 是回灌给模型的文案 */
export interface ToolResult {
  ok: boolean;
  text: string;
}

/**
 * 工具执行上下文：由 loop 逐层显式传递。
 *
 * 刻意不用模块级全局变量 —— 两个会话并发生成时，全局变量会被后启动的那一轮覆盖，
 * 结果是 A 会话的工具跑到 B 会话的工作区里去读写文件。
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
