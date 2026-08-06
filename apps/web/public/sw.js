/*
 * Service Worker почты Mail.True: уведомления о новых письмах, когда
 * вкладка закрыта.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗДЕСЬ ПРОИСХОДИТ И ПОЧЕМУ ИМЕННО ТАК
 * ------------------------------------------------------------------
 * Сообщение, которое будит браузер, приходит через ЧУЖУЮ службу доставки
 * (Google для Chrome, Mozilla для Firefox, Apple для Safari). Поэтому наш
 * сервер кладёт в него минимум: «есть новости» и отпечаток ящика. Ни темы,
 * ни отправителя, ни текста.
 *
 * Всё остальное берётся ЗДЕСЬ, запросом к нашему же серверу
 * (GET /api/push/notifications) по той же сессии, что и открытая вкладка.
 * Наружу при этом не уходит ничего.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТО ОБЫЧНЫЙ JS, А НЕ ЧАСТЬ СБОРКИ
 * ------------------------------------------------------------------
 * Service Worker обязан лежать по постоянному адресу в корне сайта: его
 * область действия — каталог, из которого он отдан. Файл со сборочным
 * хешем в имени (index-bjZSgkdc.js) для этого не годится, а собирать
 * отдельную точку входа ради ста строк — лишний механизм. Поэтому файл
 * лежит в public/ и попадает в раздачу как есть.
 *
 * Проверяемость от этого не страдает: чистые части вынесены в объект
 * `self.mailTrueSw` и проверяются тестом, который читает ИМЕННО ЭТОТ файл
 * (apps/web/tests/serviceWorker.test.ts). Проверять копию логики на
 * TypeScript было бы самообманом — в браузер уезжает этот текст.
 */

/* eslint-env serviceworker */

const API = {
  notifications: '/api/push/notifications',
  seen: '/api/push/seen',
  flags: '/api/messages/flags',
  move: '/api/messages/move',
};

/** Запасное окно: сервер недоступен, сессия истекла, ответ непонятен. */
const FALLBACK = {
  title: 'Новое письмо',
  body: 'Откройте почту, чтобы прочитать',
  tag: 'mail-true',
  icon: '/brand/notification-icon.png',
  badge: '/brand/notification-badge.png',
  actions: [{ action: 'open', title: 'Открыть почту' }],
  url: '/inbox/',
  ids: [],
};

/* ------------------------------------------------------------------ */
/* Чистые части (проверяются тестом)                                    */
/* ------------------------------------------------------------------ */

/**
 * Разбор тела push-сообщения.
 *
 * Тело может быть пустым (некоторые службы доставки будят браузер без
 * него), может быть не-JSON, а может нести готовое окно — если человек
 * сам включил «класть содержимое в push». Разваливаться нельзя ни на
 * одном из вариантов: Chrome требует показать окно на КАЖДОЕ сообщение,
 * иначе выведет своё «сайт обновился в фоне».
 */
function parsePush(raw) {
  if (!raw) return { key: null, view: null, test: false };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { key: null, view: null, test: false };
  }
  if (!data || typeof data !== 'object') return { key: null, view: null, test: false };
  return {
    key: typeof data.k === 'string' ? data.k : null,
    view: data.view && typeof data.view === 'object' ? data.view : null,
    test: data.test === true,
  };
}

/**
 * Приводит ответ сервера к тому, что понимает Notification API.
 *
 * Отдельная функция, а не «передадим как есть»: в `showNotification`
 * попадает то, что пришло по сети, и одно неожиданное поле (например,
 * `actions` строкой вместо массива) роняет показ целиком — то есть
 * человек не получает уведомление вовсе.
 */
function toNotification(view, options) {
  const source = view && typeof view === 'object' ? view : FALLBACK;
  const supportsActions = Boolean(options && options.supportsActions);
  const actions = supportsActions && Array.isArray(source.actions) ? source.actions.slice(0, 2) : [];
  return {
    title: typeof source.title === 'string' && source.title ? source.title : FALLBACK.title,
    options: {
      body: typeof source.body === 'string' ? source.body : '',
      // Ярлык — то, на чём держится «десять писем дают одно окно»:
      // окно с тем же ярлыком заменяет предыдущее, а не встаёт рядом.
      tag: typeof source.tag === 'string' && source.tag ? source.tag : FALLBACK.tag,
      icon: typeof source.icon === 'string' && source.icon ? source.icon : FALLBACK.icon,
      badge: typeof source.badge === 'string' && source.badge ? source.badge : FALLBACK.badge,
      actions,
      // Заменяя окно, всё-таки привлечь внимание ещё раз: без этого
      // второе письмо подряд обновляло бы текст молча, и человек узнал
      // бы о нём, только посмотрев на экран.
      renotify: true,
      // Окно не должно исчезать само: уведомление о письме — это то,
      // что человек мог не увидеть в первые пять секунд.
      requireInteraction: false,
      data: {
        url: typeof source.url === 'string' ? source.url : FALLBACK.url,
        ids: Array.isArray(source.ids) ? source.ids.filter((id) => typeof id === 'string') : [],
      },
    },
  };
}

