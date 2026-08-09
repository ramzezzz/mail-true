// @vitest-environment jsdom
/**
 * Страница письма против ответа, устроенного как настоящий.
 *
 * Здесь сходятся три дефекта сразу:
 *   - плашка «Показать картинки» не появлялась никогда, потому что интерфейс
 *     искал `src="http…"`, а сервер уже подменил его прозрачным пикселем и
 *     положил счётчик в `blockedRemote`;
 *   - «Отписаться» была недостижима: проверялся ключ `List-Unsubscribe`,
 *     а сервер отдаёт имена заголовков в нижнем регистре;
 *   - на любую ошибку загрузки писалось «Письмо не найдено», и повторить
 *     попытку было нечем.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MessageListQuery, MessageSummary } from '@mail-true/shared';
import { ApiError } from '../src/api/http';
import type { MessageFull } from '../src/api/types';
import { BLOCKED_PIXEL } from '../src/lib/externalImages';
import { MessagePage } from '../src/pages/MessagePage';
import { api } from '../src/api';
import { useUiStore } from '../src/app/store';

let host: HTMLDivElement;
let root: Root;

/** Ответ сервера на письмо рассылки: картинки заблокированы, есть отписка. */
function serverMessage(patch: Partial<MessageFull> = {}): MessageFull {
  return {
    id: 'inbox:209',
    folderId: 'inbox',
    uid: 209,
    threadId: 't-209',
    from: { name: 'Рассылка', address: 'news@example.com' },
    to: [{ name: null, address: 'test@mail.local' }],
    cc: [],
    subject: 'Тест картинок и отписки',
    snippet: 'Test message with external images',
    date: new Date().toISOString(),
    flags: {
      seen: true,
      flagged: false,
      answered: false,
      forwarded: false,
      draft: false,
      deleted: false,
    },
    hasAttachments: false,
    attachmentNames: [],
    labels: [],
    pinned: false,
    sizeBytes: 2048,
    messageId: '<mt-images-test@example.com>',
    inReplyTo: null,
    references: [],
    replyTo: [],
    bcc: [],
    bodyHtml:
      `<p>Test message with external images:</p>` +
      `<img src="${BLOCKED_PIXEL}" data-mt-src="http://tracker.example.com/pixel.gif?u=1">`,
    bodyText: 'Test message with external images',
    attachments: [],
    // Имена заголовков — в нижнем регистре, как их отдаёт сервер
    headers: {
      'list-unsubscribe': '<mailto:unsub@example.com>, <http://example.com/unsub?u=1>',
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
    },
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    blockedRemote: 3,
    ...patch,
  };
}

