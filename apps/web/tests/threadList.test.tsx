// @vitest-environment jsdom
/**
 * Список, сгруппированный по перепискам.
 *
 * Проверяется то, чего не было: строка списка была строкой ПИСЬМА, и ответ
 * на письмо заводил вторую строку с той же темой (docs/gaps.md, п. 11).
 *
 * Каждая проверка идёт в обе стороны, и вторая половина здесь важнее
 * первой. «Действие применилось ко всей переписке» само по себе ничего не
 * значит: дефект, которого мы боимся, выглядит как «удалил цепочку, а два
 * письма остались» — то есть строка пропала, а письма нет. Поэтому рядом
 * с каждой проверкой стоит обратная: столько же писем, сколько в строке,
 * и ни одним больше.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MessageListQuery, MessageSummary, ThreadSummary } from '@mail-true/shared';
import { api, settingsApi } from '../src/api';
import { useUiStore } from '../src/app/store';
import { MessageList, ROW_HEIGHT, rowHeightFor } from '../src/mail/MessageList';
import {
  chunkIds,
  correspondentLabel,
  expandThreadIds,
  isRowFlagged,
  isRowUnread,
  rowHasAttachments,
  rowThreadCount,
  threadMessageIds,
} from '../src/mail/threadList';
import { DEFAULT_GENERAL_SETTINGS } from '../src/settings/generalSettings';
import { FolderPage } from '../src/pages/FolderPage';

let host: HTMLDivElement;
let root: Root;

function summary(uid: number, over: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id: `inbox:${uid}`,
    folderId: 'inbox',
    uid,
    threadId: `t-${uid}`,
    from: { name: 'Пётр Смирнов', address: 'p@example.com' },
    to: [],
    cc: [],
    subject: `Тема ${uid}`,
    snippet: 'начало текста',
    date: new Date(2026, 7, 5, 12, uid).toISOString(),
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
    ...over,
  };
}

function thread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    messageIds: ['inbox:1', 'inbox:4', 'inbox:9'],
    count: 3,
    unreadCount: 0,
    flagged: false,
    hasAttachments: false,
    labels: [],
    participants: [
      { name: 'Иван', address: 'ivan@example.com' },
      { name: 'Пётр', address: 'petr@example.com' },
    ],
    ...over,
  };
}

/**
 * jsdom не считает размеров: offsetWidth/offsetHeight у него всегда нули,
 * а виртуализация меряет контейнер прокрутки именно ими — при нулевой
 * высоте она не отрисовывает ни одной строки. Выдаём ей окно 1200×800.
 */
function stubLayout() {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 1200,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 800,
  });
}

