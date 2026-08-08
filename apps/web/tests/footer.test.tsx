// @vitest-environment jsdom
/**
 * Нижняя строка состояния в каркасе почты.
 *
 * На старом коде падает каждая проверка файла: строки состояния не было
 * вовсе — ни занятого места, ни счётчиков, ни состояния связи. Отдельно
 * стоит отметить последнее: когда сервер приложения переставал отвечать,
 * почта просто переставала обновляться, и узнать об этом было НЕОТКУДА.
 *
 * Разметку смотрим в jsdom, правила для узкого экрана — в исходнике стилей
 * (медиазапросы jsdom не вычисляет), как в tests/responsiveLayout.test.tsx.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import type { Account, Folder } from '@mail-true/shared';
import { api } from '../src/api';
import { SILENCE_MS } from '../src/layout/FooterStatus';
import { SessionProvider } from '../src/app/session';
import { AppLayout } from '../src/layout/AppLayout';
import { useSilence } from '../src/layout/Footer';

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

const folders: Folder[] = [
  {
    id: 'inbox',
    path: 'INBOX',
    name: 'INBOX',
    role: 'inbox',
    parentId: null,
    depth: 0,
    unreadCount: 7,
    totalCount: 9,
    system: true,
    uidValidity: 1,
  },
  {
    id: 'sent',
    path: 'Sent',
    name: 'Sent',
    role: 'sent',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 2,
    system: true,
    uidValidity: 1,
  },
];

/** Профиль с квотой; `limit: 0` — то, что приходит без плагина quota. */
function account(usedBytes: number, limitBytes: number): Account {
  return {
    id: 'demo@mail.local',
    email: 'demo@mail.local',
    displayName: 'Демо',
    avatarUrl: null,
    quotaUsedBytes: usedBytes,
    quotaLimitBytes: limitBytes,
    signature: '',
    createdAt: null,
  };
}

interface StubOptions {
  quota?: [used: number, limit: number];
}

function stubApi(options: StubOptions = {}) {
  const [used, limit] = options.quota ?? [400 * 1024 ** 2, 8 * 1024 ** 3];
  vi.spyOn(api, 'getSession').mockResolvedValue({
    authenticated: true,
    email: 'demo@mail.local',
  } as Awaited<ReturnType<typeof api.getSession>>);
  vi.spyOn(api, 'getFolders').mockResolvedValue(folders);
  vi.spyOn(api, 'getAccount').mockResolvedValue(account(used, limit));
  vi.spyOn(api, 'getAiState').mockRejectedValue(new Error('помощник выключен'));
  // Живой подписки в проверках нет: сокет к серверу не относится к делу
  vi.spyOn(api, 'subscribe').mockReturnValue(() => undefined);
}

