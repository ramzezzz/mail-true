// Временный dev-сервер админки для живой проверки шапки и анимаций.
// /api уходит на nginx стека с подменой Host — иначе admin.mail.local не резолвится.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const ROOT = 'G:/Temp/Mail.True/apps/admin';

export default defineConfig({
  root: ROOT,
  plugins: [react()],
  resolve: { alias: { '@web': 'G:/Temp/Mail.True/apps/web/src' } },
  cacheDir: 'G:/Temp/Mail.True/apps/admin/node_modules/.vite-hdr',
  server: {
    port: 5177,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Host', 'admin.mail.local');
          });
          proxy.on('proxyRes', (proxyRes) => {
            const cookies = proxyRes.headers['set-cookie'];
            if (cookies) {
              proxyRes.headers['set-cookie'] = cookies.map((c) =>
                c.replace(/; *Domain=[^;]*/gi, '').replace(/; *Secure/gi, ''),
              );
            }
          });
        },
      },
    },
  },
});
