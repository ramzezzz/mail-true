/**
 * Дашборд: честность чисел, раздельная загрузка и автообновление.
 *
 * Проверяется не «нарисовался ли график», а правила, ради которых панель
 * наблюдения вообще имеет смысл:
 *
 *   1. НЕДОСТУПНОЕ НАЗЫВАЕТСЯ НЕДОСТУПНЫМ. Сервер приложения живёт в
 *      контейнере и часть показателей увидеть не может. Ноль вместо
 *      «не измеряли» выглядит как исправный сервер — это худшая ошибка,
 *      какую может сделать панель наблюдения.
 *   2. У КАЖДОГО ЧИСЛА НАПИСАН ИСТОЧНИК. Иначе «занято 42 %» не отвечает
 *      на вопрос «чего именно и по чьим данным».
 *   3. РАЗДЕЛЫ ГРУЗЯТСЯ ПОРОЗНЬ. Сертификаты читаются из живых соединений
 *      с таймаутом; ждать их показу загрузки процессора нельзя.
 *   4. АВТООБНОВЛЕНИЕ — ПО ФЛАЖКУ, С ПАМЯТЬЮ, И ТОЛЬКО НА ВИДИМОЙ ВКЛАДКЕ.
 *      Ровно как в «Почтовом потоке» и «Журналах почты».
 *
 * На старом коде падают все проверки этого файла: дашборд состоял из
 * плиток со счётчиками, ни ресурсов, ни истории, ни графиков не было.
 *
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoRefreshKey } from '../src/lib/autoRefresh';
import { OverviewPage } from '../src/pages/OverviewPage';

let container: HTMLElement;
let root: Root;
let requested: string[] = [];

/** Что отвечать на /overview/resources. Меняется по ходу проверок. */
let resourcesBody: Record<string, unknown>;
let historyBody: Record<string, unknown>;

const SUMMARY = {
  healthy: true,
  problems: [],
  services: [{ id: 'postgres', title: 'База данных', state: 'ok', detail: 'Отвечает' }],
  counters: {
    domains: 1,
    users: 11,
    usersActive: 10,
    usersBlocked: 1,
    aliases: 3,
    admins: 2,
    quotaTotal: 11_811_160_064,
    auditToday: 4,
    impersonations7d: 1,
  },
  domains: [],
  recentAudit: [],
};

const NO_QUEUE_NOTE =
  'Очередь недоступна: не настроен посредник к Postfix (QUEUE_AGENT_TOKEN). ' +
  'Сокет Docker вместо него мы не подключаем — это права root на всей машине';

const NO_SPOOL_NOTE =
  'Недоступно: каталог /var/spool/postfix в контейнер api не смонтирован. ' +
  'Его объём на диске дал бы только сокет Docker, а это права root на всей ' +
  'машине — подключать его мы не будем.';

function defaultResources(): Record<string, unknown> {
  return {
    takenAt: '2026-08-06T02:00:00.000Z',
    intervalSeconds: 60,
    cpu: {
      nodePercent: { value: 12.5, source: '/proc/stat (весь узел)' },
      apiPercent: { value: 3.25, source: '/sys/fs/cgroup/cpu.stat (контейнер api)' },
      cores: { value: 8, source: '/proc/stat' },
      apiLimit: { value: null, source: '/sys/fs/cgroup/cpu.max: предел не задан' },
      load1: { value: 0.56, source: '/proc/loadavg (весь узел)' },
    },
    memory: {
      total: { value: 33_538_760_704, source: '/proc/meminfo (весь узел)' },
      used: { value: 2_357_198_848, source: '/proc/meminfo: MemTotal − MemAvailable' },
      api: { value: 146_989_056, source: '/sys/fs/cgroup/memory.current (контейнер api)' },
      apiLimit: { value: null, source: '/sys/fs/cgroup/memory.max: предел не задан' },
    },
    volumes: [
      {
        path: '/var/mail/vhosts',
        device: 2049,
        totalBytes: 1_081_101_176_832,
        freeBytes: 1_015_112_499_200,
        usedBytes: 11_059_527_680,
      },
    ],
    singleDevice: true,
    slices: [
      { id: 'vmail', title: 'Письма', bytes: 38_700_000, source: 'Учёт квоты Dovecot' },
      { id: 'mailindex', title: 'Поисковые индексы', bytes: 157_600_000, source: 'Обход каталога' },
      { id: 'queue', title: 'Очередь Postfix', bytes: null, source: NO_SPOOL_NOTE },
    ],
    queue: {
      available: true,
      total: 7,
      deferred: 5,
      oldestSeconds: 8040,
      topDeferredDomains: [{ domain: 'example.org', count: 4 }],
      note: 'Посредник в контейнере postfix (postqueue -j)',
    },
    unavailable: [
      'Загрузка процессора и памяти отдельными службами (postfix, dovecot, postgres, ' +
        'rspamd): их cgroup серверу приложения не видны.',
    ],
  };
}

