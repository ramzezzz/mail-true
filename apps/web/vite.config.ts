import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Куда dev-сервер переправляет `/api` и `/ws`.
 *
 * По умолчанию — сервер приложения, запущенный на этой же машине
 * (`npm run dev` в apps/api). Но чаще почта проверяется против ПОДНЯТОГО
 * СТЕНДА, где перед API стоит nginx, — тогда адрес другой:
 *
 *   VITE_API_TARGET=http://127.0.0.1:8080 npm run dev
 *
 * Раньше адрес был прибит к `localhost:3000`, и это уже стоило времени:
 * на порту висел давно запущенный старый сервер, отвечавший 404 на метки
 * и оформление. Выглядело как «возможность сломана», а сломан был адрес.
 */
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3000';
const wsTarget = apiTarget.replace(/^http/u, 'ws');

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.{ts,tsx,mjs}'],
    environment: 'node',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      // changeOrigin и здесь: перед API стенда стоит nginx, и без подмены
      // Host рукопожатие живых обновлений упирается в 404.
      '/ws': { target: wsTarget, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
