/**
 * Клиент раздела уведомлений и отпечаток браузера.
 *
 * Отпечаток — не опознание человека и не слежка: это случайная строка,
 * которую браузер придумывает себе сам и хранит у себя. Нужна она ровно
 * для одного — чтобы сервер не слал push туда, где сейчас открыта вкладка
 * почты: иначе на одно письмо человек получал бы два одинаковых окна.
 * Сервер только сравнивает эту строку с той, что пришла вместе с
 * подпиской; узнать по ней что-либо о человеке нельзя.
 */

import { apiFetch } from '../api/http';
import type { NotificationPrefs, NotificationPrefsPatch, NotificationView, PushState } from './types';

const CLIENT_ID_KEY = 'mt-notification-client';

/**
 * Отпечаток этого браузера. Создаётся при первом обращении и живёт
 * в localStorage — то есть переживает перезагрузку страницы, но не
 * переезжает на другое устройство. Это и требуется.
 */
export function browserClientId(): string {
  if (typeof localStorage === 'undefined') return 'no-storage';
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing && existing.length > 0) return existing;
    const created =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `c${String(Date.now())}${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    // Приватный режим с запретом на хранилище. Без отпечатка push будет
    // приходить и туда, где открыта вкладка, — неприятно, но не смертельно.
    return 'no-storage';
  }
}

/** Часовой пояс браузера — по нему считаются «тихие часы». */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const notificationsApi = {
  getState: (clientId: string): Promise<PushState> =>
    apiFetch(`/api/push/state?clientId=${encodeURIComponent(clientId)}`),

  savePrefs: (patch: NotificationPrefsPatch): Promise<NotificationPrefs> =>
    apiFetch('/api/push/prefs', json('PUT', patch)),

  subscribe: (input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    clientId: string;
    timeZone: string | null;
  }): Promise<PushState> =>
    apiFetch(
      '/api/push/subscribe',
      json('POST', {
        endpoint: input.endpoint,
        keys: input.keys,
        clientId: input.clientId,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      }),
    ),

  unsubscribe: (endpoint: string): Promise<{ removed: boolean }> =>
    apiFetch('/api/push/unsubscribe', json('POST', { endpoint })),

  /**
   * Содержимое уведомления. Тот же маршрут зовёт Service Worker: правила
   * показа должны быть одни, а не «почти одни».
   */
  getNotification: (): Promise<{ view: NotificationView; pending: number }> =>
    apiFetch('/api/push/notifications'),

  /** Уведомление отработано: показано, закрыто или человек открыл почту. */
  markSeen: (ids?: string[]): Promise<{ forgotten: number; pending: number }> =>
    apiFetch('/api/push/seen', json('POST', ids && ids.length > 0 ? { ids } : {})),

  sendTest: (clientId: string): Promise<{ sent: number; error: string | null }> =>
    apiFetch('/api/push/test', json('POST', { clientId })),
};
