/**
 * 主进程入口：BrowserWindow 创建（安全基线三件套）、单实例锁、生命周期与 IPC 注册。
 *
 * 安全基线：nodeIntegration=false、contextIsolation=true、sandbox=true；
 * 渲染层只能通过 preload 暴露的白名单访问主进程能力。
 */
import path from 'node:path';
import { BrowserWindow, Menu, app, nativeTheme, session } from 'electron';
import { createIpcRouter } from './ipc';
import { ensureStorageReady, readConfig } from './storage';
import {
  DEFAULT_THEME_MODE,
  isThemeMode,
  WINDOW_BACKGROUND,
  type ResolvedTheme,
  type ThemeMode,
} from '../shared/types';

/** 开发期的渲染层地址（由 electron-vite 注入） */
const RENDERER_DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'];

/** 打包后收紧 CSP：渲染层完全没有出网需求 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ');

/** 当前主窗口 */
let mainWindow: BrowserWindow | null = null;

/** 窗口底色：跟随主题偏好解析，避免深色启动时露白 */
let windowBackgroundColor: string = WINDOW_BACKGROUND.light;

/** 把主题偏好解析成实际主题（主进程侧，不依赖 DOM） */
function resolveThemeForWindow(mode: ThemeMode | undefined): ResolvedTheme {
  const effective = isThemeMode(mode) ? mode : DEFAULT_THEME_MODE;
  if (effective === 'system') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }
  return effective;
}

/** IPC 路由（持有主窗口访问器） */
const ipcRouter = createIpcRouter({ getMainWindow: () => mainWindow });

/** 创建主窗口 */
function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'mini-agent',
    backgroundColor: windowBackgroundColor,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  if (RENDERER_DEV_SERVER_URL) {
    void window.loadURL(RENDERER_DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

/** 收紧渲染层的网络与导航能力 */
function applySecurityPolicy(): void {
  // 开发期需要 Vite HMR 的 WebSocket 与本地资源，仅在打包后收紧
  if (!app.isPackaged) {
    return;
  }
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });
}

/** 禁止渲染层发起任何外部导航或新开窗口 */
function applyNavigationGuards(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      const isLocal = url.startsWith('file://') || url.startsWith('devtools://');
      // 开发期 Vite 会从 localhost / 127.0.0.1 拉渲染层资源，必须放行，否则白屏
      const isDevServer =
        !app.isPackaged && /^http:\/\/(localhost|127\.0\.0\.1):/.test(url);
      if (!isLocal && !isDevServer) {
        event.preventDefault();
      }
    });
  });
}

/** 应用启动 */
async function bootstrap(): Promise<void> {
  await ensureStorageReady();
  // 先按持久化的主题定好窗口底色，再建窗口：show:false + ready-to-show 配合
  // 这个底色，深色启动时全程不会露白
  const config = await readConfig();
  windowBackgroundColor = WINDOW_BACKGROUND[resolveThemeForWindow(config.ui.theme)];
  ipcRouter.register();
  mainWindow = createMainWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // 移除默认菜单栏，UI 由渲染层自绘
    Menu.setApplicationMenu(null);
    applySecurityPolicy();
    applyNavigationGuards();
    void bootstrap();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // 复用模块级 windowBackgroundColor，不重新读盘
      mainWindow = createMainWindow();
    }
  });
}
