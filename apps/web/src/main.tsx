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

/*
 * ФАЙЛ, БРОШЕННЫЙ МИМО ПИСЬМА, НЕ ДОЛЖЕН УНОСИТЬ ВСЮ ПОЧТУ.
 *
 * По умолчанию браузер открывает брошенный на страницу файл вместо неё:
 * вкладка уходит на `blob:`/`file:`, и вместе с ней пропадает всё
 * приложение — включая открытые окна написания с набранными письмами.
 * Промахнуться легко: мимо тела письма это вся шапка окна, поля «Кому» и
 * «Тема», ряд вложений, нижняя панель и список писем позади.
 *
 * Гасим переход на уровне окна, а не приложения: обработчики React живут
 * внутри корня, а бросить можно куда угодно — хоть на пустое место рядом.
 * Свои перетаскивания (письмо в папку, файл в тело письма) зовут
 * preventDefault сами и до сюда не доходят.
 */
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(
    type,
    (event: DragEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (type === 'dragover' && event.dataTransfer) {
        // «Сюда бросать некуда» — курсор с перечёркнутым кругом вместо
        // приглашающего плюса: иначе человек ждёт, что файл прикрепится.
        event.dataTransfer.dropEffect = 'none';
      }
    },
    false,
  );
}

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
