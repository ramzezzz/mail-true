// Временная настройка для живой проверки страницы входа: тот же исходник
// админки, но /api уходит в поднятый стек через фронтовый nginx.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Пути считаются от самого файла: копия репозитория в другом каталоге
// (или на другом диске) должна открываться без правок.
const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: here('./apps/admin'),
  plugins: [react()],
  resolve: {
    alias: { '@web': here('./apps/web/src') },
  },
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
        headers: { Host: 'admin.mail.local' },
      },
    },
  },
});
