/**
 * 跨进程共享的类型与常量：消息 / 会话 / 配置 / 模型 / 错误码 / 主题。
 *
 * 约束：本文件零依赖，禁止 import 任何 node、electron 或浏览器专有模块；
 * 主进程、preload、渲染层三方均可安全引用。
 */

/** 已接入的模型服务标识 */
export type ProviderId = 'deepseek' | 'ollama' | 'custom';

/** 主题偏好：跟随系统 / 强制浅色 / 强制深色 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 解析后的实际主题：只有两种，供 html 的 data-theme / class 使用 */
export type ResolvedTheme = 'light' | 'dark';

/** 主题偏好默认值 */
export const DEFAULT_THEME_MODE: ThemeMode = 'system';

/** 界面上能看到的主题分组顺序（B 工程师的「外观」面板按这个顺序渲染） */
export const THEME_MODE_ORDER: ThemeMode[] = ['system', 'light', 'dark'];

/** 主题偏好的展示名 */
export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

/**
 * 主进程创建窗口时的底色。
 * 必须与 theme.css ① 段深色块的 --background（#18181b）保持一致，
 * 否则深色启动时窗口会先露一层白底再被内容覆盖。
 */
export const WINDOW_BACKGROUND: Record<ResolvedTheme, string> = {
  light: '#ffffff',
  dark: '#18181b',
};

/**
 * 校验任意值是否为主题偏好。
 * config.json 是磁盘上的明文文件、允许被手改，非法值会让渲染层写出
 * data-theme="xxx" —— 两套变量都不命中，界面会直接失去所有颜色。
 */
export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** 消息角色 */
export type Role = 'user' | 'assistant' | 'system';

/** 一轮生成结束的原因 */
export type FinishReason = 'stop' | 'length' | 'aborted' | 'error';

/**
 * 面向用户的错误码。
 * - NOT_CONFIGURED：未配置 Key / 未选模型
 * - AUTH：401 / 403 鉴权失败
 * - RATE_LIMIT：429 限流
 * - NETWORK：DNS / 超时 / 断网
 * - UNREACHABLE：本地服务连接被拒（如 Ollama 未启动）
 * - SERVER：5xx 服务端异常
 * - BAD_RESPONSE：响应体解析失败
 * - ABORTED：用户主动停止（非错误）
 * - UNKNOWN：兜底
 */
export type ErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'UNREACHABLE'
  | 'SERVER'
  | 'BAD_RESPONSE'
  | 'ABORTED'
  | 'UNKNOWN';

/** 工具步骤的执行状态 */
export type ToolStepStatus = 'running' | 'done' | 'error';

/** 一次工具调用的可展示记录 */
export interface ToolStep {
  id: string;
  /** 工具名，如 read_text_file */
  name: string;
  /** 模型给出的参数，已序列化为紧凑 JSON 文本（用于展示） */
  args: string;
  status: ToolStepStatus;
  /** 结果摘要：成功为结果前 200 字，失败为错误文案 */
  result?: string;
  /** 执行耗时（毫秒）；status 为 running 时无此字段 */
  elapsedMs?: number;
  /**
   * 该步开始时，所属消息正文已累积的字符数。
   * 主进程在「本轮文本流完、即将执行工具」时打点（同轮的多个工具共用一个值），
   * 渲染层与 md 镜像据此把工具调用与正文按时间线交错（见 shared/timeline.ts）。
   * 旧数据无此字段 → 退化为「工具整块 + 正文整块」。
   */
  contentOffset?: number;
}

/** 计划步骤的执行状态 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done';

/**
 * 一条计划步骤：标题 + 状态。
 * 由模型经 update_plan 工具维护；每次调用都是**整份覆盖更新（非增量）**——
 * 模型把当前完整的计划清单整体传回，主进程原样替换上一版，不做合并。
 */
export interface PlanStep {
  /** 这一步要做什么，简洁的纯文本 */
  title: string;
  /** 这一步的状态（pending 待开始 / in_progress 进行中 / done 已完成） */
  status: PlanStepStatus;
}

/**
 * 用户上传的文件附件。
 * path 是**相对工作区**的 POSIX 风格路径（如 uploads/20261014-111047-report.pdf）——
 * 所有工具与技能脚本都相对工作区解析路径，填绝对路径反而会被越界守卫拒绝。
 */
export interface MessageAttachment {
  /** 原始文件名（展示用，可能含中文 / 空格） */
  name: string;
  /** 相对工作区的 POSIX 风格路径 */
  path: string;
  /** 字节数 */
  size: number;
}

