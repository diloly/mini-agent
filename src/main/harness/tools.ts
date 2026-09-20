/**
 * 内置工具集合：三个全部只读（不写文件、不执行 shell）。
 *
 * 安全底线：
 * - calculator：白名单正则彻底排除字母/标识符，杜绝任何属性访问（如 `process.env`）；
 * - read_text_file：路径必须落在工作区内，且用 realpath 复核防符号链接逃逸；
 * - 任何工具执行异常都转成可读字符串返回，绝不向上抛。
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '../providers/types';
import type { HarnessTool, ToolResult } from './types';

/**
 * 工作区根目录：read_text_file 只允许读取该目录内的文件。
 *
 * 位置策略：
 * - 开发期：项目目录的**上一级**下的 workspace/（本项目即 E:\code\LocalAgent\workspace），
 *   便于在 IDE 里直接看到测试文件，且与代码仓库解耦（无需加 .gitignore）；
 * - 打包后：app.asar 是只读归档、且用户机器上并不存在开发期那个路径，
 *   因此改放 userData 下的 workspace/。
 *
 * 实现注意：开发期路径由 dirname(getAppPath()) 推导，**不硬编码盘符**，
 * 换机器 / 换项目目录都无需改代码。
 */
function getWorkspaceRoot(): string {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'workspace');
  }
  return path.join(path.dirname(app.getAppPath()), 'workspace');
}

/** 中文星期，用于时间展示 */
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 把 JSON 字符串解析为对象；解析失败回退为 {}。
 * 工具自己负责解析入参，loop 只负责透传原始字符串。
 */
function parseArgs<T>(rawArgs: string): T {
  if (!rawArgs) {
    return {} as T;
  }
  try {
    return JSON.parse(rawArgs) as T;
  } catch {
    return {} as T;
  }
}

/** 当前本地时间，形如 `2026-09-18 17:53:21 (周五)` */
const getCurrentTime: HarnessTool = {
  definition: {
    name: 'get_current_time',
    description: '获取当前本地时间（含星期）',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async execute(_rawArgs: string, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) {
      return { ok: false, text: '已停止：获取时间被用户中止' };
    }
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return { ok: true, text: `${date} ${time} (${WEEKDAY_CN[now.getDay()]})` };
  },
};

/**
 * 算术求值：仅允许数字与 + - * / ( ) 与空白。
 * 白名单正则已排除一切字母，故 Function 求值无法访问任何属性，可安全执行。
 */
const calculator: HarnessTool = {
  definition: {
    name: 'calculator',
    description: '对算术表达式求值（仅含数字与 + - * / ( )）',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '仅含数字与 + - * / ( ) 的算术表达式',
        },
      },
      required: ['expression'],
    },
  },
  async execute(rawArgs: string, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) {
      return { ok: false, text: '已停止：计算被用户中止' };
    }
    const { expression } = parseArgs<{ expression?: string }>(rawArgs);
    const expr = typeof expression === 'string' ? expression : '';
    if (expr.length === 0) {
      return { ok: false, text: '参数错误：缺少 expression 字段' };
    }
    if (expr.length > 200) {
      return { ok: false, text: '表达式过长（上限 200 字符）' };
    }
    // 硬性白名单：只允许数字、运算符、括号、空白；任何字母都进不来
    if (!/^[\d+\-*/().\s]+$/.test(expr)) {
      return { ok: false, text: '表达式含非法字符，仅允许数字与 + - * / ( )' };
    }
    try {
      // 白名单已排除标识符，Function 求值无属性访问风险
      const value = Function('"use strict"; return (' + expr + ')')();
      if (typeof value === 'number' && Number.isFinite(value)) {
        return { ok: true, text: String(value) };
      }
      return { ok: false, text: '表达式无效' };
    } catch {
      // 除数归零、语法异常等一律转成可读字符串，绝不上抛
      return { ok: false, text: '表达式无效' };
    }
  },
};

/**
 * 读工作区内文本文件。
 * 安全顺序：先校验路径落在 root 内 → realpath 复核（防符号链接逃逸）→ 确认是文件 → 读取。
 */
const readTextFile: HarnessTool = {
  /**
   * 这里用 getter 而不是静态字面量，原因有两层：
   * 1. 工作区绝对路径只有运行时才知道，静态字面量写不进去；
   * 2. 这段 description 是模型能直接读到的**唯一环境事实**——模型对"我在哪、我能碰什么"
   *    的全部认知都来自工具声明。声明里不写真实路径，模型缺事实时就会用先验补全，
   *    编出"虚拟工作区／需要上传文件"这类说法（实测出现过）。
   */
  get definition(): ToolDefinition {
    const root = getWorkspaceRoot();
    return {
      name: 'read_text_file',
      description:
        `读取文本文件（只读）。当前工作区根目录为 ${root}；` +
        `path 填相对该目录的路径（如 test.txt）。` +
        `工作区之外的本机路径一律拒绝，本工具无法读取工作区外的任何文件。`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对于工作区根目录的路径，例如 test.txt',
          },
        },
        required: ['path'],
      },
    };
  },
  async execute(rawArgs: string, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) {
      return { ok: false, text: '已停止：读取被用户中止' };
    }
    const { path: relPath } = parseArgs<{ path?: string }>(rawArgs);
    const filePath = typeof relPath === 'string' ? relPath : '';
    if (filePath.length === 0) {
      return { ok: false, text: '参数错误：缺少 path 字段' };
    }

    const root = getWorkspaceRoot();
    // 解析用户传入路径到绝对路径；若传入绝对路径，resolve 会直接采用，继而越界检查会拦下
    const target = path.resolve(root, filePath);

    // 第一道门：解析后的相对路径不能以 .. 开头，且不可以是绝对路径
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, text: `拒绝访问：路径不在工作区内（当前工作区根目录：${root}）` };
    }

    try {
      // 工作区根目录本身必须存在，否则给出引导文案
      const rootStat = await fs.promises.stat(root);
      if (!rootStat.isDirectory()) {
        return { ok: false, text: `工作区目录不存在：${root}，请先创建该目录并放入文件` };
      }
    } catch {
      return { ok: false, text: `工作区目录不存在：${root}，请先创建该目录并放入文件` };
    }

    try {
      // 第二道门：realpath 解析符号链接后的真实路径，确认仍落在 root 内（防逃逸）
      const realTarget = await fs.promises.realpath(target);
      const realRel = path.relative(root, realTarget);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        return { ok: false, text: `拒绝访问：路径不在工作区内（当前工作区根目录：${root}）` };
      }
      const stat = await fs.promises.stat(realTarget);
      if (!stat.isFile()) {
        return { ok: false, text: '目标不是文件，无法读取' };
      }
      let content = await fs.promises.readFile(realTarget, 'utf8');
      if (content.length > 20000) {
        // 超长截断，避免把巨量文本塞进上下文
        content = `${content.slice(0, 20000)}\n…（内容已截断）`;
      }
      return { ok: true, text: content };
    } catch {
      // 文件不存在 / 无权限等都转成可读文案，让模型自己决定怎么回复
      return { ok: false, text: `文件读取失败：${filePath}（请确认文件存在于工作区 ${root} 内）` };
    }
  },
};

/** 内置工具列表；loop 会取其 definition 暴露给模型 */
export const HARNESS_TOOLS: HarnessTool[] = [getCurrentTime, calculator, readTextFile];

/** 按工具名查找，找不到返回 undefined（loop 会据此生成可读错误并回灌） */
export function findTool(name: string): HarnessTool | undefined {
  return HARNESS_TOOLS.find((tool) => tool.definition.name === name);
}
