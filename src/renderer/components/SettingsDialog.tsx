/**
 * 设置弹层：左右分栏（左导航 + 右内容），含「模型 / 外观 / 记忆 / 账号」四个分组。
 *
 * 安全约定：
 * - API Key 只进不出：渲染层拿不到历史密钥，输入框永远为空；
 *   填空表示「不改动」，填新值表示「覆盖保存」
 * - 保存成功后回读的仍是 PublicConfig（密钥已脱敏为 hasApiKey）
 */
import {
  Alert,
  Button,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
} from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import type { ConfigSaveInput, ListModelsDraft } from '../../shared/ipc-channels';
import {
  AUTH_ERROR_TEXT,
  DEFAULT_BASE_URL,
  DEFAULT_NUM_CTX,
  NUM_CTX_MAX,
  NUM_CTX_MIN,
  OLLAMA_NUM_CTX_PRESETS,
  PROVIDER_LABELS,
  THEME_MODE_LABELS,
  THEME_MODE_ORDER,
  type ProviderId,
  type ThemeMode,
} from '../../shared/types';
import { saveConfig } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

/** 模型服务候选项 */
const PROVIDER_OPTIONS: Array<{ id: ProviderId; label: string }> = [
  { id: 'deepseek', label: PROVIDER_LABELS.deepseek },
  { id: 'ollama', label: PROVIDER_LABELS.ollama },
  { id: 'custom', label: PROVIDER_LABELS.custom },
];

/** 设置分组 id */
type SettingsSectionId = 'model' | 'appearance' | 'memory' | 'account';

/** 设置分组（顺序即导航顺序） */
const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
  { id: 'model', label: '模型' },
  { id: 'appearance', label: '外观' },
  { id: 'memory', label: '记忆' },
  { id: 'account', label: '账号' },
];

/** 子标题样式 */
const SECTION_LABEL_CLASS = 'mb-1 block text-[12px] text-muted';

