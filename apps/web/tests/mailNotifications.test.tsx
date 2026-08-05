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
import { newMailNotification, stripTabCounter, tabTitle } from '../src/lib/notifications';

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

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  document.title = 'Почта — Mail.True';
  setHidden(true);
  vi.spyOn(api, 'getFolders').mockResolvedValue(folders);
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
  it('текст — от кого и о чём', () => {
    expect(newMailNotification(newMessage)).toEqual({ title: 'Пётр', body: 'Договор' });
    // Имени нет — показываем адрес
    expect(
      newMailNotification({ from: { name: null, address: 'petr@example.com' }, subject: '' }),
    ).toEqual({ title: 'petr@example.com', body: '(без темы)' });
  });

  it('показывается, когда настройка включена и вкладка свёрнута', async () => {
    const { shown } = stubNotification('granted');
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ notifications: { browser: true, tabCounter: true } }),
    );
    render();
    await waitFor(() => document.title.startsWith('(231)'), 'загрузку настроек');

    act(() => publishMailEvent(newMessage));

    // Раньше настройку не читал никто: уведомления не было никогда
    expect(shown).toEqual([{ title: 'Пётр', body: 'Договор' }]);
  });

  it('с выключенной настройкой не показывается', async () => {
    const { shown } = stubNotification('granted');
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ notifications: { browser: false, tabCounter: true } }),
    );
    render();
    await waitFor(() => document.title.startsWith('(231)'), 'загрузку настроек');

    act(() => publishMailEvent(newMessage));
    expect(shown).toHaveLength(0);
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
    expect(shown).toHaveLength(0);
  });

  it('без разрешения браузера уведомления нет, но разрешение спрашивается', async () => {
    const { shown, requestPermission } = stubNotification('default');
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ notifications: { browser: true, tabCounter: true } }),
    );
    render();
    await waitFor(() => requestPermission.mock.calls.length === 1, 'запрос разрешения');

    act(() => publishMailEvent(newMessage));
    expect(shown).toHaveLength(0);
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
