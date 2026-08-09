// @vitest-environment jsdom
/**
 * Три раздела владельца ящика в интерфейсе: «Вход и действия», «Выгрузка
 * ящика» и «Восстановление писем».
 *
 * Проверяется то, что ломается молча:
 *
 *   1. раздела, за которым на сервере ничего нет, в меню и на главной
 *      настроек НЕТ — «кнопка появляется вместе с поведением»;
 *   2. в режиме заглушек ни один из трёх не ходит в настоящий /api:
 *      без сессии тот отвечает 401, и общий обработчик увёл бы человека
 *      на экран входа из режима, где входа не предполагается;
 *   3. история входов по умолчанию не тонет в служебных подключениях
 *      самой почты, но и не прячет их насовсем;
 *   4. страница выгрузки не рисует долю выполнения, пока письма не
 *      сосчитаны, — полоска на нуле читается как «ничего не происходит».
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  formatBytes,
  formatLeft,
  isExportLive,
  ownerApi,
  plural,
  type AccessEvent,
  type AccessLogState,
  type ExportPageState,
  type RecoveryPageState,
} from '../src/settings/ownerApi';
import * as ownerQueries from '../src/settings/ownerQueries';
import { SettingsLayout } from '../src/settings/SettingsLayout';
import { AccessLogPage } from '../src/pages/settings/AccessLogPage';
import { ExportPage } from '../src/pages/settings/ExportPage';
import { RecoveryPage, restoreNote } from '../src/pages/settings/RecoveryPage';

/* ------------------------------------------------------------------ */
/* Заготовки состояний                                                  */
/* ------------------------------------------------------------------ */

function event(partial: Partial<AccessEvent>): AccessEvent {
  return {
    at: '2026-08-06T18:00:00.000Z',
    channel: 'web',
    success: true,
    ip: '203.0.113.7',
    where: 'интернет',
    userAgent: null,
    service: false,
    detail: 'Вход через веб-интерфейс',
    origin: 'app',
    ...partial,
  };
}

const ACCESS_ON: AccessLogState & { loading: boolean } = {
  available: true,
  reason: null,
  retentionDays: 90,
  items: [],
  hasMore: false,
  loading: false,
};

const EXPORT_ON: ExportPageState & { loading: boolean } = {
  available: true,
  reason: null,
  ttlHours: 48,
  jobs: [],
  loading: false,
};

const RECOVERY_ON: RecoveryPageState & { loading: boolean } = {
  available: true,
  reason: null,
  days: 7,
  maxDays: 30,
  scheduledPurge: true,
  items: [],
  totals: { count: 0, bytes: 0 },
  loading: false,
};

const OFF = { available: false, reason: 'Не применена миграция' } as const;

function stubSections(options: {
  access?: Partial<AccessLogState>;
  exports?: Partial<ExportPageState>;
  recovery?: Partial<RecoveryPageState>;
}) {
  vi.spyOn(ownerQueries, 'useAccessLog').mockReturnValue({
    ...ACCESS_ON,
    ...options.access,
  });
  vi.spyOn(ownerQueries, 'useExports').mockReturnValue({ ...EXPORT_ON, ...options.exports });
  vi.spyOn(ownerQueries, 'useRecovery').mockReturnValue({ ...RECOVERY_ON, ...options.recovery });
}

/* ------------------------------------------------------------------ */

let host: HTMLElement;
let root: Root;

