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
    const items = Array.from({ length: Math.min(query.limit, TOTAL - query.offset) }, (_, i) =>
      summary(query.offset + i + 1),
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
    // Подписи «Показано 100 из 187» под списком в привычных почтовых интерфейсах нет ни в каком виде
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
    // Причина — словами сервера: 5xx с человеческим текстом больше не
    // подменяется общей заглушкой (см. tests/serverErrorText.test.ts).
    expect(text()).toContain('Сервер недоступен');
  });
});

/**
 * Перетаскивание письма в папку.
 *
 * Строка списка представляет ПЕРЕПИСКУ, а не письмо: под ней может лежать
 * шесть писем. Все действия панели раскрывают её перед отправкой на
 * сервер — перетаскивание клало в буфер идентификаторы строк как есть.
 * В папку переезжало одно последнее письмо из шести, а строка исчезала из
 * списка целиком: человек видел переехавшую переписку, у которой пять
 * писем остались во «Входящих».
 */
describe('перетаскивание в папку', () => {
  it('в буфер кладутся все письма переписки, а не одна строка', async () => {
    vi.spyOn(api, 'getMessages').mockImplementation(
      vi.fn(async () => ({
        items: [
          {
            ...summary(9),
            thread: {
              messageIds: ['inbox:1', 'inbox:4', 'inbox:9'],
              count: 3,
              unreadCount: 0,
              flagged: false,
              hasAttachments: false,
              labels: [],
              participants: [{ name: 'Иван', address: 'ivan@example.com' }],
            },
          } as MessageSummary,
        ],
        total: 1,
        offset: 0,
        limit: 100,
      })),
    );
    /*
     * Виртуализация меряет окно списка через offsetHeight, а в jsdom он
     * всегда ноль — без этой подпорки не отрисовалось бы ни одной строки
     * (тот же приём в keyboardAccess.test.tsx).
     */
    for (const [prop, value] of [
      ['offsetHeight', 600],
      ['offsetWidth', 900],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value });
    }

    render();
    await waitFor(
      () => host.querySelectorAll('a[draggable="true"]').length > 0,
      'строка списка с перепиской',
    );

    const row = host.querySelector('a[draggable="true"]') as HTMLElement | null;
    expect(row, 'строка списка должна быть перетаскиваемой').toBeTruthy();

    const stored = new Map<string, string>();
    const transfer = {
      setData: (format: string, value: string) => void stored.set(format, value),
      getData: (format: string) => stored.get(format) ?? '',
      get types() {
        return [...stored.keys()];
      },
      effectAllowed: 'none',
    } as unknown as DataTransfer;

    const event = new Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    act(() => void row!.dispatchEvent(event));

    const payload = JSON.parse(stored.get('application/x-mail-true-ids') ?? '[]') as string[];
    expect(payload).toEqual(['inbox:1', 'inbox:4', 'inbox:9']);
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
describe('обычная пересылка', () => {
  it('доносит вложения исходного письма, а не бросает их', async () => {
    /*
     * «Переслать» собирало только тему и цитату тела. Вложения молча
     * отбрасывались: человек открывал письмо со счётом, нажимал
     * «Переслать», писал «см. вложение» и отправлял — получатель получал
     * письмо без файла. Ни предупреждения, ни следа.
     */
    vi.spyOn(api, 'getMessages').mockImplementation(serverPages());
    vi.spyOn(api, 'getMessage').mockResolvedValue({
      ...summary(2),
      bodyHtml: '<p>во вложении счёт</p>',
      bodyText: 'во вложении счёт',
      attachments: [
        {
          partId: '2',
          filename: 'счёт.pdf',
          mimeType: 'application/pdf',
          size: 1024,
          contentId: null,
          inline: false,
        },
        // Встроенная картинка не переносится: она уже внутри цитаты, и
        // вторая копия приехала бы отдельным файлом image001.png.
        {
          partId: '3',
          filename: 'image001.png',
          mimeType: 'image/png',
          size: 512,
          contentId: '<img1>',
          inline: true,
        },
      ],
      headers: {},
    } as never);
    const getPart = vi
      .spyOn(api, 'getMessagePart')
      .mockResolvedValue(new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
    const upload = vi.spyOn(api, 'uploadAttachment').mockResolvedValue({
      id: 'up-1',
      filename: 'счёт.pdf',
      size: 1024,
      mimeType: 'application/pdf',
    } as never);

    render();
    await waitFor(() => Boolean(button('Показать ещё')), 'загруженный список');

    // Пересылка из списка вызывается клавишей F — кнопки в панели нет.
    act(() => useUiStore.getState().selectMany(['inbox:2']));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    });

    await waitFor(
      () => (useUiStore.getState().composeWindows[0]?.draft.attachments.length ?? 0) > 0,
      'вложение должно доехать в окно написания',
    );

    const win = useUiStore.getState().composeWindows[0];
    expect(win?.draft.attachments.map((a) => a.filename)).toEqual(['счёт.pdf']);
    // Скачиваем и загружаем ровно одну часть: встроенную картинку не трогаем.
    expect(getPart).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

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

/* ------------------------------------------------------------------ */
/* Выделение и правая кнопка                                           */
/* ------------------------------------------------------------------ */

/**
 * Виртуализация меряет окно списка через offsetHeight, а в jsdom он всегда
 * ноль — без этой подпорки не отрисовалось бы ни одной строки.
 */
function stubLayout(): void {
  for (const [prop, value] of [
    ['offsetHeight', 600],
    ['offsetWidth', 900],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value });
  }
}

const rowsInList = () => [...host.querySelectorAll<HTMLElement>('a[draggable="true"]')];
const rowFor = (id: string) =>
  rowsInList().find((a) => a.getAttribute('href') === `/inbox/${encodeURIComponent(id)}`);

describe('правый щелчок мимо выделения', () => {
  it('не сбрасывает набранные галочки', async () => {
    /*
     * Комментарий над обработчиком обещал: «Щелчок по НЕвыделенной строке
     * выделение не трогает». Строкой ниже стоял `clearSelection()` —
     * человек набирал два десятка галочек, чуть промахивался правой
     * кнопкой мимо выделения и терял весь набор.
     */
    vi.spyOn(api, 'getMessages').mockImplementation(serverPages());
    stubLayout();
    render();
    await waitFor(() => rowsInList().length > 0, 'строки списка');

    act(() => useUiStore.getState().selectMany(['inbox:1', 'inbox:2']));
    const other = rowFor('inbox:3');
    expect(other, 'строка, по которой щёлкают, должна быть на экране').toBeTruthy();
    act(
      () =>
        void other!.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
        ),
    );

    expect(useUiStore.getState().selectedIds.size, 'галочки обязаны остаться').toBe(2);
    expect(host.querySelector('[role="menu"]'), 'меню должно открыться').toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* Погашенные строки уезжающих писем                                   */
/* ------------------------------------------------------------------ */

describe('строки уезжающих писем', () => {
  it('второе удаление не зажигает первую строку обратно', async () => {
    /*
     * Список уезжающих ЗАМЕНЯЛСЯ, а не дополнялся: удалил письмо A, тут же
     * удалил B — строка A переставала быть погашенной и снова выглядела
     * живой. Человек удалял её второй раз.
     */
    vi.spyOn(api, 'getMessages').mockImplementation(serverPages());
    // Ответа сервера ждём вечно: строки гаснут сразу, не дожидаясь его
    vi.spyOn(api, 'moveMessages').mockImplementation(() => new Promise(() => undefined));
    stubLayout();
    render();
    await waitFor(() => rowsInList().length > 0, 'строки списка');

    const leaving = () =>
      rowsInList()
        .filter((a) => a.getAttribute('aria-hidden') === 'true')
        .map((a) => a.getAttribute('href'));

    const deleteSelected = async () => {
      await waitFor(() => Boolean(button('Удалить')), 'панель выделения');
      act(() => void button('Удалить')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    };

    act(() => useUiStore.getState().selectMany(['inbox:1']));
    await deleteSelected();
    await waitFor(() => leaving().length === 1, 'первая строка погасла');

    act(() => useUiStore.getState().selectMany(['inbox:2']));
    await deleteSelected();
    await waitFor(() => leaving().length === 2, 'обе строки погашены');

    expect(leaving()).toEqual(['/inbox/inbox%3A1', '/inbox/inbox%3A2']);
  });
});
