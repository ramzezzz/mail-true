import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Админка живёт на отдельном порту (5174) и проксирует /api на тот же
 * бэкенд, что и почта. Отдельный порт — не косметика: у админки своя
 * cookie и своя точка входа, смешивать их с почтой нельзя.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@web': fileURLToPath(new URL('../web/src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
  server: {
    port: 5174,
    proxy: {
      // Тот же адрес, что и у apps/web: API один на оба приложения.
      // Разные порты приводили к тому, что админка стучалась в чужой,
      // случайно оставшийся запущенным экземпляр и получала 404.
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
