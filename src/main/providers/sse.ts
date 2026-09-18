/**
 * 流式响应解析工具：SSE（DeepSeek / OpenAI 兼容）与 NDJSON（Ollama）共用一套按行切分逻辑。
 *
 * 关键实现点：
 * 1. 使用 TextDecoder({ stream: true }) 增量解码，跨 chunk 的多字节 UTF-8 字符不会被截断成乱码；
 * 2. 维护残留行缓冲，只有遇到 \n 才产出完整行，末尾不足一行的部分留到下一轮；
 * 3. 全程支持 AbortSignal：中止时立即 cancel 底层 reader，避免悬挂的 read()。
 */
import { ProviderError } from './types';

/** 单行回调 */
type LineHandler = (line: string) => void;

/** 去掉行尾的 \r（兼容 CRLF 换行） */
function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * 把缓冲区中的完整行喂给 handler，并返回未解析完的残留部分。
 * @param buffer 当前累积的文本
 * @param onLine 完整行回调
 * @returns 残留的未完成行
 */
function drainCompleteLines(buffer: string, onLine: LineHandler): string {
  let start = 0;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    onLine(stripCarriageReturn(buffer.slice(start, index)));
    start = index + 1;
    index = buffer.indexOf('\n', start);
  }
  return start === 0 ? buffer : buffer.slice(start);
}

/**
 * 逐行遍历二进制流。
 * @param stream 响应体可读流
 * @param signal 中止信号
 * @param onLine 完整行回调
 */
async function iterateLines(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onLine: LineHandler,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const handleAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) {
    handleAbort();
  } else {
    signal.addEventListener('abort', handleAbort, { once: true });
  }

  try {
    for (;;) {
      if (signal.aborted) {
        throw createAbortError();
      }
      let result: { done: boolean; value?: Uint8Array } = { done: false };
      try {
        result = await reader.read();
      } catch (error) {
        // abort 触发的 cancel 会让挂起的 read() 抛 TypeError，
        // 这里还原成 AbortError，避免「用户点停止」被误报成网络故障
        if (signal.aborted) {
          throw createAbortError();
        }
        throw error;
      }
      if (result.done) {
        break;
      }
      const value = result.value;
      if (value) {
        // stream: true 保证跨 chunk 的多字节字符被保留到下一轮再解码
        buffer += decoder.decode(value, { stream: true });
        buffer = drainCompleteLines(buffer, onLine);
      }
    }
    // 冲刷解码器残留字节，再处理最后一行（可能没有换行结尾）
    buffer += decoder.decode();
    buffer = drainCompleteLines(buffer, onLine);
    if (buffer.length > 0) {
      onLine(stripCarriageReturn(buffer));
    }
  } catch (error) {
    // 非正常结束（解析异常 / 中止）：底层连接可能还挂着一个未读完的 read()，主动取消
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', handleAbort);
    try {
      reader.releaseLock();
    } catch {
      // 流已被 cancel / 关闭时 releaseLock 会抛 TypeError，不能让它覆盖真实异常
    }
  }
}

/** 构造一个 name 为 AbortError 的异常，供统一的中止判定使用 */
export function createAbortError(): Error {
  const error = new Error('请求已被中止');
  error.name = 'AbortError';
  return error;
}

/**
 * 解析 SSE 流。
 * 约定：以空行作为事件分隔符，data: 前缀行可多行拼接，遇到 [DONE] 由调用方自行判断结束。
 *
 * @param stream 响应体可读流
 * @param handlers.onData 每个事件的 data 载荷（已去掉前缀并 trim）
 * @param signal 中止信号
 */
export async function parseSse(
  stream: ReadableStream<Uint8Array>,
  handlers: { onData: (data: string) => void },
  signal: AbortSignal,
): Promise<void> {
  let eventData = '';
  const flushEvent = (): void => {
    if (eventData.length === 0) {
      return;
    }
    const data = eventData;
    eventData = '';
    handlers.onData(data);
  };

  await iterateLines(
    stream,
    signal,
    (line) => {
      if (line === '') {
        // 空行：一个事件结束
        flushEvent();
        return;
      }
      if (line.startsWith(':')) {
        // 注释行（心跳）
        return;
      }
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        eventData = eventData.length === 0 ? payload : `${eventData}\n${payload}`;
      }
      // 其余字段（event: / id: / retry:）本项目不使用，直接忽略
    },
  );

  // 部分实现在流结束时不会补空行，这里补刷一次
  flushEvent();
}

/**
 * 解析 NDJSON 流（每行一个完整 JSON，Ollama 使用）。
 * @param stream 响应体可读流
 * @param handlers.onRecord 每行解析出的 JSON 对象
 * @param signal 中止信号
 */
export async function parseNdjson(
  stream: ReadableStream<Uint8Array>,
  handlers: { onRecord: (record: unknown) => void },
  signal: AbortSignal,
): Promise<void> {
  await iterateLines(
    stream,
    signal,
    (line) => {
      const text = line.trim();
      if (text.length === 0) {
        return;
      }
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        throw new ProviderError(
          'BAD_RESPONSE',
          '模型返回内容解析失败',
          true,
        );
      }
      handlers.onRecord(record);
    },
  );
}

/** 合并后的信号句柄：需要在使用结束后调用 dispose 释放定时器与监听器 */
export interface CombinedSignal {
  signal: AbortSignal;
  /** 是否由超时触发（用于区分「用户中止」与「请求超时」） */
  isTimeout: () => boolean;
  /** 释放资源 */
  dispose: () => void;
}

/**
 * 合并多个信号并附加可选超时。
 * 不依赖 AbortSignal.any，以兼容不同 Electron / Node 版本。
 *
 * @param signals 原始信号列表（可含 undefined）
 * @param timeoutMs 超时毫秒数，0 或负数表示不设超时
 */
export function combineSignals(
  signals: Array<AbortSignal | undefined>,
  timeoutMs = 0,
): CombinedSignal {
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = (): void => {
    controller.abort();
  };
  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    isTimeout: () => timedOut,
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
      }
      for (const signal of signals) {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
