/**
 * SKILL.md frontmatter 的极简手写解析（零新依赖）。
 *
 * 只认「行首、无缩进」的 `name:` / `description:` / `allowed-tools:`，值为单行标量（可被成对引号包裹）；
 * 多行块标量（`|` / `>`）按降级策略拼接后续缩进行（见 readScalar）。
 *
 * `parseFrontmatter` 是**纯函数**：不读盘、不抛异常（解析与 IO 分离）；
 * 读盘由 `readSkillMdHead` 负责。本模块为纯逻辑，不含宿主桌面框架依赖。
 */
import * as fs from 'node:fs';

/** 只读文件前 N 字节用于解析 frontmatter（frontmatter 必在文件最前，避免为取两个字段读整份大文件） */
const FRONTMATTER_MAX_BYTES = 8_192;

export interface ParsedFrontmatter {
  /** 是否检测到 frontmatter 块（首行为 ---） */
  hasFrontmatter: boolean;
  /** frontmatter 里的 name（无则 undefined） */
  name?: string;
  /** frontmatter 里的 description（无则 undefined） */
  description?: string;
  /**
   * frontmatter 里 `allowed-tools` 的**原样标量值**（无则 undefined），形如 `Read,Bash`。
   * 刻意**不做切分**：本模块只负责「取标量」，切分交给消费方（skills/content.ts）。
   * 注意：YAML 数组写法（`allowed-tools:` 换行后 `- Read`）解析不到 ⇒ 返回 undefined，
   * 属**有意降级**（拿不到就不提示，宁可不提示也不误报）。
   */
  allowedTools?: string;
  /** 去掉 frontmatter 后的正文（trim 前后空白）；无 frontmatter 时为传入的原文 */
  body: string;
}

/** 去掉外层成对的单/双引号；未成对则原样返回 */
function unquote(value: string): string {
  if (value.length >= 2) {
    const head = value.charAt(0);
    const tail = value.charAt(value.length - 1);
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * 读取一个键的值。
 * - 普通单行标量：去空白 + 去成对引号；
 * - **降级处理块标量**（值以 `|` 或 `>` 开头）：向下拼接「比 key 行更缩进」的后续行，
 *   `|` 用换行连接、`>` 用空格连接，遇到非缩进行停止；拼接结果 trim 后为空才回退空串。
 *   理由：`description: |` 的内容在**下一行**，若只取「第一行」会得到空串，技能描述就丢了。
 * @returns value 与本次额外消费的行数（供调用方跳过这些行）
 */
function readScalar(
  lines: string[],
  keyLineIndex: number,
  rawValue: string,
  endExclusive: number,
): { value: string; consumed: number } {
  const trimmed = rawValue.trim();
  const marker = trimmed.charAt(0);
  if (marker === '|' || marker === '>') {
    const parts: string[] = [];
    let index = keyLineIndex + 1;
    for (; index < endExclusive; index += 1) {
      const line = lines[index];
      if (line.trim().length === 0) {
        parts.push('');
        continue;
      }
      if (!/^[ \t]/.test(line)) {
        break; // 非缩进行 ⇒ 块标量结束
      }
      parts.push(line.trim());
    }
    const joined = marker === '|' ? parts.join('\n') : parts.join(' ');
    return { value: joined.trim(), consumed: index - keyLineIndex - 1 };
  }
  return { value: unquote(trimmed), consumed: 0 };
}

/**
 * 解析 SKILL.md 文本的 frontmatter。**纯函数、不读盘、不抛异常**：
 * 传入内容不符合 frontmatter 约定时，返回 `{ hasFrontmatter:false, body: 原文 }`。
 * 只识别行首、无缩进的 `name:` / `description:` / `allowed-tools:`，值为单行标量（可被成对引号包裹）。
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);

  // 首行必须是单独成行的 ---；否则视为「无 frontmatter」
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { hasFrontmatter: false, body: raw };
  }

  // 找下一个单独成行的 --- 作为结束行；找不到 ⇒ 视为不合法，同样退回「无 frontmatter」
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex < 0) {
    return { hasFrontmatter: false, body: raw };
  }

  let name: string | undefined;
  let description: string | undefined;
  let allowedTools: string | undefined;
  for (let i = 1; i < closingIndex; i += 1) {
    // 正则锚定行首且首字符即 key：带前导空白的行不会匹配（满足「行首、无缩进」）
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(lines[i]);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (key !== 'name' && key !== 'description' && key !== 'allowed-tools') {
      continue;
    }
    const scalar = readScalar(lines, i, match[2], closingIndex);
    i += scalar.consumed;
    if (key === 'name') {
      if (name === undefined) {
        name = scalar.value;
      }
    } else if (key === 'description') {
      if (description === undefined) {
        description = scalar.value;
      }
    } else if (allowedTools === undefined) {
      allowedTools = scalar.value;
    }
  }

  const body = lines.slice(closingIndex + 1).join('\n').trim();
  return { hasFrontmatter: true, name, description, allowedTools, body };
}

/**
 * 只取文件前 FRONTMATTER_MAX_BYTES 字节（读盘辅助，IO 与解析分离）。
 * 文件不存在 / 不可读时会 reject —— 由调用方捕获并「跳过该技能」，不向上扩散。
 */
export async function readSkillMdHead(skillMdPath: string): Promise<string> {
  const handle = await fs.promises.open(skillMdPath, 'r');
  try {
    const buffer = Buffer.alloc(FRONTMATTER_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_MAX_BYTES, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}
