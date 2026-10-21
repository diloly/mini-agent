/**
 * Checkpoint（续跑检查点）：「可续跑态」的格式定义与落盘 IO。
 *
 * 与 assistant 消息 meta 的区别：meta 存的是「展示态」（正文 + 工具步骤快照），
 * 供界面渲染；checkpoint 存的是「可续跑态」——中断时发给模型的完整 convo 快照，
 * 没有它就无法接着中断前的上下文继续生成。
 *
 * 存放位置：账号目录（<userData>/accounts/<id>/）下的 checkpoints/ 子目录，
 * 与 conversations.json 同级隔离；一个 convo 快照一个文件，按
 * conversationId__assistantMessageId 命名（conversationId 是 UUID 形态，
 * 只含小写十六进制与连字符，可安全直接拼进文件名）。
 *
 * 写入策略：由 IPC 适配层消费 harness 的 conversation-snapshot 事件触发——
 * loop 在每个工具结果回填后都会发这条事件，适配层据此整体覆盖写一次。
 * 被动崩溃（进程被杀）时磁盘上留下的仍是最近一次完整快照，
 * 用户点「继续」才有得可续。
 */
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { accountDir, atomicWrite, getActiveAccountId } from './storage';
import type { LlmMessage } from './providers/types';

/** 一条可续跑态快照 */
export interface CheckpointData {
  /** 格式版本号，用于将来演进；读取时严格校验 */
  version: 1;
  conversationId: string;
  /** 续跑对应的 assistant 消息 id */
  assistantMessageId: string;
  /** 中断时已消耗的轮数（runAgentLoop 的 turn 计数；续跑从 turn+1 继续） */
  turn: number;
  /** 中断时的完整 convo 快照（system + user + assistant(tool_calls) + tool 消息，浅拷贝已由调用方保证） */
  convo: LlmMessage[];
  /** 写入时间戳，诊断用 */
  savedAt: number;
}

/** 某账号的 checkpoint 目录：<账号目录>/checkpoints/ */
function checkpointsDir(accountId: string): string {
  return path.join(accountDir(accountId), 'checkpoints');
}

/**
 * 某个 checkpoint 文件的完整路径。
 * conversationId 是 UUID 形态，可安全直接拼进文件名（无路径分隔符与保留字符）。
 */
export function checkpointPath(
  accountId: string,
  conversationId: string,
  assistantMessageId: string,
): string {
  return path.join(checkpointsDir(accountId), `${conversationId}__${assistantMessageId}.json`);
}

/**
 * 覆盖写一版 checkpoint（先确保目录存在，再走 storage 的原子写）。
 * 无账号（未登录）时静默返回，与 storage 其余写路径同口径。
 * 入口自校验 turn>=1 的整数：validateCheckpoint 读取时会拒掉 turn<1 的快照，
 * 写了也读不回、更删不掉（删路径不校验 turn），纯废文件——与其依赖调用方纪律，
 * 不如在模块边界上挡住（当前唯一调用方 loop 已保证，此处防的是未来新调用方）。
 */
export async function writeCheckpoint(data: CheckpointData): Promise<void> {
  if (!Number.isInteger(data.turn) || data.turn < 1) {
    return;
  }
  const accountId = getActiveAccountId();
  if (!accountId) {
    return;
  }
  await mkdir(checkpointsDir(accountId), { recursive: true });
  await atomicWrite(
    checkpointPath(accountId, data.conversationId, data.assistantMessageId),
    data,
  );
}

/**
 * 读取 checkpoint。文件不存在或内容非法一律返回 null，绝不抛错——
 * 续跑入口把「没有 checkpoint」当作正常的「无可续跑」处理，不是系统异常。
 */
export async function readCheckpoint(
  accountId: string,
  conversationId: string,
  assistantMessageId: string,
): Promise<CheckpointData | null> {
  let raw: string;
  try {
    raw = await readFile(
      checkpointPath(accountId, conversationId, assistantMessageId),
      'utf8',
    );
  } catch {
    // 文件不存在 / 不可读：按「无 checkpoint」处理
    return null;
  }
  try {
    return validateCheckpoint(JSON.parse(raw) as unknown);
  } catch {
    // JSON 解析失败：磁盘文件可能被手改坏，同样按「无 checkpoint」处理
    return null;
  }
}

/** 删除单个 checkpoint；文件不存在时静默（unlink 的 ENOENT 直接吞掉） */
export async function deleteCheckpoint(
  accountId: string,
  conversationId: string,
  assistantMessageId: string,
): Promise<void> {
  await unlink(checkpointPath(accountId, conversationId, assistantMessageId)).catch(
    () => undefined,
  );
}

/**
 * 删除某会话的全部 checkpoint（删会话 / 清本地数据时连带清理）。
 * 目录不存在（从未写过 checkpoint）时静默；无账号时静默。
 */
export async function deleteCheckpointsForConversation(
  accountId: string,
  conversationId: string,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(checkpointsDir(accountId));
  } catch {
    // 目录不存在：本来就没有 checkpoint 可删
    return;
  }
  const prefix = `${conversationId}__`;
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith('.json')) {
      await unlink(path.join(checkpointsDir(accountId), name)).catch(() => undefined);
    }
  }
}

/**
 * 严格校验一版 checkpoint 快照；任何字段不满足要求都返回 null（绝不抛错）。
 * 磁盘文件允许被手改，非法数据若放行，会把畸形的 convo 发给模型或让续跑跳到错误的轮数。
 */
export function validateCheckpoint(raw: unknown): CheckpointData | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const data = raw as Partial<CheckpointData>;
  if (data.version !== 1) {
    return null;
  }
  if (typeof data.conversationId !== 'string' || data.conversationId.length === 0) {
    return null;
  }
  if (typeof data.assistantMessageId !== 'string' || data.assistantMessageId.length === 0) {
    return null;
  }
  if (typeof data.turn !== 'number' || !Number.isInteger(data.turn) || data.turn < 1) {
    return null;
  }
  if (!Array.isArray(data.convo)) {
    return null;
  }
  for (const message of data.convo) {
    if (!message || typeof message !== 'object') {
      return null;
    }
    const candidate = message as LlmMessage;
    if (
      candidate.role !== 'user' &&
      candidate.role !== 'assistant' &&
      candidate.role !== 'system' &&
      candidate.role !== 'tool'
    ) {
      return null;
    }
    if (typeof candidate.content !== 'string') {
      return null;
    }
  }
  return {
    version: 1,
    conversationId: data.conversationId,
    assistantMessageId: data.assistantMessageId,
    turn: data.turn,
    convo: data.convo as LlmMessage[],
    // savedAt 仅诊断用，缺失或非法时退化为 0，不影响可续跑性
    savedAt: typeof data.savedAt === 'number' ? data.savedAt : 0,
  };
}
