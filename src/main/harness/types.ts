/**
 * harness 层共享类型：手写 agent loop 与工具的定义契约。
 *
 * 设计意图：
 * - 不引任何 agent 框架（不装 @openai/agents / langchain / zod），全部手写；
 * - HarnessTool 把「工具声明」与「执行函数」绑定在一起，loop 只认 definition 与 execute；
 * - execute 必须自己吞掉异常并返回可读字符串，绝不向上抛，保证工具失败只回灌给模型、
 *   而不会让整轮生成走到 chat:error。
 */
import type { ToolDefinition } from '../providers/types';

/** 工具执行结果：ok 标识是否「业务成功」，text 是回灌给模型的文案 */
export interface ToolResult {
  ok: boolean;
  text: string;
}

/** 一个可被模型调用的工具：声明 + 只读执行函数 */
export interface HarnessTool {
  definition: ToolDefinition;
  /**
   * 执行工具。
   * - 必须自己吞掉异常、不要向上抛；
   * - 返回结构化结果：ok 表示是否业务成功（如被安全边界拒绝则为 false），
   *   text 无论 ok 与否都要回灌给模型，让模型自己解释失败原因；
   * - status 的 ✓ / ✕ 由 loop 依据 ok 决定。
   */
  execute: (rawArgs: string, signal: AbortSignal) => Promise<ToolResult>;
}