function defaultHistory(): Record<string, unknown> {
  return {
    available: true,
    note: 'Снимки раз в 60 с, усреднены по 60 с',
    hours: 24,
    stepSeconds: 60,
    // Пять точек с дырой посередине: по два измерения с каждой стороны,
    // то есть по СПЛОШНОМУ куску линии слева и справа от пропуска. Куски
    // по одной точке рисуются кружками, и разрыв линии на них не проверить.
    points: [
      point('2026-08-06T01:00:00.000Z', 10, 30),
      point('2026-08-06T01:15:00.000Z', 11, 31),
      gap('2026-08-06T01:30:00.000Z'),
      point('2026-08-06T01:45:00.000Z', 13, 31),
      point('2026-08-06T02:00:00.000Z', 14, 32),
    ],
  };
}

function point(at: string, cpu: number, mem: number): Record<string, unknown> {
  return {
    at,
    cpuNodePercent: cpu,
    cpuApiPercent: cpu / 4,
    load1: cpu / 20,
    memUsedPercent: mem,
    diskUsedPercent: 6,
    memApiBytes: 147_000_000,
    vmailBytes: 38_700_000,
    dbBytes: 21_000_000,
    queueTotal: 7,
    queueDeferred: 5,
    queueOldestSeconds: 8040,
  };
}

/** Дыра в наблюдении: сервер приложения перезапускался. */
function gap(at: string): Record<string, unknown> {
  return {
    at,
    cpuNodePercent: null,
    cpuApiPercent: null,
    load1: null,
    memUsedPercent: null,
    diskUsedPercent: null,
    memApiBytes: null,
    vmailBytes: null,
    dbBytes: null,
    queueTotal: null,
    queueDeferred: null,
    queueOldestSeconds: null,
  };
}

const MAIL = {
  hours: 24,
  stepSeconds: 300,
  buckets: [
    { at: '2026-08-06T01:00:00.000Z', counts: { sent: 12, deferred: 2 } },
    { at: '2026-08-06T02:00:00.000Z', counts: { sent: 27, bounced: 1 } },
  ],
  totals: { sent: 39, deferred: 2, bounced: 1, rejected: 6 },
  byDirection: { in: 30, out: 12 },
  spamRejected: 5,
  spamNote: 'Отдельного поля «спам» в журнале Postfix нет',
  rejectReasons: [{ reason: 'Gtube pattern', count: 5 }],
  deferReasons: [{ reason: 'connect to IP:25: Connection refused', count: 2 }],
  sizes: {
    messages: 40,
    totalBytes: 4_000_000,
    avgBytes: 100_000,
    medianBytes: 12_000,
    maxBytes: 2_000_000,
  },
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hour === 14 ? 20 : 1 })),
  historyStartsAt: '2026-08-05T18:57:28.000Z',
  historyEndsAt: '2026-08-06T02:00:00.000Z',
  mailboxesTotal: 11,
  mailboxesActive: 4,
  activityNote: '«Активен» значит «за окно был хотя бы один конверт»',
};

