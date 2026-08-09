/**
 * Service Worker уведомлений — проверяется ИМЕННО ТОТ файл, который
 * уезжает в браузер.
 *
 * Файл читается с диска (apps/web/public/sw.js) и выполняется в песочнице
 * с поддельным `self`. Так сделано нарочно: работник лежит в public/ и не
 * проходит через сборку, поэтому проверять копию его логики на TypeScript
 * было бы самообманом — в браузер уезжает этот текст, а не копия.
 *
 * Здесь же проверяется главное свойство всего раздела: работник ЗАБИРАЕТ
 * содержимое уведомления с нашего сервера, а не берёт его из push. Если
 * кто-нибудь однажды «упростит» это, положив тему письма в push-сообщение
 * по умолчанию, проверка ниже упадёт.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SW_PATH = fileURLToPath(new URL('../public/sw.js', import.meta.url));
const SOURCE = readFileSync(SW_PATH, 'utf8');

interface Listeners {
  [event: string]: ((event: unknown) => void)[];
}

interface Harness {
  self: Record<string, unknown>;
  listeners: Listeners;
  shown: { title: string; options: Record<string, unknown> }[];
  requests: { url: string; init: Record<string, unknown> | undefined }[];
  fetchMock: ReturnType<typeof vi.fn>;
  opened: string[];
  navigated: string[];
  focused: number;
  /** Дожидается всех обещаний, переданных в event.waitUntil. */
  settle(): Promise<void>;
}

/** Поднимает работника в песочнице с поддельным окружением браузера. */
function loadWorker(
  options: { notificationResponse?: unknown; ok?: boolean; clients?: unknown[] } = {},
): Harness {
  const listeners: Listeners = {};
  const shown: Harness['shown'] = [];
  const requests: Harness['requests'] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const pending: Promise<unknown>[] = [];
  let focused = 0;

  const fetchMock = vi.fn(async (url: string, init?: Record<string, unknown>) => {
    requests.push({ url, init });
    return {
      ok: options.ok ?? true,
      status: options.ok === false ? 401 : 200,
      json: async () => options.notificationResponse ?? {},
      text: async () => '',
    };
  });

  const windowClients = (options.clients ?? []).map((client) => ({
    ...(client as object),
    focus: () => {
      focused += 1;
      return Promise.resolve();
    },
    navigate: (url: string) => {
      navigated.push(url);
      return Promise.resolve();
    },
  }));

  const self: Record<string, unknown> = {
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      (listeners[name] ??= []).push(handler);
    },
    skipWaiting: () => undefined,
    location: { origin: 'https://mail.local' },
    registration: {
      showNotification: (title: string, opts: Record<string, unknown>) => {
        shown.push({ title, options: opts });
        return Promise.resolve();
      },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(windowClients),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
  };

  /*
   * Хранилище отпечатка ящика. Настоящий Cache Storage работнику нужен
   * ровно для одного: помнить, чей это браузер, между запусками (его
   * останавливают между уведомлениями). Здесь — простейшая замена с тем
   * же поведением.
   */
  const store = new Map<string, string>();
  const caches = {
    open: async () => ({
      match: async (key: string) => {
        const value = store.get(key);
        return value === undefined ? undefined : { text: async () => value };
      },
      put: async (key: string, response: { text: () => Promise<string> }) => {
        store.set(key, await response.text());
      },
      delete: async (key: string) => store.delete(key),
    }),
  };

  const context = createContext({
    self,
    caches,
    Response: class {
      #body: string;
      constructor(body: string) {
        this.#body = body;
      }
      async text(): Promise<string> {
        return this.#body;
      }
    },
    fetch: fetchMock,
    // Браузер, который умеет кнопки в уведомлении
    Notification: function Notification() {} as unknown,
    URL,
    JSON,
    Array,
    console,
    Promise,
  });
  (context as { Notification: { prototype: Record<string, unknown> } }).Notification.prototype = {
    actions: [],
  };

  runInContext(SOURCE, context);

  return {
    self,
    listeners,
    shown,
    requests,
    fetchMock,
    opened,
    navigated,
    get focused() {
      return focused;
    },
    settle: async () => {
      await Promise.all(pending);
      // Обещания из waitUntil собираются в fire(); ждём микрозадачи
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

/** Вызывает обработчик события и дожидается его работы. */
async function fire(harness: Harness, name: string, event: Record<string, unknown>): Promise<void> {
  const waited: Promise<unknown>[] = [];
  const full = { ...event, waitUntil: (promise: Promise<unknown>) => waited.push(promise) };
  for (const handler of harness.listeners[name] ?? []) handler(full);
  await Promise.all(waited);
}

function sw(harness: Harness) {
  return harness.self['mailTrueSw'] as {
    parsePush(raw: string): { key: string | null; view: unknown; test: boolean };
    toNotification(
      view: unknown,
      options: { supportsActions: boolean },
    ): { title: string; options: Record<string, unknown> };
    pickClient(clients: unknown[], origin: string): unknown;
  };
}

/* ------------------------------------------------------------------ */

describe('разбор push-сообщения', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = loadWorker();
  });

  it('минимальное тело разбирается в отпечаток ящика и ничего больше', () => {
    const parsed = sw(harness).parsePush('{"v":1,"k":"0123456789abcdef"}');
    expect(parsed).toEqual({ key: '0123456789abcdef', view: null, test: false });
  });

  it('пустое и битое тело не роняют работника', () => {
    // Chrome требует показать окно на КАЖДОЕ push-сообщение: упавший
    // разбор означал бы чужой текст «сайт обновился в фоне» вместо нашего.
    for (const raw of ['', 'не json', '[]', 'null', '"строка"']) {
      expect(sw(harness).parsePush(raw)).toEqual({ key: null, view: null, test: false });
    }
  });

  it('готовое окно в теле подхватывается — это выбор человека', () => {
    const parsed = sw(harness).parsePush('{"v":1,"k":"abc","view":{"title":"Пётр"}}');
    expect(parsed.view).toEqual({ title: 'Пётр' });
  });
});

