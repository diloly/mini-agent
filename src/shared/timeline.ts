/**
 * 正文与工具调用的时间线装配。
 *
 * 主进程在「本轮文本流完、即将执行工具」时给每个 ToolStep 打上 `contentOffset`
 * （该步开始时正文已累积的字符数，见 `main/harness/loop.ts`）。本模块据此把一整块
 * 正文切成若干段，与工具调用按时间顺序交错。
 *
 * 渲染层与会话 md 镜像**共用这一份逻辑**：本项目对跨产物一致性要求高，
 * 各写一份迟早会漂移。
 *
 * 向后兼容：旧数据没有 `contentOffset` ⇒ 退化为「工具整块在前、正文整块在后」
 * 的老排法（与改动前的渲染层行为一致）。
 */
import type { ToolStep } from './types';

/** 时间线上的一个片段：一段正文，或一组发生在同一分界点的工具调用 */
export type TimelineItem =
  | { kind: 'text'; text: string }
  | { kind: 'steps'; steps: ToolStep[] };

/**
 * 取一步的分界点，并夹取到 [0, 正文长度]。
 * 缺字段时按「正文末尾」处理（附到时间线最后）。
 */
function offsetOf(step: ToolStep, contentLength: number): number {
  const raw = typeof step.contentOffset === 'number' ? step.contentOffset : contentLength;
  return Math.max(0, Math.min(raw, contentLength));
}

/**
 * 把正文与工具调用装配成按时间顺序排列的片段序列。
 * @param content 该条消息的完整正文
 * @param steps 工具步骤；数组顺序即调用顺序（时间顺序）
 */
export function buildTimeline(content: string, steps: ToolStep[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const hasOffset = steps.some((step) => typeof step.contentOffset === 'number');

  // 没有任何分界点信息（旧数据）：保持改动前的排法
  if (!hasOffset) {
    if (steps.length > 0) {
      items.push({ kind: 'steps', steps });
    }
    if (content.length > 0) {
      items.push({ kind: 'text', text: content });
    }
    return items;
  }

  let cursor = 0;
  let index = 0;
  while (index < steps.length) {
    const at = Math.max(cursor, offsetOf(steps[index], content.length));
    if (at > cursor) {
      items.push({ kind: 'text', text: content.slice(cursor, at) });
      cursor = at;
    }
    // 同一分界点上的连续步骤归为一组：一轮里的多个工具共用同一个分界点。
    // group 为空时至少吸收一步，保证 index 必定前进、不会死循环。
    const group: ToolStep[] = [];
    while (index < steps.length) {
      const nextAt = Math.max(cursor, offsetOf(steps[index], content.length));
      if (nextAt !== at && group.length > 0) {
        break;
      }
      group.push(steps[index]);
      index += 1;
    }
    items.push({ kind: 'steps', steps: group });
  }

  if (cursor < content.length) {
    items.push({ kind: 'text', text: content.slice(cursor) });
  }
  return items;
}
