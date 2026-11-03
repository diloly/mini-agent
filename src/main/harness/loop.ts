/**
 * 手写 agent loop：带 tools 反复调用模型，直到模型不再请求工具或达到轮数上限。
 *
 * 流程：
 *   用户提问 → 带 tools 调模型 → 有 tool_calls？→ 本地串行执行 → 结果回填 → 再调模型（最多 16 轮）
 *                                                  └ 无 tool_calls → 输出文本，结束
 *
 * 关键约定：
 * - 工具执行失败绝不让整轮走到 chat:error——失败文案同样作为 tool 消息回灌给模型，由其自行解释；
 * - text 跨轮累积，最终返回完整全文；
 * - 每轮开头检查 signal.aborted，已中止立即抛 createAbortError()，让上层按 ABORTED 收尾；
 * - 工具并行执行不做（MVP 串行，顺序更利于 UI 展示）。
 *
 * 与外界的唯一通道是 **HarnessEvent 事件**（events.ts）：
 * loop 只陈述事实，不关心谁在听、听者要什么 UI 形状。UI 信封（requestId /
 * messageId）、展示字段（contentOffset）、落盘时机都由消费方（IPC 适配层）自己决定。
 */
import type { FinishReason } from '../../shared/types';
import type {
  LLMProvider,
  LlmMessage,
  LlmToolCall,
  ProviderConfig,
} from '../providers/types';
import { createAbortError } from '../providers/sse';
import type { HarnessEventSink, HarnessToolCallRecord } from './events';
import { findTool, harnessToolsFor } from './tools';
import type { ToolContext, ToolResult } from './types';

/**
 * agent loop 的最大轮数：超过则强制收尾，避免模型无限调用工具。
 *
 * 注意「轮」的口径：一轮 = 一次「模型回话」。模型在一轮里可以同时输出正文与多个
 * tool_calls，所以轮数远小于工具调用次数。
 *
 * 为什么要放宽到 16：系统规则要求「开始某一步之前、完成某一步之后，各调用一次
 * update_plan」，于是每个计划步骤实际要占约 2 轮。实测 4 步任务约需 9~11 轮，
 * 旧的 8 轮必然撞顶（用户实机复现过：4 步全完成、6 个工具执行完，却卡在上限收尾）。
 * 16 轮可覆盖 6~7 步的任务。不再往上调：每轮都是一次真实的模型请求（计费 + 延迟），
 * 上限过高只会让跑飞的模型多烧 token，并不会让任务更容易成功。
 */
const MAX_TURNS = 16;

/**
 * 工具结果回显给模型前的最大长度，超出部分截断。
 *
 * 导出是给 judge 的 case 快照复用（judge/snapshot.ts）：评测看到的轨迹片段长度
 * 必须与模型当时看到的完全一致，否则「模型没看到完整结果」这件事就无从判断。
 */
export const TOOL_RESULT_PREVIEW_LIMIT = 200;

/** 模型开始请求某个工具时的即时通知（用于 UI 立刻显示「正在调用」） */
interface ToolCallStartInfo {
  id: string;
  name: string;
}

/** loop 的最终产物（harness 口径：事实记录，不含 UI / persistence 字段） */
export interface HarnessResult {
  text: string;
  finishReason: FinishReason;
  /** 实际消耗的轮数 */
  turns: number;
  /** 全部工具调用的事实记录（顺序即调用顺序；渲染用的 ToolStep 由消费方转换） */
  steps: HarnessToolCallRecord[];
}

/**
 * 执行单个工具调用，并把结果回填进上下文。
 * 不抛异常：工具不存在、执行异常都转成可读字符串，照常回灌给模型。
 *
 * 全程只发事件：tool-call-start（进函数时）/ tool-call-end（出结果时）/
 * plan-updated（工具带回计划时）/ conversation-snapshot（结果回填后）。
 * 展示字段与落盘与否，全部由事件消费方决定。
 */