function render(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Кнопка появляется вместе с поведением                                */
/* ------------------------------------------------------------------ */

describe('разделов, за которыми ничего нет, в меню нет', () => {
  it('все три пункта появляются, когда сервер сказал available', () => {
    stubSections({});
    render(<SettingsLayout />);
    expect(host.textContent).toContain('Вход и действия');
    expect(host.textContent).toContain('Выгрузка ящика');
    expect(host.textContent).toContain('Восстановление писем');
  });

  it('без применённой миграции пунктов не появляется ни одного', () => {
    stubSections({ access: OFF, exports: OFF, recovery: OFF });
    render(<SettingsLayout />);
    expect(host.textContent).not.toContain('Вход и действия');
    expect(host.textContent).not.toContain('Выгрузка ящика');
    expect(host.textContent).not.toContain('Восстановление писем');
  });

  it('разделы независимы: одна миграция из трёх включает один пункт', () => {
    // Миграции применяют по одной, и раздел, у которого таблица уже есть,
    // обязан работать, не дожидаясь двух остальных.
    stubSections({ exports: OFF, recovery: OFF });
    render(<SettingsLayout />);
    expect(host.textContent).toContain('Вход и действия');
    expect(host.textContent).not.toContain('Выгрузка ящика');
  });
});

/* ------------------------------------------------------------------ */
/* Режим заглушек                                                       */
/* ------------------------------------------------------------------ */

describe('на заглушечных данных запроса на сервер нет', () => {
  it('все три раздела отвечают «недоступно» и не трогают fetch', async () => {
    // Признак режима вычисляется один раз при загрузке модуля, поэтому
    // подменяется он, а не переменная окружения.
    vi.resetModules();
    vi.doMock('../src/api/mockFlag', () => ({ useMocks: true }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const mocked = await import('../src/settings/ownerApi');

    const access = await mocked.ownerApi.getAccessLog();
    const exports = await mocked.ownerApi.getExports();
    const recovery = await mocked.ownerApi.getRecovery();

    expect(access.available).toBe(false);
    expect(exports.available).toBe(false);
    expect(recovery.available).toBe(false);
    // Причина названа словами: пустой раздел без объяснения выглядит поломкой.
    expect(access.reason).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.doUnmock('../src/api/mockFlag');
    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

/* ------------------------------------------------------------------ */
/* История входов                                                       */
/* ------------------------------------------------------------------ */

describe('история входов', () => {
  it('служебные подключения свёрнуты, но их число названо', () => {
    stubSections({
      access: {
        items: [
          event({ detail: 'Вход через веб-интерфейс' }),
          event({ service: true, channel: 'imap', detail: 'Служебное подключение веб-интерфейса' }),
          event({ service: true, channel: 'imap', detail: 'Служебное подключение веб-интерфейса' }),
        ],
      },
    });
    render(<AccessLogPage />);
    expect(host.textContent).toContain('Вход через веб-интерфейс');
    // Сами строки свёрнуты…
    expect(host.textContent).not.toContain('Служебное подключение веб-интерфейса');
    // …но человек знает, что они есть, и может их раскрыть.
    expect(host.textContent).toContain('Показывать служебные подключения самой почты (2)');
  });

  it('неудачные попытки входа названы отдельно и заметно', () => {
    stubSections({
      access: {
        items: [event({ success: false, detail: 'Неудачная попытка входа через веб-интерфейс' })],
      },
    });
    render(<AccessLogPage />);
    expect(host.textContent).toContain('Неудачных попыток входа: 1');
  });

  it('раздел, выключенный сервером, объясняет причину', () => {
    stubSections({ access: { ...OFF, items: [] } });
    render(<AccessLogPage />);
    expect(host.textContent).toContain('Не применена миграция');
  });
});

/* ------------------------------------------------------------------ */
/* Выгрузка ящика                                                       */
/* ------------------------------------------------------------------ */

function job(partial: Partial<ExportPageState['jobs'][number]>) {
  return {
    id: 1,
    state: 'running' as const,
    includeSpam: false,
    includeTrash: false,
    totalMessages: 0,
    doneMessages: 0,
    doneBytes: 0,
    skipped: 0,
    fileBytes: 0,
    error: null,
    createdAt: '2026-08-06T18:00:00.000Z',
    finishedAt: null,
    expiresAt: null,
    ...partial,
  };
}

describe('выгрузка ящика', () => {
  it('пока письма не сосчитаны, доля не обещается', () => {
    stubSections({ exports: { jobs: [job({ totalMessages: 0 })] } });
    render(<ExportPage />);
    expect(host.textContent).toContain('Считаем письма в папках');
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
  });

  it('ход работы показан числами, а не одной полоской', () => {
    // Полоска на 40% ничего не говорит человеку с 60 тысячами писем.
    stubSections({
      exports: { jobs: [job({ totalMessages: 60412, doneMessages: 24130, doneBytes: 1024 })] },
    });
    render(<ExportPage />);
    // Разделитель разрядов у русской локали — НЕразрывный пробел; сверяем
    // по обычному, иначе проверка ловила бы форматирование, а не числа.
    const text = (host.textContent ?? '').replace(/\u00A0/gu, ' ');
    expect(text).toContain('60 412');
    expect(text).toContain('24 130');
  });

  it('готовый архив предлагается ссылкой, а не запросом из кода', () => {
    // Файл бывает на гигабайты: скачивание через fetch держало бы его
    // целиком в памяти вкладки.
    stubSections({
      exports: {
        jobs: [
          job({
            state: 'ready',
            totalMessages: 10,
            doneMessages: 10,
            fileBytes: 2048,
            expiresAt: '2026-08-08T18:00:00.000Z',
          }),
        ],
      },
    });
    render(<ExportPage />);
    const link = host.querySelector('a[download]');
    expect(link?.getAttribute('href')).toBe(ownerApi.exportFileUrl(1));
  });

  it('пока идёт задание, заказать второе нельзя', () => {
    stubSections({ exports: { jobs: [job({ state: 'queued' })] } });
    render(<ExportPage />);
    expect(host.textContent).not.toContain('Выгрузить ящик');
    expect(host.textContent).toContain('Отменить');
  });

  /*
   * Готовый архив, в который вошла НЕ вся почта.
   *
   * Сервер теперь кладёт в задание оговорку: какие папки прочитать не
   * удалось и остановился ли архив на потолке размера. Показывать её
   * обязательно — «Готово» и полная полоска читаются как «вся почта у
   * вас», и без этой строки человек уносит неполный архив, не зная об
   * этом. Раньше поле `error` показывалось только у сорвавшегося задания.
   */
  it('о неполном архиве сказано рядом с кнопкой «Скачать»', () => {
    stubSections({
      exports: {
        jobs: [
          job({
            state: 'ready',
            totalMessages: 10,
            doneMessages: 8,
            fileBytes: 2048,
            error: 'Не удалось прочитать 1 папку (Договоры) — их писем в архиве нет.',
          }),
        ],
      },
    });
    render(<ExportPage />);
    expect(host.textContent).toContain('Договоры');
    // И архив при этом остаётся скачиваемым: он собран и он лучшее, что есть.
    expect(host.querySelector('a[download]')).not.toBeNull();
  });

  it('живым считается только незаконченное задание', () => {
    expect(isExportLive(job({ state: 'queued' }))).toBe(true);
    expect(isExportLive(job({ state: 'running' }))).toBe(true);
    expect(isExportLive(job({ state: 'ready' }))).toBe(false);
    expect(isExportLive(job({ state: 'failed' }))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Восстановление писем                                                 */
/* ------------------------------------------------------------------ */

describe('восстановление писем', () => {
  it('занятое место названо числом — за ним сюда и приходят', () => {
    stubSections({ recovery: { totals: { count: 3, bytes: 5 * 1024 * 1024 } } });
    render(<RecoveryPage />);
    expect(host.textContent).toContain('5,0 МБ');
    expect(host.textContent).toContain('Удалить всё сейчас');
  });

  it('без служебного доступа к хранилищу человека предупреждают', () => {
    // Хранение при этом работает, а удалять по сроку будет некому —
    // ящик тихо забьётся, и узнать об этом надо заранее.
    stubSections({ recovery: { scheduledPurge: false } });
    render(<RecoveryPage />);
    expect(host.textContent).toContain('не может удалять письма по сроку');
  });

  /*
   * Возврат может вернуть не всё, и об этом надо сказать числом.
   *
   * Сервер считает потери с самого начала (`missing` — письма уже нет в
   * ящике, `failed` — почтовый сервер отказал), а экран результат мутации
   * не читал вовсе: список просто становился короче. Выбрал сорок,
   * вернулось двенадцать — ни числа, ни предупреждения.
   */
  it('о письмах, которые не вернулись, сказано числом', () => {
    expect(restoreNote(40, { restored: 12, missing: 27, failed: 1 })).toBe(
      'Вернулось в корзину 12 писем из 40: 27 писем уже нет в ящике; ' +
        '1 письмо не отдал почтовый сервер — попробуйте ещё раз.',
    );
  });

  it('когда вернулось всё, лишних слов нет', () => {
    // Короткий список и есть подтверждение: сообщение «всё хорошо»
    // после каждого действия человек перестаёт читать через день.
    expect(restoreNote(3, { restored: 3, missing: 0, failed: 0 })).toBeNull();
  });

  it('потолок сервера ограничивает выбор сроков, а не только запрос', () => {
    stubSections({ recovery: { maxDays: 7 } });
    render(<RecoveryPage />);
    const values = [...host.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    expect(values).toEqual(['0', '1', '3', '7']);
  });
});

/* ------------------------------------------------------------------ */
/* Показ значений                                                       */
/* ------------------------------------------------------------------ */

describe('числа по-русски', () => {
  it('размер округляется так, как его читают', () => {
    expect(formatBytes(0)).toBe('0 Б');
    expect(formatBytes(1536)).toBe('2 КБ');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5,0 МБ');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3,0 ГБ');
  });

  it('склонение считается, а не подставляется наугад', () => {
    expect(plural(1, 'день', 'дня', 'дней')).toBe('день');
    expect(plural(2, 'день', 'дня', 'дней')).toBe('дня');
    expect(plural(5, 'день', 'дня', 'дней')).toBe('дней');
    expect(plural(11, 'день', 'дня', 'дней')).toBe('дней');
    expect(plural(21, 'день', 'дня', 'дней')).toBe('день');
  });

  it('остаток срока не обещает точности, которой нет', () => {
    const now = Date.parse('2026-08-06T12:00:00.000Z');
    expect(formatLeft('2026-08-13T12:00:00.000Z', now)).toBe('7 дней');
    expect(formatLeft('2026-08-06T15:00:00.000Z', now)).toBe('3 часа');
    expect(formatLeft('2026-08-06T11:00:00.000Z', now)).toBe('вот-вот');
    // Срок хранения архива — 48 часов. «Через 1 день» здесь звучало бы
    // вдвое тревожнее правды, поэтому до двух суток считаем часами.
    expect(formatLeft('2026-08-08T11:00:00.000Z', now)).toBe('47 часов');
  });
});
