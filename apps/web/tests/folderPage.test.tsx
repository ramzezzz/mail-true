// @vitest-environment jsdom
/**
 * Список писем папки.
 *
 * Проверяется то, чего не было:
 *   - подгрузка следующих страниц. Живой ящик отвечает `total: 187` при
 *     limit=100, а интерфейс запрашивал ровно одну страницу с `offset: 0`
 *     и `total` не использовал — 87 писем были недостижимы;
 *   - честная подпись кнопки выделения (выделяются только загруженные);
 *   - разбор ошибки загрузки: раньше на экран попадал `String(error)`
 *     вместе с именем класса и без возможности повторить;
 *   - видимый отказ мутации: «переместить» падало молча.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MessageListQuery, MessageSummary } from '@mail-true/shared';
import { api } from '../src/api';
import { ApiError } from '../src/api/http';
import { useUiStore } from '../src/app/store';
import { FolderPage } from '../src/pages/FolderPage';
import { Notice } from '../src/layout/Notice';

let host: HTMLDivElement;
let root: Root;

/** Живой ящик: 187 писем во «Входящих». */
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

/** Отвечает как сервер: не больше limit писем и общий total. */
function serverPages() {
  return vi.fn(async (query: MessageListQuery) => {
    const items = Array.from(
      { length: Math.min(query.limit, TOTAL - query.offset) },
      (_, i) => summary(query.offset + i + 1),
    );
    return { items, total: TOTAL, offset: query.offset, limit: query.limit };
  });
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox']}>
          <Routes>
            <Route
              path=":folderId"
              element={
                <>
                  <FolderPage />
                  <Notice />
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

const text = () => host.textContent ?? '';
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ selectedIds: new Set<string>(), notice: null, composeWindows: [] });
  vi.spyOn(api, 'getFolders').mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('подгрузка писем', () => {
  it('после первой сотни из 187 предлагает «Показать ещё» и не считает вслух', async () => {
    vi.spyOn(api, 'getMessages').mockImplementation(serverPages());
    render();
    await waitFor(() => Boolean(button('Показать ещё')), 'кнопку подгрузки');
    // Подписи «Показано 100 из 187» под списком у mail.ru нет ни в каком виде
    expect(text()).not.toContain('Показано');
  });

  it('по нажатию догружает остальные 87 писем', async () => {
    const getMessages = serverPages();
    vi.spyOn(api, 'getMessages').mockImplementation(getMessages);
    render();
    await waitFor(() => Boolean(button('Показать ещё')), 'первую страницу');

    act(() => button('Показать ещё')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    // Догрузили всё — кнопки больше нет, а подпись выделения перестала
    // оговариваться числом загруженных
    await waitFor(() => !button('Показать ещё'), 'вторую страницу');

    // Вторая страница запрошена именно со смещением 100
    expect(getMessages.mock.calls.some(([q]) => q.offset === 100)).toBe(true);
  });

  it('пока загружено не всё, кнопка выделения говорит правду', async () => {
    vi.spyOn(api, 'getMessages').mockImplementation(serverPages());
    render();
    await waitFor(() => text().includes('Выделить загруженные (100 из 187)'), 'честную подпись');

    act(() => button('Показать ещё')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => !button('Показать ещё'), 'вторую страницу');
    expect(text()).toContain('Выделить все');
    expect(text()).not.toContain('Выделить загруженные');
  });
});

describe('ошибка загрузки списка', () => {
  it('объясняет причину без имени класса и даёт повторить', async () => {
    const getMessages = vi
      .spyOn(api, 'getMessages')
      .mockRejectedValueOnce(new ApiError(503, '/api/messages', 'Сервер недоступен'));
    render();
    await waitFor(() => text().includes('Не удалось загрузить письма'), 'сообщение об ошибке');
    expect(text()).not.toContain('ApiError');

    getMessages.mockImplementation(serverPages());
    act(() => button('Повторить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(
      () => text().includes('Выделить загруженные (100 из 187)'),
      'список после повтора',
    );
  });
});

describe('отказ мутации', () => {
  it('неудавшееся перемещение больше не пропадает молча', async () => {
    vi.spyOn(api, 'getMessages').mockImplementation(serverPages());
    vi.spyOn(api, 'moveMessages').mockRejectedValue(
      new ApiError(503, '/api/messages/move', 'Сервер недоступен'),
    );
    render();
    await waitFor(() => text().includes('Выделить загруженные (100 из 187)'), 'список');

    // выделяем письмо и жмём «Удалить» (это перемещение в корзину)
    act(() => useUiStore.getState().selectMany(['inbox:1']));
    await waitFor(() => Boolean(button('Удалить')), 'панель выделения');
    act(() => button('Удалить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await waitFor(() => text().includes('Не удалось переместить письма'), 'сообщение об отказе');
    expect(text()).toContain('Сервер не отвечает');
  });
});


/**
 * «Переслать как вложение» в меню над списком.
 *
 * Раньше пункт только писал в консоль браузера: человек нажимал и не
 * понимал, сработало или сломалось. Теперь он открывает окно написания
 * с приложенным письмом, а байты письма берёт сервер прямо из ящика —
 * поэтому наружу уходит идентификатор, а не тело.
 */
describe('переслать как вложение', () => {
  it('открывает окно написания с приложенным письмом', async () => {
    vi.spyOn(api, 'getMessages').mockImplementation(serverPages());
    render();
    await waitFor(() => Boolean(button('Показать ещё')), 'загруженный список');

    // Панель с этим пунктом появляется только над выделенными письмами
    act(() => useUiStore.getState().selectMany(['inbox:2']));
    const more = host.querySelector('button[aria-label="Ещё действия"]');
    act(() => more?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const item = button('Переслать как вложение');
    expect(item, 'пункт меню должен быть на месте').toBeTruthy();
    act(() => item?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const win = useUiStore.getState().composeWindows[0];
    expect(win, 'окно написания должно открыться').toBeTruthy();
    expect(win?.init.attachMessages).toEqual([{ id: 'inbox:2', label: 'Письмо 2' }]);
    // Тема — как у обычной пересылки, чтобы получатель понял, что это
    expect(win?.draft.subject).toBe('Fwd: Письмо 2');
    expect(win?.draft.attachedMessages).toHaveLength(1);
    // Выделение снимается: письмо уже отдано в окно написания
    expect(useUiStore.getState().selectedIds.size).toBe(0);
  });

  it('пачку писем прикладывает целиком, а тему называет их числом', async () => {
    vi.spyOn(api, 'getMessages').mockImplementation(serverPages());
    render();
    await waitFor(() => Boolean(button('Показать ещё')), 'загруженный список');

    act(() => useUiStore.getState().selectMany(['inbox:2', 'inbox:3']));
    const more = host.querySelector('button[aria-label="Ещё действия"]');
    act(() => more?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() =>
      button('Переслать как вложение')?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    const win = useUiStore.getState().composeWindows[0];
    expect(win?.draft.attachedMessages.map((m) => m.id)).toEqual(['inbox:2', 'inbox:3']);
    expect(win?.draft.subject).toBe('Fwd: 2 писем');
  });
});
