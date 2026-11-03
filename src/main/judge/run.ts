/**
 * judge 调用编排：读配置 → 建运行期配置 → 调 Provider → 解析 → 组装 JudgeRun。
 *
 * 三条硬性纪律：
 * 1. **不传 tools**：评测是「读一遍问答然后打分」，给 judge 工具只会让它去干活而不是打分；
 * 2. **60 秒超时**：judge 的输出很短，超过一分钟基本是服务卡住，继续等只是拖住 UI；
 * 3. **绝不抛**：任何失败都收敛成一条带 `error` 的 run —— 上层据此记一条失败记录，
 *    已有分数一格都不动（失败的重评不能清掉历史成绩）。
 *
 * 解析失败重试一次：第一次失败往往是模型加了句解释或包了代码块，追加一句「只输出 JSON」
 * 通常就能救回来；再失败就是模型能力问题，记 error 比硬猜分数诚实。
 */
import type { AppConfig, JudgeCase, JudgeRun, ProviderId } from '../../shared/types';
import { getProvider, isProviderId } from '../providers';
import { buildProviderConfig } from '../providers/runtime';
import { combineSignals, type CombinedSignal } from '../providers/sse';
import type { LlmMessage } from '../providers/types';
import { readConfig } from '../storage';
import { readableJudgeError } from './errors';
import { computeOverall, parseJudgeOutput } from './parse';
import { buildJudgeInput, JUDGE_SYSTEM_PROMPT, RUBRIC_VERSION } from './prompt';

/** judge 请求超时（毫秒） */
const JUDGE_TIMEOUT_MS = 60_000;

/** 重试时追加的提示：直接告诉模型上一次错在哪、这次只要什么 */
const RETRY_HINT =
  '\n\n（上次输出无法解析。只输出一个 JSON 对象，不要代码块、不要任何其它文字。）';

/** 两次都解析不出来时的错误文案 */
const PARSE_ERROR_TEXT = '评测输出无法解析';

/** 没有任何可用模型时的错误文案 */
const NO_PROVIDER_TEXT = '当前没有可用的模型，无法评测';

/** 组装一条 run 的公共外壳（runAt / rubricVersion 由这里统一填） */
function makeRun(
  judgeProviderId: ProviderId,
  judgeModel: string,
  extra: Omit<Partial<JudgeRun>, 'runAt' | 'judgeProviderId' | 'judgeModel' | 'rubricVersion'>,
): JudgeRun {
  return {
    runAt: Date.now(),
    judgeProviderId,
    judgeModel,
    rubricVersion: RUBRIC_VERSION,
    ...extra,
  };
}

/** 该 Provider 是否已具备可用配置（缺 Key / 缺模型都算不可用） */
function isUsable(config: AppConfig, providerId: ProviderId): boolean {
  if (!isProviderId(providerId)) {
    return false;
  }
  try {
    return getProvider(providerId).isConfigured(buildProviderConfig(config, providerId));
  } catch {
    // 配置残缺到构造不出运行期配置时，一律当作不可用，别让异常冒到上层
    return false;
  }
}

/**
 * 对一条 case 跑一次评测。
 *
 * @param target 待评测的 case 快照
 * @returns 一条 JudgeRun；失败时只有 `error`，绝不抛异常
 */
export async function evaluateCase(target: JudgeCase): Promise<JudgeRun> {
  // 出错时也要能说清「用哪个模型评的」，故先用 case 自带的指纹兜底
  let judgeProviderId: ProviderId = target.generation.providerId;
  let judgeModel: string = target.generation.model;
  let combined: CombinedSignal | null = null;

  try {
    const config = await readConfig();
    // 优先用「生成这条回答的那个模型」：同条件比较才有意义；
    // 它不可用（Key 被清、Ollama 关了）时退回当前激活模型，总比不评好。
    const chosen: ProviderId | null = isUsable(config, target.generation.providerId)
      ? target.generation.providerId
      : isUsable(config, config.activeProviderId)
        ? config.activeProviderId
        : null;
    if (chosen === null) {
      return makeRun(judgeProviderId, judgeModel, { error: NO_PROVIDER_TEXT });
    }

    const provider = getProvider(chosen);
    const providerConfig = buildProviderConfig(config, chosen);
    judgeProviderId = chosen;
    judgeModel = providerConfig.model;

    const input = buildJudgeInput(target);
    // active 是局部 const，作用域内类型确定；combined 只是留给 catch / finally 收尾用
    const active = combineSignals([], JUDGE_TIMEOUT_MS);
    combined = active;

    const first = await provider.chatStream(
      {
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        signal: active.signal,
      },
      providerConfig,
      { onDelta: () => undefined },
    );

    let parsed = parseJudgeOutput(first.text);
    // 超时 / 已中止时不再重试：信号已经废了，重试只会立刻再失败
    if (parsed === null && !active.signal.aborted) {
      const retryMessages: LlmMessage[] = [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: `${input}${RETRY_HINT}` },
      ];
      const retry = await provider.chatStream(
        { messages: retryMessages, signal: active.signal },
        providerConfig,
        { onDelta: () => undefined },
      );
      parsed = parseJudgeOutput(retry.text);
    }

    if (parsed === null) {
      return makeRun(judgeProviderId, judgeModel, { error: PARSE_ERROR_TEXT });
    }

    const { overall, capped } = computeOverall(parsed.scores);
    return makeRun(judgeProviderId, judgeModel, {
      scores: parsed.scores,
      overall,
      capped,
      reason: parsed.reason,
    });
  } catch (error) {
    const message =
      combined !== null && combined.isTimeout()
        ? `评测请求超时（${JUDGE_TIMEOUT_MS / 1000} 秒）`
        : readableJudgeError(error, '评测失败');
    return makeRun(judgeProviderId, judgeModel, { error: message });
  } finally {
    combined?.dispose();
  }
}
