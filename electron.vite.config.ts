// 构建配置：main / preload / renderer 三套独立 Vite 配置，产物分别落在 out/ 三个子目录。
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'out/main'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'out/preload'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    // 显式绑定 127.0.0.1：Windows 上 localhost 常被解析成 IPv6 ::1，
    // 而 vite 默认只监听 127.0.0.1，electron 加载 localhost:5173 会 ERR_CONNECTION_REFUSED 白屏。
    // 绑死 127.0.0.1 后，electron-vite 注入的 ELECTRON_RENDERER_URL 也变为 127.0.0.1，两端一致。
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