describe('приведение ответа сервера к окну браузера', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = loadWorker();
  });

  it('нормальный ответ переносится целиком', () => {
    const result = sw(harness).toNotification(
      {
        title: 'Пётр',
        body: 'Договор',
        tag: 'mail-true:abc',
        icon: '/api/sender-logos/example.com/image?v=1',
        badge: '/brand/notification-badge.png',
        actions: [{ action: 'read', title: 'Прочитано' }],
        url: '/inbox/inbox%3A296',
        ids: ['inbox:296'],
      },
      { supportsActions: true },
    );
    expect(result.title).toBe('Пётр');
    expect(result.options['tag']).toBe('mail-true:abc');
    expect(result.options['icon']).toBe('/api/sender-logos/example.com/image?v=1');
    expect(result.options['actions']).toHaveLength(1);
    expect(result.options['data']).toEqual({ url: '/inbox/inbox%3A296', ids: ['inbox:296'] });
    // Заменяя окно, привлечь внимание ещё раз — иначе второе письмо
    // подряд обновило бы текст молча
    expect(result.options['renotify']).toBe(true);
  });

  it('битый ответ не отменяет уведомление, а заменяется запасным', () => {
    // Иначе одно неожиданное поле в ответе означало бы, что человек не
    // получил уведомления вовсе.
    const result = sw(harness).toNotification(
      { title: 42, body: null, actions: 'кнопки', tag: '' },
      { supportsActions: true },
    );
    expect(result.title).toBe('Новое письмо');
    expect(result.options['tag']).toBe('mail-true');
    expect(result.options['actions']).toEqual([]);
  });

  it('браузер без поддержки кнопок получает окно без кнопок', () => {
    const result = sw(harness).toNotification(
      { title: 'Пётр', actions: [{ action: 'read', title: 'Прочитано' }] },
      { supportsActions: false },
    );
    expect(result.options['actions']).toEqual([]);
    expect(result.title).toBe('Пётр');
  });

  it('кнопок не больше двух: остальные браузер всё равно не покажет', () => {
    const result = sw(harness).toNotification(
      {
        title: 'Пётр',
        actions: [
          { action: 'read', title: 'Прочитано' },
          { action: 'archive', title: 'В архив' },
          { action: 'open', title: 'Открыть' },
        ],
      },
      { supportsActions: true },
    );
    expect(result.options['actions']).toHaveLength(2);
  });
});

