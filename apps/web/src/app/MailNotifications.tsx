/**
 * Уведомления о новой почте: всплывающее окно браузера и счётчик
 * непрочитанных в заголовке вкладки.
 *
 * Обе настройки живут в «Общих настройках» и до сих пор не делали ничего:
 * их сохраняли, читать было некому. Компонент ничего не рисует — он
 * подключает поведение и висит в каркасе страницы.
 */

import { useEffect, useRef } from 'react';
import { useUnreadTotal } from '../api/accountsQueries';
import { newMailNotification, stripTabCounter, tabTitle } from '../lib/notifications';
import { useGeneralPreferences } from '../settings/generalSettings';
import { useMailEvents } from './mailEvents';

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

/** Всплывающие уведомления браузера о новых письмах. */
export function useBrowserNewMailNotifications(enabled: boolean): void {
  // Разрешение спрашиваем только когда настройка включена: без неё
  // спрашивать не за что, а браузер запоминает первый отказ надолго.
  useEffect(() => {
    if (!enabled || typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') void Notification.requestPermission();
  }, [enabled]);

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useMailEvents((event) => {
    if (!enabledRef.current || event.type !== 'new-message') return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // «Когда вкладка свёрнута» — так обещает сама настройка. Открытую
    // вкладку и так видно: письмо появляется в списке само.
    if (typeof document !== 'undefined' && !document.hidden) return;
    const { title, body } = newMailNotification(event);
    // tag — чтобы повторное событие об одном письме (переподключение
    // сокета) не выкладывало второе такое же уведомление.
    new Notification(title, { body, tag: event.id });
  });
}

export function MailNotifications() {
  const preferences = useGeneralPreferences();
  useTabUnreadCounter(preferences.notifications.tabCounter);
  useBrowserNewMailNotifications(preferences.notifications.browser);
  return null;
}
