// @vitest-environment jsdom
/**
 * Возврат из письма в список: то же место и подсвеченное письмо.
 *
 * Дефект: человек листал папку, открывал письмо в середине и, вернувшись,
 * оказывался в начале списка. При просмотре нескольких писем подряд место
 * приходилось искать заново после каждого — а если папка длинная и часть
 * страниц была догружена, то и подгружать заново.
 *
 * Главный случай здесь — именно длинный список с догруженными страницами:
 * если после возврата список схлопывается до первой сотни, «то же место»
 * невозможно в принципе.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MessageListQuery, MessageSummary } from '@mail-true/shared';
import { api } from '../src/api';
import { useUiStore } from '../src/app/store';
import { flattenRows } from '../src/mail/MessageList';
import { restoreScrollTop, rowIndexOf, rowOffsetTop } from '../src/lib/listPosition';
import { FolderPage } from '../src/pages/FolderPage';
import { MessagePage } from '../src/pages/MessagePage';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

let host: HTMLDivElement;
let root: Root;

/** Живой ящик: 187 писем, сервер отдаёт по сотне. */
const TOTAL = 187;
const METRICS = { rowHeight: 48, headerHeight: 40 };

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

function serverPages() {
  return vi.fn(async (query: MessageListQuery) => {
    const items = Array.from(
      { length: Math.min(query.limit, TOTAL - query.offset) },
      (_, i) => summary(query.offset + i + 1),
    );
    return { items, total: TOTAL, offset: query.offset, limit: query.limit };
  });
}

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

/**
 * Кэш запросов общий на весь сценарий: уход в письмо размонтирует страницу
 * папки, но подгруженные страницы живут в кэше — иначе после возврата список
 * схлопнулся бы до первой сотни.
 */
let client: QueryClient;