/**
 * 用户对一条 assistant 回答的评价。
 * 只有赞 / 踩两态：未评价时**不写该字段**，而不是写第三种「无」值。
 */
export type Verdict = 'up' | 'down';

/** 消息的附加信息，仅 assistant 消息会写入 provider / model / 结束状态 */
export interface MessageMeta {
  providerId?: ProviderId;
  model?: string;
  finishReason?: FinishReason;
  errorCode?: ErrorCode;
  errorText?: string;
  /** 本轮的工具调用步骤（无工具调用时不写） */
  steps?: ToolStep[];
  /** 本轮 agent 维护的计划清单（整份快照）；模型没建计划时不写 */
  plan?: PlanStep[];
  /** 本轮 agent loop 实际消耗的轮数 */
  turns?: number;
  /** 有 checkpoint 可续跑：被中止且尚未续跑完成/清理的消息为 true，界面据此显示「继续」 */
  resumable?: boolean;
  /** 用户评价（赞 / 踩）；取消评价时删字段，不留第三态 */
  feedback?: Verdict;
  /** 评价时间（epoch 毫秒）；与 feedback 同生同灭 */
  feedbackAt?: number;
  /**
   * 生成这一轮时生效的 system prompt 模板指纹（finalize 时写入）。
   * 刻意在收尾时算而不是建 case 时算 —— 否则「生成完又装了技能」会让指纹漂移。
   */
  promptVersion?: string;
  /** 生成这一轮时暴露给模型的工具集指纹（finalize 时写入，工具集变了分数就不可比） */
  toolSetHash?: string;
}

/** 单条消息；流式期间 content 为「已累积的完整文本」 */
export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: number;
  meta?: MessageMeta;
  /** 用户消息附带的文件（已由主进程复制进工作区 uploads/）；无附件时不写 */
  attachments?: MessageAttachment[];
}

/** 会话：元数据 + 内嵌全量消息，列表按 updatedAt 倒序 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId: ProviderId;
  model: string;
  messages: Message[];
  /**
   * 该会话的工作区根目录（绝对路径）。
   * 缺省时回退到默认工作区；读写文件的工具只允许在该目录内操作。
   */
  workspaceRoot?: string;
  /**
   * 是否置顶。置顶会话排在列表最前。
   * 缺省 / 非 true 一律视为未置顶（不写 false，避免旧数据与新数据两种形态并存）。
   */
  pinned?: boolean;
}

/** DeepSeek 配置：apiKeyEnc 为 safeStorage 加密后的 base64 密文，永不出主进程 */
export interface DeepSeekProviderSettings {
  baseUrl: string;
  model: string;
  apiKeyEnc?: string;
  /**
   * 上下文窗口（token 数），仅用于「上下文用量」统计的分母；不参与请求体。
   * 缺省时读取侧回退 DEFAULT_CONTEXT_WINDOW，不写盘补默认值（旧配置无需迁移）。
   */
  contextWindow?: number;
}

/** Ollama 配置：本地服务无需密钥 */
export interface OllamaProviderSettings {
  baseUrl: string;
  model: string;
  /**
   * 上下文窗口（token 数），对应 Ollama 请求体的 options.num_ctx。
   * 缺省时由 normalizeConfig 补 DEFAULT_NUM_CTX。
   */
  numCtx?: number;
}

/** 自定义（OpenAI 兼容）配置：apiKeyEnc 为 safeStorage 加密后的 base64 密文，永不出主进程 */
export interface CustomProviderSettings {
  baseUrl: string;
  model: string;
  apiKeyEnc?: string;
  /** 上下文窗口（token 数），仅用于「上下文用量」统计的分母；缺省回退 DEFAULT_CONTEXT_WINDOW */
  contextWindow?: number;
}

/** 应用配置（与会话数据物理分离，清历史不丢 Key） */
export interface AppConfig {
  version: 1;
  activeProviderId: ProviderId;
  providers: {
    deepseek: DeepSeekProviderSettings;
    ollama: OllamaProviderSettings;
    custom: CustomProviderSettings;
  };
  /**
   * 记忆功能总开关。关闭后：不做记忆提炼（省掉每轮那次额外模型调用）、
   * 不向模型注入记忆、也不暴露 append_daily_note 工具。
   */
  memoryEnabled: boolean;
  ui: {
    lastConversationId?: string;
    /** 主题偏好，持久化在 config.json */
    theme?: ThemeMode;
  };
}

/** 候选模型 */
export interface ModelInfo {
  id: string;
  label: string;
  /**
   * 服务端声明的上下文窗口（token），仅当 /models 响应里带了才填。
   * 标准 OpenAI 兼容接口不返回该字段（DeepSeek 官方也没有）；OpenRouter（context_length）、
   * vLLM（max_model_len）等网关会带 —— 有则用于自动填充设置里的「上下文窗口」，没有就不猜。
   */
  contextWindow?: number;
}

