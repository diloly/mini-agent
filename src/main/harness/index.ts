/**
 * harness 层统一出口：主进程编排层（ipc.ts）只从本文件 import。
 */
export { runAgentLoop } from './loop';
export type { HarnessResult, HarnessCallbacks } from './loop';
export { HARNESS_TOOLS, findTool } from './tools';
export type { HarnessTool } from './types';