export default function SettingsDialog() {
  const open = useAppStore((state) => state.settingsOpen);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const refreshModels = useAppStore((state) => state.refreshModels);
  const setThemeMode = useAppStore((state) => state.setThemeMode);
  const setMemoryEnabled = useAppStore((state) => state.setMemoryEnabled);
  const config = useAppStore((state) => state.config);
  const auth = useAppStore((state) => state.auth);
  const signOut = useAppStore((state) => state.signOut);
  const clearLocalData = useAppStore((state) => state.clearLocalData);

  const [providerId, setProviderId] = useState<ProviderId>('deepseek');
  const [deepseekBaseUrl, setDeepseekBaseUrl] = useState(DEFAULT_BASE_URL.deepseek);
  const [deepseekModel, setDeepseekModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(DEFAULT_BASE_URL.ollama);
  const [ollamaModel, setOllamaModel] = useState('');
  // Ollama 上下文长度：'custom' 表示自定义档，其余值为 OLLAMA_NUM_CTX_PRESETS 里的档位（字符串形态）
  const [ollamaNumCtxSelect, setOllamaNumCtxSelect] = useState(String(DEFAULT_NUM_CTX));
  const [ollamaNumCtxCustom, setOllamaNumCtxCustom] = useState('');
  // 自定义（OpenAI 兼容）服务：Base URL 必填、API Key 可留空（本地服务常免密钥）
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // 当前所在分组：用户上次停在哪个就保持哪个，弹层重开不强制回「模型」
  const [section, setSection] = useState<SettingsSectionId>('model');
  // 账号分组：清除数据的二次确认、操作进行中标记与回显
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountNotice, setAccountNotice] = useState<string | null>(null);

  const prevOpenRef = useRef(false);

  // 仅在「由关到开」的瞬间回填一次，避免保存后 config 变化把用户正在编辑的内容冲掉
  useEffect(() => {
    if (!open) {
      prevOpenRef.current = false;
      return;
    }
    if (prevOpenRef.current) {
      return;
    }
    prevOpenRef.current = true;
    const config = useAppStore.getState().config;
    if (!config) {
      return;
    }
    setProviderId(config.activeProviderId);
    setDeepseekBaseUrl(config.providers.deepseek.baseUrl || DEFAULT_BASE_URL.deepseek);
    setDeepseekModel(config.providers.deepseek.model);
    setOllamaBaseUrl(config.providers.ollama.baseUrl || DEFAULT_BASE_URL.ollama);
    setOllamaModel(config.providers.ollama.model);
    // 上下文长度：命中预设档位就选档位；未命中（旧配置 / 手改过的值）进「自定义」并带入现值
    const storedNumCtx =
      typeof config.providers.ollama.numCtx === 'number'
        ? config.providers.ollama.numCtx
        : DEFAULT_NUM_CTX;
    if (OLLAMA_NUM_CTX_PRESETS.includes(storedNumCtx)) {
      setOllamaNumCtxSelect(String(storedNumCtx));
      setOllamaNumCtxCustom('');
    } else {
      setOllamaNumCtxSelect('custom');
      setOllamaNumCtxCustom(String(storedNumCtx));
    }
    setCustomBaseUrl(config.providers.custom.baseUrl);
    setCustomModel(config.providers.custom.model);
    setCustomApiKey('');
    setApiKey('');
    setLocalError(null);
  }, [open]);

  /**
   * 重新拉取候选模型。
   * 用输入框里的现值拉取（不落盘）：用户改完 Base URL 不保存也能直接验证新地址；
   * 拉不到就回空列表提示手填，任何东西都不会被写进配置 —— 输错的地址不会被保存。
   * apiKey 与保存同一口径：留空表示沿用已存密钥（历史密钥对界面不可见，由主进程补齐）。
   */
  function handleFetchModels(): void {
    const draft: ListModelsDraft =
      providerId === 'deepseek'
        ? { baseUrl: deepseekBaseUrl, apiKey }
        : providerId === 'ollama'
          ? { baseUrl: ollamaBaseUrl }
          : { baseUrl: customBaseUrl, apiKey: customApiKey };
    void refreshModels(providerId, draft);
  }

  /** 关闭弹层（等价点击遮罩 / 取消） */
  function handleOpenChange(next: boolean): void {
    setSettingsOpen(next);
  }

  /** 保存：API Key 为空时不下发该字段，避免误清已有密钥 */
  async function handleSave(): Promise<void> {
    setSaving(true);
    setLocalError(null);
    // 自定义上下文长度先做本地校验：不合法就不发起保存，避免把畸形值写进配置
    let resolvedNumCtx = DEFAULT_NUM_CTX;
    if (ollamaNumCtxSelect === 'custom') {
      const raw = ollamaNumCtxCustom.trim();
      const parsed = Number(raw);
      if (raw.length === 0 || !Number.isInteger(parsed) || parsed < NUM_CTX_MIN || parsed > NUM_CTX_MAX) {
        setLocalError(`上下文长度需为 ${NUM_CTX_MIN} 到 ${NUM_CTX_MAX} 之间的整数（token）`);
        setSaving(false);
        return;
      }
      resolvedNumCtx = parsed;
    } else {
      resolvedNumCtx = Number(ollamaNumCtxSelect);
    }
    const payload: ConfigSaveInput = {
      activeProviderId: providerId,
      deepseek: { baseUrl: deepseekBaseUrl, model: deepseekModel },
      ollama: { baseUrl: ollamaBaseUrl, model: ollamaModel, numCtx: resolvedNumCtx },
      custom: { baseUrl: customBaseUrl, model: customModel },
    };
    if (apiKey.trim().length > 0) {
      payload.deepseek = {
        baseUrl: deepseekBaseUrl,
        model: deepseekModel,
        apiKey: apiKey.trim(),
      };
    }
    // 自定义服务的密钥同样是「只进不出」：留空不下发，避免误清已存密钥
    if (customApiKey.trim().length > 0) {
      payload.custom = {
        baseUrl: customBaseUrl,
        model: customModel,
        apiKey: customApiKey.trim(),
      };
    }
    try {
      const next = await saveConfig(payload);
      useAppStore.setState({ config: next });
      await refreshModels(next.activeProviderId);
      setApiKey('');
      setCustomApiKey('');
      setSettingsOpen(false);
    } catch {
      setLocalError('保存配置失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  /** 退出登录：成功后门禁会切回登录页；本弹层随主界面卸载 */
  async function handleSignOut(): Promise<void> {
    if (accountBusy) {
      return;
    }
    setAccountBusy(true);
    try {
      await signOut();
    } finally {
      setAccountBusy(false);
    }
  }

  /** 清除本账号本地会话数据：首次点击进入二次确认，再次点击才真正执行 */
  async function handleClearData(): Promise<void> {
    if (accountBusy) {
      return;
    }
    if (!confirmingClear) {
      setConfirmingClear(true);
      setAccountError(null);
      setAccountNotice(null);
      return;
    }
    setAccountBusy(true);
    setAccountError(null);
    setAccountNotice(null);
    try {
      const removed = await clearLocalData();
      if (removed === null) {
        setAccountError(AUTH_ERROR_TEXT.UNKNOWN);
      } else {
        setAccountNotice(`已清除 ${removed} 条会话`);
      }
    } finally {
      setConfirmingClear(false);
      setAccountBusy(false);
    }
  }

  const safeStorageAvailable = config?.safeStorageAvailable ?? true;
  const models = config ? config.models[providerId] ?? [] : [];
  const modelValue =
    providerId === 'deepseek'
      ? deepseekModel
      : providerId === 'ollama'
        ? ollamaModel
        : customModel;
  const setModelValue =
    providerId === 'deepseek'
      ? setDeepseekModel
      : providerId === 'ollama'
        ? setOllamaModel
        : setCustomModel;
  const currentThemeMode: ThemeMode = config?.ui?.theme ?? 'system';
  // 记忆功能开关：配置缺省（旧版本配置）时按「开启」处理，与主进程默认值一致
  const memoryEnabled = config?.memoryEnabled ?? true;

  return (
    <Modal>
      <Modal.Backdrop isOpen={open} onOpenChange={handleOpenChange} isDismissable>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>设置</Modal.Heading>
              <Modal.CloseTrigger aria-label="关闭" title="关闭">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  className="h-4 w-4"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </Modal.CloseTrigger>
            </Modal.Header>

            <Modal.Body className="p-0">
              <div className="flex min-h-[400px]">
                {/* 左：设置分组（靠底色差与间距区分，不加分割线） */}
                <nav className="w-[152px] shrink-0 bg-background-secondary p-2">
                  {SETTINGS_SECTIONS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={[
                        'mb-1 block w-full cursor-pointer rounded-[6px] px-2 py-2 text-left text-[13px]',
                        section === item.id ? 'bg-surface-selected text-fg' : 'text-muted hover:text-fg',
                      ].join(' ')}
                      onClick={() => {
                        setSection(item.id);
                        // 切走分组即放弃未完成的二次确认：否则用户换个分组再回来，
                        // 按钮仍显示「确认清除？」而一次点击就直接删数据 —— 等于把二次确认穿透了。
                        setConfirmingClear(false);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </nav>

                {/* 右：具体设置 */}
                <div className="min-w-0 flex-1 flex flex-col gap-4 p-4">
                  {section === 'model' ? (
                    <>
                      {localError ? (
                        <Alert status="danger">
                          <Alert.Indicator />
                          <Alert.Content>
                            <Alert.Title>{localError}</Alert.Title>
                          </Alert.Content>
                        </Alert>
                      ) : null}

                      {safeStorageAvailable ? null : (
                        <Alert status="warning">
                          <Alert.Indicator />
                          <Alert.Content>
                            <Alert.Title>当前系统不支持加密存储</Alert.Title>
                            <Alert.Description>
                              API Key 只会保存在内存中，重启应用后需要重新填写。
                            </Alert.Description>
                          </Alert.Content>
                        </Alert>
                      )}

                      {/* 模型服务选择 */}
                      <div>
                        <Label className={SECTION_LABEL_CLASS}>模型服务</Label>
                        <Select
                          variant="secondary"
                          placeholder="选择模型服务"
                          value={providerId}
                          onChange={(value: unknown) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            if (next === 'deepseek' || next === 'ollama' || next === 'custom') {
                              setProviderId(next);
                            }
                          }}
                        >
                          <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox>
                              {PROVIDER_OPTIONS.map((option) => (
                                <ListBox.Item key={option.id} id={option.id}>
                                  <Label>{option.label}</Label>
                                </ListBox.Item>
                              ))}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                      </div>

                      {/* DeepSeek */}
                      {providerId === 'deepseek' ? (
                        <>
                          <div>
                            <Label className={SECTION_LABEL_CLASS}>Base URL</Label>
                            <Input
                              variant="secondary"
                              fullWidth
                              value={deepseekBaseUrl}
                              onChange={(event) => setDeepseekBaseUrl(event.target.value)}
                              placeholder={DEFAULT_BASE_URL.deepseek}
                            />
                          </div>
                          <div>
                            <Label className={SECTION_LABEL_CLASS}>模型</Label>
                            <Input
                              variant="secondary"
                              fullWidth
                              value={deepseekModel}
                              onChange={(event) => setDeepseekModel(event.target.value)}
                              placeholder="deepseek-chat"
                            />
                          </div>
                          <div>
                            <Label className={SECTION_LABEL_CLASS}>API Key（只进不出，留空表示不改动）</Label>
                            <Input
                              variant="secondary"
                              fullWidth
                              type="password"
                              autoComplete="off"
                              value={apiKey}
                              onChange={(event) => setApiKey(event.target.value)}
                              placeholder="sk-..."
                            />
                          </div>
                        </>
                      ) : null}

                      {/* Ollama */}
                      {providerId === 'ollama' ? (
                        <>
                          <div>
                            <Label className={SECTION_LABEL_CLASS}>Base URL</Label>
                            <Input
                              variant="secondary"
                              fullWidth
                              value={ollamaBaseUrl}
                              onChange={(event) => setOllamaBaseUrl(event.target.value)}
                              placeholder={DEFAULT_BASE_URL.ollama}
                            />
                          </div>
                          <div>
                            <Label className={SECTION_LABEL_CLASS}>模型</Label>
                            <Input
                              variant="secondary"
                              fullWidth
                              value={ollamaModel}
                              onChange={(event) => setOllamaModel(event.target.value)}
                              placeholder="qwen2.5:7b"
                            />
                          </div>
                          <div>
                            <Label className={SECTION_LABEL_CLASS}>上下文长度</Label>
                            <Select
                              variant="secondary"
                              value={ollamaNumCtxSelect}
                              onChange={(value: unknown) => {
                                const next = Array.isArray(value) ? value[0] : value;
                                if (typeof next === 'string') {
                                  setOllamaNumCtxSelect(next);
                                }
                              }}
                            >
                              <Select.Trigger>
                                <Select.Value />
                                <Select.Indicator />
                              </Select.Trigger>
                              <Select.Popover>
                                <ListBox>
                                  {OLLAMA_NUM_CTX_PRESETS.map((value) => (
                                    <ListBox.Item key={value} id={String(value)}>
                                      <Label>{`${value / 1024}K`}</Label>
                                    </ListBox.Item>
                                  ))}
                                  <ListBox.Item id="custom">
                                    <Label>自定义</Label>
                                  </ListBox.Item>
                                </ListBox>
                              </Select.Popover>
                            </Select>
                          </div>
                          {ollamaNumCtxSelect === 'custom' ? (
                            <div>
                              <Label className={SECTION_LABEL_CLASS}>自定义上下文长度（token）</Label>
                              <Input
                                variant="secondary"
                                fullWidth
                                type="number"
                                value={ollamaNumCtxCustom}
                                onChange={(event) => setOllamaNumCtxCustom(event.target.value)}
                                placeholder={`${NUM_CTX_MIN} - ${NUM_CTX_MAX}`}
                              />
                            </div>
                          ) : null}
                          <p className="text-[12px] text-muted">
                            上下文窗口越大，能携带的对话历史与工具结果越多，但占用内存也越多；
                            超过模型实际上限时 Ollama 可能拒绝加载或明显变慢。回复说到一半就停，
                            通常是这里偏小导致的。
                          </p>
                        </>
                      ) : null}

                      {/* 自定义（OpenAI 兼容）：Base URL、API Key、模型全部自填 */}
                      {providerId === 'custom' ? (
                        <>
                          <div>
                            <Label className={SECTION_LABEL_CLASS}>Base URL</Label>
                            <Input
                              variant="secondary"
                              fullWidth
                              value={customBaseUrl}
                              onChange={(event) => setCustomBaseUrl(event.target.value)}
                              placeholder="https://api.openai.com/v1"
                            />
                          </div>
                          <div>
                            <Label className={SECTION_LABEL_CLASS}>
                              API Key（只进不出，留空表示不改动；本地服务可留空）
                            </Label>
                            <Input
                              variant="secondary"
                              fullWidth
                              type="password"
                              autoComplete="off"
                              value={customApiKey}
                              onChange={(event) => setCustomApiKey(event.target.value)}
                              placeholder="sk-..."
                            />
                          </div>
                          <div>
                            <Label className={SECTION_LABEL_CLASS}>模型</Label>
                            <Input
                              variant="secondary"
                              fullWidth
                              value={customModel}
                              onChange={(event) => setCustomModel(event.target.value)}
                              placeholder="gpt-4o-mini"
                            />
                          </div>
                          <p className="text-[12px] text-muted">
                            OpenAI 兼容接口：向 Base URL 追加 /chat/completions 与 /models 发起请求；API Key
                            可留空（本地服务通常不需要）。
                          </p>
                        </>
                      ) : null}

                      {/* 候选模型 */}
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <Label className="text-[12px] text-muted">
                            候选模型（{models.length}）
                          </Label>
                          <Button size="sm" variant="ghost" onPress={handleFetchModels}>
                            拉取列表
                          </Button>
                        </div>
                        {models.length === 0 ? (
                          <p className="text-[12px] text-muted">
                            暂无候选，可直接在上方的「模型」中手填。
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {models.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                className={[
                                  'cursor-pointer rounded-[6px] border border-line px-2 py-1 text-[12px]',
                                  item.id === modelValue
                                    ? 'bg-surface-selected text-fg'
                                    : 'bg-surface text-muted hover:text-fg',
                                ].join(' ')}
                                onClick={() => setModelValue(item.id)}
                              >
                                {item.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  ) : null}

                  {section === 'appearance' ? (
                    <div>
                      <Label className={SECTION_LABEL_CLASS}>主题</Label>
                      <div className="flex flex-col gap-1">
                        {THEME_MODE_ORDER.map((mode) => {
                          const selected = currentThemeMode === mode;
                          return (
                            <button
                              key={mode}
                              type="button"
                              className={[
                                'flex w-full cursor-pointer items-center justify-between rounded-[8px] border px-3 py-2 text-left text-[13px]',
                                selected
                                  ? 'border-accent bg-surface-selected text-fg'
                                  : 'border-line text-fg hover:bg-surface-secondary',
                              ].join(' ')}
                              onClick={() => void setThemeMode(mode)}
                            >
                              <span>{THEME_MODE_LABELS[mode]}</span>
                              {selected ? <span className="text-[12px] text-muted">当前</span> : null}
                            </button>
                          );
                        })}
                      </div>
                      <p className="mt-2 text-[12px] text-muted">
                        选择「跟随系统」时，应用会随 Windows 的浅色/深色设置自动切换。
                      </p>
                    </div>
                  ) : null}

                  {section === 'memory' ? (
                    <div>
                      <Label className={SECTION_LABEL_CLASS}>记忆功能</Label>
                      <div className="flex flex-col gap-1">
                        {[
                          { value: true, label: '开启' },
                          { value: false, label: '关闭' },
                        ].map((option) => {
                          const selected = memoryEnabled === option.value;
                          return (
                            <button
                              key={option.label}
                              type="button"
                              className={[
                                'flex w-full cursor-pointer items-center justify-between rounded-[8px] border px-3 py-2 text-left text-[13px]',
                                selected
                                  ? 'border-accent bg-surface-selected text-fg'
                                  : 'border-line text-fg hover:bg-surface-secondary',
                              ].join(' ')}
                              onClick={() => void setMemoryEnabled(option.value)}
                            >
                              <span>{option.label}</span>
                              {selected ? <span className="text-[12px] text-muted">当前</span> : null}
                            </button>
                          );
                        })}
                      </div>
                      <p className="mt-2 text-[12px] text-muted">
                        开启后，应用会在每个会话结束后从当前工作区提炼长期记忆，并在下一轮对话中注入，
                        同时允许使用「每日笔记」工具；关闭后这三项一并停用，本机已有的记忆文件不会被删除。
                      </p>
                    </div>
                  ) : null}

                  {section === 'account' ? (
                    <div className="flex flex-col gap-4">
                      <div>
                        <Label className={SECTION_LABEL_CLASS}>当前账号</Label>
                        <p className="text-[13px] text-fg">{auth?.email ?? '未登录'}</p>
                        <p className="mt-1 text-[12px] text-muted">
                          会话数据按账号分区保存在本机；登录服务仅用于身份校验。
                        </p>
                      </div>

                      {accountError ? (
                        <Alert status="danger">
                          <Alert.Indicator />
                          <Alert.Content>
                            <Alert.Title>{accountError}</Alert.Title>
                          </Alert.Content>
                        </Alert>
                      ) : null}
                      {accountNotice ? (
                        <p className="rounded-[6px] border border-line bg-surface-secondary px-3 py-2 text-[12px] text-fg">
                          {accountNotice}
                        </p>
                      ) : null}

                      <div>
                        <Label className={SECTION_LABEL_CLASS}>本地数据</Label>
                        <div className="flex items-center gap-2">
                          {/* 危险操作：用实心 danger。刻意不用 danger-soft ——
                              它取 --danger-soft，而本主题把它定成 #fef2f2（浅色），
                              在白底弹层上几乎看不见，会重演「不像按钮」的问题。 */}
                          <Button
                            variant="danger"
                            isDisabled={accountBusy}
                            onPress={() => void handleClearData()}
                          >
                            {confirmingClear ? '确认清除' : '清除本账号会话数据'}
                          </Button>
                          {confirmingClear ? (
                            <Button
                              variant="secondary"
                              isDisabled={accountBusy}
                              onPress={() => setConfirmingClear(false)}
                            >
                              取消
                            </Button>
                          ) : null}
                        </div>
                        <p className="mt-2 text-[12px] text-muted">
                          只删除本机当前账号的会话记录，不影响云端账号与其它账号的数据，清除后不可恢复。
                        </p>
                      </div>

                      <div>
                        {/* 与侧边栏账号菜单里的「退出登录」保持同一色义（那里是 text-danger） */}
                        <Button
                          variant="danger"
                          isDisabled={accountBusy}
                          onPress={() => void handleSignOut()}
                        >
                          退出登录
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </Modal.Body>

            <Modal.Footer>
              {/* 模型页页脚只留「保存」：关闭弹层的入口已经有右上角 ×、点遮罩、Esc 三个，
                  原来的「取消」与它们完全等价，是多余的第四个入口。
                  表单在「由关到开」的瞬间会从 config 重新回填（见上面的 prevOpenRef 逻辑），
                  所以直接关掉即等于放弃本次修改，不需要一个专门的「取消」。 */}
              {section === 'model' ? (
                <div className="flex w-full items-center justify-end">
                  <Button variant="primary" isPending={saving} onPress={() => void handleSave()}>
                    保存
                  </Button>
                </div>
              ) : (
                <div className="flex w-full items-center justify-end">
                  <Button variant="primary" onPress={() => setSettingsOpen(false)}>完成</Button>
                </div>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
