/**
 * Страница журнала на экране: цвет строк, порядок, живое обновление.
 *
 * Здесь нужен настоящий DOM: раскраска идёт классами, подпись уровня —
 * отдельным элементом, а живое обновление живёт в эффектах с таймером
 * и обработчиком видимости вкладки.
 *
 * На старом коде падает всё: страницы журналов не существовало.
 *
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_LEVELS, levelShort } from '../src/lib/logLevels';
import { autoRefreshKey } from '../src/lib/autoRefresh';
import { LogsPage } from '../src/pages/LogsPage';
import type { LogPage, LogSourcesResponse, LogTailPage } from '../src/api/types';

let container: HTMLDivElement;
let root: Root;

/** Строки, которые «сервер» отдаёт страницей: свежие сверху, как в API. */
const LINES: LogPage['items'] = [
  {
    offset: 400,
    level: 'error',
    at: '2026-08-05T20:30:03.000Z',
    component: 'smtp',
    queueId: '4c2w',
    text: '4c2w: to=<нет@example.org>, status=bounced (550 5.1.1 User unknown)',
  },
  {
    offset: 300,
    level: 'warn',
    at: '2026-08-05T20:30:02.000Z',
    component: 'smtp',
    queueId: '4c2x',
    text: '4c2x: to=<a@example.org>, status=deferred (Connection timed out)',
  },
  {
    offset: 200,
    level: 'info',
    at: '2026-08-05T20:30:01.000Z',
    component: 'lmtp',
    queueId: '4c2y',
    text: '4c2y: to=<user@mail.local>, status=sent (250 2.0.0 saved)',
  },
  {
    offset: 100,
    level: 'debug',
    at: '2026-08-05T20:30:00.000Z',
    component: 'imap',
    queueId: null,
    text: 'Debug: Effective uid=5000',
  },
];

const SOURCES: LogSourcesResponse = {
  dir: '/var/log/mail',
  levels: ['error', 'warn', 'info', 'debug'],
  items: [
    {
      source: 'postfix',
      fileName: 'postfix.log',
      present: true,
      sizeBytes: 24_150_709,
      modifiedAt: '2026-08-05T20:30:03.000Z',
      rotatedFiles: 2,
    },
    {
      source: 'dovecot',
      fileName: 'dovecot.log',
      present: true,
      sizeBytes: 1024,
      modifiedAt: null,
      rotatedFiles: 0,
    },
    { source: 'api', fileName: 'api.log', present: false, sizeBytes: 0, modifiedAt: null, rotatedFiles: 0 },
  ],
};

/** Запросы, которые страница успела сделать. */
let requested: string[] = [];
/** Что отдавать на дочитывание новых строк. */
let tailQueue: LogTailPage[] = [];

function page(items: LogPage['items'], nextBefore: number | null): LogPage {
  return {
    source: 'postfix',
    items,
    nextBefore,
    tailOffset: 500,
    fileId: '2049-777',
    sizeBytes: 24_150_709,
    rotated: false,
    budgetExhausted: false,
  };
}

function tail(items: LogPage['items'], nextAfter: number): LogTailPage {
  return {
    source: 'postfix',
    items,
    nextAfter,
    fileId: '2049-777',
    sizeBytes: 24_150_709,
    rotated: false,
    more: false,
  };
}