/** Отрисовать каркас на адресе папки и дождаться ответов заглушек. */
async function render(
  path = '/inbox/',
  seed?: (client: QueryClient) => void,
  /** Повторы отказов: как в бою (`shouldRetryQuery`), а не мгновенная сдача. */
  retry: boolean | number = false,
) {
  client = new QueryClient({
    defaultOptions: { queries: { retry, retryDelay: 10_000 } },
  });
  seed?.(client);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <SessionProvider>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path=":folderId" element={<div>список писем</div>} />
                <Route path="search" element={<div>поиск</div>} />
              </Route>
            </Routes>
          </SessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Дать очереди микрозадач разойтись: сессия, папки, профиль
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Дать разойтись не только микрозадачам, но и отложенным уведомлениям кэша.
 *
 * react-query шлёт их «следующей задачей» (setTimeout 0) — так он поступает
 * со ВСЕМИ своими подписками, и на то же самое подписана строка состояния:
 * иначе кэш дёргал бы её посреди отрисовки соседнего компонента (см.
 * Footer.tsx, useMailStatus). Задержка в бою — доли миллисекунды, а вот
 * проверке приходится её дожидаться явно.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const footer = (): HTMLElement | null => host.querySelector('footer[aria-label="Состояние почты"]');
const footerText = (): string => footer()?.textContent ?? '';
const refreshButton = (): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('footer button');

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  stubApi();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('что показывает строка состояния', () => {
  it('строка есть в каркасе и подписана для чтения с экрана', async () => {
    await render();
    expect(footer(), 'строки состояния нет в разметке').not.toBeNull();
  });

  it('счётчики берутся у ТЕКУЩЕЙ папки, а не у входящих всегда', async () => {
    await render('/inbox/');
    expect(footerText()).toContain('9 писем, 7 непрочитанных');

    await act(async () => root.unmount());
    root = createRoot(host);
    await render('/sent/');
    expect(footerText()).toContain('2 письма');
    expect(footerText(), 'у отправленных непрочитанных нет — их и не пишем').not.toContain(
      'непрочитанн',
    );
  });

  it('вне папки (поиск) счётчиков нет, а место и связь остаются', async () => {
    await render('/search');
    expect(footerText()).not.toMatch(/\d+ писем/u);
    expect(footerText()).toContain('Занято');
  });

  it('занятое место — словами привычных почтовых интерфейсов и шкалой с настоящей долей', async () => {
    await render();
    expect(footerText()).toContain('Занято 400 МБ из 8 ГБ');
    const meter = host.querySelector('footer [role="progressbar"]');
    expect(meter, 'шкалы занятого места нет').not.toBeNull();
    // 400 МБ из 8 ГБ — это 4,9%, а не «половина» и не «пусто»
    expect(meter!.getAttribute('aria-valuenow')).toBe('5');
    expect(meter!.getAttribute('aria-valuetext')).toBe('Занято 400 МБ из 8 ГБ');
  });

  it('без предела квоты о месте МОЛЧИМ, а не показываем «0 из 0»', async () => {
    vi.restoreAllMocks();
    stubApi({ quota: [0, 0] });
    await render();
    expect(footerText()).not.toContain('Занято');
    expect(host.querySelector('footer [role="progressbar"]')).toBeNull();
    // При этом остальная строка на месте — молчит только квота
    expect(footerText()).toContain('9 писем');
  });

  it('версия показывается, когда сервер её назвал', async () => {
    await render('/inbox/', (c) => c.setQueryData(['version'], { version: '1.4.2' }));
    expect(footerText()).toContain('v1.4.2');
  });

  it('сервер не назвал версию — пусто, а не «v» и не «0.0.0»', async () => {
    await render('/inbox/', (c) => c.setQueryData(['version'], { version: null }));
    expect(footerText()).not.toMatch(/v\d/u);
    expect(footerText()).not.toMatch(/0\.0\.0/u);
    // Остальная строка при этом на месте
    expect(footerText()).toContain('9 писем');
  });

  it('версии нет вовсе — строка молчит о ней', async () => {
    await render();
    expect(footerText(), 'версии неоткуда взяться — её и нет').not.toMatch(/v\d/u);
  });
});

/* ------------------------------------------------------------------ */
/* Обновление посреди чужой отрисовки                                  */
/* ------------------------------------------------------------------ */

/** Кнопка «открыть поиск»: переход, а не первая отрисовка страницы. */
function ToSearch(): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/search')}>
      {OPEN_SEARCH}
    </button>
  );
}

const OPEN_SEARCH = 'открыть поиск';