function renderFolder(path = '/inbox') {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path=":folderId" element={<FolderPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Уход в письмо: страница папки размонтируется целиком. */
function unmountFolder() {
  act(() => root.render(<div />));
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.textContent}`);
}

const scrollBox = (): HTMLElement | null => host.querySelector('[class*="scroll"]');
const rowsOnScreen = (): HTMLElement[] => [...host.querySelectorAll('a[href^="/inbox/"]')];
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

/** Прокручивает список так, как это делает человек. */
function scrollTo(top: number) {
  const box = scrollBox();
  if (!box) throw new Error('списка нет');
  act(() => {
    box.scrollTop = top;
    box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

beforeEach(() => {
  stubLayout();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useUiStore.setState({
    selectedIds: new Set<string>(),
    notice: null,
    composeWindows: [],
    listScroll: {},
    visitedMessage: null,
  });
  vi.spyOn(api, 'getFolders').mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUiStore.setState({ listScroll: {}, visitedMessage: null });
  vi.restoreAllMocks();
});

describe('куда ставить прокрутку', () => {
  it('заголовки периодов учитываются: строка не «уезжает» на их высоту', () => {
    const rows = flattenRows([summary(1), summary(2), summary(3)]);
    // Первый ряд — заголовок периода, дальше письма
    expect(rows[0]?.type).toBe('header');
    expect(rowOffsetTop(rows, 1, METRICS)).toBe(40);
    expect(rowOffsetTop(rows, 3, METRICS)).toBe(40 + 48 * 2);
  });

  it('вернулись туда же — список стоит ровно там, где стоял', () => {
    const rows = flattenRows(Array.from({ length: 200 }, (_, i) => summary(i + 1)));
    const index = rowIndexOf(rows, 'inbox:40');
    const top = rowOffsetTop(rows, index, METRICS) - 100;
    expect(
      restoreScrollTop({ savedTop: top, highlightIndex: index, rows, metrics: METRICS, viewportHeight: 800 }),
    ).toBe(top);
  });

  it('ушли стрелками к другому письму — список доводится до него', () => {
    const rows = flattenRows(Array.from({ length: 200 }, (_, i) => summary(i + 1)));
    const index = rowIndexOf(rows, 'inbox:120');
    // Человек ушёл с сорокового письма, а вернулся со сто двадцатого:
    // ждёт увидеть последнее прочитанное, а не то, с которого начал
    const savedTop = rowOffsetTop(rows, rowIndexOf(rows, 'inbox:40'), METRICS);
    const top = restoreScrollTop({
      savedTop,
      highlightIndex: index,
      rows,
      metrics: METRICS,
      viewportHeight: 800,
    });
    const rowTop = rowOffsetTop(rows, index, METRICS);
    expect(top).not.toBe(savedTop);
    expect(top!).toBeLessThanOrEqual(rowTop);
    expect(top! + 800).toBeGreaterThanOrEqual(rowTop + METRICS.rowHeight);
  });

  it('в список пришли впервые — восстанавливать нечего', () => {
    const rows = flattenRows([summary(1)]);
    expect(
      restoreScrollTop({ savedTop: undefined, highlightIndex: -1, rows, metrics: METRICS, viewportHeight: 800 }),
    ).toBeNull();
  });
});

describe('возврат в список', () => {
  it('прокрутка восстанавливается — и подгруженные страницы не схлопываются', async () => {
    const getMessages = serverPages();
    vi.spyOn(api, 'getMessages').mockImplementation(getMessages);

    renderFolder();
    await waitFor(() => Boolean(button('Показать ещё')), 'первую страницу');
    // Догружаем вторую сотню — ровно тот случай, ради которого всё и делается
    act(() => button('Показать ещё')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => !button('Показать ещё'), 'вторую страницу');

    scrollTo(3000);
    // Ушли в письмо, которое на этом месте и видно (строка 64 идёт с 3064-го
    // пикселя при окне 800): вернуться человек должен ровно сюда, без
    // «доведения» списка до строки
    useUiStore.getState().setVisitedMessage('inbox', 'inbox:64');
    unmountFolder();
    expect(useUiStore.getState().listScroll['inbox:all']).toBe(3000);

    // Вернулись
    renderFolder();
    await waitFor(() => rowsOnScreen().length > 0, 'список после возврата');

    // Все 187 писем на месте: список не схлопнулся до первой сотни, иначе
    // «то же положение» было бы невозможно
    expect(host.textContent).not.toContain('Показать ещё');
    expect(scrollBox()?.scrollTop).toBe(3000);
  });

  it('строка, из которой вернулись, подсвечена', async () => {
    vi.spyOn(api, 'getMessages').mockImplementation(serverPages());
    useUiStore.getState().setVisitedMessage('inbox', 'inbox:3');

    renderFolder();
    await waitFor(() => rowsOnScreen().length > 0, 'список');

    const visited = host.querySelector('a[href="/inbox/inbox%3A3"]');
    expect(visited?.className, 'подсветки нет').toMatch(/visited/u);
    // И только она одна: метка про одно письмо, а не про пачку
    expect(rowsOnScreen().filter((r) => /visited/u.test(r.className))).toHaveLength(1);
  });

  it('в другой папке подсветки нет и чужая прокрутка не восстанавливается', async () => {
    vi.spyOn(api, 'getMessages').mockImplementation(async (query: MessageListQuery) => ({
      items: Array.from({ length: 20 }, (_, i) => ({
        ...summary(i + 1),
        id: `${query.folderId}:${i + 1}`,
        folderId: query.folderId,
      })),
      total: 20,
      offset: 0,
      limit: query.limit,
    }));
    useUiStore.setState({
      visitedMessage: { folderId: 'inbox', messageId: 'inbox:3' },
      listScroll: { 'inbox:all': 3000 },
    });

    renderFolder('/archive');
    await waitFor(() => Boolean(host.querySelector('a[href^="/archive/"]')), 'список архива');

    expect(host.querySelector('[class*="visited"]')).toBeNull();
    expect(scrollBox()?.scrollTop).toBe(0);
  });

  it('смена отбора снимает подсветку: список стал другим', async () => {
    vi.spyOn(api, 'getMessages').mockImplementation(serverPages());
    useUiStore.getState().setVisitedMessage('inbox', 'inbox:3');

    renderFolder();
    await waitFor(() => Boolean(host.querySelector('[class*="visited"]')), 'подсветку');

    // «Непрочитанные» в панели над списком
    const filterButton = button('Все письма') ?? button('Фильтр');
    expect(filterButton, 'кнопки отбора нет').toBeTruthy();
    act(() => filterButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const unread = [...host.querySelectorAll('button, [role="menuitem"]')].find(
      (b) => b.textContent?.trim() === 'Непрочитанные',
    );
    expect(unread, 'пункта «Непрочитанные» нет').toBeTruthy();
    act(() => unread!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(useUiStore.getState().visitedMessage).toBeNull();
  });
});

describe('переход стрелками внутри просмотра', () => {
  it('обновляет место возврата: ждём последнее прочитанное, а не первое', async () => {
    const full = (uid: number) => ({
      ...summary(uid),
      messageId: `<m-${uid}@example.com>`,
      inReplyTo: null,
      references: [],
      replyTo: [],
      bcc: [],
      bodyHtml: `<p>письмо ${uid}</p>`,
      bodyText: `письмо ${uid}`,
      attachments: [],
      headers: {},
      authentication: { spf: 'pass' as const, dkim: 'pass' as const, dmarc: 'pass' as const },
      blockedRemote: 0,
    });
    vi.spyOn(api, 'getMessages').mockImplementation(serverPages());
    vi.spyOn(api, 'getMessage').mockImplementation(async (id: string) =>
      full(Number(id.split(':')[1])),
    );
    vi.spyOn(api, 'setFlags').mockResolvedValue({ updated: 1 });

    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/inbox/inbox%3A40']}>
            <Routes>
              <Route path=":folderId/:messageId" element={<MessagePage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => host.textContent!.includes('письмо 40'), 'сороковое письмо');
    expect(useUiStore.getState().visitedMessage?.messageId).toBe('inbox:40');

    // Стрелка «следующее письмо» листает прямо здесь, не возвращаясь в список
    const next = host.querySelector('[aria-label="Следующее письмо"]');
    expect(next, 'стрелки перехода нет').toBeTruthy();
    act(() => next!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => host.textContent!.includes('письмо 41'), 'сорок первое письмо');

    expect(useUiStore.getState().visitedMessage?.messageId).toBe('inbox:41');
  });
});

describe('подсветка не спорит с выделением и курсором', () => {
  it('это третье состояние: полоска у края, а не заливка строки', () => {
    const css = readFileSync(join(SRC, 'mail/MessageList.module.css'), 'utf8');
    const at = css.indexOf('\n.row.visited::before {');
    expect(at, 'правила подсветки нет').toBeGreaterThanOrEqual(0);
    const body = css.slice(at, css.indexOf('}', at));

    // Заливку строки трогать нельзя: ею заняты выделение галочкой
    // (--row-bg press) и клавиатурный курсор (--row-bg hover)
    expect(body).not.toMatch(/--row-bg/u);
    expect(body).toMatch(/width:\s*4px/u);
    expect(body).toMatch(/background:\s*var\(--mt-color-background-accent\)/u);
    // Текста подсветка не касается вовсе — жирный шрифт непрочитанного
    // остаётся единственным, что говорит о непрочитанности
    expect(body).not.toMatch(/font-weight/u);

    // Налёт кладётся поверх подложки картинкой, а не подменяет её: строку,
    // из которой вернулись, видно и когда она заодно выделена галочкой
    const tintAt = css.indexOf('\n.row.visited {');
    expect(tintAt, 'налёта нет').toBeGreaterThanOrEqual(0);
    const tint = css.slice(tintAt, css.indexOf('}', tintAt));
    expect(tint).toMatch(/background-image:\s*linear-gradient/u);
    expect(tint).toMatch(/--mt-color-background-accent-tint-alpha/u);
    expect(tint).not.toMatch(/--row-bg/u);
  });
});