const USERS = {
  hours: 24,
  sort: 'totalMessages',
  limit: 25,
  offset: 0,
  total: 2,
  items: [
    {
      id: 1,
      email: 'test@mail.local',
      active: true,
      quotaBytes: 1_073_741_824,
      sentMessages: 12,
      sentBytes: 240_000,
      receivedMessages: 30,
      receivedBytes: 900_000,
    },
    {
      id: 2,
      email: 'other@mail.local',
      active: false,
      quotaBytes: 1_073_741_824,
      sentMessages: 0,
      sentBytes: 0,
      receivedMessages: 0,
      receivedBytes: 0,
    },
  ],
};

const MAILBOXES = {
  available: true,
  note: 'Учёт квоты Dovecot (maildirsize)',
  takenAt: '2026-08-06T02:00:00.000Z',
  totalBytes: 38_700_000,
  withoutAccounting: 1,
  total: 2,
  items: [
    {
      email: 'test@mail.local',
      bytes: 1_020_000_000,
      messages: 656,
      quotaBytes: 1_073_741_824,
      usedPercent: 95,
      active: true,
      known: true,
    },
    {
      email: 'other@mail.local',
      bytes: 0,
      messages: 0,
      quotaBytes: 1_073_741_824,
      usedPercent: 0,
      active: true,
      known: true,
    },
  ],
};

const SECURITY = {
  warnDays: 21,
  certificateNote: 'Сертификат читается из живого соединения со службой, а не из файла',
  certificates: [
    {
      title: 'Отправка почты (SMTPS 465)',
      host: 'postfix',
      port: 465,
      available: true,
      subject: 'mail.local',
      issuer: 'mail.local',
      validFrom: '2026-08-01T00:00:00.000Z',
      validTo: '2026-08-20T00:00:00.000Z',
      daysLeft: 14,
      selfSigned: true,
      names: ['mail.local'],
      error: null,
    },
  ],
  domains: [
    {
      id: 1,
      name: 'mail.local',
      dnsOverall: 'warn',
      dnsCheckedAt: '2026-08-05T20:00:00.000Z',
      dkimSelector: 'mail',
      dkimConfigured: true,
    },
  ],
};

function mockFetch(): void {
  vi.stubGlobal('fetch', async (url: string) => {
    requested.push(url);
    let body: unknown = {};
    if (url.includes('/overview/resources')) body = resourcesBody;
    else if (url.includes('/overview/history')) body = historyBody;
    // Разбор идёт от ДЛИННОГО пути к короткому: «/overview/mailboxes»
    // содержит в себе «/overview/mail», и при обратном порядке таблица
    // занятости ящиков молча получала бы ответ почтового раздела.
    else if (url.includes('/overview/mailboxes')) body = MAILBOXES;
    else if (url.includes('/overview/mail')) body = MAIL;
    else if (url.includes('/overview/users')) body = USERS;
    else if (url.includes('/overview/security')) body = SECURITY;
    else if (url.includes('/overview')) body = SUMMARY;
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function open(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <OverviewPage />
      </QueryClientProvider>,
    );
  });
  await settle();
}

const text = (): string => container.textContent ?? '';

function autoCheckbox(): HTMLInputElement {
  const box = [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('Автообновление'))
    ?.querySelector('input');
  expect(box, 'на дашборде нет флажка автообновления').toBeTruthy();
  return box as HTMLInputElement;
}

