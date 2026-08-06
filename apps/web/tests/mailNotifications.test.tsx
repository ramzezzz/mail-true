// @vitest-environment jsdom
/**
 * Уведомления браузера и счётчик непрочитанных во вкладке.
 *
 * Обе настройки сохранялись и не делали ничего: `notifications.browser` и
 * `notifications.tabCounter` не читал ни один компонент. Событие о новом
 * письме взято такое, какое шлёт сервер по /ws (см. apps/api/src/ws.ts):
 *
 *   {"type":"new-message","folderId":"inbox","id":"inbox:296","uid":296,
 *    "from":{"name":"Пётр","address":"petr@example.com"},
 *    "subject":"Договор","date":"2026-08-05T11:20:00.000Z"}
 *
 * Число непрочитанных берётся из GET /api/accounts/unread — общий счётчик
 * по всем ящикам (на живом стенде для одного ящика это те же 231, что и
 * unreadCount папки "inbox" в GET /api/folders; проверено обоими запросами).
 * Сюда же подставлены папки: без раздела ящиков счётчик берётся из них.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Folder } from '@mail-true/shared';
import { accountsApi, api, settingsApi } from '../src/api';
import type { GeneralSettings } from '../src/api/settingsTypes';
import { publishMailEvent } from '../src/app/mailEvents';
import { MailNotifications } from '../src/app/MailNotifications';
import { stripTabCounter, tabTitle } from '../src/lib/notifications';
import { notificationsApi } from '../src/notifications/api';
import { CLAIM_WINDOW_MS } from '../src/notifications/local';
import type { NotificationView } from '../src/notifications/types';

let host: HTMLDivElement;
let root: Root;

const folders: Folder[] = [
  {
    id: 'inbox',
    path: 'INBOX',
    name: 'INBOX',
    role: 'inbox',
    parentId: null,
    depth: 0,
    unreadCount: 231,
    totalCount: 295,
    system: true,
    uidValidity: 1_785_895_020,
  },
  {
    id: 'spam',
    path: 'Spam',
    name: 'Spam',
    role: 'spam',
    parentId: null,
    depth: 0,
    unreadCount: 7,
    totalCount: 9,
    system: true,
    uidValidity: 1_785_895_023,
  },
];

const newMessage = {
  type: 'new-message' as const,
  folderId: 'inbox',
  id: 'inbox:296',
  uid: 296,
  from: { name: 'Пётр', address: 'petr@example.com' },
  subject: 'Договор',
  date: '2026-08-05T11:20:00.000Z',
};

function serverSettings(patch: Partial<GeneralSettings> = {}): GeneralSettings {
  return {
    senderName: '',
    signatures: [],
    defaultSignatureId: null,
    autoReply: { enabled: false, text: '', from: null, to: null },
    notifications: { browser: false, tabCounter: true },
    quoteOriginalOnReply: true,
    afterDelete: 'list',
    autoCollectContacts: true,
    ...patch,
  };
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MailNotifications />
      </QueryClientProvider>,
    );
  });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what} (заголовок: ${document.title})`);
}

/** Подменяет Notification и запоминает показанные уведомления. */
function stubNotification(permission: NotificationPermission) {
  const shown: Array<{ title: string; body?: string | undefined }> = [];
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => permission);
    constructor(title: string, options?: NotificationOptions) {
      shown.push({ title, body: options?.body });
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return { shown, requestPermission: FakeNotification.requestPermission };
}

/** Вкладка свёрнута/развёрнута — от этого зависит показ уведомления. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

/**
 * Готовое окно, каким его собирает СЕРВЕР.
 *
 * Текст уведомления клиент больше не сочиняет: уровень подробности,
 * первые фразы письма и сводка от ИИ известны только серверу, и он же
 * отвечает Service Worker при закрытой вкладке. Вид ответа — тот, что
 * отдаёт GET /api/push/notifications (apps/api/src/push/routes.ts).
 */
function serverView(patch: Partial<NotificationView> = {}): NotificationView {
  return {
    title: 'Пётр',
    body: 'Договор',
    tag: 'mail-true:0123456789abcdef',
    icon: '/brand/notification-icon.png',
    badge: '/brand/notification-badge.png',
    actions: [{ action: 'read', title: 'Прочитано' }],
    url: '/inbox/inbox%3A296',
    ids: ['inbox:296'],
    degraded: null,
    ...patch,
  };
}

/** Дожидается окна: вкладки договариваются о показе не мгновенно. */
async function settleClaims(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, CLAIM_WINDOW_MS + 40));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  document.title = 'Почта — Mail.True';
  setHidden(true);
  vi.spyOn(api, 'getFolders').mockResolvedValue(folders);
  vi.spyOn(notificationsApi, 'getNotification').mockResolvedValue({
    view: serverView(),
    pending: 1,
  });
  vi.spyOn(notificationsApi, 'markSeen').mockResolvedValue({ forgotten: 0, pending: 0 });
  // Счётчик считается по всем ящикам; здесь ящик один, и общее число
  // совпадает с непрочитанными в его «Входящих»
  vi.spyOn(accountsApi, 'getUnread').mockResolvedValue({
    total: 231,
    accounts: [{ email: 'test@mail.local', kind: 'own', unread: 231, error: null }],
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.title = 'Почта — Mail.True';
});

