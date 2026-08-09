// @vitest-environment jsdom
/**
 * Склейка страниц списка писем.
 *
 * Сервер режет ПОЗИЦИОННО: сортирует все подходящие письма и отдаёт ломоть
 * `slice(offset, offset + limit)`. Клиент же просил следующую страницу со
 * смещением, посчитанным по числу ПОЛУЧЕННЫХ писем, и склеивал страницы
 * простым `flatMap` — без единой проверки на повтор. Отсюда две беды,
 * которые человек видит как «список сошёл с ума»:
 *
 *   - страница пришла короче, чем просили (письмо удалили между поиском и
 *     выборкой), — следующая начиналась с заходом на уже показанное:
 *     строки задваивались, а соседние пропадали;
 *   - между подгрузками пришла новая почта, весь список сдвинулся — и то,
 *     что было последним на первой странице, приехало первым на второй.
 *
 * Двойная строка — не косметика: у неё тот же идентификатор, поэтому
 * галочка ставится сразу в двух местах, а виртуализация получает два узла
 * с одним ключом.
 *
 * Здесь же третье: склеенный массив обязан быть ОДНИМ И ТЕМ ЖЕ, пока не
 * приехали новые данные. Новый массив на каждый рендер список писем читает
 * как «письма изменились» и заново считает строки, счётчики переписок и
 * состояния выделения — а заодно доводит прокрутку до строки под курсором,
 * утаскивая человека с того места, куда он уехал колесом.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageListQuery, MessageSummary } from '@mail-true/shared';
import { api } from '../src/api';
import { useFolderMessages, type FolderMessages } from '../src/api/queries';

let host: HTMLDivElement;
let root: Root;

/** Живой ящик: 187 писем во «Входящих», сервер отдаёт по сотне. */
const TOTAL = 187;

function summary(uid: number): MessageSummary {
  return {
    id: `inbox:${uid}`,
    folderId: 'inbox',
    uid,
    threadId: `t-${uid}`,
    from: { name: 'Отправитель', address: 'from@example.com' },
    to: [],
    cc: [],
    subject: `Письмо ${uid}`,
    snippet: 'текст',
    date: new Date(2026, 6, 1, 12, 0, uid % 60).toISOString(),
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

/** Папка целиком, новые первыми: так её и держит сервер перед нарезкой. */
function inbox(total = TOTAL): MessageSummary[] {
  return Array.from({ length: total }, (_, i) => summary(total - i));
}

/* ------------------------------------------------------------------ */
/* Показ                                                               */
/* ------------------------------------------------------------------ */

/** Последнее, что вернул хук: из него берутся items и loadMore. */
let page: FolderMessages | null = null;
/** Все ссылки на склеенный список — по одной на рендер. */
let seenItems: readonly MessageSummary[][] = [];

function Probe({ tick }: { tick: number }) {
  const result = useFolderMessages('inbox', 'all');
  page = result;
  seenItems = [...seenItems, result.items];
  return <div data-tick={tick}>{result.items.length}</div>;
}

let client: QueryClient;

function render(tick = 0) {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe tick={tick} />
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
  throw new Error(`не дождались: ${what}`);
}

const ids = (): string[] => (page?.items ?? []).map((m) => m.id);
const offsets = (getMessages: { mock: { calls: [MessageListQuery][] } }): number[] =>
  getMessages.mock.calls.map(([query]) => query.offset);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  page = null;
  seenItems = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe('страница пришла короче, чем просили', () => {
  it('следующая просится с прежнего рубежа, и строки не задваиваются', async () => {
    /*
     * Одно письмо удалили между поиском и выборкой: сервер взял ломоть на
     * сотню, а отдал 99 писем — так и написано в его коде (в ветке
     * переписок это прямо `if (!latest) continue`).
     */
    const all = inbox();
    const getMessages = vi.fn(async (query: MessageListQuery) => ({
      items: all
        .slice(query.offset, query.offset + query.limit)
        .filter((m) => m.id !== 'inbox:182'),
      total: TOTAL,
      offset: query.offset,
      limit: query.limit,
    }));
    vi.spyOn(api, 'getMessages').mockImplementation(getMessages);

    render();
    await waitFor(() => (page?.items.length ?? 0) > 0, 'первую страницу');
    expect(page!.items).toHaveLength(99);

    act(() => page!.loadMore());
    await waitFor(() => !page!.hasMore, 'вторую страницу');

    // Второй ломоть начинается там, где кончился первый, — по ЗАПРОШЕННОМУ
    // куску, а не по числу доехавших писем (иначе было бы 99).
    expect(offsets(getMessages)).toContain(100);
    expect(offsets(getMessages)).not.toContain(99);
    // И ни одной задвоенной строки
    expect(new Set(ids()).size).toBe(ids().length);
  });
});

describe('между подгрузками пришла новая почта', () => {
  it('сдвинувшийся список не показывает письмо дважды', async () => {
    const all = inbox();
    let arrived = false;
    const getMessages = vi.fn(async (query: MessageListQuery) => {
      const list = arrived ? [summary(1000), ...all] : all;
      const items = list.slice(query.offset, query.offset + query.limit);
      // Новое письмо приходит сразу после первой страницы: к моменту
      // второго запроса весь список сдвинут на одну строку вниз.
      arrived = true;
      return { items, total: list.length, offset: query.offset, limit: query.limit };
    });
    vi.spyOn(api, 'getMessages').mockImplementation(getMessages);

    render();
    await waitFor(() => (page?.items.length ?? 0) === 100, 'первую страницу');

    act(() => page!.loadMore());
    await waitFor(() => !page!.hasMore, 'вторую страницу');

    // Письмо, стоявшее последним на первой странице, приехало и вторым
    // ломтём — показать его дважды нельзя.
    expect(new Set(ids()).size).toBe(ids().length);
    expect(page!.loaded).toBe(ids().length);
  });
});

describe('постоянство склеенного списка', () => {
  it('перерисовка без новых данных отдаёт ТОТ ЖЕ массив писем', async () => {
    vi.spyOn(api, 'getMessages').mockImplementation(async (query: MessageListQuery) => ({
      items: inbox().slice(query.offset, query.offset + query.limit),
      total: TOTAL,
      offset: query.offset,
      limit: query.limit,
    }));

    render(1);
    await waitFor(() => (page?.items.length ?? 0) === 100, 'список');

    const before = page!.items;
    // Перерисовка по причине, не имеющей к письмам никакого отношения
    render(2);
    expect(page!.items, 'письма не менялись — массив обязан остаться тем же').toBe(before);
    expect(seenItems[seenItems.length - 1]).toBe(seenItems[seenItems.length - 2]);
  });
});