/**
 * 渲染层唯一可见的配置形态：密钥一律脱敏为 hasApiKey 布尔值，
 * 任何 *Enc 字段都不得出现在这里。
 */
export interface PublicConfig {
  activeProviderId: ProviderId;
  providers: {
    deepseek: { baseUrl: string; model: string; hasApiKey: boolean; contextWindow?: number };
    ollama: { baseUrl: string; model: string; numCtx?: number };
    custom: { baseUrl: string; model: string; hasApiKey: boolean; contextWindow?: number };
  };
  models: Record<ProviderId, ModelInfo[]>;
  safeStorageAvailable: boolean;
  /**
   * 默认工作区根目录（会话未指定工作区时生效）。
   * 只用于界面展示 —— 让用户知道「不指定工作区时 agent 会在哪个目录里干活」。
   */
  defaultWorkspaceRoot: string;
  /** 记忆功能总开关（与 AppConfig.memoryEnabled 同值，供设置界面展示） */
  memoryEnabled: boolean;
  /** 界面态：不涉密，用于重启后恢复上次查看的会话与主题 */
  ui?: {
    lastConversationId?: string;
    theme?: ThemeMode;
  };
}

/** 各 Provider 的展示名（渲染层通过 PROVIDER_LABELS[providerId] 取值，避免在组件里出现分支判断） */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
  custom: '自定义',
};

/** 各 Provider 的默认 Base URL */
export const DEFAULT_BASE_URL: Record<ProviderId, string> = {
  deepseek: 'https://api.deepseek.com',
  ollama: 'http://127.0.0.1:11434',
  // 自定义服务没有可信的默认地址：留空强制用户自填，避免误指向某个具体厂商
  custom: '',
};

/** 各 Provider 的默认模型（Ollama 无默认，需用户选择或手填） */
export const DEFAULT_MODEL: Record<ProviderId, string> = {
  // 旧 id deepseek-chat 已弃用，统一切到 v4 系列
  deepseek: 'deepseek-v4-flash',
  ollama: '',
  // 自定义服务的模型名由用户自填，不给默认值
  custom: '',
};

/** 会话标题回退值 */
export const DEFAULT_CONVERSATION_TITLE = '新会话';

/**
 * Ollama 上下文长度预设档位（token）。
 * 模型自带的默认 num_ctx 通常很小（gemma4 实测只有几千），工具结果全文回灌后
 * 模型几百字就截断 —— 这个设置就是给用户调大的旋钮。
 */
export const OLLAMA_NUM_CTX_PRESETS: number[] = [4096, 8192, 16384, 32768, 65536, 131072];

/** Ollama 上下文长度默认值（token）：32K，兼顾历史长度与内存占用 */
export const DEFAULT_NUM_CTX = 32768;

/** 自定义上下文长度的合法区间（token） */
export const NUM_CTX_MIN = 1024;
export const NUM_CTX_MAX = 262144;

/**
 * 校验任意值是否为合法的 Ollama 上下文长度。
 * config.json 是磁盘上的明文文件、允许被手改，非法值（非整数 / 超出区间）
 * 必须回退默认，否则会把畸形值发给 Ollama。
 */
export function isValidNumCtx(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= NUM_CTX_MIN &&
    value <= NUM_CTX_MAX
  );
}

/**
 * 云端 / 自定义 provider 的默认上下文窗口（token）。
 * 只用于「上下文用量」统计的分母——统计不参与请求，估错不影响模型调用；
 * 用户可在设置里按实际模型改（如 128K / 300K），改完统计即刻按新窗口计算。
 */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/** 上下文窗口的合法区间（token）：下限覆盖小模型，上限覆盖 1M 级长上下文 */
export const CONTEXT_WINDOW_MIN = 2048;
export const CONTEXT_WINDOW_MAX = 1048576;

/** 校验任意值是否为合法的上下文窗口（仅 deepseek / custom 使用；ollama 走 numCtx） */
export function isValidContextWindow(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CONTEXT_WINDOW_MIN &&
    value <= CONTEXT_WINDOW_MAX
  );
}

/**
 * 会话列表排序：置顶优先，组内按 updatedAt 倒序。
 * 主进程的 list 接口与渲染层的乐观更新都用这一份，保证两侧顺序一致。
 */
