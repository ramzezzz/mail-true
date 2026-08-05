/** Точка входа: провайдеры (react-query), роутер, тема, WebSocket-подписка. */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';

import './styles/tokens.css';
import './styles/themes.css';
import './styles/global.css';

import { useMocks } from './api';
import { shouldRetryQuery } from './api/http';
import { initWallpaper } from './appearance/wallpapers';
import { applyTheme, useUiStore } from './app/store';
import { router } from './app/router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // 401 и 403 повторять бессмысленно — это просьба войти, а не сбой.
      // Раньше такой ответ повторялся трижды, и пользователь ждал впустую.
      retry: useMocks ? false : shouldRetryQuery,
      refetchOnWindowFocus: !useMocks,
    },
  },
});

// применяем сохранённую тему до первого рендера, чтобы не мигало
applyTheme(useUiStore.getState().theme);
// и восстанавливаем выбранные обои (своя картинка читается из IndexedDB
// асинхронно; до неё «обойная» тема показывает градиент-заглушку)
void initWallpaper();

// Серверные события (пришло письмо, изменились счётчики) подключает
// SessionProvider: подписка нужна только при живой сессии, а сокет должен
// переустанавливаться после обрывов (см. lib/reconnectingSocket.ts).

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
