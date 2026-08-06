/**
 * Уведомления о новой почте и счётчик непрочитанных в заголовке вкладки.
 *
 * Компонент ничего не рисует — он подключает поведение и висит в каркасе
 * страницы (см. router.tsx).
 *
 * Сам показ окна живёт в `notifications/local.ts`: там же договорённость
 * между вкладками (три открытых вкладки не должны дать три окна) и выбор
 * между Service Worker и прямым показом. Здесь остаётся только то, что
 * касается каркаса приложения: чтение настроек и заголовок вкладки.
 */

import { useEffect, useRef } from 'react';
import { useUnreadTotal } from '../api/accountsQueries';
import { stripTabCounter, tabTitle } from '../lib/notifications';
import { useGeneralPreferences } from '../settings/generalSettings';
import { useLocalNotifications } from '../notifications/local';
import { ensureServiceWorker } from '../notifications/subscribe';

/**
 * Счётчик непрочитанных — в заголовок вкладки.
 *
 * Считаем по ВСЕМ ящикам, а не только по текущему: связанный ящик тоже
 * получает почту, и о ней надо узнавать, не переключаясь. Число берётся
 * из общего `useUnreadTotal` — того же, что показывает значок в шапке,
 * чтобы в двух местах не оказалось двух разных правд.
 */
export function useTabUnreadCounter(enabled: boolean): void {
  const { total: unread } = useUnreadTotal();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const base = stripTabCounter(document.title);
    document.title = tabTitle(base, unread, enabled);
    // Настройку выключили или вкладку закрывают — заголовок возвращаем.
    return () => {
      document.title = base;
    };
  }, [unread, enabled]);
}

/**
 * Поднимает Service Worker, если уведомления уже разрешены.
 *
 * Именно «уже разрешены»: регистрация работника сама по себе ничего не
 * спрашивает и ничего не показывает, но заводить фоновую службу тому,
 * кто уведомлений не просил, незачем. А тому, кто просил, она нужна на
 * каждой загрузке страницы: работник мог быть снят браузером, и без
 * него не будет ни кнопок в окне, ни уведомлений с закрытой вкладкой.
 */
function useServiceWorker(enabled: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (!enabled || done.current) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    done.current = true;
    void ensureServiceWorker();
  }, [enabled]);
}

export function MailNotifications() {
  const preferences = useGeneralPreferences();
  const enabled = preferences.notifications.browser;
  useTabUnreadCounter(preferences.notifications.tabCounter);
  useServiceWorker(enabled);
  useLocalNotifications({ enabled });
  return null;
}