describe('строка состояния не обновляется посреди чужой отрисовки', () => {
  /*
   * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Строка состояния подписана на кэш запросов, а
   * кэш зовёт слушателей СИНХРОННО, прямо из того места, где его изменили.
   * Изменяют его в том числе во время отрисовки: `useQuery`/`useQueries`
   * заводят запись в кэше в теле рендера. Открытие поиска — ровно этот
   * случай: колонка фильтров и сохранённые запросы (SearchFacets,
   * SavedSearches) монтируются переходом и заводят свои записи, а строка
   * состояния — их сосед по каркасу. Голый слушатель обновлял её посреди
   * чужого рендера, и React честно ругался.
   *
   * Проверка идёт ПЕРЕХОДОМ, а не отрисовкой сразу на /search: при первой
   * отрисовке строка подписывается уже после того, как всё нарисовано, и
   * поймать нечего — на сломанном коде такая проверка зеленела бы.
   */
  it('открытие поиска не обновляет строку состояния из чужого рендера', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(' '));
    });

    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/inbox/']}>
            <SessionProvider>
              <Routes>
                <Route element={<AppLayout />}>
                  <Route path=":folderId" element={<ToSearch />} />
                  <Route path="search" element={<div>страница поиска</div>} />
                </Route>
              </Routes>
            </SessionProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    errors.length = 0;

    const open = [...host.querySelectorAll('button')].find((b) => b.textContent === OPEN_SEARCH);
    expect(open, 'кнопки перехода в поиск нет — проверять нечего').toBeDefined();
    await act(async () => {
      open!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    spy.mockRestore();
    expect(host.textContent, 'поиск не открылся — значит, проверка ничего не проверила').toContain(
      'страница поиска',
    );
    const renderPhase = errors.filter((line) => line.includes('while rendering a different'));
    expect(renderPhase, renderPhase.join('\n\n')).toEqual([]);
    // Строка состояния при этом на месте и жива
    expect(footer(), 'строка состояния пропала').not.toBeNull();
  });
});

describe('свежесть и обновление', () => {
  it('показано, когда список обновлялся, и есть чем обновить', async () => {
    await render();
    expect(footerText()).toMatch(/Обновлено/u);
    const button = refreshButton();
    expect(button, 'кнопки обновления нет').not.toBeNull();
    expect(button!.textContent).toContain('Обновить');
  });

  it('кнопка вправду перечитывает папки, а не только меняет подпись', async () => {
    await render();
    const before = vi.mocked(api.getFolders).mock.calls.length;
    await act(async () => {
      refreshButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(api.getFolders).mock.calls.length).toBeGreaterThan(before);
  });
});

describe('состояние связи', () => {
  it('сервер перестал отвечать — это видно внизу', async () => {
    await render();
    expect(footerText()).not.toContain('Сервер не отвечает');

    // Ровно то, что отдаёт nginx, когда контейнер api остановлен
    vi.mocked(api.getFolders).mockRejectedValue(
      Object.assign(new Error('Bad Gateway'), { status: 502 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey: ['folders'] });
    });
    await settle();

    expect(footerText(), 'отказ сервера остался незамеченным').toContain('Сервер не отвечает');
  });

  it('сервер ответил — тревога снимается сама', async () => {
    await render();
    vi.mocked(api.getFolders).mockRejectedValue(
      Object.assign(new Error('Bad Gateway'), { status: 502 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey: ['folders'] });
    });
    await settle();
    expect(footerText()).toContain('Сервер не отвечает');

    vi.mocked(api.getFolders).mockResolvedValue(folders);
    await act(async () => {
      await client.refetchQueries({ queryKey: ['folders'] });
    });
    await settle();
    expect(footerText()).not.toContain('Сервер не отвечает');
    expect(footerText()).toMatch(/Обновлено/u);
  });

  it('запрос завис без ответа — отказ виден сразу, «Обновление…» не врёт', async () => {
    /*
     * Ровно то, что наблюдалось на стенде при остановленном контейнере api:
     * nginx отвечает 502, react-query НЕ оседает в ошибку и держит запрос
     * «идущим» — на стенде это длилось 24 секунды и дальше. Всё это время
     * строка обязана говорить об отказе, а не обещать обновление.
     */
    // Повторы включены и разнесены во времени — ровно как в бою: попытка
    // отказала, ошибка ещё НЕ осела, запрос числится идущим
    await render('/inbox/', undefined, 2);
    expect(footerText()).toMatch(/Обновлено/u);

    vi.mocked(api.getFolders).mockRejectedValue(
      Object.assign(new Error('Bad Gateway'), { status: 502 }),
    );
    await act(async () => {
      refreshButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await settle();

    // Ошибка не осела: запрос ждёт повтора (retryDelay 10 с)
    const state = client.getQueryState(['folders']);
    expect(state?.error, 'ошибка осела — сценарий не тот, что на стенде').toBeNull();
    expect(state?.fetchFailureCount, 'попытка не отмечена').toBeGreaterThan(0);

    expect(footerText(), 'об отказе не сказано').toContain('Сервер не отвечает');
    expect(footerText(), '«Обновление…» — обещание, которого никто не выполнит').not.toContain(
      'Обновление…',
    );
    // Возраст показанных данных остаётся на виду: он и нужен человеку
    expect(footerText()).toMatch(/Обновлено/u);
  });

  it('пока сервера нет, кнопка «Обновить» ОСТАЁТСЯ доступной', async () => {
    /*
     * Найдено на живом стенде: пока контейнер api был остановлен,
     * react-query повторял запросы с растущей паузой, isFetching не
     * опускался в ноль десятками секунд — и кнопка, отключавшаяся
     * «на время запроса», была недоступна именно тогда, когда человеку
     * нужно попробовать ещё раз.
     */
    await render();
    let release: (() => void) | undefined;
    vi.mocked(api.getFolders).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          release = () => reject(Object.assign(new Error('Bad Gateway'), { status: 502 }));
        }),
    );
    // Пока запрос висит, кнопка обязана оставаться нажимаемой в любой миг
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        refreshButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
      expect(refreshButton()!.disabled, `шаг ${i}: кнопка повтора недоступна`).toBe(false);
    }
    // Состояние передаётся атрибутом, а не блокировкой кнопки
    expect(refreshButton()!.hasAttribute('aria-busy')).toBe(true);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
  });

  it('истёкшая сессия не выдаётся за потерю связи', async () => {
    await render();
    vi.mocked(api.getFolders).mockRejectedValue(
      Object.assign(new Error('Требуется вход'), { status: 401 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey: ['folders'] });
    });
    expect(footerText()).not.toContain('Сервер не отвечает');
  });

  it('об отказе связи сообщается вслух, а подпись времени — нет', async () => {
    await render();
    const live = host.querySelector('footer [aria-live="polite"]');
    expect(live, 'об отказе связи никто не узнает с экранного диктора').not.toBeNull();
    // Подпись «Обновлено N минут назад» меняется каждую минуту: попади она
    // в живую область, диктор читал бы её вслух до бесконечности
    expect(live!.textContent).not.toMatch(/Обновлено/u);
  });
});

