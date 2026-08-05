/**
 * Точка входа админки.
 *
 * Токены и темы берём из веб-интерфейса — дизайн-система одна на оба
 * приложения. Своих цветов админка не заводит, только семантические
 * переменные плотной вёрстки в styles/admin.css.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '@web/styles/tokens.css';
import '@web/styles/themes.css';
import './styles/admin.css';

import { SessionProvider } from './app/session';
import { AppRoutes } from './app/router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // 401 повторять бессмысленно — это просьба войти, а не сбой
      retry: (failureCount, error) => {
        const status = (error as { status?: number } | null)?.status;
        if (status === 401 || status === 403) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Не найден элемент #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