export function sortConversationsByPinned<T extends { pinned?: boolean; updatedAt: number }>(
  list: readonly T[],
): T[] {
  return [...list].sort((a, b) => {
    const pinnedDiff = Number(b.pinned === true) - Number(a.pinned === true);
    return pinnedDiff !== 0 ? pinnedDiff : b.updatedAt - a.updatedAt;
  });
}

/** 单次请求携带的历史消息条数上限 */
export const CONTEXT_MESSAGE_LIMIT = 20;

/** 会话标题截断长度 */
export const TITLE_MAX_LENGTH = 20;

/**
 * 错误码 → 面向用户的简体中文文案。
 *
 * 全仓唯一来源：主进程（Provider 层构造 ProviderError）与渲染层（错误块展示）
 * 共用这一张表，保证同一句话只有一处定义。
 */
export const ERROR_TEXT: Record<ErrorCode, string> = {
  NOT_CONFIGURED: '尚未配置模型，请先到设置中填写',
  AUTH: 'API Key 无效或已失效（401/403）',
  RATE_LIMIT: '请求过于频繁，请稍后再试（429）',
  NETWORK: '网络连接失败，请检查网络后重试',
  UNREACHABLE: '无法连接模型服务，请确认服务已经启动',
  SERVER: '模型服务暂时不可用（5xx）',
  BAD_RESPONSE: '模型返回内容解析失败',
  ABORTED: '已停止生成',
  UNKNOWN: '发生未知错误',
};

/**
 * 错误码 → 是否可重试（决定是否渲染「重试」按钮）。
 *
 * 注意 UNREACHABLE 这里的文案是**通用兜底**：厂商专属提示
 * （如 Ollama 的「请确认已启动 ollama serve」）由 LLMProvider.unreachableHint
 * 提供，主进程在构造 ProviderError 时用 hint 覆盖此处的通用文案。
 */
export const ERROR_RETRYABLE: Record<ErrorCode, boolean> = {
  NOT_CONFIGURED: false,
  AUTH: true,
  RATE_LIMIT: true,
  NETWORK: true,
  UNREACHABLE: true,
  SERVER: true,
  BAD_RESPONSE: true,
  ABORTED: false,
  UNKNOWN: true,
};

/**
 * 账号相关的用户可见错误码。
 * 与模型侧 ErrorCode 分开：两者语义不同（一个讲登录、一个讲推理），
 * 混用会让「AUTH」这类歧义码在两张表里指向不同含义。
 */
export type AuthErrorCode =
  | 'INVALID_EMAIL' // 邮箱格式不合法
  | 'INVALID_CREDENTIALS' // 邮箱或密码错误
  | 'EMAIL_NOT_CONFIRMED' // 邮箱尚未确认
  | 'EMAIL_ALREADY_REGISTERED' // 该邮箱已注册
  | 'WEAK_PASSWORD' // 密码强度不足
  | 'NETWORK' // 网络不可达
  | 'RATE_LIMIT' // 操作过于频繁
  | 'SERVICE_UNAVAILABLE' // 登录服务未配置 / 不可用
  | 'UNKNOWN';

/**
 * 错误码 → 面向用户的简体中文文案（账号体系）。
 *
 * 全仓唯一来源：主进程 auth/errors.ts 映射、渲染层登录页展示共用这一张表，
 * 保证同一句话只有一处定义；组件内不得硬写中文错误句。
 */
export const AUTH_ERROR_TEXT: Record<AuthErrorCode, string> = {
  INVALID_EMAIL: '邮箱格式不正确',
  INVALID_CREDENTIALS: '邮箱或密码错误',
  EMAIL_NOT_CONFIRMED: '邮箱尚未确认，请先到邮箱点击确认链接',
  EMAIL_ALREADY_REGISTERED: '该邮箱已注册，请直接登录',
  WEAK_PASSWORD: '密码强度不足（至少 6 位）',
  NETWORK: '无法连接登录服务，请检查网络后重试',
  RATE_LIMIT: '操作过于频繁，请稍后再试',
  SERVICE_UNAVAILABLE: '登录服务未配置，请联系管理员',
  UNKNOWN: '操作失败，请稍后重试',
};

/* ───────────────────────────── 质量评测（LLM-as-judge） ───────────────────────────── */

/**
 * 生成这一轮时的指纹：谁生成的、用哪套 prompt 模板、暴露了哪些工具。
 * 三个指纹齐全才敢把两条 case 放在一起做 A/B 比较。
 */