beforeEach(() => {
  requested = [];
  resourcesBody = defaultResources();
  historyBody = defaultHistory();
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  container = document.createElement('main');
  document.body.append(container);
  root = createRoot(container);
  mockFetch();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */

describe('дашборд грузит разделы порознь', () => {
  it('шесть запросов вместо одного: медленный раздел не держит остальные', async () => {
    await open();
    for (const path of [
      '/overview/resources',
      '/overview/history',
      '/overview/mail',
      '/overview/users',
      '/overview/mailboxes',
      '/overview/security',
    ]) {
      expect(
        requested.some((url) => url.includes(path)),
        `нет запроса ${path}`,
      ).toBe(true);
    }
  });

  it('окно времени уходит на сервер, а не режется в браузере', async () => {
    // Резать окно на клиенте значило бы тянуть всю историю ради часа.
    await open();
    expect(requested.some((url) => url.includes('/overview/history?hours=24'))).toBe(true);

    const weekButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'неделя',
    );
    await act(async () => weekButton?.click());
    await settle();
    expect(requested.some((url) => url.includes('hours=168'))).toBe(true);
  });

  it('выбор окна переживает перезагрузку страницы', async () => {
    await open();
    const hourButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'час',
    );
    await act(async () => hourButton?.click());
    await settle();
    expect(localStorage.getItem('mt-admin-dashboard-window')).toBe('1');
  });
});

describe('недоступное называется недоступным', () => {
  it('очередь без посредника даёт объяснение, а не нули', async () => {
    resourcesBody = {
      ...defaultResources(),
      queue: {
        available: false,
        total: null,
        deferred: null,
        oldestSeconds: null,
        topDeferredDomains: [],
        note: NO_QUEUE_NOTE,
      },
    };
    await open();
    expect(text()).toContain('не настроен посредник к Postfix');
    // Ноль писем в очереди — это «всё доставлено», и показывать его
    // вместо «неизвестно» нельзя.
    expect(text()).not.toContain('0 писем в очереди');
  });

  it('объём очереди на диске объяснён, а не спрятан из круговой диаграммы', async () => {
    await open();
    expect(text()).toContain('Очередь Postfix');
    expect(text()).toContain('/var/spool/postfix');
    expect(text()).toContain('права root');
  });

  it('чужие службы честно названы невидимыми', async () => {
    await open();
    expect(text()).toContain('Чего не видно отсюда');
    expect(text()).toContain('их cgroup серверу приложения не видны');
  });

  it('несделанная миграция даёт объяснение вместо пустого графика', async () => {
    historyBody = {
      available: false,
      note: 'История показателей недоступна: не применена миграция 0011_metrics.sql.',
      hours: 24,
      stepSeconds: 60,
      points: [],
    };
    await open();
    expect(text()).toContain('не применена миграция 0011_metrics.sql');
  });

  it('нерабочий сборщик не превращается в нули', async () => {
    resourcesBody = {
      takenAt: null,
      intervalSeconds: 0,
      cpu: null,
      memory: null,
      volumes: [],
      singleDevice: false,
      slices: [],
      queue: null,
      unavailable: ['Сборщик показателей не запущен: раздел ресурсов недоступен.'],
    };
    await open();
    expect(text()).toContain('Сборщик показателей не запущен');
    expect(text()).toContain('не измеряли');
  });
});

describe('у каждого числа написан источник', () => {
  it('загрузка процессора подписана файлом, из которого прочитана', async () => {
    await open();
    expect(text()).toContain('/proc/stat (весь узел)');
    expect(text()).toContain('/sys/fs/cgroup/cpu.stat (контейнер api)');
  });

  it('память узла отличена от памяти сервера приложения', async () => {
    // Одно число «память» на дашборде почтового сервера — это ловушка:
    // 32 ГБ узла и 140 МБ контейнера отвечают на разные вопросы.
    await open();
    expect(text()).toContain('Память узла');
    expect(text()).toContain('Память: сервер приложения');
  });

  it('общий том у писем, индексов и журналов назван прямо', async () => {
    await open();
    expect(text()).toContain('ОДНОМ устройстве');
  });
});