describe('молчание сервера — тоже ответ', () => {
  /*
   * Главная находка стенда. Останавливаем контейнер api: запрос из браузера
   * НЕ ОТКАЗЫВАЕТ — он висит. `fetch('/api/folders')` не разрешился и не
   * отверг обещание за восемь секунд, состояние запроса в react-query
   * осталось нетронутым (fetchStatus "fetching", fetchFailureCount 0,
   * error null) двадцать четыре секунды и дальше. Значит, показ состояния
   * связи не имеет права опираться на отказы: их может не быть.
   *
   * Поведение во времени проверяется на самом наблюдателе, а не через
   * внутренности react-query: перевод часов на двенадцать секунд внутри
   * живого кэша запросов задевает и его собственные таймеры, и проверка
   * начинает измерять их, а не нас.
   */
  function Probe({ busy }: { busy: boolean }) {
    return <span data-testid="silence">{useSilence(busy) ? 'молчит' : 'отвечает'}</span>;
  }

  const state = (): string | null =>
    host.querySelector('[data-testid="silence"]')?.textContent ?? null;

  it('срабатывает ровно на пороге, а не раньше', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await act(async () => root.render(<Probe busy={true} />));
      expect(state(), 'тревога поднята сразу').toBe('отвечает');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SILENCE_MS - 1000);
      });
      expect(state(), 'тревога поднята до порога').toBe('отвечает');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(state(), 'молчание сервера осталось незамеченным').toBe('молчит');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ответ пришёл вовремя — тревоги не было и будильник снят', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await act(async () => root.render(<Probe busy={true} />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SILENCE_MS - 2000);
      });
      // Ответ пришёл: разговор кончился
      await act(async () => root.render(<Probe busy={false} />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SILENCE_MS * 2);
      });
      expect(state(), 'сработал снятый будильник').toBe('отвечает');
    } finally {
      vi.useRealTimers();
    }
  });

  it('после отказа новый разговор считает срок заново', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await act(async () => root.render(<Probe busy={true} />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SILENCE_MS + 500);
      });
      expect(state()).toBe('молчит');

      // Сервер ответил — тревога снимается
      await act(async () => root.render(<Probe busy={false} />));
      expect(state()).toBe('отвечает');

      // Новый разговор: срок отсчитывается сначала, а не «уже молчал»
      await act(async () => root.render(<Probe busy={true} />));
      expect(state()).toBe('отвечает');
    } finally {
      vi.useRealTimers();
    }
  });
});

