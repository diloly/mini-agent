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
}

/** Ollama 配置：本地服务无需密钥 */
export interface OllamaProviderSettings {
  baseUrl: string;
  model: string;
}

/** 自定义（OpenAI 兼容）配置：apiKeyEnc 为 safeStorage 加密后的 base64 密文，永不出主进程 */
export interface CustomProviderSettings {
  baseUrl: string;
  model: string;
  apiKeyEnc?: string;
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
}

/**
 * 渲染层唯一可见的配置形态：密钥一律脱敏为 hasApiKey 布尔值，
 * 任何 *Enc 字段都不得出现在这里。
 */
export interface PublicConfig {
  activeProviderId: ProviderId;
  providers: {
    deepseek: { baseUrl: string; model: string; hasApiKey: boolean };
    ollama: { baseUrl: string; model: string };
    custom: { baseUrl: string; model: string; hasApiKey: boolean };
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
