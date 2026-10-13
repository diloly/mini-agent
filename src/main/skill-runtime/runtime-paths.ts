/**
 * runtime 路径解析：内置 CPython 运行时的边界适配器。
 *
 * ★ 本文件是唯一**直接** import electron 的运行时模块（app.isPackaged / process.resourcesPath）。
 *   纯逻辑模块（tools-skill-run / interpreter / run-process）只经「注入的 RuntimeResolver 接口」
 *   取路径，从而保持无 electron、可测、无循环依赖；tools.ts 作为组合根会**间接**依赖 electron，
 *   这是可接受的（它是主进程专属模块，不在 renderer / 无 electron 环境加载）。
 *
 * 本文件只导出三样：`resolveRuntimeRoot()` / `RuntimeResolver` / `createRuntimeResolver()`。
 * ⚠️ `resolveNodeExe()` **已移到 interpreter.ts**：interpreter.ts 需要它来构造 `.js` 的
 *    InterpreterSpec.command，而 interpreter.ts **不能** import 本文件（会间接拖入 electron）；
 *    同理 run-process.ts 的 buildChildEnv 也要用它算 node 目录。故它必须待在一个「无 electron」的
 *    模块里 —— interpreter.ts。那里复用的是 Node 全局属性 process.execPath，不产生 electron 依赖。
 */
import { app } from 'electron';
import * as path from 'node:path';

/**
 * runtime 根目录：
 * - 打包态：<resources>/runtime（electron-builder 的 extraResources 投放，见 electron-builder.yml）；
 * - 开发态：<项目根>/resources/runtime
 *   （electron-vite 开发期 app.getAppPath() 返回项目根，即含 package.json 的目录，
 *    故拼出的相对布局与打包后一致）。
 *
 * 🔴 打包态**绝不**用 __dirname 拼路径 —— 打包后主进程代码位于 app.asar 内，
 *    __dirname 会指向 asar 内部，spawn 其中的可执行文件必然失败。
 */
export function resolveRuntimeRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.join(app.getAppPath(), 'resources', 'runtime');
}

/** 注入接口：只暴露「取 runtime 根」一件事，不含任何 electron 类型。 */
export interface RuntimeResolver {
  /** runtime 根目录：dev = 项目内 resources/runtime；打包 = <resources>/runtime */
  resolveRuntimeRoot(): string;
}

/** electron 侧实现；由组合根 tools.ts 构造并注入给 tools-skill-run.ts。 */
export function createRuntimeResolver(): RuntimeResolver {
  return { resolveRuntimeRoot };
}