async function executeToolCall(
  call: LlmToolCall,
  convo: LlmMessage[],
  records: HarnessToolCallRecord[],
  emit: HarnessEventSink,
  signal: AbortSignal,
  toolContext: ToolContext,
  turn: number,
): Promise<void> {
  // 执行前先广播「正在调用」：此时模型参数已流完，带上完整 arguments，
  // 消费方能把 running 占位从流式期间的空参数刷新成完整参数（长耗时工具尤其重要）。
  // 展示需要的正文分界点由消费方按此刻自己看到的正文长度折算，loop 不生产该字段。
  emit({ type: 'tool-call-start', id: call.id, name: call.name, arguments: call.arguments });

  const start = Date.now();
  const tool = findTool(call.name, toolContext);

  let result: ToolResult;
  try {
    if (!tool) {
      // 模型请求了一个不存在的工具：结构化失败，但照常回灌，不中断整轮。
      // 🔴 回灌文案必须给出可执行的下一步，不能只回一句「未知工具」。实测（2026-10-13）：
      //    模型读完技能文档后，会把文档里写的 CLI 命令当成工具名发出来
      //    （如 `westock search`、`westock-data:westock.quote`），而本应用没有「执行任意命令」的通用入口。
      //    只回「未知工具」等于没给任何可用信息，模型只能换个名字反复试，最后放弃。
      //    故必须讲清三件事：① 有哪些工具可用；② 本应用没有通用命令执行入口 —— 只能运行技能包内
      //    **已存在的**脚本/程序文件，不能执行任意外部命令；
      //    ③ 技能类需求该改走哪条路（包内脚本/程序能跑；装到技能目录之外的独立程序不能跑）。
      const availableNames = harnessToolsFor(toolContext).map(
        (item) => item.define(toolContext).name,
      );
      result = {
        ok: false,
        text:
          `未知工具：${call.name}。本应用没有名为「${call.name}」的工具，` +
          `也没有「执行任意命令」的通用入口。\n` +
          `本次实际可用的工具只有这 ${availableNames.length} 个：${availableNames.join('、')}。\n` +
          `如果「${call.name}」来自某个技能文档里写的命令，请注意本应用的能力边界：` +
          `① 技能包内**已存在的**脚本/程序文件可以用 run_skill_script 运行（skill = 技能标识符，` +
          `script = 相对该技能目录的路径，如 scripts/setup.cjs 或 bin/tool.exe，` +
          `支持 .py / .js / .mjs / .cjs / .exe / .bat / .cmd / .ps1 / .sh）；` +
          `② 但技能目录**之外**的程序（如装到用户主目录的某个 CLI）越界、执行不了。` +
          `若该技能的核心能力属于 ②，请如实告诉用户「该技能在当前环境中无法直接使用」` +
          `（可提示把可执行文件装进技能目录内），不要编造结果，也不要改用其它工具硬凑。`,
      };
    } else {
      // execute 自行负责解析参数与吞掉异常，返回 { ok, text }
      result = await tool.execute(call.arguments, signal, toolContext);
    }
  } catch (error) {
    // execute 约定不抛异常，但以防万一漏网，这里兜底，绝不让整轮走到 chat:error
    result = { ok: false, text: `工具执行异常：${error instanceof Error ? error.message : String(error)}` };
  }

  const elapsedMs = Date.now() - start;
  const resultPreview = result.text.slice(0, TOOL_RESULT_PREVIEW_LIMIT);

  // 无论 ok 与否都把结果回填为 tool 消息，让模型自己解释失败原因
  convo.push({
    role: 'tool',
    content: result.text,
    toolCallId: call.id,
    name: call.name,
  });

  const record: HarnessToolCallRecord = {
    id: call.id,
    name: call.name,
    args: call.arguments,
    // ✓ / ✕ 由 ok 决定：被安全边界拒绝、参数非法等都算失败
    status: result.ok ? 'done' : 'error',
    result: resultPreview,
    elapsedMs,
  };
  records.push(record);
  emit({
    type: 'tool-call-end',
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    ok: result.ok,
    preview: resultPreview,
    elapsedMs,
  });
  // 工具带回的计划清单（目前仅 update_plan）：数据由工具产出，事件由 loop 外发
  if (result.plan) {
    emit({ type: 'plan-updated', steps: result.plan });
  }
  // 上下文的完整快照：中性事实，是否落盘（如「可续跑态」）由消费方决定。
  // 放在结果回填之后发布，消费方拿到的 convo 一定是「N = N」的完整形态。
  emit({ type: 'conversation-snapshot', convo: [...convo], turn });
}

/**
 * 运行手写 agent loop。
 * @param provider 模型适配器
 * @param providerConfig 运行期配置（含明文 Key）
 * @param messages 已含本轮 user 提问的上下文
 * @param signal 中止信号
 * @param emit 领域事件出口（唯一的外部通道，见 events.ts）
 * @param toolContext 工具执行上下文（工作区 / 备份目录 / 会话 id），逐层传给工具
 */