function render(entry = '/inbox/inbox%3A209') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path=":folderId/:messageId" element={<MessagePage />} />
            {/* Куда уводит Escape со страницы письма: по этой надписи и
                видно, ушли мы в список или остались в письме. */}
            <Route path=":folderId" element={<div>Список писем</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Ждёт, пока на экране не появится ожидаемое (запросы заглушек — async). */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.textContent}`);
}

const text = () => host.textContent ?? '';
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
const click = (el: Element) =>
  act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ listView: { threaded: false, filter: 'all', labelFilter: null } });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('внешние картинки', () => {
  it('плашка появляется по счётчику сервера, а «Показать» перезапрашивает письмо', async () => {
    const getMessage = vi
      .spyOn(api, 'getMessage')
      .mockImplementation(async (_id: string, options?: { images?: boolean }) =>
        options?.images
          ? serverMessage({
              blockedRemote: 0,
              bodyHtml: '<img src="http://tracker.example.com/pixel.gif?u=1">',
            })
          : serverMessage(),
      );

    render();
    await waitFor(() => host.textContent!.includes('заблокированы'), 'плашку о картинках');

    const show = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Показать');
    expect(show).toBeDefined();
    act(() => show!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // Именно перезапрос с ?images=1: разблокировать картинки на клиенте нечем
    await waitFor(
      () => getMessage.mock.calls.some((call) => call[1]?.images === true),
      'запрос письма с картинками',
    );
    await waitFor(() => !host.textContent!.includes('заблокированы'), 'исчезновение плашки');
    expect(host.innerHTML).toContain('src="http://tracker.example.com/pixel.gif?u=1"');
  });

  it('в письме без внешних картинок плашки нет', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      serverMessage({ blockedRemote: 0, bodyHtml: '<p>простое письмо</p>', headers: {} }),
    );
    render();
    await waitFor(() => host.textContent!.includes('простое письмо'), 'тело письма');
    expect(host.textContent).not.toContain('заблокированы');
  });
});

describe('отписка от рассылки', () => {
  it('кнопка появляется на заголовке в нижнем регистре', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage());
    render();
    await waitFor(() => host.textContent!.includes('Отписаться'), 'кнопку отписки');
  });

  it('без заголовка отписки кнопки нет', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage({ headers: {} }));
    render();
    await waitFor(() => host.textContent!.includes('Тест картинок'), 'письмо');
    expect(host.textContent).not.toContain('Отписаться');
  });
});

describe('ошибки загрузки письма', () => {
  it('404 — «Письмо не найдено», без предложения повторить', async () => {
    vi.spyOn(api, 'getMessage').mockRejectedValue(
      new ApiError(404, '/api/messages/inbox:209', 'Письмо не найдено', 'NOT_FOUND'),
    );
    render();
    await waitFor(() => host.textContent!.includes('Письмо не найдено'), 'сообщение о ненайденном');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Повторить')).toBe(
      false,
    );
  });

  it('сбой сервера — другое сообщение и кнопка «Повторить»', async () => {
    const getMessage = vi
      .spyOn(api, 'getMessage')
      .mockRejectedValueOnce(new ApiError(503, '/api/messages/inbox:209', 'Сервер недоступен'))
      .mockResolvedValue(serverMessage());

    render();
    await waitFor(
      () => host.textContent!.includes('Не удалось загрузить письмо'),
      'сообщение о сбое',
    );
    // Раньше здесь было «Письмо не найдено» — и повторить попытку было нечем
    expect(host.textContent).not.toContain('Письмо не найдено');

    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Повторить');
    expect(retry).toBeDefined();
    act(() => retry!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await waitFor(() => host.textContent!.includes('Тест картинок'), 'письмо после повтора');
    expect(getMessage.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('письмо на два десятка получателей', () => {
  /** 21 адресат: столько же, сколько у письма EDGE-20RCPT на стенде. */
  const many = Array.from({ length: 21 }, (_, i) => ({
    name: null,
    address: `user${String(i).padStart(2, '0')}@example.org`,
  }));

  it('кнопка «подробности» не уезжает за обрезанный список адресатов', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage({ to: many }));
    render();
    await waitFor(() => host.textContent!.includes('Кому:'), 'строку получателей');

    const toggle = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'подробности',
    );
    expect(toggle).toBeDefined();

    // Многоточие висит на перечне адресатов, а кнопка — снаружи него.
    // Раньше обрезалась строка целиком, и кнопка оказывалась за краем
    // контейнера с overflow: hidden — невидимой и некликабельной.
    const clipped = host.querySelector('[class*="senderToText"]');
    expect(clipped).not.toBeNull();
    expect(clipped!.textContent).toContain('Кому:');
    expect(clipped!.contains(toggle!)).toBe(false);
  });

  it('по нажатию показывает всех адресатов', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage({ to: many }));
    render();
    await waitFor(() => host.textContent!.includes('Кому:'), 'строку получателей');

    const toggle = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'подробности',
    )!;
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await waitFor(() => host.textContent!.includes('user20@example.org'), 'полный список');
    expect(host.textContent).toContain('user00@example.org');
  });
});

/* ------------------------------------------------------------------ */
/* Пометки открытого письма                                            */
/* ------------------------------------------------------------------ */

/** Пустой список папки: соседей у письма в этих проверках нет. */
function emptyList() {
  return vi.fn(async (query: MessageListQuery) => ({
    items: [] as MessageSummary[],
    total: 0,
    offset: query.offset,
    limit: query.limit,
  }));
}

describe('флажок на открытом письме', () => {
  it('поставленный флажок виден в самом письме, и его можно снять', async () => {
    /*
     * Пометки правились в списке (`['messages']`), а показанное письмо
     * лежит под своим ключом (`['message', id, images]`) — и его никто не
     * сбрасывал. Пункт меню продолжал называться «Пометить флажком»,
     * второе нажатие снова слало `flagged: true`, и СНЯТЬ флажок из
     * просмотра письма было нельзя вообще.
     */
    vi.spyOn(api, 'getMessages').mockImplementation(emptyList());
    let flagged = false;
    const getMessage = vi
      .spyOn(api, 'getMessage')
      .mockImplementation(async () =>
        serverMessage({ flags: { ...serverMessage().flags, flagged } }),
      );
    const setFlags = vi.spyOn(api, 'setFlags').mockImplementation(async (request) => {
      if (request.set.flagged !== undefined) flagged = request.set.flagged;
      return { updated: request.ids.length };
    });

    render();
    await waitFor(() => text().includes('Тест картинок'), 'письмо');

    const openMore = () => click(host.querySelector('button[aria-label="Ещё действия"]')!);
    openMore();
    await waitFor(() => Boolean(button('Пометить флажком')), 'пункт меню');
    click(button('Пометить флажком')!);

    await waitFor(() => setFlags.mock.calls.length === 1, 'запрос пометки');
    expect(setFlags.mock.calls[0]?.[0].set).toMatchObject({ flagged: true });

    // Письмо обязано перечитаться: иначе оно так и осталось бы без флажка
    await waitFor(() => getMessage.mock.calls.length > 1, 'перечитанное письмо');

    openMore();
    await waitFor(() => Boolean(button('Снять флажок')), 'пункт «Снять флажок»');
    expect(button('Пометить флажком')).toBeUndefined();

    // И снятие доходит до сервера как снятие, а не как повторная простановка
    click(button('Снять флажок')!);
    await waitFor(() => setFlags.mock.calls.length === 2, 'запрос снятия');
    expect(setFlags.mock.calls[1]?.[0].set).toMatchObject({ flagged: false });
  });
});

/* ------------------------------------------------------------------ */
/* Escape в окне поверх письма                                         */
/* ------------------------------------------------------------------ */

describe('Escape в предпросмотре вложения', () => {
  it('закрывает окно и НЕ уводит со страницы письма', async () => {
    /*
     * Окно и страница письма слушали Escape на одном и том же `document`
     * во всплытии, а `stopPropagation` соседа по узлу не гасит: одно
     * нажатие закрывало предпросмотр И одновременно уводило в список.
     * Человек хотел закрыть картинку, а терял и письмо.
     */
    vi.spyOn(api, 'getMessages').mockImplementation(emptyList());
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      serverMessage({
        attachments: [
          {
            partId: '2',
            filename: 'записка.txt',
            mimeType: 'text/plain',
            size: 12,
            contentId: null,
            inline: false,
          },
        ],
      }),
    );
    vi.spyOn(api, 'getMessagePart').mockResolvedValue(new Blob(['привет'], { type: 'text/plain' }));

    render();
    await waitFor(() => Boolean(button('записка.txt')), 'карточку вложения');
    click(button('записка.txt')!);
    await waitFor(() => Boolean(host.querySelector('[role="dialog"]')), 'окно предпросмотра');

    // Клавиша нажимается там, где стоит фокус, — внутри окна, а не в
    // пустоте: именно так её и получает браузер.
    const dialog = host.querySelector('[role="dialog"]')!;
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // Окно уезжает с ходом (MODAL_EXIT_MS) — дожидаемся конца
    await waitFor(() => !host.querySelector('[role="dialog"]'), 'закрытие окна');

    expect(text(), 'Escape в окне не должен уводить в список').not.toContain('Список писем');
    expect(text()).toContain('Тест картинок');
  });
});

/* ------------------------------------------------------------------ */
/* Переписка при включённой группировке                                */
/* ------------------------------------------------------------------ */

function threadSummary(uid: number, threadId: string): MessageSummary {
  return {
    id: `inbox:${uid}`,
    folderId: 'inbox',
    uid,
    threadId,
    from: { name: 'Иван', address: 'ivan@example.com' },
    to: [],
    cc: [],
    subject: `Реплика ${uid}`,
    snippet: `начало ${uid}`,
    date: new Date(2026, 6, 1, 12, uid).toISOString(),
    flags: {
      seen: true,
      flagged: false,
      answered: false,
      forwarded: false,
      draft: false,
      deleted: false,
    },
    hasAttachments: false,
    attachmentNames: [],
    labels: [],
    pinned: false,
    sizeBytes: 1024,
  };
}

/**
 * Сервер с включённой группировкой: строка на переписку — и та же папка
 * плоским списком, если группировку не просили.
 */
function threadedServer() {
  const conversation = [1, 2, 3].map((uid) => threadSummary(uid, 't-1'));
  const other = threadSummary(10, 't-10');
  return vi.fn(async (query: MessageListQuery) => {
    const items = query.threaded
      ? [
          {
            ...conversation[2]!,
            thread: {
              messageIds: ['inbox:1', 'inbox:2', 'inbox:3'],
              count: 3,
              unreadCount: 0,
              flagged: false,
              hasAttachments: false,
              labels: [],
              participants: [{ name: 'Иван', address: 'ivan@example.com' }],
            },
          },
          other,
        ]
      : [...conversation, other];
    return { items, total: items.length, offset: query.offset, limit: query.limit };
  });
}

describe('переписка при включённой группировке', () => {
  beforeEach(() => {
    useUiStore.setState({ listView: { threaded: true, filter: 'all', labelFilter: null } });
  });

  it('показывает весь разговор, а не одну последнюю реплику', async () => {
    /*
     * С группировкой сервер отдаёт по одной строке на переписку, и блок
     * «Ещё писем в переписке» оставался пуст: разговор из трёх писем
     * показывал только то, которое открыли. Без группировки те же письма
     * были на месте — то есть возможность ломалась ровно от включения
     * переписок в настройках.
     */
    vi.spyOn(api, 'getMessages').mockImplementation(threadedServer());
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      serverMessage({ id: 'inbox:3', uid: 3, threadId: 't-1', subject: 'Реплика 3' }),
    );

    render('/inbox/inbox%3A3');
    await waitFor(() => text().includes('Ещё писем в переписке'), 'блок переписки');
    expect(text()).toContain('Ещё писем в переписке: 2');
    // Свёрнутая строка разговора показывает начало письма, а не тему
    expect(text()).toContain('начало 1');
    expect(text()).toContain('начало 2');
  });

  it('стрелки к соседям работают и у письма из середины переписки', async () => {
    /*
     * Строку списка представляет ПОСЛЕДНЕЕ письмо разговора. У письма,
     * открытого из блока переписки (или по прямой ссылке, или из поиска),
     * совпадения по идентификатору в списке не находилось вовсе — и обе
     * стрелки гасли намертво.
     */
    vi.spyOn(api, 'getMessages').mockImplementation(threadedServer());
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      serverMessage({ id: 'inbox:1', uid: 1, threadId: 't-1', subject: 'Реплика 1' }),
    );

    render('/inbox/inbox%3A1');
    await waitFor(() => text().includes('Реплика 1'), 'письмо');

    const next = host.querySelector<HTMLButtonElement>('button[aria-label="Следующее письмо"]');
    expect(next, 'кнопка соседнего письма должна быть на месте').toBeTruthy();
    expect(next!.disabled, 'следующая строка списка есть — стрелка обязана работать').toBe(false);
  });
});
