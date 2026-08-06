// @vitest-environment jsdom
/**
 * Дописывание сохранённого черновика.
 *
 * Дефект, который здесь закрывается. Черновик нельзя было дописать: щелчок
 * по нему в папке «Черновики» открывал обычный просмотр письма, окно
 * написания не открывалось никак, а кнопки «Продолжить» не существовало.
 * Сохранённое письмо оставалось в папке навсегда — как текст, до которого
 * нельзя дотянуться.
 *
 * Проверяется не подсветка кнопок, а то, что уходит на сервер: окно, в
 * котором поля заполнены, но `draftUid` не уехал, плодит копии черновика —
 * а именно этого человек и не должен видеть.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { DraftContent, MessageSummary } from '@mail-true/shared';
import { api } from '../src/api';
import type { MessageFull, SendRequest } from '../src/api/types';
import { useUiStore } from '../src/app/store';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { FolderPage } from '../src/pages/FolderPage';
import { MessagePage } from '../src/pages/MessagePage';

let host: HTMLDivElement;
let root: Root;

/** Черновик в папке — строка списка. */
function draftSummary(uid = 38): MessageSummary {
  return {
    id: `drafts:${uid}`,
    folderId: 'drafts',
    uid,
    threadId: `t-${uid}`,
    from: { name: 'Я', address: 'demo@mail.local' },
    to: [{ name: null, address: 'irina@mail.local' }],
    cc: [],
    subject: 'Договор на подпись',
    snippet: 'Добрый день!',
    date: new Date(2026, 6, 1, 12, 0).toISOString(),
    flags: {
      seen: true,
      flagged: false,
      answered: false,
      forwarded: false,
      draft: true,
      deleted: false,
    },
    hasAttachments: true,
    attachmentNames: ['договор.pdf'],
    labels: [],
    pinned: false,
    sizeBytes: 4096,
  };
}

/** Ответ `GET /api/drafts/:uid`. */
function draftContent(patch: Partial<DraftContent> = {}): DraftContent {
  return {
    draftUid: 38,
    to: [{ name: 'Ирина', address: 'irina@mail.local' }],
    cc: [{ name: null, address: 'copy@mail.local' }],
    bcc: [{ name: null, address: 'hidden@mail.local' }],
    subject: 'Договор на подпись',
    bodyHtml: '<div>Добрый день! Отправляю договор</div>',
    attachments: [{ id: 'up-1', filename: 'договор.pdf', size: 12345 }],
    inReplyTo: null,
    references: [],
    requestReadReceipt: false,
    ...patch,
  };
}

/** Полное письмо-черновик для страницы просмотра. */
function draftMessage(): MessageFull {
  const summary = draftSummary();
  return {
    ...summary,
    messageId: '<draft-38@mail.local>',
    inReplyTo: null,
    references: [],
    replyTo: [],
    bcc: [],
    bodyHtml: '<div>Добрый день! Отправляю договор</div>',
    bodyText: 'Добрый день! Отправляю договор',
    attachments: [],
    headers: {},
    authentication: { spf: 'none', dkim: 'none', dmarc: 'none' },
    blockedRemote: 0,
  };
}

/**
 * jsdom не считает размеров, а виртуализация списка меряет контейнер именно
 * ими — при нулевой высоте не отрисовывается ни одной строки.
 */
function stubLayout() {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
}

function renderFolder() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/drafts']}>
          <Routes>
            <Route
              path=":folderId"
              element={
                <>
                  <FolderPage />
                  <ComposeWindows />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

function renderMessage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/drafts/drafts%3A38']}>
          <Routes>
            <Route
              path=":folderId/:messageId"
              element={
                <>
                  <MessagePage />
                  <ComposeWindows />
                </>
              }
            />
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
  throw new Error(`не дождались: ${what}\n${host.textContent}`);
}

const byLabel = (label: string): HTMLInputElement | null =>
  host.querySelector(`input[aria-label="${label}"]`);
const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const editor = (): HTMLElement | null => host.querySelector('[aria-label="Текст письма"]');
const composeOpen = (): boolean => useUiStore.getState().composeWindows.length > 0;

function click(element: Element | null | undefined, init: MouseEventInit = {}) {
  if (!element) throw new Error('нечего нажимать');
  // cancelable — как у настоящего щелчка: без него preventDefault ничего
  // не значит, и jsdom пытается уйти по ссылке даже там, где продукт
  // переход отменил
  act(() =>
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })),
  );
}

/**
 * jsdom умеет ругаться «Not implemented: navigation» на каждый переход по
 * настоящей ссылке. Ссылка у строки списка — настоящая, и это правильно
 * (Ctrl+щелчок открывает письмо в новой вкладке), поэтому переход глушим
 * здесь, а не убираем из продукта. Обработчик висит на документе и потому
 * срабатывает ПОСЛЕ обработчика строки — её поведение не подменяется.
 */
const swallowNavigation = (e: Event) => e.preventDefault();

