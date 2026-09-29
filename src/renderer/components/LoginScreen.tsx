/**
 * 登录页：全屏居中的账号卡片，支持「登录 / 注册」两种模式切换。
 *
 * 约定：
 * - 渲染层绝不接触网络：所有请求都经 store action → preload → 主进程，组件内不出现
 *   fetch / XMLHttpRequest / @supabase；
 * - 错误文案一律取 AUTH_ERROR_TEXT（主进程已翻译成中文），组件内不硬写错误句；
 * - 颜色只用语义类（bg-surface / text-fg / text-muted / border-line / text-accent），不写色值；
 * - 输入框聚焦不改变外观：由 theme.css 统一压制（.input:focus 保持常态边框），组件不再叠样式。
 */
import { Button, Input, Label } from '@heroui/react';
import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';

/** 表单模式：登录 / 注册 */
type AuthMode = 'signIn' | 'signUp';

/** 字段标签样式（与设置弹层保持一致） */
const FIELD_LABEL_CLASS = 'mb-1 block text-[12px] text-muted';

export default function LoginScreen() {
  const signIn = useAppStore((state) => state.signIn);
  const signUp = useAppStore((state) => state.signUp);

  const [mode, setMode] = useState<AuthMode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [noticeText, setNoticeText] = useState<string | null>(null);

  /** 切换模式：清空上一次的错误 / 提示，避免串台 */
  function switchMode(next: AuthMode): void {
    setMode(next);
    setErrorText(null);
    setNoticeText(null);
  }

  /** 提交：登录成功由 store 切换门禁；失败在此展示中文错误文案 */
  async function handleSubmit(): Promise<void> {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setErrorText(null);
    setNoticeText(null);
    try {
      if (mode === 'signIn') {
        const message = await signIn(email, password, remember);
        if (message) {
          setErrorText(message);
        }
      } else {
        const result = await signUp(email, password);
        if (result.error) {
          setErrorText(result.error);
        } else if (result.needsEmailConfirm) {
          // 成功提示（非错误）：不占用 AUTH_ERROR_TEXT 表
          setNoticeText('注册成功，请到邮箱点击确认链接后返回登录。');
          setMode('signIn');
          setPassword('');
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  const isSignIn = mode === 'signIn';

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="w-[360px] rounded-[8px] border border-line bg-surface p-6">
        <h1 className="mb-1 text-[15px] font-medium text-fg">{isSignIn ? '登录' : '注册'}</h1>
        <p className="mb-4 text-[12px] text-muted">登录后会话数据将按账号分区保存在本机</p>

        {errorText ? (
          <p className="mb-3 rounded-[6px] border border-line bg-danger-soft px-3 py-2 text-[12px] text-danger">
            {errorText}
          </p>
        ) : null}
        {noticeText ? (
          <p className="mb-3 rounded-[6px] border border-line bg-surface-secondary px-3 py-2 text-[12px] text-fg">
            {noticeText}
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          <div>
            <Label className={FIELD_LABEL_CLASS}>邮箱</Label>
            <Input
              variant="secondary"
              fullWidth
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </div>

          <div>
            <Label className={FIELD_LABEL_CLASS}>密码</Label>
            <Input
              variant="secondary"
              fullWidth
              type="password"
              autoComplete={isSignIn ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={isSignIn ? '请输入密码' : '至少 6 位'}
            />
          </div>

          {isSignIn ? (
            <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-muted">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-accent"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              记住我
            </label>
          ) : null}

          <Button
            variant="primary"
            className="w-full"
            isPending={submitting}
            onPress={() => void handleSubmit()}
          >
            {isSignIn ? '登录' : '注册'}
          </Button>
        </div>

        <div className="mt-4 text-center text-[12px] text-muted">
          {isSignIn ? (
            <>
              还没有账号？
              <button
                type="button"
                className="cursor-pointer text-accent"
                onClick={() => switchMode('signUp')}
              >
                去注册
              </button>
            </>
          ) : (
            <>
              已有账号？
              <button
                type="button"
                className="cursor-pointer text-accent"
                onClick={() => switchMode('signIn')}
              >
                去登录
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
