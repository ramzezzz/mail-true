// @vitest-environment jsdom
/**
 * Клавиатура и доступность списка писем.
 *
 * Здесь заперты четыре найденных вживую дефекта:
 *   - обещанных документом клавиш R, F и Delete не существовало;
 *   - после навигации стрелками глобальный Enter отбирал нажатие
 *     у сфокусированной кнопки, и нажать нельзя было уже ничего;
 *   - стрелки двигали подсветку, но не переносили фокус: событие фокуса
 *     не наступало, и скринридер строку не читал;
 *   - у поля поиска не было видимой рамки фокуса.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MessageListQuery, MessageSummary } from '@mail-true/shared';
import { api } from '../src/api';
import type { MessageFull } from '../src/api/types';
import { useUiStore } from '../src/app/store';
import { FolderPage } from '../src/pages/FolderPage';

let host: HTMLDivElement;
let root: Root;

const TOTAL = 5;

function summary(uid: number): MessageSummary {
  return {
    id: `inbox:${uid}`,
    folderId: 'inbox',
    uid,
    threadId: `t-${uid}`,
    from: { name: `Отправитель ${uid}`, address: `from${uid}@example.com` },
    to: [],
    cc: [],
    subject: `Письмо ${uid}`,
    snippet: 'текст',
    date: new Date(2026, 6, 1, 12, 0, uid).toISOString(),
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

/** Полное письмо: из него собирается цитата для ответа и пересылки. */
function full(uid: number): MessageFull {
  return {
    ...summary(uid),
    messageId: `<mt-${uid}@example.com>`,
    inReplyTo: null,
    references: [],
    replyTo: [],
    bcc: [],
    bodyHtml: `<p>тело письма ${uid}</p>`,
    bodyText: `тело письма ${uid}`,
    attachments: [],
    headers: {},
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    blockedRemote: 0,
  };
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox']}>
          {/* Кнопка вне страницы папки — как «Написать письмо» в боковой
              колонке. Именно на ней Enter переставал работать. */}
          <button type="button">Написать письмо</button>
          <Routes>
            <Route path=":folderId" element={<FolderPage />} />
            <Route path=":folderId/:messageId" element={<div>ОТКРЫТО ПИСЬМО</div>} />
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

const text = () => host.textContent ?? '';
const rows = () => [...host.querySelectorAll<HTMLAnchorElement>('a[href^="/inbox/inbox"]')];

/** Клавиша «сверху», как её видит глобальный обработчик на document. */
function press(key: string, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function renderList() {
  vi.spyOn(api, 'getMessages').mockImplementation(async (query: MessageListQuery) => ({
    items: Array.from({ length: TOTAL }, (_, i) => summary(i + 1)),
    total: TOTAL,
    offset: query.offset,
    limit: query.limit,
  }));
  render();
  await waitFor(() => rows().length > 0, 'строки списка');
}

/**
 * Виртуализация меряет окно списка через offsetHeight, а в jsdom он всегда
 * ноль — без этой подпорки не отрисовалось бы ни одной строки.
 */
function giveElementsSize() {
  for (const [prop, value] of [
    ['offsetHeight', 600],
    ['offsetWidth', 900],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value });
  }
}

beforeEach(() => {
  giveElementsSize();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ selectedIds: new Set<string>(), composeWindows: [], notice: null });
  vi.spyOn(api, 'getFolders').mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('обещанные документом клавиши R, F, Delete', () => {
  it('R открывает ответ письму под курсором', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(full(1));
    await renderList();

    press('ArrowDown');
    press('r');
    await waitFor(() => useUiStore.getState().composeWindows.length === 1, 'окно ответа');

    const init = useUiStore.getState().composeWindows[0]!.init;
    expect(init.to).toBe('from1@example.com');
    expect(init.subject).toBe('Re: Письмо 1');
    expect(init.inReplyTo).toBe('<mt-1@example.com>');
  });

  it('F открывает пересылку: получателя нет, тело исходное', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(full(1));
    await renderList();

    press('ArrowDown');
    press('f');
    await waitFor(() => useUiStore.getState().composeWindows.length === 1, 'окно пересылки');

    const init = useUiStore.getState().composeWindows[0]!.init;
    expect(init.to).toBeUndefined();
    expect(init.subject).toBe('Fwd: Письмо 1');
    expect(init.bodyHtml).toContain('тело письма 1');
  });

  it('Delete отправляет письмо под курсором в корзину', async () => {
    const moveMessages = vi
      .spyOn(api, 'moveMessages')
      .mockResolvedValue({ moved: 1, targetFolderId: 'trash' });
    await renderList();

    press('ArrowDown');
    press('Delete');
    await waitFor(() => moveMessages.mock.calls.length > 0, 'запрос на перемещение');

    expect(moveMessages).toHaveBeenCalledWith({ ids: ['inbox:1'], targetFolderId: 'trash' });
  });
});

describe('Enter на кнопке принадлежит кнопке', () => {
  it('после навигации стрелками кнопка «Написать письмо» остаётся рабочей', async () => {
    await renderList();

    // Разбираем список стрелками — курсор встаёт на второе письмо
    press('ArrowDown');
    press('ArrowDown');

    const compose = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Написать письмо',
    )!;
    compose.focus();
    const event = press('Enter', compose);

    // Глобальный обработчик руки убрал: нажатие досталось кнопке,
    // а не увело в письмо, выбранное стрелками
    expect(event.defaultPrevented).toBe(false);
    expect(text()).not.toContain('ОТКРЫТО ПИСЬМО');
    expect(text()).toContain('Письмо 1');
  });

  it('Enter в списке по-прежнему открывает письмо под курсором', async () => {
    await renderList();

    press('ArrowDown');
    press('Enter', rows()[0]!);

    await waitFor(() => text().includes('ОТКРЫТО ПИСЬМО'), 'открытое письмо');
  });
});

describe('стрелки переносят настоящий фокус (для скринридера)', () => {
  it('после стрелки вниз document.activeElement — строка под курсором', async () => {
    await renderList();

    press('ArrowDown');
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows()[0]!.getAttribute('aria-current')).toBe('true');

    press('ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows()[1]!.getAttribute('aria-current')).toBe('true');
    expect(rows()[0]!.getAttribute('aria-current')).toBeNull();
  });

  it('roving tabindex: в обход по Tab попадает ровно одна строка', async () => {
    await renderList();

    // До навигации Tab заводит в список на первую строку
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1]);

    press('ArrowDown');
    press('ArrowDown');
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
  });
});

describe('видимая рамка фокуса у поля поиска', () => {
  it('поле поиска меняет вид при получении фокуса', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/layout/SearchBar.module.css'), 'utf8');
    // У самого input `outline: none` и прозрачный фон, поэтому рамку рисует
    // поле целиком. Без этого правила идущий через Tab не видел, где он.
    const rule = /\.field:focus-within\s*\{[^}]*\}/u.exec(css)?.[0] ?? '';
    expect(rule).toMatch(/outline:\s*\d+px\s+solid/u);
  });
});
