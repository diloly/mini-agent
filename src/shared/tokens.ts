/**
 * 上下文用量的 token 粗估（无 tokenizer 依赖）。
 *
 * 为什么不引 tokenizer：本项目支持多 provider（DeepSeek / Ollama / 任意 OpenAI
 * 兼容服务），各家 BPE 词表不同，装一份 tokenizer 只能覆盖其中一家、体积还不小。
 * 统计只用于判断「还剩多少余量」（以及后续的上下文压缩触发阈值），误差 ±20%
 * 完全够用；真要精确到 token，只能由各家自己的 count_tokens 接口给出。
 *
 * 经验口径（刻意偏保守高估）：
 * - CJK 字符（汉字 / 假名 / 谚文 / 全角标点）：约 1 字符 = 1 token
 * - 其余字符（英文 / 数字 / 符号 / 代码）：约 4 字符 = 1 token
 *
 * 宁可让用户提前觉得「快满了」，也不要低估到模型端才爆窗——后者是静默截断，
 * 用户完全不知道上下文已经丢了一截。
 */

/** 判断一个码点是否属于「按 1 字符 ≈ 1 token 计」的 CJK 区段 */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x3000 && code <= 0x303f) || // CJK 符号与标点（，。「」等）
    (code >= 0xff00 && code <= 0xffef) || // 全角字符
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0xac00 && code <= 0xd7af) // 谚文
  );
}

/**
 * 估算一段文本的 token 数。
 * 按码点迭代（for...of），emoji 等代理对按 1 个字符计，不会被算成两个。
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isCjkCodePoint(code)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

/** 估算一组消息的 token 总量（只统计 content，工具步骤等元数据不计入上下文） */
export function estimateMessagesTokens(messages: ReadonlyArray<{ content: string }>): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.content);
  }
  return total;
}