describe('заголовок вкладки', () => {
  it('складывается из числа непрочитанных и названия', () => {
    expect(tabTitle('Почта — Mail.True', 231, true)).toBe('(231) Почта — Mail.True');
    // Всё прочитано — скобок нет
    expect(tabTitle('Почта — Mail.True', 0, true)).toBe('Почта — Mail.True');
    // Настройка выключена — тоже нет
    expect(tabTitle('Почта — Mail.True', 231, false)).toBe('Почта — Mail.True');
  });

  it('счётчик не наращивает скобки на самом себе', () => {
    expect(stripTabCounter('(231) Почта — Mail.True')).toBe('Почта — Mail.True');
    expect(stripTabCounter('Почта — Mail.True')).toBe('Почта — Mail.True');
    expect(tabTitle(stripTabCounter('(231) Почта — Mail.True'), 12, true)).toBe(
      '(12) Почта — Mail.True',
    );
  });

  it('показывает непрочитанные во «Входящих», когда счётчик включён', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ notifications: { browser: false, tabCounter: true } }),
    );
    render();
    // Раньше настройку не читал никто и заголовок оставался прежним
    await waitFor(() => document.title === '(231) Почта — Mail.True', 'счётчик в заголовке');
  });

  it('выключенный счётчик заголовок не трогает', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ notifications: { browser: false, tabCounter: false } }),
    );
    render();
    await waitFor(() => api.getFolders !== undefined, 'загрузку папок');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(document.title).toBe('Почта — Mail.True');
  });
});

describe('всплывающее уведомление о новом письме', () => {
  it('текст берётся у сервера, а не сочиняется на клиенте', async () => {
    const { shown } = stubNotification('granted');
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ notifications: { browser: true, tabCounter: true } }),
    );
    render();
    await waitFor(() => document.title.startsWith('(231)'), 'загрузку настроек');

    act(() => publishMailEvent(newMessage));
    await settleClaims();

    /*
     * Событие WebSocket несёт и отправителя, и тему — соблазн собрать
     * текст прямо здесь был велик. Но выбранный уровень подробности,
     * первые фразы письма и сводку от ИИ знает только сервер, и он же
     * отвечает Service Worker при закрытой вкладке. Проверяем именно
     * это: показано то, что прислал сервер.
     */
    expect(notificationsApi.getNotification).toHaveBeenCalled();
    expect(shown).toEqual([{ title: 'Пётр', body: 'Договор' }]);
  });

  it('показывает то, что прислал сервер, а не то, что пришло в событии', async () => {
    const { shown } = stubNotification('granted');
    // Уровень «только факт»: сервер намеренно не выдаёт ни отправителя,
    // ни темы — и клиент не должен подставить их из события.
    vi.spyOn(notificationsApi, 'getNotification').mockResolvedValue({
      view: serverView({ title: 'Новое письмо', body: 'Откройте почту, чтобы прочитать' }),
      pending: 1,
    });
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ notifications: { browser: true, tabCounter: true } }),
    );
    render();
    await waitFor(() => document.title.startsWith('(231)'), 'загрузку настроек');

    act(() => publishMailEvent(newMessage));
    await settleClaims();

    expect(shown).toEqual([{ title: 'Новое письмо', body: 'Откройте почту, чтобы прочитать' }]);
  });

  it('с выключенной настройкой не показывается и сервер не спрашивается', async () => {
    const { shown } = stubNotification('granted');
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ notifications: { browser: false, tabCounter: true } }),
    );
    render();
    await waitFor(() => document.title.startsWith('(231)'), 'загрузку настроек');

    act(() => publishMailEvent(newMessage));
    await settleClaims();
    expect(shown).toHaveLength(0);
    expect(notificationsApi.getNotification).not.toHaveBeenCalled();
  });

  it('на открытой вкладке не показывается — письмо и так видно в списке', async () => {
    const { shown } = stubNotification('granted');
    setHidden(false);
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ notifications: { browser: true, tabCounter: true } }),
    );
    render();
    await waitFor(() => document.title.startsWith('(231)'), 'загрузку настроек');

    act(() => publishMailEvent(newMessage));
    await settleClaims();
    expect(shown).toHaveLength(0);
  });

  it('разрешение НЕ спрашивается при загрузке почты', async () => {
    const { shown, requestPermission } = stubNotification('default');
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ notifications: { browser: true, tabCounter: true } }),
    );
    render();
    await waitFor(() => document.title.startsWith('(231)'), 'загрузку настроек');

    act(() => publishMailEvent(newMessage));
    await settleClaims();

    /*
     * Раньше разрешение спрашивалось прямо здесь — на загрузке страницы.
     * Так делать нельзя: Chrome с версии 80 подменяет такой запрос
     * неприметной иконкой в адресной строке, Firefox с версии 72 гасит
     * его совсем, а человек, которому окно выскочило на первой секунде,
     * жмёт «Блокировать» — и вернуть это можно только руками в настройках
     * браузера. Теперь разрешение спрашивается на странице настроек,
     * прямо в обработчике нажатия (см. NotificationsPage).
     */
    expect(requestPermission).not.toHaveBeenCalled();
    expect(shown).toHaveLength(0);
    expect(notificationsApi.getNotification).not.toHaveBeenCalled();
  });

  it('служебные события уведомлений не порождают', async () => {
    const { shown } = stubNotification('granted');
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ notifications: { browser: true, tabCounter: true } }),
    );
    render();
    await waitFor(() => document.title.startsWith('(231)'), 'загрузку настроек');

    act(() => publishMailEvent({ type: 'ready' }));
    act(() => publishMailEvent({ type: 'idle-lost' }));
    expect(shown).toHaveLength(0);
  });
});