/**
 * Выбор вкладки, которую поднять по щелчку.
 *
 * Открывать новую вкладку, когда почта уже открыта, — самый частый способ
 * испортить впечатление: у человека их становится пять. Поэтому сначала
 * ищем свою вкладку, и только если её нет — открываем новую.
 */
function pickClient(clients, origin) {
  const list = Array.isArray(clients) ? clients : [];
  const own = list.filter((client) => typeof client.url === 'string' && client.url.startsWith(origin));
  if (own.length === 0) return null;
  // Видимая вкладка предпочтительнее свёрнутой: человек смотрит на неё.
  return own.find((client) => client.visibilityState === 'visible') ?? own[0];
}

self.mailTrueSw = { parsePush, toNotification, pickClient, FALLBACK };

/* ------------------------------------------------------------------ */
/* Жизненный цикл                                                       */
/* ------------------------------------------------------------------ */

self.addEventListener('install', () => {
  // Новая версия начинает работать сразу. Кэша у нас нет, ломать нечего,
  // а ждать закрытия всех вкладок ради исправления в уведомлениях —
  // значит чинить их через неделю.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/* ------------------------------------------------------------------ */
/* Уведомление                                                          */
/* ------------------------------------------------------------------ */

/** Забирает содержимое уведомления с НАШЕГО сервера. */
async function fetchView() {
  const response = await fetch(API.notifications, {
    // Без cookie сервер не узнает, чей это ящик. Запрос свой,
    // к своему же адресу — никуда наружу он не идёт.
    credentials: 'include',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data && typeof data === 'object' ? data.view : null;
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const raw = event.data ? event.data.text() : '';
      const incoming = parsePush(raw);

      let view = incoming.view;
      if (!view) {
        try {
          view = await fetchView();
        } catch {
          // Сервер недоступен с этого устройства (нет сети, почта за
          // границей сети предприятия). Показываем безымянное окно —
          // это честнее, чем промолчать: письмо-то пришло.
          view = null;
        }
      }
      if (!view && incoming.test) {
        view = {
          ...FALLBACK,
          title: 'Проверка уведомлений',
          body: 'Уведомления Mail.True работают. Так вы увидите новое письмо.',
        };
      }

      const supportsActions = 'actions' in Notification.prototype;
      const prepared = toNotification(view, { supportsActions });
      await self.registration.showNotification(prepared.title, prepared.options);
    })(),
  );
});

/* ------------------------------------------------------------------ */
/* Действия в окне                                                      */
/* ------------------------------------------------------------------ */

/** Сообщает серверу, что уведомление отработано, — чтобы оно не всплыло снова. */
async function markSeen(ids) {
  await fetch(API.seen, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
  }).catch(() => undefined);
}

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification && event.notification.data) || {};
  const ids = Array.isArray(data.ids) ? data.ids : [];
  event.notification.close();

  event.waitUntil(
    (async () => {
      /*
       * Кнопки «Прочитано» и «В архив» обращаются к тем же самым
       * маршрутам, что и сама почта. Второго пути к тем же действиям
       * нет намеренно: он означал бы второй набор проверок прав.
       */
      if (event.action === 'read' && ids.length > 0) {
        await fetch(API.flags, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, seen: true }),
        }).catch(() => undefined);
        await markSeen(ids);
        return;
      }
      if (event.action === 'archive' && ids.length > 0) {
        await fetch(API.move, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, targetFolderId: 'archive' }),
        }).catch(() => undefined);
        await markSeen(ids);
        return;
      }

      // Обычный щелчок: открываем ИМЕННО ЭТО письмо.
      await markSeen(ids);
      const url = typeof data.url === 'string' ? data.url : FALLBACK.url;
      const target = new URL(url, self.location.origin).href;
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = pickClient(clients, self.location.origin);
      if (existing) {
        // Уже открытую почту переводим на нужное письмо, а не плодим вкладки
        if ('navigate' in existing) await existing.navigate(target).catch(() => undefined);
        await existing.focus();
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener('notificationclose', (event) => {
  // Окно закрыли рукой — значит, увидели. Повторять эти же письма
  // следующим уведомлением незачем.
  const data = (event.notification && event.notification.data) || {};
  event.waitUntil(markSeen(Array.isArray(data.ids) ? data.ids : []));
});