beforeEach(() => {
  stubLayout();
  document.addEventListener('click', swallowNavigation);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ composeWindows: [], notice: null, selectedIds: new Set<string>() });
  vi.spyOn(api, 'getFolders').mockResolvedValue([
    {
      id: 'drafts',
      path: 'Drafts',
      name: 'Черновики',
      role: 'drafts',
      parentId: null,
      depth: 0,
      unreadCount: 0,
      totalCount: 1,
      system: true,
      uidValidity: 1,
    },
  ]);
  vi.spyOn(api, 'getMessages').mockResolvedValue({
    items: [draftSummary()],
    total: 1,
    offset: 0,
    limit: 100,
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.removeEventListener('click', swallowNavigation);
  useUiStore.setState({ composeWindows: [], notice: null });
  vi.restoreAllMocks();
});

describe('щелчок по черновику открывает окно написания', () => {
  it('вместо просмотра письма открывается окно с набранным письмом', async () => {
    const getDraft = vi.spyOn(api, 'getDraft').mockResolvedValue(draftContent());
    renderFolder();
    await waitFor(() => Boolean(host.querySelector('a[href="/drafts/drafts%3A38"]')), 'строку черновика');

    click(host.querySelector('a[href="/drafts/drafts%3A38"]'));
    await waitFor(composeOpen, 'окно написания');

    expect(getDraft).toHaveBeenCalledWith(38);
    // Всё, что было в письме, — на своих местах
    expect(byLabel('Кому')?.value).toBe('Ирина <irina@mail.local>');
    expect(byLabel('Копия')?.value).toBe('copy@mail.local');
    // «Скрытая» обязана быть видна, а не спрятана за ссылкой: письмо уходит
    // и этому адресату тоже, и человек должен видеть кому
    expect(byLabel('Скрытая')?.value).toBe('hidden@mail.local');
    expect(byLabel('Тема')?.value).toBe('Договор на подпись');
    expect(editor()?.textContent).toContain('Отправляю договор');
    // Вложение черновика на месте — ровно одно
    expect(host.textContent).toContain('договор.pdf');
    expect([...host.querySelectorAll('[class*="attachChip"]')].filter(
      (chip) => chip.textContent?.includes('договор.pdf'),
    )).toHaveLength(1);
  });

  it('Ctrl+щелчок остаётся ссылкой: открывается просмотр, а не окно', async () => {
    const getDraft = vi.spyOn(api, 'getDraft').mockResolvedValue(draftContent());
    renderFolder();
    await waitFor(() => Boolean(host.querySelector('a[href="/drafts/drafts%3A38"]')), 'строку черновика');

    click(host.querySelector('a[href="/drafts/drafts%3A38"]'), { ctrlKey: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Человек, открывающий черновик в новой вкладке, ждёт письма, а не
    // окна написания в старой вкладке
    expect(getDraft).not.toHaveBeenCalled();
    expect(composeOpen()).toBe(false);
    // Ссылка ведёт на просмотр — её адрес не должен подменяться
    expect(host.querySelector('a[href="/drafts/drafts%3A38"]')).not.toBeNull();
  });

  it('в обычной папке щелчок по-прежнему открывает просмотр', async () => {
    const getDraft = vi.spyOn(api, 'getDraft').mockResolvedValue(draftContent());
    vi.spyOn(api, 'getFolders').mockResolvedValue([]);
    vi.spyOn(api, 'getMessages').mockResolvedValue({
      items: [{ ...draftSummary(7), id: 'inbox:7', folderId: 'inbox', flags: { ...draftSummary().flags, draft: false } }],
      total: 1,
      offset: 0,
      limit: 100,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/inbox']}>
            <Routes>
              <Route path=":folderId" element={<><FolderPage /><ComposeWindows /></>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => Boolean(host.querySelector('a[href="/inbox/inbox%3A7"]')), 'строку письма');

    click(host.querySelector('a[href="/inbox/inbox%3A7"]'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(getDraft).not.toHaveBeenCalled();
    expect(composeOpen()).toBe(false);
  });
});

describe('дописанный черновик не плодит копии', () => {
  it('сохранение дважды уходит с тем же draftUid, а не заводит новый черновик', async () => {
    vi.spyOn(api, 'getDraft').mockResolvedValue(draftContent());
    // Сервер отвечает новым UID: черновик заменяется целиком (IMAP APPEND +
    // удаление старого), и следующее сохранение должно ссылаться уже на него
    let nextUid = 39;
    const saveDraft = vi.spyOn(api, 'saveDraft').mockImplementation(async (request) => ({
      ok: true,
      draftId: `drafts:${nextUid}`,
      draftUid: request.draftUid === undefined ? 100 : nextUid++,
      savedAt: new Date().toISOString(),
    }));

    renderFolder();
    await waitFor(() => Boolean(host.querySelector('a[href="/drafts/drafts%3A38"]')), 'строку черновика');
    click(host.querySelector('a[href="/drafts/drafts%3A38"]'));
    await waitFor(composeOpen, 'окно написания');

    click(buttonByText('Сохранить'));
    await waitFor(() => saveDraft.mock.calls.length > 0, 'первое сохранение');
    expect((saveDraft.mock.calls[0]?.[0] as SendRequest).draftUid).toBe(38);

    await waitFor(() => Boolean(buttonByText('Сохранить')), 'кнопку после первого сохранения');
    click(buttonByText('Сохранить'));
    await waitFor(() => saveDraft.mock.calls.length > 1, 'второе сохранение');
    // Второе сохранение ссылается на последнюю версию, а не заводит третью:
    // без этого в папке лежали бы три письма вместо одного
    expect((saveDraft.mock.calls[1]?.[0] as SendRequest).draftUid).toBe(39);
    expect(saveDraft.mock.calls.every((c) => (c[0] as SendRequest).draftUid !== undefined)).toBe(true);
  });

  it('вложение уходит на сервер ровно одно — и при первом, и при повторном сохранении', async () => {
    vi.spyOn(api, 'getDraft').mockResolvedValue(draftContent());
    const saveDraft = vi.spyOn(api, 'saveDraft').mockResolvedValue({
      ok: true,
      draftId: 'drafts:39',
      draftUid: 39,
      savedAt: new Date().toISOString(),
    });

    renderFolder();
    await waitFor(() => Boolean(host.querySelector('a[href="/drafts/drafts%3A38"]')), 'строку черновика');
    click(host.querySelector('a[href="/drafts/drafts%3A38"]'));
    await waitFor(composeOpen, 'окно написания');

    click(buttonByText('Сохранить'));
    await waitFor(() => saveDraft.mock.calls.length > 0, 'первое сохранение');
    click(buttonByText('Сохранить'));
    await waitFor(() => saveDraft.mock.calls.length > 1, 'второе сохранение');

    for (const call of saveDraft.mock.calls) {
      expect((call[0] as SendRequest).attachmentIds).toEqual(['up-1']);
    }
  });

  it('отправка дописанного письма уносит с собой draftUid — черновик убирает сервер', async () => {
    vi.spyOn(api, 'getDraft').mockResolvedValue(draftContent());
    const send = vi
      .spyOn(api, 'sendMessage')
      .mockResolvedValue({ ok: true, sentMessageId: 'sent:1' });

    renderFolder();
    await waitFor(() => Boolean(host.querySelector('a[href="/drafts/drafts%3A38"]')), 'строку черновика');
    click(host.querySelector('a[href="/drafts/drafts%3A38"]'));
    await waitFor(composeOpen, 'окно написания');

    click(buttonByText('Отправить'));
    await waitFor(() => send.mock.calls.length > 0, 'отправку письма');
    // Оставшийся после отправки черновик — беда, из-за которой человек потом
    // гадает, ушло письмо или нет
    expect((send.mock.calls[0]?.[0] as SendRequest).draftUid).toBe(38);
  });
});

describe('черновик не обрастает подписями', () => {
  it('открытие черновика не добавляет в письмо второй блок подписи', async () => {
    vi.spyOn(api, 'getDraft').mockResolvedValue(
      draftContent({ bodyHtml: '<div>текст</div><div>-- <br>Иван</div>' }),
    );
    renderFolder();
    await waitFor(() => Boolean(host.querySelector('a[href="/drafts/drafts%3A38"]')), 'строку черновика');
    click(host.querySelector('a[href="/drafts/drafts%3A38"]'));
    await waitFor(composeOpen, 'окно написания');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    // Тело — ровно то, что сохранили: ни пустого абзаца сверху, ни второго
    // блока подписи. Иначе за три открытия черновика письмо обрастает тремя.
    expect(editor()?.innerHTML).toBe('<div>текст</div><div>-- <br>Иван</div>');
  });
});

describe('просмотр черновика по прямой ссылке', () => {
  it('на странице письма есть «Продолжить», и она открывает то же окно', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(draftMessage());
    const getDraft = vi.spyOn(api, 'getDraft').mockResolvedValue(draftContent());
    vi.spyOn(api, 'setFlags').mockResolvedValue({ updated: 1 });

    renderMessage();
    await waitFor(() => host.textContent!.includes('Продолжить'), 'кнопку «Продолжить»');
    // И сказано, что письмо не отправлено: иначе черновик выглядит как
    // обычное полученное письмо
    expect(host.textContent).toContain('письмо ещё не отправлено');

    click(buttonByText('Продолжить'));
    await waitFor(composeOpen, 'окно написания');
    expect(getDraft).toHaveBeenCalledWith(38);
    expect(byLabel('Тема')?.value).toBe('Договор на подпись');
  });

  it('у обычного письма кнопки «Продолжить» нет', async () => {
    const usual = draftMessage();
    vi.spyOn(api, 'getMessage').mockResolvedValue({
      ...usual,
      id: 'inbox:209',
      folderId: 'inbox',
      flags: { ...usual.flags, draft: false },
    });
    vi.spyOn(api, 'setFlags').mockResolvedValue({ updated: 1 });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/inbox/inbox%3A209']}>
            <Routes>
              <Route path=":folderId/:messageId" element={<MessagePage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => host.textContent!.includes('Ответить'), 'страницу письма');
    expect(host.textContent).not.toContain('Продолжить');
  });
});