export interface GenerationFingerprint {
  providerId: ProviderId;
  model: string;
  /** system prompt 模板指纹（只含手写模板文案，不含技能列表 / 记忆正文 / 绝对路径） */
  promptVersion: string;
  /** promptVersion 的来源：'message' = 消息自带的当时指纹；'current' = 老消息回退到当前值 */
  promptVersionSource?: 'message' | 'current';
  /** 工具集指纹（工具名排序后哈希） */
  toolSetHash: string;
  /** 生成这一轮时的应用版本 */
  appVersion: string;
  /** 本轮 agent loop 实际消耗的轮数 */
  turns?: number;
}

/** 四个评分维度，取值一律为 1–5 的整数（禁止 0 分与小数） */
export interface JudgeScores {
  relevance: number;
  faithfulness: number;
  completeness: number;
  clarity: number;
}

/** 一次评测运行的结果；失败时只有 error，不写 scores */
export interface JudgeRun {
  /** 运行时间（epoch 毫秒） */
  runAt: number;
  judgeProviderId: ProviderId;
  judgeModel: string;
  /** rubric 版本号：rubric 改了分数就不可比 */
  rubricVersion: string;
  scores?: JudgeScores;
  /** 四维均值，保留 1 位小数 */
  overall?: number;
  /** 忠实度硬否决已触发（overall 被封顶） */
  capped?: boolean;
  /** 模型给出的理由 */
  reason?: string;
  /** 解析 / 校验 / 调用失败的原因 */
  error?: string;
}

/**
 * 一条被评测的问答快照。
 * 刻意存**快照副本**而非引用：会话删除、消息编辑重发都不该改动已归档的评测数据。
 */
export interface JudgeCase {
  id: string;
  conversationId: string;
  /** 被评测的 assistant 消息 id（同时是幂等键：同一消息只允许一条 case） */
  messageId: string;
  createdAt: number;
  /** 反查出来的用户提问（用于分组：同一个问题前后空格不同不算不同 case） */
  question: string;
  /** 归一化后的问题指纹 */
  questionHash: string;
  answer: string;
  /** 回答超长被截断时为 true */
  answerTruncated: boolean;
  /** 本轮工具调用轨迹（快照） */
  steps: ToolStep[];
  finishReason?: FinishReason;
  verdict?: Verdict;
  generation: GenerationFingerprint;
  /** 历次评测运行，最多保留 JUDGE_RUN_LIMIT 条（含失败） */
  runs: JudgeRun[];
}

/** 评测集列表项：不含 answer / steps，避免 IPC 负载过重 */
export interface JudgeCaseSummary {
  id: string;
  conversationId: string;
  messageId: string;
  createdAt: number;
  /** 提问，截断到 60 字 */
  question: string;
  verdict?: Verdict;
  overall?: number;
  /** 最弱维度（取最新一次成功 run） */
  weakest?: keyof JudgeScores;
  /** 是否已有至少一次成功 run */
  hasRun: boolean;
  /** 最新一次 run 的失败原因 */
  error?: string;
}

/** 评测集汇总（设置页「质量」分组用） */
export interface JudgeSummary {
  /** case 总数 */
  total: number;
  /** 已有成功 run 的 case 数 */
  evaluated: number;
  /** 最近 30 天内创建的 case 数 */
  window30d: number;
  /** 忠实度硬否决触发的次数 */
  cappedCount: number;
  /** 所有成功 run 的 overall 均值；无数据时为 null */
  avgOverall: number | null;
  /** 四维均值；某维度无数据时为 null */
  dims: Record<keyof JudgeScores, number | null>;
  /** 被踩（verdict === 'down'）的 case 总数；downSamples 只是最近的若干条 */
  downCount: number;
  /** 被踩的样本（最多若干条，供人工回看） */
  downSamples: JudgeCaseSummary[];
}

/** 单条 case 保存的回答字符上限（超出截断并置 answerTruncated） */
export const JUDGE_ANSWER_MAX_CHARS = 8000;
/** 单步工具调用参数落盘上限（字符）：write_text_file 的 args 可能是整份文件正文 */
export const JUDGE_STEP_ARGS_MAX_CHARS = 500;
/** 提问落盘上限（字符）：用户可能粘贴长文档，与 answer 对称设限 */
export const JUDGE_QUESTION_MAX_CHARS = 4000;
/** 评测集条数上限，超出按「无 run 且无 verdict」优先淘汰最旧 */
export const JUDGE_CASE_LIMIT = 500;
/** 单条 case 保留的评测运行次数上限（含失败） */
export const JUDGE_RUN_LIMIT = 5;
/** 维度分下限 */
export const JUDGE_SCORE_MIN = 1;
/** 维度分上限 */
export const JUDGE_SCORE_MAX = 5;
/** 忠实度 ≤2 时 overall 的封顶值 */
export const JUDGE_CAP_OVERALL = 2;
