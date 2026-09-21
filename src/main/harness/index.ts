/**
 * harness 层统一出口：主进程编排层（ipc.ts）只从本文件 import。
 */
export { runAgentLoop } from './loop';
export type { HarnessResult, HarnessCallbacks } from './loop';
// HARNESS_TOOLS 是未过滤的原始注册表（不含记忆开关判定），对外取工具集合请用
// harnessToolsFor —— 它才是「本次生成实际暴露给模型」的集合。
export { HARNESS_TOOLS, findTool, harnessToolsFor } from './tools';
export type { HarnessTool, ToolContext, ToolResult } from './types';
