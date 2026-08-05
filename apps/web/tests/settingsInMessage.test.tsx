// @vitest-environment jsdom
/**
 * Две общие настройки, которые страница письма обязана слушаться.
 *
 * До этого их не читал никто: `quoteOriginalOnReply` был переключателем без
 * последствий — цитата подставлялась всегда, — а `afterDelete` обещал выбор
 * «остаться в списке или перейти к следующему письму», и после удаления
 * всегда открывался список. Значения снимаются с настоящего
 * GET /api/settings/general (там же они и хранятся).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { MessageSummary } from '@mail-true/shared';
import { api, settingsApi } from '../src/api';
import type { MessageFull, MessagesPage } from '../src/api/types';
import type { GeneralSettings } from '../src/api/settingsTypes';
import { useUiStore } from '../src/app/store';
import { MessagePage } from '../src/pages/MessagePage';

let host: HTMLDivElement;
let root: Root;
let path = '';

const flags = {
  seen: true,
  flagged: false,
  answered: false,
  forwarded: false,
  draft: false,
  deleted: false,
};

function summary(uid: number, subject: string): MessageSummary {
  return {
    id: `inbox:${uid}`,
    folderId: 'inbox',
    uid,
    threadId: `t-${uid}`,
    from: { name: 'Пётр', address: 'petr@example.com' },
    to: [{ name: null, address: 'test@mail.local' }],
    cc: [],
    subject,
    snippet: subject,
    date: new Date(2026, 7, uid).toISOString(),
    flags,
    hasAttachments: false,
    attachmentNames: [],
    labels: [],
    pinned: false,
    sizeBytes: 1024,
  };
}

function full(uid: number, subject: string): MessageFull {
  return {
    ...summary(uid, subject),
    messageId: `<mt-${uid}@example.com>`,
    inReplyTo: null,
    references: [],
    replyTo: [],
    bcc: [],
    bodyHtml: `<p>Текст письма ${uid}</p>`,
    bodyText: `Текст письма ${uid}`,
    attachments: [],
    headers: {},
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    blockedRemote: 0,
  };
}

/** Папка из трёх писем: открыто среднее, значит следующее есть. */
const folderPage: MessagesPage = {
  items: [summary(208, 'Первое'), summary(209, 'Открытое'), summary(210, 'Следующее')],
  total: 3,
  offset: 0,
  limit: 100,
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

function LocationProbe() {
  path = useLocation().pathname;
  return null;
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox/inbox%3A209']}>
          <LocationProbe />
          <Routes>
            <Route path=":folderId/:messageId" element={<MessagePage />} />
            <Route path="*" element={<div>список писем</div>} />
          </Routes>
        </MemoryRouter>
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
  throw new Error(`не дождались: ${what}\n${path}\n${host.textContent}`);
}

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

/** Готовит страницу письма с заданными общими настройками. */
async function openMessage(settings: GeneralSettings) {
  vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(settings);
  vi.spyOn(api, 'getMessage').mockImplementation(async (id: string) =>
    full(Number(id.split(':')[1]), 'Открытое'),
  );
  vi.spyOn(api, 'getMessages').mockResolvedValue(folderPage);
  render();
  await waitFor(() => host.textContent!.includes('Текст письма'), 'тело письма');
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  path = '';
  useUiStore.setState({ composeWindows: [] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUiStore.setState({ composeWindows: [] });
  vi.restoreAllMocks();
});

describe('цитата исходного письма в ответе', () => {
  it('включённая настройка подставляет цитату', async () => {
    await openMessage(serverSettings({ quoteOriginalOnReply: true }));
    act(() => button('Ответить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const init = useUiStore.getState().composeWindows[0]?.init;
    expect(init?.bodyHtml).toContain('blockquote');
    expect(init?.bodyHtml).toContain('Текст письма 209');
  });

  it('выключённая — оставляет письмо пустым', async () => {
    await openMessage(serverSettings({ quoteOriginalOnReply: false }));
    act(() => button('Ответить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // Раньше цитата вставлялась всегда: переключатель ничего не значил
    const init = useUiStore.getState().composeWindows[0]?.init;
    expect(init?.bodyHtml).toBeUndefined();
    expect(init?.to).toBe('petr@example.com');
  });

  it('пересылка настройке не подчиняется — без исходного письма она пуста', async () => {
    await openMessage(serverSettings({ quoteOriginalOnReply: false }));
    act(() => button('Переслать')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(useUiStore.getState().composeWindows[0]?.init.bodyHtml).toContain('Текст письма 209');
  });
});

describe('поведение после удаления письма', () => {
  it('«к списку писем» возвращает в папку', async () => {
    await openMessage(serverSettings({ afterDelete: 'list' }));
    vi.spyOn(api, 'moveMessages').mockResolvedValue({ moved: 1 });

    act(() => button('Удалить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => path === '/inbox/', 'возврат в список');
  });

  it('«к следующему письму» открывает следующее письмо папки', async () => {
    await openMessage(serverSettings({ afterDelete: 'next-message' }));
    vi.spyOn(api, 'moveMessages').mockResolvedValue({ moved: 1 });

    act(() => button('Удалить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // Раньше настройку не читал никто и здесь всегда открывался список
    await waitFor(() => path === '/inbox/inbox%3A210', 'переход к следующему письму');
  });

  it('следующего письма нет — остаётся список, а не пустой экран', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(
      serverSettings({ afterDelete: 'next-message' }),
    );
    vi.spyOn(api, 'getMessage').mockResolvedValue(full(210, 'Последнее'));
    // Открыто последнее письмо папки: переходить дальше некуда
    vi.spyOn(api, 'getMessages').mockResolvedValue({
      items: [summary(209, 'Открытое'), summary(210, 'Последнее')],
      total: 2,
      offset: 0,
      limit: 100,
    });
    vi.spyOn(api, 'moveMessages').mockResolvedValue({ moved: 1 });

    act(() => {
      root.render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })}
        >
          <MemoryRouter initialEntries={['/inbox/inbox%3A210']}>
            <LocationProbe />
            <Routes>
              <Route path=":folderId/:messageId" element={<MessagePage />} />
              <Route path="*" element={<div>список писем</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => host.textContent!.includes('Текст письма'), 'тело письма');

    act(() => button('Удалить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => path === '/inbox/', 'возврат в список');
  });
});
