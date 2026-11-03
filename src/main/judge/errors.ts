/**
 * judge 侧的错误 → 可读简体中文。
 *
 * 核心目的：**不把 fs 的原始 message 透到渲染层**。Node 的 fs 错误形如
 * `EACCES: permission denied, open 'C:\Users\<用户名>\...\judge-cases.json'`，
 * 既不解决问题，又把本机用户名与目录结构写进了界面的 tooltip。
 * 按 errno 归类后给一句用户能行动的话，细节留给主进程日志。
 */
import { ProviderError } from '../providers/types';

/** 需要脱敏的 fs 错误码（这些错误的 message 一定带绝对路径） */
const FS_ERROR_CODES = new Set([
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOSPC',
  'EROFS',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'EISDIR',
  'ENOTDIR',
]);

/**
 * @param error 捕获到的任意异常
 * @param fallback 兜底文案（各调用点语义不同：写入失败 / 评测失败 / 保存评价失败）
 */
export function readableJudgeError(error: unknown, fallback: string): string {
  if (error instanceof ProviderError) {
    return error.userMessage;
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && FS_ERROR_CODES.has(code)) {
      return '本地评测数据读写失败（磁盘或权限问题）';
    }
    if (error.message.length > 0) {
      return `${fallback}：${error.message.slice(0, 120)}`;
    }
  }
  return fallback;
}