describe('графики', () => {
  it('пропуск в наблюдении рвёт линию, а не соединяет края', async () => {
    await open();
    const svg = container.querySelector('svg[aria-label*="Загрузка процессора"]');
    expect(svg, 'нет графика загрузки').toBeTruthy();
    // Считаем только линии данных: внутри <defs> лежат ещё и штрихи узоров
    // заливки, и без отсева проверка проходила бы на них одних.
    const lines = [...svg!.querySelectorAll('path[stroke]')].filter(
      (path) => path.closest('defs') === null,
    );
    // Три ряда, у каждого дыра посередине — значит по ДВА куска, а не по
    // одному сквозному. Один путь на ряд означал бы, что дыра затянута.
    expect(lines.length, 'дыра в наблюдении соединена сплошной линией').toBe(6);
    for (const line of lines) {
      // В каждом куске ровно один переход пера: два «M» в одном пути —
      // это как раз перепрыгнутая дыра.
      expect(line.getAttribute('d')?.match(/M/gu)?.length ?? 0).toBe(1);
    }
  });

  it('у графика есть текстовое описание для скринридера', async () => {
    await open();
    const labels = [...container.querySelectorAll('svg[role="img"]')].map((s) =>
      s.getAttribute('aria-label'),
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('в легенде стоит слово, а не только цвет', async () => {
    await open();
    expect(text()).toContain('Доставлено');
    expect(text()).toContain('Отложено');
  });
});

describe('статистика по ящикам', () => {
  it('показывает, кто сколько отправил и получил', async () => {
    await open();
    expect(text()).toContain('test@mail.local');
    expect(text()).toContain('Отправил');
    expect(text()).toContain('Объём полученного');
  });

  it('сортировка меняет запрос, а не переставляет одну страницу', async () => {
    // Переставлять страницу на клиенте — значит сортировать 25 строк из
    // тысячи и показывать не тех, кто в самом деле в верхушке.
    await open();
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Объём отправленного'),
    );
    await act(async () => button?.click());
    await settle();
    expect(requested.some((url) => url.includes('sort=sentBytes'))).toBe(true);
  });

  it('близость к квоте показана числом, а не только цветом полосы', async () => {
    await open();
    expect(text()).toContain('95.0 %');
  });

  it('молчащие ящики посчитаны', async () => {
    await open();
    expect(text()).toContain('Молчали за период: 1');
  });
});

describe('сертификаты', () => {
  it('скорое истечение видно словами, а не только цветом плашки', async () => {
    await open();
    expect(text()).toContain('осталось 14 дн');
  });

  it('самоподписанный сертификат назван самоподписанным', async () => {
    await open();
    expect(text()).toContain('самоподписанный');
  });
});

describe('автообновление', () => {
  it('флажок есть и по умолчанию выключен', async () => {
    await open();
    expect(autoCheckbox().checked).toBe(false);
  });

  it('выключенный флажок не порождает ни одного повторного запроса', async () => {
    await open();
    const before = requested.length;
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    await settle();
    expect(requested.length).toBe(before);
  });

  it('выбор запоминается своим ключом, не задевая другие журналы', async () => {
    await open();
    await act(async () => autoCheckbox().click());
    expect(localStorage.getItem(autoRefreshKey('dashboard'))).toBe('1');
    expect(localStorage.getItem(autoRefreshKey('queue'))).not.toBe('1');
    expect(localStorage.getItem(autoRefreshKey('flow-history'))).not.toBe('1');
  });

  it('включённый флажок обновляет разделы сам', async () => {
    await open();
    await act(async () => autoCheckbox().click());
    const before = requested.filter((u) => u.includes('/overview/resources')).length;
    await act(async () => {
      vi.advanceTimersByTime(40_000);
    });
    await settle();
    const after = requested.filter((u) => u.includes('/overview/resources')).length;
    expect(after).toBeGreaterThan(before);
  });

  it('невидимая вкладка не опрашивается', async () => {
    // Забытая на сутки панель иначе молотила бы запросами тот же сервер,
    // что возит почту.
    await open();
    await act(async () => autoCheckbox().click());
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    const before = requested.length;
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    await settle();
    expect(requested.length).toBe(before);
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });
});
