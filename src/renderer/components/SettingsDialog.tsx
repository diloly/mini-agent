/**
 * 设置弹层：左右分栏（左导航 + 右内容），含「模型」与「外观」两个分组。
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
import type { ConfigSaveInput } from '../../shared/ipc-channels';
import {
  DEFAULT_BASE_URL,
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
];

/** 设置分组 id */
type SettingsSectionId = 'model' | 'appearance' | 'memory';

/** 设置分组（顺序即导航顺序） */
const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
  { id: 'model', label: '模型' },
  { id: 'appearance', label: '外观' },
  { id: 'memory', label: '记忆' },
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

  const [providerId, setProviderId] = useState<ProviderId>('deepseek');
  const [deepseekBaseUrl, setDeepseekBaseUrl] = useState(DEFAULT_BASE_URL.deepseek);
  const [deepseekModel, setDeepseekModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(DEFAULT_BASE_URL.ollama);
  const [ollamaModel, setOllamaModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // 当前所在分组：用户上次停在哪个就保持哪个，弹层重开不强制回「模型」
  const [section, setSection] = useState<SettingsSectionId>('model');

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
    setApiKey('');
    setLocalError(null);
  }, [open]);

  /** 重新拉取候选模型 */
  function handleFetchModels(): void {
    void refreshModels(providerId);
  }

  /** 关闭弹层（等价点击遮罩 / 取消） */
  function handleOpenChange(next: boolean): void {
    setSettingsOpen(next);
  }

  /** 保存：API Key 为空时不下发该字段，避免误清已有密钥 */
  async function handleSave(): Promise<void> {
    setSaving(true);
    setLocalError(null);
    const payload: ConfigSaveInput = {
      activeProviderId: providerId,
      deepseek: { baseUrl: deepseekBaseUrl, model: deepseekModel },
      ollama: { baseUrl: ollamaBaseUrl, model: ollamaModel },
    };
    if (apiKey.trim().length > 0) {
      payload.deepseek = {
        baseUrl: deepseekBaseUrl,
        model: deepseekModel,
        apiKey: apiKey.trim(),
      };
    }
    try {
      const next = await saveConfig(payload);
      useAppStore.setState({ config: next });
      await refreshModels(next.activeProviderId);
      setApiKey('');
      setSettingsOpen(false);
    } catch {
      setLocalError('保存配置失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  const safeStorageAvailable = config?.safeStorageAvailable ?? true;
  const models = config ? config.models[providerId] ?? [] : [];
  const modelValue = providerId === 'deepseek' ? deepseekModel : ollamaModel;
  const setModelValue = providerId === 'deepseek' ? setDeepseekModel : setOllamaModel;
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
                      onClick={() => setSection(item.id)}
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
                            if (next === 'deepseek' || next === 'ollama') {
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
                </div>
              </div>
            </Modal.Body>

            <Modal.Footer>
              {section === 'model' ? (
                <div className="flex w-full items-center justify-end gap-2">
                  <Button variant="ghost" onPress={() => setSettingsOpen(false)}>取消</Button>
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