/* --- Стили: высота, телефон, отключённые анимации ---------------------- */

const css = readFileSync(resolve(process.cwd(), 'src/layout/Footer.module.css'), 'utf8');
const layoutCss = readFileSync(resolve(process.cwd(), 'src/layout/AppLayout.module.css'), 'utf8');

/** Тело правила по селектору. */
function rule(source: string, selector: string): string {
  const at = source.indexOf(selector);
  expect(at, `нет правила ${selector}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', at);
  return source.slice(open + 1, source.indexOf('}', open));
}

/** Тело всех блоков @media (max-width: N) с N не больше предела. */
function narrowRules(source: string, upTo: number): string {
  let out = '';
  const media = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let found = media.exec(source);
  while (found) {
    let depth = 1;
    let i = media.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    if (Number(found[1]) <= upTo) out += source.slice(media.lastIndex, i);
    found = media.exec(source);
  }
  return out;
}

describe('строка не прыгает и не отбирает места сверх своего', () => {
  it('высота задана жёстко: чем бы строку ни наполнили, она одна', () => {
    const body = rule(css, '.footer {');
    expect(body).toMatch(/height:\s*28px/u);
    expect(body).toMatch(/min-height:\s*28px/u);
    // Перенос на вторую строку двигал бы весь список писем
    expect(body).toMatch(/white-space:\s*nowrap/u);
    // Строка не участвует в дележе высоты — её 28 точек неизменны
    expect(body).toMatch(/flex:\s*none/u);
  });

  it('цифры моноширинные — счётчики не дёргают соседей', () => {
    expect(rule(css, '.footer {')).toMatch(/font-variant-numeric:\s*tabular-nums/u);
  });

  it('страница получает разрешение подвинуться, а не выдавливает строку', () => {
    // .content с overflow:hidden; страницы объявляют height:100%
    expect(layoutCss).toMatch(/\.content\s*>\s*:not\(footer\)\s*\{[^}]*min-height:\s*0/u);
  });
});

describe('телефон и отключённые анимации', () => {
  it('на телефоне строки нет вовсе: внизу уже стоит навигация', () => {
    // display:none убирает её и из дерева доступности — visibility или
    // нулевая высота оставили бы невидимую строку диктору
    expect(narrowRules(css, 600)).toMatch(/\.footer\s*\{[^}]*display:\s*none/u);
  });

  it('нижняя навигация остаётся на своём месте и своей высоты', () => {
    // Полоса телефона — 56px, и строка состояния её не двигает
    const bottom = readFileSync(resolve(process.cwd(), 'src/layout/BottomNav.module.css'), 'utf8');
    expect(narrowRules(bottom, 600)).toMatch(/height:\s*calc\(56px/u);
  });

  it('с отключёнными анимациями ничего не крутится и не едет', () => {
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(reduced).toMatch(/\.spinning\s*\{[^}]*animation:\s*none/u);
    expect(reduced).toMatch(/\.meterFill\s*\{[^}]*transition:\s*none/u);
  });
});