export async function runAgentLoop(params: {
  provider: LLMProvider;
  providerConfig: ProviderConfig;
  messages: LlmMessage[];
  signal: AbortSignal;
  emit: HarnessEventSink;
  toolContext: ToolContext;
  /** 续跑时中断前已生成的正文；loop 内部 text 以此为初值，result.text 含旧正文，text 事件仍只推增量 */
  initialText?: string;
  /** 续跑从第几轮继续（中断时已消耗的轮数 +1）；缺省从第 1 轮开始 */
  startTurn?: number;
  /** 续跑说明；半截工具批次补全完成后追加到 convo 末尾（位置必须在 tool 消息之后） */
  resumeNote?: string;
}): Promise<HarnessResult> {
  const {
    provider,
    providerConfig,
    messages,
    signal,
    emit,
    toolContext,
    // 续跑三参：解构漏掉会在本行等处直接 ReferenceError（首跑就炸），
    // 必须与签名里的声明一一对应
    initialText,
    startTurn,
    resumeNote,
  } = params;
  // 复制一份上下文，loop 内部会不断追加 assistant / tool 消息，不能污染入参
  const convo: LlmMessage[] = [...messages];

  // 续跑时 text 以中断前已生成的正文为初值：消费方已有旧正文，
  // text 事件只会推出增量，两者拼接后与 result.text 一致
  let text = initialText ?? '';
  const steps: HarnessToolCallRecord[] = [];
  // 中间轮截断记录（轮号）。旧实现只保留「最后一轮」的 finishReason：模型第 N 轮
  // （N < 最后一轮）输出撞长度上限被截断时，这个事实整体丢弃 —— 用户看不到，
  // 模型自己也不知道上一条 assistant 消息不完整、工具参数可能是残缺 JSON，
  // 会当作无事发生继续说（MEMORY.md Harness 节记录的已知缺口，2026-10-16 补）。
  const truncatedTurns: number[] = [];

  // 续跑起点处理（普通首跑时 startTurn 缺省为 1，这段同样执行、只是没有悬空批次）：
  //
  // ① 半截工具批次补全：中断（用户点停止 / 进程崩溃）可能发生在「模型一轮发出 N 个
  //    tool_calls、只回填了前 K 个结果」的中间态。checkpoint 的 convo 就是那个形态，
  //    直接发给模型会被 OpenAI 兼容接口拒绝——协议要求 assistant 声明的每个
  //    tool_call 都必须有一条 tool 结果与之对应。故续跑时先把缺失的 K+1..N 补跑完，
  //    让 convo 恢复「N = N」的完整形态再进 turn 循环。
  // ② 补跑期间每个工具回填后 loop 都会发 conversation-snapshot：补跑同样可能被
  //    中止 / 崩溃，消费方据此增量落盘才有得可续。
  // ③ 无论有没有悬空批次，都先发一版快照：保证 resume 起点（startTurn-1 轮）有据可查。
  // ④ resumeNote 放在补全之后：assistant(tool_calls) 与 tool 消息在协议上必须相邻，
  //    system 提示插在两者之间会破坏兼容服务端的位置假设（与截断回灌同一纪律）。
  // 补跑循环是否已发过快照（true 时下面的兜底快照就是纯冗余 IO，跳过）
  let snapshotEmitted = false;
  const lastMessage = convo.at(-1);
  if (
    lastMessage &&
    lastMessage.role === 'assistant' &&
    lastMessage.toolCalls &&
    lastMessage.toolCalls.length > 0
  ) {
    // 从队尾向前收集紧邻的 tool 消息（即该 assistant 声明之后已回填的结果）
    const trailingToolMessages: LlmMessage[] = [];
    for (let i = convo.length - 1; i >= 0; i -= 1) {
      const message = convo[i];
      if (message.role !== 'tool') {
        break;
      }
      trailingToolMessages.unshift(message);
    }
    // 悬空判定：已回填条数 < 声明条数。tool 消息按 toolCallId 与 call 对应
    const filledIds = new Set(trailingToolMessages.map((message) => message.toolCallId ?? ''));
    const missingCalls = lastMessage.toolCalls.filter((call) => !filledIds.has(call.id));
    for (const call of missingCalls) {
      // 与 turn 循环同一纪律：每补一个工具前检查中止，已停止就立即抛，不再补下一个
      if (signal.aborted) {
        throw createAbortError();
      }
      // text 此刻 = initialText（续跑时即中断前已生成的正文）
      await executeToolCall(call, convo, steps, emit, signal, toolContext, (startTurn ?? 1) - 1);
      snapshotEmitted = true;
    }
  }
  // 仅续跑路径发兜底快照（③）：补跑循环已发过同 turn 快照时跳过，避免每次续跑
  // 多一次全量 convo 序列化。首跑（startTurn 缺省）同样不发——此时一个工具都
  // 没跑过，turn=0 的快照过不了 validateCheckpoint 的 turn>=1 校验，发了也是废文件，
  // 还会让正常首跑的每条 abort 都留下一个永远续不动的 checkpoint
  if (!snapshotEmitted && startTurn !== undefined) {
    emit({ type: 'conversation-snapshot', convo: [...convo], turn: startTurn - 1 });
  }
  if (resumeNote) {
    convo.push({ role: 'system', content: resumeNote });
  }

  for (let turn = startTurn ?? 1; turn <= MAX_TURNS; turn += 1) {
    // 每轮开头先检查中止：用户点停止后尽快退出，避免再发一次请求烧 token
    if (signal.aborted) {
      throw createAbortError();
    }

    const result = await provider.chatStream(
      {
        messages: convo,
        tools: harnessToolsFor(toolContext).map((tool) => tool.define(toolContext)),
        signal,
      },
      providerConfig,
      {
        onDelta: (delta) => {
          // text 跨轮累积，最终返回完整全文
          text += delta;
          emit({ type: 'text', delta });
        },
        onToolCallStart: (call: ToolCallStartInfo) => {
          // 模型刚宣布要调工具（流式期间，参数还在分片累加）：广播一次让消费方先有个
          // running 占位。参数此刻不完整，故不带；执行前 executeToolCall 会用同一 id
          // 再发一条带完整 arguments 的事件。正文分界点由消费方自行折算。
          emit({ type: 'tool-call-start', id: call.id, name: call.name });
        },
      },
    );

    // 模型没再要工具 → 这轮就是最终答案
    const toolCalls = result.toolCalls ?? [];
    if (toolCalls.length === 0) {
      // 若此前任何一轮被截断，本次运行的事实就是「发生过截断」，finishReason 必须
      // 报 'length' 而不是最后一轮的 'stop'：被截断的正文已混进 text 里，
      // 藏不住也不该藏（导出镜像与界面都靠这个值给「未完整结束」的落点）。
      return {
        text,
        finishReason: truncatedTurns.length > 0 ? 'length' : result.finishReason,
        turns: turn,
        steps,
      };
    }

    // 把 assistant 这轮的发言（含它想调的工具）原样存回上下文
    convo.push({
      role: 'assistant',
      content: result.text,
      toolCalls,
    });

    // 依次串行执行每个工具，结果回填——顺序执行更利于消费方逐步展示。
    // 每个工具结束后 executeToolCall 会自行发出 tool-call-end 与
    // conversation-snapshot 两条事件，这里不再单独处理落盘时机。
    for (const call of toolCalls) {
      // 批次内中止检查：用户点停止后，当前工具执行完即停，不再跑本批次剩余的工具 ——
      // 剩余工具连同已回填的部分构成「半截批次」留在 convo 里，快照已发，
      // 用户点「继续」时由文件开头的续跑起点处理块补跑（旧的实现在这里不检查，
      // 停止后会把整批剩余工具跑完，既违背停止意图又让半截批次只在崩溃场景出现）。
      if (signal.aborted) {
        throw createAbortError();
      }
      await executeToolCall(call, convo, steps, emit, signal, toolContext, turn);
    }

    // 截断回灌：这一轮输出被长度上限切断 ⇒ 显式告诉模型，不让它当作无事发生
    // （「把不确定性当确定性讲」纪律：部分完成必须回灌 + 给下一步）。
    // 位置放在工具结果之后（本轮回填的最后一条）：assistant(tool_calls) 与 tool
    // 消息在协议上必须相邻，system 提示插在两者之间会破坏兼容服务端的位置假设。
    if (result.finishReason === 'length') {
      truncatedTurns.push(turn);
      convo.push({
        role: 'system',
        content:
          `系统提示：你第 ${turn} 轮的输出达到了模型输出长度上限、已被截断，` +
          `那条 assistant 消息并不完整，本轮请求的工具调用参数（arguments）也可能是不完整的 JSON。` +
          `若刚执行完的工具结果里出现参数解析类错误，不要原样重发同样的参数：` +
          `应缩短输出、把这一步拆小重试，或如实告诉用户这一步无法继续。`,
      });
    }
  }

  // 达到轮数上限：给模型一个收尾提示，避免界面「卡住」看起来像没结束
  const note = '\n（已达到工具调用轮数上限，停止进一步操作）';
  text += note;
  return { text, finishReason: 'length', turns: MAX_TURNS, steps };
}