beforeEach(() => {
  stubLayout();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ selectedIds: new Set<string>(), notice: null, composeWindows: [] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Что представляет строка                                              */
/* ------------------------------------------------------------------ */

describe('строка списка представляет переписку целиком', () => {
  it('действие над строкой относится ко всем её письмам', () => {
    const row = summary(9, { thread: thread() });
    expect(threadMessageIds(row)).toEqual(['inbox:1', 'inbox:4', 'inbox:9']);
    expect(expandThreadIds(['inbox:9'], [row])).toEqual(['inbox:1', 'inbox:4', 'inbox:9']);
  });

  it('обратный ход: строка без переписки остаётся одним письмом', () => {
    const plain = summary(9);
    expect(threadMessageIds(plain)).toEqual(['inbox:9']);
    expect(expandThreadIds(['inbox:9'], [plain])).toEqual(['inbox:9']);
  });

  it('одно и то же письмо не уходит в действие дважды', () => {
    // Две строки одной папки могут назвать общее письмо только по ошибке
    // сервера — но «удалить» от этого не должно уйти на него два раза.
    const a = summary(9, { thread: thread({ messageIds: ['inbox:1', 'inbox:9'] }) });
    const b = summary(4, { thread: thread({ messageIds: ['inbox:1', 'inbox:4'] }) });
    const ids = expandThreadIds(['inbox:9', 'inbox:4'], [a, b]);
    expect(ids).toEqual(['inbox:1', 'inbox:9', 'inbox:4']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('выделенная строка, которой уже нет в списке, не теряется', () => {
    // Выделение переживает подгрузку и обновление списка. Молча выбросить
    // такой идентификатор значило бы не сделать того, что человек просил.
    expect(expandThreadIds(['inbox:77'], [summary(9)])).toEqual(['inbox:77']);
  });

  it('переписка непрочитана, пока непрочитано хоть одно письмо', () => {
    const unread = summary(9, { flags: { ...summary(9).flags, seen: true } });
    unread.thread = thread({ unreadCount: 1 });
    expect(isRowUnread(unread)).toBe(true);
    // Обратный ход: последнее письмо ПРОЧИТАНО. Считай строка по нему —
    // непрочитанное письмо исчезало бы из виду от того, что на него ответили.
    expect(unread.flags.seen).toBe(true);

    const allRead = summary(9, { thread: thread({ unreadCount: 0 }) });
    expect(isRowUnread(allRead)).toBe(false);
  });

  it('флажок и скрепка строки собраны со всей переписки', () => {
    const row = summary(9, { thread: thread({ flagged: true, hasAttachments: true }) });
    expect(isRowFlagged(row)).toBe(true);
    expect(rowHasAttachments(row)).toBe(true);
    // Обратный ход: у самого последнего письма ни флажка, ни вложений нет
    expect(row.flags.flagged).toBe(false);
    expect(row.hasAttachments).toBe(false);
  });

  it('без переписки признаки берутся у самого письма — как раньше', () => {
    const row = summary(9, {
      flags: { ...summary(9).flags, seen: false, flagged: true },
      hasAttachments: true,
    });
    expect(isRowUnread(row)).toBe(true);
    expect(isRowFlagged(row)).toBe(true);
    expect(rowHasAttachments(row)).toBe(true);
  });

  it('счётчик берётся у сервера, а запасной — только когда сводки нет', () => {
    expect(rowThreadCount(summary(9, { thread: thread({ count: 6 }) }), 2)).toBe(6);
    expect(rowThreadCount(summary(9), 2)).toBe(2);
  });

  it('в колонке отправителя — участники переписки, а не только последний', () => {
    expect(correspondentLabel(summary(9, { thread: thread() }))).toBe('Иван, Пётр');
    // Обратный ход: переписка одного человека и обычное письмо выглядят
    // ровно как раньше — именем отправителя строки. Перечислять одного
    // участника отдельным путём незачем: он и есть отправитель последнего
    // письма, потому что все письма переписки написал он.
    expect(
      correspondentLabel(summary(9, { thread: thread({ participants: [summary(9).from] }) })),
    ).toBe('Пётр Смирнов');
    expect(correspondentLabel(summary(9))).toBe('Пётр Смирнов');
  });

  it('письма режутся на запросы по пятьсот — предел маршрута', () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `inbox:${String(i + 1)}`);
    const chunks = chunkIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 201]);
    // Обратный ход: ни одно письмо не потерялось при разрезании
    expect(chunks.flat()).toEqual(ids);
    expect(chunkIds([])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Виртуализация                                                        */
/* ------------------------------------------------------------------ */

describe('высота строки известна JavaScript, а не только CSS', () => {
  function renderList(messages: MessageSummary[]) {
    act(() => {
      root.render(
        <MemoryRouter>
          <MessageList messages={messages} />
        </MemoryRouter>,
      );
    });
    return [...host.querySelectorAll<HTMLElement>('[class*="virtualRow"]')];
  }

  it('строка переписки той же высоты, что строка письма', () => {
    // Виртуализация ставит высоту КАЖДОЙ строке сама, числом из JavaScript
    // (estimateSize). Если строка переписки окажется выше нарисованного,
    // список поедет — и тем сильнее, чем дальше пролистали.
    const grouped = renderList([summary(9, { thread: thread() }), summary(2)]);
    const heights = grouped.map((el) => el.style.height);
    const rowHeight = `${String(rowHeightFor(false, false))}px`;

    expect(heights.filter((h) => h !== '40px')).toEqual([rowHeight, rowHeight]);
    expect(rowHeight).toBe(`${String(ROW_HEIGHT.desktop.normal)}px`);
  });

  it('подложка списка ровно такой высоты, сколько в ней строк', () => {
    // Обратный ход к предыдущей проверке: сумма, которую виртуализация
    // отвела под список, должна сойтись с числом строк. Разойдётся — и
    // прокрутка начнёт останавливаться не там, где кончаются письма.
    const rows = renderList([
      summary(9, { thread: thread() }),
      summary(4, { thread: thread({ count: 2 }) }),
      summary(2),
    ]);
    const inner = host.querySelector<HTMLElement>('[class*="inner"]')!;
    const headers = rows.filter((el) => el.style.height === '40px').length;

    expect(rows.length).toBe(headers + 3);
    expect(inner.style.height).toBe(`${String(headers * 40 + 3 * ROW_HEIGHT.desktop.normal)}px`);
  });

  it('в строке переписки видны участники и число писем', () => {
    renderList([summary(9, { thread: thread({ count: 3 }) })]);
    const badge = host.querySelector('[class*="threadCount"]');
    expect(badge?.textContent).toBe('3');
    expect(host.textContent).toContain('Иван, Пётр');
  });
});

/* ------------------------------------------------------------------ */
/* Действия над строкой в живой странице папки                          */
/* ------------------------------------------------------------------ */

describe('действия страницы папки над строкой-перепиской', () => {
  /** Список из одной переписки (три письма) и одного обычного письма. */
  function serverPage() {
    return vi.fn(async (query: MessageListQuery) => ({
      items: [summary(9, { thread: thread() }), summary(2)],
      total: 2,
      offset: query.offset,
      limit: query.limit,
    }));
  }

  function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/inbox']}>
            <Routes>
              <Route path=":folderId" element={<FolderPage />} />
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
    throw new Error(`не дождались: ${what}\n${host.textContent ?? ''}`);
  }

  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

  let getMessages: ReturnType<typeof serverPage>;

  beforeEach(() => {
    getMessages = serverPage();
    vi.spyOn(api, 'getMessages').mockImplementation(getMessages);
    vi.spyOn(api, 'getFolders').mockResolvedValue([]);
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(DEFAULT_GENERAL_SETTINGS);
  });

  it('по умолчанию список просят сгруппированным — как в mail.ru', async () => {
    render();
    await waitFor(() => getMessages.mock.calls.length > 0, 'запрос списка');
    expect(getMessages.mock.calls[0]?.[0].threaded).toBe(true);
  });

  it('список показывается письмами, если человек так выбрал', async () => {
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue({
      ...DEFAULT_GENERAL_SETTINGS,
      groupByThread: false,
    });
    render();
    await waitFor(
      () => getMessages.mock.calls.some(([q]) => q.threaded === false),
      'запрос без группировки',
    );
  });

  it('«Удалить» уносит в корзину ВСЮ переписку', async () => {
    const moveMessages = vi.spyOn(api, 'moveMessages').mockResolvedValue({ moved: 3 });
    render();
    await waitFor(() => Boolean(host.querySelector('[class*="threadCount"]')), 'список');

    act(() => useUiStore.getState().selectMany(['inbox:9']));
    await waitFor(() => Boolean(button('Удалить')), 'панель выделения');
    act(() => button('Удалить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await waitFor(() => moveMessages.mock.calls.length > 0, 'запрос переноса');
    expect(moveMessages.mock.calls[0]?.[0]).toEqual({
      ids: ['inbox:1', 'inbox:4', 'inbox:9'],
      targetFolderId: 'trash',
    });
  });

  it('обратный ход: обычное письмо уносится одно, а не с соседями', async () => {
    const moveMessages = vi.spyOn(api, 'moveMessages').mockResolvedValue({ moved: 1 });
    render();
    await waitFor(() => Boolean(host.querySelector('[class*="threadCount"]')), 'список');

    act(() => useUiStore.getState().selectMany(['inbox:2']));
    await waitFor(() => Boolean(button('Удалить')), 'панель выделения');
    act(() => button('Удалить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await waitFor(() => moveMessages.mock.calls.length > 0, 'запрос переноса');
    expect(moveMessages.mock.calls[0]?.[0].ids).toEqual(['inbox:2']);
  });

  /** Горячая клавиша списка (U — непрочитано, I — флажок). */
  const press = (key: string) =>
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });

  it('«Пометить непрочитанным» действует на всю переписку', async () => {
    const setFlags = vi.spyOn(api, 'setFlags').mockResolvedValue({ updated: 3 });
    render();
    await waitFor(() => Boolean(host.querySelector('[class*="threadCount"]')), 'список');

    act(() => useUiStore.getState().selectMany(['inbox:9']));
    press('u');

    await waitFor(() => setFlags.mock.calls.length > 0, 'запрос пометок');
    expect(setFlags.mock.calls[0]?.[0]).toEqual({
      ids: ['inbox:1', 'inbox:4', 'inbox:9'],
      set: { seen: false },
    });
  });

  it('обратный ход: у обычного письма меняется только оно', async () => {
    const setFlags = vi.spyOn(api, 'setFlags').mockResolvedValue({ updated: 1 });
    render();
    await waitFor(() => Boolean(host.querySelector('[class*="threadCount"]')), 'список');

    act(() => useUiStore.getState().selectMany(['inbox:2']));
    press('u');

    await waitFor(() => setFlags.mock.calls.length > 0, 'запрос пометок');
    expect(setFlags.mock.calls[0]?.[0].ids).toEqual(['inbox:2']);
  });

  it('флажок ставится на всю переписку', async () => {
    const setFlags = vi.spyOn(api, 'setFlags').mockResolvedValue({ updated: 3 });
    render();
    await waitFor(() => Boolean(host.querySelector('[class*="threadCount"]')), 'список');

    act(() => useUiStore.getState().selectMany(['inbox:9']));
    press('i');

    await waitFor(() => setFlags.mock.calls.length > 0, 'запрос пометок');
    expect(setFlags.mock.calls[0]?.[0]).toEqual({
      ids: ['inbox:1', 'inbox:4', 'inbox:9'],
      set: { flagged: true },
    });
  });

  it('«Отметить все прочитанными» доходит до всех писем всех переписок', async () => {
    const setFlags = vi.spyOn(api, 'setFlags').mockResolvedValue({ updated: 4 });
    render();
    await waitFor(() => Boolean(host.querySelector('[class*="threadCount"]')), 'список');
    act(() =>
      button('Отметить все прочитанными')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );

    await waitFor(() => setFlags.mock.calls.length > 0, 'запрос пометок');
    // Две строки — но четыре письма. Раньше сюда ушли бы два
    // идентификатора, и половина папки осталась бы непрочитанной.
    expect(setFlags.mock.calls[0]?.[0].ids).toEqual(['inbox:1', 'inbox:4', 'inbox:9', 'inbox:2']);
  });

  it('смахивание строки уносит в архив всю переписку', async () => {
    const moveMessages = vi.spyOn(api, 'moveMessages').mockResolvedValue({ moved: 3 });
    render();
    await waitFor(() => Boolean(host.querySelector('[class*="threadCount"]')), 'список');

    /*
     * Касания собираются вручную: конструктора `Touch` в jsdom нет, а
     * обработчику нужны только координаты первой точки. Событие обычное,
     * список координат подставлен полем — React отдаёт обработчику
     * родное событие как есть.
     */
    const shell = host.querySelector<HTMLElement>('[class*="swipeShell"]')!;
    const touchEvent = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'touches', {
        value: [{ clientX: x, clientY: 0 }],
      });
      return event;
    };
    act(() => {
      shell.dispatchEvent(touchEvent('touchstart', 0));
      // Больше SWIPE_TRIGGER (88px) — жест доведён до конца
      shell.dispatchEvent(touchEvent('touchmove', 200));
      shell.dispatchEvent(new Event('touchend', { bubbles: true }));
    });

    await waitFor(() => moveMessages.mock.calls.length > 0, 'запрос переноса');
    expect(moveMessages.mock.calls[0]?.[0]).toEqual({
      ids: ['inbox:1', 'inbox:4', 'inbox:9'],
      targetFolderId: 'archive',
    });
  });
});
