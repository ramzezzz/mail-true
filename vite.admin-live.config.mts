// Временная настройка для живой проверки страницы входа: тот же исходник
// админки, но /api уходит в поднятый стек через фронтовый nginx.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const ROOT = 'G:/Temp/Mail.True/apps/admin';

export default defineConfig({
  root: ROOT,
  plugins: [react()],
  resolve: {
    alias: { '@web': 'G:/Temp/Mail.True/apps/web/src' },
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
