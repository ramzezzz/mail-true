/**
 * Разрешение браузера, Service Worker и подписка на доставку.
 *
 * ------------------------------------------------------------------
 * КОГДА СПРАШИВАЕТСЯ РАЗРЕШЕНИЕ
 * ------------------------------------------------------------------
 * Только из обработчика действия человека: включения переключателя в
 * настройках или нажатия на предложение в почте. Ни при загрузке
 * страницы, ни «через пять секунд», ни при первом письме.
 *
 * Это не вежливость, а работоспособность. Chrome с версии 80 подменяет
 * запрос, показанный без действия пользователя, неприметной иконкой в
 * адресной строке; Firefox с версии 72 гасит его совсем. То есть окно,
 * показанное «на всякий случай», человек в большинстве случаев просто не
 * увидит. А увидит — нажмёт «Блокировать», потому что на первой секунде
 * знакомства с почтой отвечать на такой вопрос нечем. После этого сайт
 * спросить больше не может НИКОГДА — только человек руками в настройках
 * браузера (подсказку даёт capability.ts).
 *
 * Отсюда же порядок шагов ниже: сначала спрашиваем разрешение, и только
 * получив его, регистрируем Service Worker и создаём подписку. Обратный
 * порядок оставлял бы после отказа зарегистрированного работника,
 * которому нечего делать.
 */

import { notificationsApi, browserClientId, browserTimeZone } from './api';
import type { PushState } from './types';

/** Адрес Service Worker. В корне сайта — от этого зависит его область действия. */
export const SERVICE_WORKER_URL = '/sw.js';

/**
 * Ключ VAPID из base64url в байты.
 *
 * `applicationServerKey` принимает только BufferSource: строку он молча
 * не понимает, а подписка при этом создаётся — и уведомления не приходят,
 * потому что ключ в ней не тот.
 */
export function decodeVapidKey(base64Url: string): Uint8Array {
  const padded = base64Url.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Ключ подписки из ArrayBuffer в base64url — в таком виде его ждёт сервер. */
export function encodeKey(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** Результат попытки включить уведомления — с причиной отказа, а не просто false. */
export interface EnableResult {
  ok: boolean;
  /** 'denied' — человек отказал; 'unsupported' — браузер не умеет; 'failed' — не вышло. */
  reason: 'denied' | 'unsupported' | 'failed' | null;
  message: string | null;
  state: PushState | null;
}

/**
 * Спрашивает разрешение. Вызывать ТОЛЬКО из обработчика действия
 * человека — см. пояснение в шапке файла.
 */
export async function requestPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

/**
 * Регистрирует Service Worker.
 *
 * `updateViaCache: 'none'` — чтобы браузер не отдавал старую версию файла
 * из своего кэша: работник живёт неделями, и исправление в нём иначе
 * доезжает до людей с задержкой в те же недели.
 */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
      scope: '/',
      updateViaCache: 'none',
    });
  } catch {
    return null;
  }
}

/**
 * Включает уведомления при закрытой вкладке: разрешение → работник →
 * подписка → сервер.
 *
 * Каждый шаг может не получиться, и на каждом возвращается СВОЯ причина:
 * «не вышло» без объяснения — это ровно та жалоба, из-за которой раздел
 * и написан так подробно.
 */
export async function enablePush(vapidPublicKey: string | null): Promise<EnableResult> {
  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Браузер не поддерживает доставку уведомлений при закрытой вкладке',
      state: null,
    };
  }
  if (!vapidPublicKey) {
    return {
      ok: false,
      reason: 'failed',
      message: 'Сервер не выдал ключ для подписки',
      state: null,
    };
  }

  const permission = await requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      reason: 'denied',
      message:
        permission === 'denied'
          ? 'Браузер заблокировал уведомления от этого сайта'
          : 'Разрешение не выдано',
      state: null,
    };
  }

  const registration = await ensureServiceWorker();
  if (!registration) {
    return {
      ok: false,
      reason: 'failed',
      message: 'Не удалось запустить фоновую службу уведомлений',
      state: null,
    };
  }

  try {
    // Работник должен быть готов принимать сообщения: подписка, созданная
    // до его готовности, приводит к push, который некому показать.
    await navigator.serviceWorker.ready;

    const existing = await registration.pushManager.getSubscription();
    /*
     * Старая подписка могла быть выдана под ДРУГОЙ ключ сервера — так
     * бывает после переноса установки. Уведомления по ней не придут
     * никогда, и понять это по внешним признакам нельзя. Поэтому
     * несовпадающую подписку отменяем и создаём заново.
     */
    const wanted = decodeVapidKey(vapidPublicKey);
    const matches =
      existing !== null &&
      existing.options.applicationServerKey !== null &&
      sameKey(new Uint8Array(existing.options.applicationServerKey), wanted);
    if (existing && !matches) await existing.unsubscribe().catch(() => undefined);

    const subscription =
      existing && matches
        ? existing
        : await registration.pushManager.subscribe({
            // Без этого Chrome подписку не создаст вовсе: он требует
            // обещания, что каждое сообщение будет показано человеку.
            userVisibleOnly: true,
            applicationServerKey: wanted as BufferSource,
          });

    const state = await notificationsApi.subscribe({
      endpoint: subscription.endpoint,
      keys: {
        p256dh: encodeKey(subscription.getKey('p256dh')),
        auth: encodeKey(subscription.getKey('auth')),
      },
      clientId: browserClientId(),
      timeZone: browserTimeZone(),
    });
    return { ok: true, reason: null, message: null, state };
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      message: err instanceof Error ? err.message : 'Не удалось оформить подписку',
      state: null,
    };
  }
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Выключает доставку при закрытой вкладке.
 *
 * Отменяется и подписка в браузере, и запись на сервере. Оставить одно
 * без другого — значит либо продолжать будить браузер впустую, либо
 * держать в базе подписку, о которой браузер уже не знает.
 */
export async function disablePush(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await notificationsApi.unsubscribe(subscription.endpoint).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}