describe('показ уведомления', () => {
  it('содержимое забирается с нашего сервера, а не из push-сообщения', async () => {
    const harness = loadWorker({
      notificationResponse: {
        view: { title: 'Пётр', body: 'Договор поставки', tag: 'mail-true:abc', ids: ['inbox:296'] },
      },
    });

    await fire(harness, 'push', { data: { text: () => '{"v":1,"k":"abc"}' } });

    // Вот оно, главное свойство: за содержимым работник пошёл к нам
    const call = harness.requests.find((r) => r.url.startsWith('/api/push/notifications'));
    expect(call, 'работник обязан спросить содержимое у нашего сервера').toBeTruthy();
    expect(call?.init?.['credentials']).toBe('include');
    /*
     * И назвал ящик, которому пришло уведомление.
     *
     * Подписка привязана к адресу в момент включения, а сессия в браузере
     * могла смениться — человек переключился на второй ящик. Без этого
     * признака сервер собирал содержимое по текущей сессии, и в окне
     * показывались письма ДРУГОГО ящика.
     */
    expect(call?.url).toContain('k=abc');
    expect(harness.shown).toHaveLength(1);
    expect(harness.shown[0]?.title).toBe('Пётр');
    expect(harness.shown[0]?.options['body']).toBe('Договор поставки');
  });

  it('недоступный сервер даёт безымянное окно, а не тишину', async () => {
    const harness = loadWorker({ ok: false });
    await fire(harness, 'push', { data: { text: () => '{"v":1,"k":"abc"}' } });

    // Письмо пришло — промолчать было бы хуже всего. Сессия могла истечь,
    // а телефон — оказаться вне сети предприятия.
    expect(harness.shown).toHaveLength(1);
    expect(harness.shown[0]?.title).toBe('Новое письмо');
    expect(harness.shown[0]?.options['body']).toBe('Откройте почту, чтобы прочитать');
  });

  it('готовое окно в push показывается своему ящику без обращения к серверу', async () => {
    /*
     * «Класть содержимое в push» затевалось ради случая, когда до
     * сервера не достучаться, — значит сверка отпечатка обязана
     * обходиться без сети. Страница сообщает работнику, чей это
     * браузер, сообщением mt-own-key.
     */
    const harness = loadWorker();
    await fire(harness, 'message', { data: { type: 'mt-own-key', key: 'abc' } });
    await fire(harness, 'push', {
      data: { text: () => '{"v":1,"k":"abc","view":{"title":"Пётр","body":"Договор"}}' },
    });
    expect(harness.requests.filter((r) => r.url === '/api/push/notifications')).toHaveLength(0);
    expect(harness.shown[0]?.title).toBe('Пётр');
  });

  it('готовое окно ЧУЖОГО ящика не показывается: на общем компьютере это чужая почта', async () => {
    /*
     * Сессия первого истекла (именно истекла — выход подписку снимает),
     * вошёл второй. Уведомление первому приходит с содержимым внутри, и
     * раньше окно рисовалось как есть: второй видел отправителя и тему
     * чужого письма.
     */
    const harness = loadWorker();
    await fire(harness, 'message', { data: { type: 'mt-own-key', key: 'второй' } });
    await fire(harness, 'push', {
      data: { text: () => '{"v":1,"k":"первый","view":{"title":"Пётр","body":"Договор"}}' },
    });
    expect(harness.shown[0]?.title).not.toBe('Пётр');
    expect(String(harness.shown[0]?.options['body'] ?? '')).not.toContain('Договор');
  });

  it('проверочное уведомление не притворяется письмом', async () => {
    // Иначе человек, нажавший «отправить проверочное», решит, что ему
    // написали. Очередь при этом пуста, и сервер вернул бы обычное
    // «Новое письмо» — на живом стенде так и вышло.
    const harness = loadWorker({
      notificationResponse: { view: { title: 'Новое письмо', body: 'Откройте почту' } },
    });
    await fire(harness, 'push', { data: { text: () => '{"v":1,"k":"abc","test":true}' } });

    expect(harness.shown[0]?.title).toBe('Проверка уведомлений');
    expect(String(harness.shown[0]?.options['body'])).toContain('работают');
    // Ярлык ящика: проверочное окно должно смениться первым же письмом,
    // а не остаться висеть рядом с настоящими уведомлениями
    expect(harness.shown[0]?.options['tag']).toBe('mail-true:abc');
  });

  it('проверка сообщает, если работник не достучался до нашего сервера', async () => {
    // Push дошёл (служба доставки и ключи в порядке), а содержимое — нет:
    // истёкшая сессия или устройство вне сети предприятия. Тогда
    // настоящие письма будут показываться безымянными, и узнать об этом
    // иначе негде.
    const harness = loadWorker({ ok: false });
    await fire(harness, 'push', { data: { text: () => '{"v":1,"k":"abc","test":true}' } });

    expect(harness.shown[0]?.title).toBe('Проверка уведомлений');
    expect(String(harness.shown[0]?.options['body'])).toContain('подтянуть не удалось');
  });
});

