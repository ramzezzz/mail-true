/**
 * Уведомления, пока почта открыта хотя бы в одной вкладке.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТОТ ПУТЬ ОТДЕЛЬНЫЙ
 * ------------------------------------------------------------------
 * Здесь ничего не проходит через чужие серверы: событие о письме приходит
 * по нашему же WebSocket, окно рисует сама страница. Никакой службы
 * доставки, никаких подписок, никакого разрешения на фоновую работу —
 * только разрешение на показ уведомлений.
 *
 * ------------------------------------------------------------------
 * ДВЕ ВКЛАДКИ — ОДНО ОКНО
 * ------------------------------------------------------------------
 * Почта нередко открыта в трёх вкладках сразу, и событие о письме придёт
 * в каждую. Ярлык окна (`tag`) спасает не полностью: браузер заменяет
 * окно с тем же ярлыком, но со звуком и подсветкой это выглядит как три
 * уведомления подряд.
 *
 * Поэтому вкладки договариваются между собой. Увидев письмо, вкладка
 * объявляет о намерении показать окно и ждёт короткое время; показывает
 * та, у которой номер меньше. Договорённость детерминированная: выбор не
 * зависит ни от порядка сообщений, ни от того, кто успел первым, —
 * а значит, не может «иногда» дать два окна.
 */

import { useEffect, useRef } from 'react';
import { useMailEvents } from '../app/mailEvents';
import type { WsEvent } from '../api/types';
import { notificationsApi } from './api';
import type { NotificationView } from './types';

/** Канал, по которому вкладки договариваются. */
export const CLAIM_CHANNEL = 'mail-true-notifications';

/**
 * Сколько ждём заявок от соседних вкладок.
 *
 * Шестьдесят миллисекунд: меньше — и сообщение соседней вкладки может не
 * успеть (BroadcastChannel доставляет асинхронно), больше — и задержка
 * уведомления становится заметной. Для сравнения: письмо до этого места
 * добиралось секунды.
 */
export const CLAIM_WINDOW_MS = 60;

export interface Claim {
  id: string;
  tabId: string;
}

/**
 * Кто показывает окно.
 *
 * Побеждает наименьший номер вкладки — по сравнению строк, а не по
 * времени прихода заявки. Это и делает выбор одинаковым во всех вкладках
 * сразу: у каждой на руках один и тот же список.
 */
export function claimWinner(claims: readonly Claim[], id: string): string | null {
  const forId = claims.filter((claim) => claim.id === id).map((claim) => claim.tabId);
  if (forId.length === 0) return null;
  return forId.reduce((min, tabId) => (tabId < min ? tabId : min));
}

/** Номер вкладки: живёт ровно столько, сколько сама вкладка. */
export function makeTabId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `t${String(Date.now())}${Math.random().toString(36).slice(2)}`;
}

/* ------------------------------------------------------------------ */
/* Показ окна                                                           */
/* ------------------------------------------------------------------ */

/**
 * Показывает окно.
 *
 * Через Service Worker, если он есть, и напрямую — если нет. Разница не
 * косметическая: только `registration.showNotification` умеет кнопки
 * («Прочитано», «В архив»), и только у него нажатие попадает в тот же
 * обработчик, что и у уведомления при закрытой вкладке. То есть щелчок
 * по окну ведёт себя одинаково, открыта почта или нет.
 */
export async function showNotificationView(view: NotificationView): Promise<boolean> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;

  const options: NotificationOptions & { actions?: { action: string; title: string }[] } = {
    body: view.body,
    tag: view.tag,
    icon: view.icon,
    badge: view.badge,
    data: { url: view.url, ids: view.ids },
  };

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      if (registration) {
        await registration.showNotification(view.title, {
          ...options,
          actions: view.actions,
          // Заменяя прежнее окно, привлечь внимание ещё раз: иначе
          // второе письмо подряд обновило бы текст молча.
          renotify: true,
          // И не гасить окно само по себе — то же правило, что в
          // служебном сценарии: уведомление о письме ждёт человека, а не
          // отсчитывает секунды до исчезновения.
          requireInteraction: true,
        } as NotificationOptions);
        return true;
      }
    } catch {
      /* работник не готов — покажем окно напрямую */
    }
  }

  // Без работника кнопок не будет: конструктор Notification их не умеет.
  // Само уведомление при этом работает, и щелчок ведёт в письмо.
  const notification = new Notification(view.title, options);
  notification.onclick = () => {
    window.focus();
    window.location.assign(view.url);
    notification.close();
    void notificationsApi.markSeen(view.ids).catch(() => undefined);
  };
  return true;
}

/* ------------------------------------------------------------------ */
/* Подключение к событиям                                               */
/* ------------------------------------------------------------------ */

export interface LocalNotificationsOptions {
  /** Показывать ли уведомления вообще (главный выключатель настроек). */
  enabled: boolean;
}

/**
 * Уведомления о новых письмах на открытой вкладке.
 *
 * Ничего не рисует: подключает поведение и висит в каркасе страницы.
 */
export function useLocalNotifications({ enabled }: LocalNotificationsOptions): void {
  const tabId = useRef<string>('');
  if (tabId.current === '') tabId.current = makeTabId();

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Заявки соседних вкладок и наши собственные — общий список на вкладку.
  const claims = useRef<Claim[]>([]);
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bus = new BroadcastChannel(CLAIM_CHANNEL);
    channel.current = bus;
    bus.onmessage = (event: MessageEvent<Claim>) => {
      const claim = event.data;
      if (claim && typeof claim.id === 'string' && typeof claim.tabId === 'string') {
        claims.current.push(claim);
      }
    };
    return () => {
      bus.close();
      channel.current = null;
    };
  }, []);

  /*
   * Человек вернулся к почте — уведомления больше не новости.
   * Без этого следующее письмо показало бы «5 новых писем», четыре из
   * которых человек уже прочитал глазами в открытом списке.
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = (): void => {
      if (!document.hidden) void notificationsApi.markSeen().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useMailEvents((event: WsEvent) => {
    if (!enabledRef.current || event.type !== 'new-message') return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // Открытую вкладку видно и так: письмо появляется в списке само.
    if (typeof document !== 'undefined' && !document.hidden) return;

    const id = event.id;
    const claim: Claim = { id, tabId: tabId.current };
    claims.current.push(claim);
    channel.current?.postMessage(claim);

    window.setTimeout(() => {
      const winner = claimWinner(claims.current, id);
      claims.current = claims.current.filter((c) => c.id !== id);
      if (winner !== tabId.current) return;
      /*
       * Содержимое окна собирает СЕРВЕР — тот же самый маршрут, что зовёт
       * Service Worker при закрытой вкладке. Событие WebSocket уже несёт
       * тему и отправителя, и соблазн собрать текст здесь был велик; но
       * две реализации одних и тех же уровней подробности расходятся
       * всегда, и расходиться начали бы там, где это заметнее всего.
       */
      void notificationsApi
        .getNotification()
        .then((result) => showNotificationView(result.view))
        .catch(() => undefined);
    }, CLAIM_WINDOW_MS);
  });
}