function mockFetch(pages: LogPage[]): void {
  let index = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    requested.push(url);
    let body: unknown;
    if (url.includes('/logs/sources')) body = SOURCES;
    else if (url.includes('/logs/new')) body = tailQueue.shift() ?? tail([], 500);
    else body = pages[Math.min(index++, pages.length - 1)];
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <LogsPage />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function rows(): HTMLElement[] {
  const list = container.querySelector('[role="log"]');
  return [...(list?.querySelectorAll('[class*="line_"]') ?? [])] as HTMLElement[];
}

beforeEach(() => {
  requested = [];
  tailQueue = [];
  globalThis.localStorage?.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('строки журнала раскрашены по уровню', () => {
  it('у каждого уровня свой класс и своя подпись словом', async () => {
    mockFetch([page(LINES, null)]);
    await render();

    for (const level of LOG_LEVELS) {
      const row = rows().find((node) => node.className.includes(`level_${level.id}`));
      expect(row, `на экране нет строки уровня «${level.title}»`).toBeDefined();
      expect(
        row!.textContent,
        `строка уровня «${level.title}» не подписана словом — цвет остался единственным признаком`,
      ).toContain(levelShort(level.id));
    }
  });

  it('цвет не единственный признак: у ошибки и события разные подписи', async () => {
    mockFetch([page(LINES, null)]);
    await render();
    expect(levelShort('error')).not.toBe(levelShort('info'));
    expect(container.textContent).toContain(levelShort('error'));
    expect(container.textContent).toContain(levelShort('info'));
  });

  it('текст строки показывается целиком, а не обрезком', async () => {
    mockFetch([page(LINES, null)]);
    await render();
    expect(container.textContent).toContain('550 5.1.1 User unknown');
    expect(container.textContent).toContain('Connection timed out');
  });
});

describe('порядок строк', () => {
  it('свежее — внизу, как в живом журнале', async () => {
    // Сервер отдаёт свежие сверху; на экране порядок обратный, потому что
    // новое приписывается снизу, а старое подгружается прокруткой вверх.
    mockFetch([page(LINES, null)]);
    await render();
    const texts = rows().map((r) => r.textContent ?? '');
    expect(texts[0]).toContain('Effective uid=5000');
    expect(texts[texts.length - 1]).toContain('550 5.1.1 User unknown');
  });
});

describe('автообновление', () => {
  it('по умолчанию выключено', async () => {
    // Список, который шевелится сам, — решение человека, а не наше за него.
    mockFetch([page(LINES, null)]);
    await render();
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box, 'на странице нет флажка автообновления').toBeTruthy();
    expect(box.checked).toBe(false);
  });

  it('выбор запоминается отдельно для каждого журнала', async () => {
    mockFetch([page(LINES, null)]);
    await render();
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      box.click();
    });
    expect(globalThis.localStorage.getItem(autoRefreshKey('logs:postfix'))).toBe('1');
    expect(globalThis.localStorage.getItem(autoRefreshKey('logs:dovecot'))).toBeNull();
  });

  it('включённое дочитывает новое отдельным запросом с курсором', async () => {
    // Не перечитыванием первой страницы: оно не отличает новое от уже
    // показанного и на быстром журнале теряет строки между опросами.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch([page(LINES, null)]);
    await render();

    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      box.click();
    });

    tailQueue = [
      tail(
        [
          {
            offset: 500,
            level: 'error',
            at: '2026-08-05T20:31:00.000Z',
            component: 'smtp',
            queueId: '4c30',
            text: '4c30: to=<нет@example.net>, status=bounced (550 5.1.1 совсем новая)',
          },
        ],
        620,
      ),
    ];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    await settle();

    const tailRequest = requested.find((url) => url.includes('/logs/new'));
    expect(tailRequest, 'страница не спросила новое').toBeDefined();
    expect(tailRequest, 'курсор не ушёл в запрос').toContain('after=500');
    expect(tailRequest, 'опознаватель файла не ушёл — проворот остался бы незамеченным').toContain(
      'fileId=',
    );
    expect(container.textContent).toContain('совсем новая');

    // Новая строка приписана СНИЗУ, а не воткнута сверху.
    const texts = rows().map((r) => r.textContent ?? '');
    expect(texts[texts.length - 1]).toContain('совсем новая');
  });

  it('отбор по уровню уходит в запрос нового: мимо фильтра ничего не появляется', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch([page(LINES, null)]);
    await render();

    const selects = [...container.querySelectorAll('select')];
    const levelSelect = selects[1] as HTMLSelectElement;
    await act(async () => {
      levelSelect.value = 'error';
      levelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();

    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      box.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });

    const tailRequest = requested.find((url) => url.includes('/logs/new'));
    expect(tailRequest).toContain('level=error');
  });

  it('выключённое автообновление сервер не опрашивает', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch([page(LINES, null)]);
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(requested.some((url) => url.includes('/logs/new'))).toBe(false);
  });

  it('на невидимой вкладке опрос молчит', async () => {
    // Забытая на сутки панель иначе молотила бы запросами тот же сервер,
    // что возит почту.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch([page(LINES, null)]);
    await render();
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      box.click();
    });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(requested.some((url) => url.includes('/logs/new'))).toBe(false);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(requested.some((url) => url.includes('/logs/new'))).toBe(true);
  });
});

describe('подгрузка старого', () => {
  it('первая страница просит журнал без курсора', async () => {
    mockFetch([page(LINES, 100)]);
    await render();
    const logsRequest = requested.find((url) => url.includes('/logs?'));
    expect(logsRequest, 'страница не запросила журнал').toBeDefined();
    expect(logsRequest).not.toContain('before=');
  });

  it('прокрутка к началу ленты просит следующую страницу по курсору', async () => {
    mockFetch([page(LINES, 100), page([], null)]);
    await render();

    const list = container.querySelector('[role="log"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await settle();

    const second = requested.filter((url) => url.includes('/logs?')).at(-1);
    expect(second, 'вторая страница не запрошена').toBeDefined();
    expect(second, 'курсор не ушёл в запрос — подгрузка вернула бы то же самое').toContain(
      'before=100',
    );
    // Опознаватель файла ловит проворот журнала между запросами: без него
    // смещение указало бы на чужую строку.
    expect(second).toContain('fileId=');
  });

  it('когда старее ничего нет, так и написано', async () => {
    mockFetch([page(LINES, null)]);
    await render();
    expect(container.textContent).toContain('Это начало текущего файла журнала');
  });
});

describe('что показано и откуда', () => {
  it('под лентой сказано, какой файл читается и насколько он велик', async () => {
    mockFetch([page(LINES, null)]);
    await render();
    expect(container.textContent).toContain('postfix.log');
    expect(container.textContent).toContain('Показано строк: 4');
  });

  it('про провёрнутые куски сказано прямо, а не умолчано', async () => {
    // Иначе «за позавчера ничего нет» читается как «позавчера ничего
    // не было», хотя это просто другой файл.
    mockFetch([page(LINES, null)]);
    await render();
    expect(container.textContent).toContain('провёрнутых кусков: 2');
  });
});