describe('действия в уведомлении', () => {
  const notification = (ids: string[] = ['inbox:296']) => ({
    close: () => undefined,
    data: { url: '/inbox/inbox%3A296', ids },
  });

  it('обычный щелчок открывает именно это письмо', async () => {
    const harness = loadWorker();
    await fire(harness, 'notificationclick', { notification: notification(), action: '' });

    expect(harness.opened).toEqual(['https://mail.local/inbox/inbox%3A296']);
    // И сообщает серверу, что уведомление отработано
    expect(harness.requests.some((r) => r.url === '/api/push/seen')).toBe(true);
  });

  it('открытую почту переводит на письмо, а не плодит вкладки', async () => {
    const harness = loadWorker({
      clients: [{ url: 'https://mail.local/inbox/', visibilityState: 'visible' }],
    });
    await fire(harness, 'notificationclick', { notification: notification(), action: '' });

    expect(harness.opened).toEqual([]);
    expect(harness.navigated).toEqual(['https://mail.local/inbox/inbox%3A296']);
    expect(harness.focused).toBe(1);
  });

  it('«Прочитано» помечает письмо тем же маршрутом, что и сама почта', async () => {
    const harness = loadWorker();
    await fire(harness, 'notificationclick', { notification: notification(), action: 'read' });

    const call = harness.requests.find((r) => r.url === '/api/messages/flags');
    expect(call, 'кнопка обязана ходить в общий маршрут пометок').toBeTruthy();
    expect(JSON.parse(String(call?.init?.['body']))).toEqual({ ids: ['inbox:296'], seen: true });
    // И почту при этом не открывает: смысл кнопки — не открывать
    expect(harness.opened).toEqual([]);
  });

  it('«В архив» перекладывает письмо и тоже не открывает почту', async () => {
    const harness = loadWorker();
    await fire(harness, 'notificationclick', { notification: notification(), action: 'archive' });

    const call = harness.requests.find((r) => r.url === '/api/messages/move');
    expect(JSON.parse(String(call?.init?.['body']))).toEqual({
      ids: ['inbox:296'],
      targetFolderId: 'archive',
    });
    expect(harness.opened).toEqual([]);
  });

  it('закрытое окно НЕ считается прочитанным письмом', async () => {
    /*
     * Найдено на живом стенде. Chrome прячет уведомление сам через два
     * десятка секунд, и событие закрытия при этом неотличимо от нажатия
     * человеком. Пока обработчик был, пять писем, пришедших за время
     * отсутствия, схлопывались до последнего: каждое «закрытое» окно
     * вычёркивало свои письма, и вместо «5 новых писем» оставалось одно.
     */
    const harness = loadWorker();
    expect(harness.listeners['notificationclose'] ?? []).toHaveLength(0);
  });
});

describe('выбор вкладки', () => {
  it('предпочитается видимая вкладка почты, чужие не трогаются', () => {
    const harness = loadWorker();
    const pick = sw(harness).pickClient(
      [
        { url: 'https://example.com/', visibilityState: 'visible' },
        { url: 'https://mail.local/inbox/', visibilityState: 'hidden' },
        { url: 'https://mail.local/settings', visibilityState: 'visible' },
      ],
      'https://mail.local',
    ) as { url: string } | null;
    expect(pick?.url).toBe('https://mail.local/settings');
  });

  it('без своих вкладок выбирать нечего', () => {
    const harness = loadWorker();
    expect(
      sw(harness).pickClient(
        [{ url: 'https://example.com/', visibilityState: 'visible' }],
        'https://mail.local',
      ),
    ).toBeNull();
    expect(sw(harness).pickClient([], 'https://mail.local')).toBeNull();
  });
});
