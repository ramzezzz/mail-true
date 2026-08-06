// @vitest-environment jsdom
/**
 * «Отложить письмо до срока» — сторона интерфейса.
 *
 * Проверяется то, без чего возможность не работает, даже если сервер
 * безупречен:
 *
 *   - кнопки «Отложить» НЕТ, пока сервер не сказал, что возможность у него
 *     есть: мёртвых кнопок в продукте не бывает;
 *   - при откладывании уходит НАЗВАНИЕ срока и пояс браузера, а не
 *     посчитанный здесь час: считает сервер, и второго расчёта нет;
 *   - вернувшееся письмо видно — оно поднимается наверх отдельной группой
 *     со значком времени, иначе оно приезжает в середину списка, туда,
 *     откуда его неделю назад и убрали;
 *   - в самой папке «Отложенные» вместо «Отложить» стоит «Вернуть сейчас»,
 *     а в строке виден срок.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Folder, MessageSummary } from '@mail-true/shared';
import { api } from '../src/api';
import { useUiStore } from '../src/app/store';
import { FolderPage } from '../src/pages/FolderPage';
import { flattenRows, RETURNED_GROUP_LABEL } from '../src/mail/MessageList';
import {
  formatWakeAt,
  snoozeApi,
  toLocalInputValue,
  type SnoozedState,
} from '../src/mail/snoozeApi';

let host: HTMLDivElement;
let root: Root;

/**
 * jsdom не считает размеров: offsetWidth/offsetHeight у него всегда нули,
 * а виртуализация списка меряет контейнер прокрутки именно ими — при
 * нулевой высоте она не рисует ни одной строки. Выдаём ей окно 1200×800.
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

function summary(uid: number, extra: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id: `inbox:${uid}`,
    folderId: 'inbox',
    uid,
    threadId: `t-${uid}`,
    from: { name: 'Директор', address: 'boss@example.com' },
    to: [],
    cc: [],
    subject: `Письмо ${String(uid)}`,
    snippet: 'вернёмся к этому в сентябре',
    date: new Date(2026, 7, 5, 12, 0, uid % 60).toISOString(),
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
    ...extra,
  };
}

function folder(id: string, role: Folder['role'], name: string): Folder {
  return {
    id,
    path: name,
    name,
    role,
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 1,
    system: true,
    uidValidity: 1,
  };
}

const FOLDERS: Folder[] = [
  folder('inbox', 'inbox', 'INBOX'),
  folder('snoozed', 'snoozed', 'Snoozed'),
];

function state(patch: Partial<SnoozedState> = {}): SnoozedState {
  return { available: true, scheduledReturn: true, reason: null, items: [], ...patch };
}

/** Рисует страницу папки с подставленными ответами сервера. */
async function renderFolder(folderId: string, messages: MessageSummary[]) {
  vi.spyOn(api, 'getFolders').mockResolvedValue(FOLDERS);
  vi.spyOn(api, 'getMessages').mockImplementation(async () => ({
    items: messages,
    total: messages.length,
    offset: 0,
    limit: 100,
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/${folderId}/`]}>
          <Routes>
            <Route path="/:folderId/" element={<FolderPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Двух ответов сервера мало: список папки и состояние «Отложенных» —
  // разные запросы, и строки появляются только после второго. Ждём
  // очередь макрозадач, а не один микротакт.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Кнопка по её видимой подписи. */
function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').trim().includes(text),
  );
}

beforeEach(() => {
  stubLayout();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  useUiStore.getState().clearSelection();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe('кнопка «Отложить»', () => {
  /**
   * Главное правило продукта: кнопка появляется вместе с поведением.
   * За «Отложить» стоят база и работник возврата; когда их нет, сервер
   * отвечает `available: false`, и кнопки быть не должно — иначе человек
   * нажмёт её и получит отказ там, где ждал действия.
   */
  it('не появляется, пока сервер не сказал, что возможность есть', async () => {
    vi.spyOn(snoozeApi, 'fetchSnoozed').mockResolvedValue(
      state({ available: false, reason: 'Не настроена база данных' }),
    );
    await renderFolder('inbox', [summary(1)]);
    act(() => useUiStore.getState().selectMany(['inbox:1']));
    expect(buttonByText('Отложить')).toBeUndefined();
  });

  it('появляется в панели над выделенными письмами', async () => {
    vi.spyOn(snoozeApi, 'fetchSnoozed').mockResolvedValue(state());
    await renderFolder('inbox', [summary(1)]);
    act(() => useUiStore.getState().selectMany(['inbox:1']));
    expect(buttonByText('Отложить')).toBeDefined();
  });

  /**
   * Час считает СЕРВЕР. Отсюда уходит название срока и пояс браузера —
   * и ничего больше. Второй расчёт того же самого разошёлся бы с первым,
   * и человек увидел бы в меню один час, а письмо приехало бы в другой.
   */
  it('отправляет название срока и пояс браузера, а не посчитанный здесь час', async () => {
    vi.spyOn(snoozeApi, 'fetchSnoozed').mockResolvedValue(state());
    const snooze = vi
      .spyOn(snoozeApi, 'snoozeMessages')
      .mockResolvedValue({ snoozed: 1, wakeAt: '2026-08-06T05:00:00.000Z' });

    await renderFolder('inbox', [summary(1)]);
    act(() => useUiStore.getState().selectMany(['inbox:1']));
    act(() => buttonByText('Отложить')?.click());

    const item = [...host.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').trim() === 'Завтра утром',
    );
    expect(item, 'в меню нет готового срока «Завтра утром»').toBeDefined();
    await act(async () => {
      item?.click();
      await Promise.resolve();
    });

    expect(snooze).toHaveBeenCalledTimes(1);
    const request = snooze.mock.calls[0]?.[0];
    expect(request?.ids).toEqual(['inbox:1']);
    expect(request?.preset).toBe('tomorrow-morning');
    // Никакого `until` при готовом сроке: час здесь не считается.
    expect(request?.until).toBeUndefined();
  });

  /** Произвольная дата уходит моментом времени — его человек и выбрал. */
  it('произвольная дата уходит как момент времени', async () => {
    vi.spyOn(snoozeApi, 'fetchSnoozed').mockResolvedValue(state());
    const snooze = vi
      .spyOn(snoozeApi, 'snoozeMessages')
      .mockResolvedValue({ snoozed: 1, wakeAt: '2026-09-01T06:00:00.000Z' });

    await renderFolder('inbox', [summary(1)]);
    act(() => useUiStore.getState().selectMany(['inbox:1']));
    act(() => buttonByText('Отложить')?.click());

    const input = host.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    expect(input, 'поля произвольной даты нет').toBeDefined();
    const chosen = new Date(2026, 8, 1, 9, 0);
    act(() => {
      // Поле правится как обычное поле React: значение + событие ввода.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, toLocalInputValue(chosen));
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Кнопка «Отложить» внутри меню, а не та, что его открывает: искать
    // по подписи мало — подпись у них одинаковая.
    const menu = host.querySelector('[role="menu"]');
    await act(async () => {
      [...(menu?.querySelectorAll('button') ?? [])]
        .find((b) => (b.textContent ?? '').trim() === 'Отложить')
        ?.click();
      await Promise.resolve();
    });

    const request = snooze.mock.calls[0]?.[0];
    expect(request?.preset).toBe('custom');
    expect(request?.until).toBe(chosen.toISOString());
  });
});

describe('папка «Отложенные»', () => {
  const snoozedMessage = summary(9, { id: 'snoozed:501', folderId: 'snoozed', uid: 501 });

  it('вместо «Отложить» предлагает вернуть письмо сейчас', async () => {
    vi.spyOn(snoozeApi, 'fetchSnoozed').mockResolvedValue(state());
    await renderFolder('snoozed', [snoozedMessage]);
    act(() => useUiStore.getState().selectMany(['snoozed:501']));
    expect(buttonByText('Вернуть сейчас')).toBeDefined();
    expect(buttonByText('Отложить')).toBeUndefined();
  });

  /**
   * Срок — единственное содержательное, что есть в этой папке. Без него
   * «Отложенные» ничем не отличаются от «Архива»: те же письма, тот же
   * порядок, и понять, когда они вернутся, нельзя ничем.
   */
  it('показывает срок возврата прямо в строке письма', async () => {
    const wakeAt = new Date(Date.now() + 24 * 3600 * 1000);
    wakeAt.setHours(8, 0, 0, 0);
    vi.spyOn(snoozeApi, 'fetchSnoozed').mockResolvedValue(
      state({
        items: [
          {
            id: 'snoozed:501',
            subject: 'Письмо 9',
            from: 'boss@example.com',
            wakeAt: wakeAt.toISOString(),
            preset: 'tomorrow-morning',
            originPath: 'INBOX',
            orphan: false,
          },
        ],
      }),
    );
    await renderFolder('snoozed', [snoozedMessage]);
    expect(host.textContent).toContain(formatWakeAt(wakeAt.toISOString()));
  });

  it('«Вернуть сейчас» шлёт серверу именно выбранные письма', async () => {
    vi.spyOn(snoozeApi, 'fetchSnoozed').mockResolvedValue(state());
    const unsnooze = vi
      .spyOn(snoozeApi, 'unsnoozeMessages')
      .mockResolvedValue({ returned: 1 });
    await renderFolder('snoozed', [snoozedMessage]);
    act(() => useUiStore.getState().selectMany(['snoozed:501']));
    await act(async () => {
      buttonByText('Вернуть сейчас')?.click();
      await Promise.resolve();
    });
    expect(unsnooze).toHaveBeenCalledWith(['snoozed:501']);
  });
});

describe('вернувшееся письмо заметно', () => {
  /**
   * Письмо возвращается на своё место ПО ДАТЕ — то есть в середину списка,
   * туда, откуда человек его неделю назад и убрал. Без отдельной группы
   * наверху возможность не работала бы вовсе: письмо честно вернулось,
   * а найти его нельзя. Ровно так же поступает Яндекс.
   */
  it('поднимается отдельной группой в самый верх списка', () => {
    const rows = flattenRows([
      summary(1),
      summary(2, { returnedFromSnooze: true }),
      summary(3),
    ]);
    expect(rows[0]).toEqual({ type: 'header', label: RETURNED_GROUP_LABEL });
    expect(rows[1]).toMatchObject({ type: 'message', message: { id: 'inbox:2' } });
    // Остальные письма остаются в своих периодах, а не сливаются с группой.
    expect(rows.filter((r) => r.type === 'header').length).toBeGreaterThan(1);
  });

  it('без вернувшихся писем лишней группы не появляется', () => {
    const rows = flattenRows([summary(1), summary(2)]);
    expect(rows.some((r) => r.type === 'header' && r.label === RETURNED_GROUP_LABEL)).toBe(
      false,
    );
  });

  it('в строке рисуется значок времени — иначе непонятно, почему письмо наверху', async () => {
    vi.spyOn(snoozeApi, 'fetchSnoozed').mockResolvedValue(state());
    await renderFolder('inbox', [summary(1, { returnedFromSnooze: true })]);
    const badge = host.querySelector('[title="Письмо вернулось из «Отложенных»"]');
    expect(badge, 'значка времени у вернувшегося письма нет').not.toBeNull();
  });
});

describe('слова о сроке', () => {
  const now = new Date(2026, 7, 5, 21, 30);

  it('называют срок по-человечески, а не датой', () => {
    expect(formatWakeAt(new Date(2026, 7, 6, 8, 0).toISOString(), now)).toBe('завтра в 08:00');
    expect(formatWakeAt(new Date(2026, 7, 8, 8, 0).toISOString(), now)).toBe('в субботу в 08:00');
  });

  /** Дальше недели язык уже не помогает: «через 43 дня» не говорит ничего. */
  it('дальше недели показывают дату', () => {
    expect(formatWakeAt(new Date(2026, 8, 17, 8, 0).toISOString(), now)).toBe(
      '17 сентября в 08:00',
    );
    expect(formatWakeAt(new Date(2027, 0, 11, 8, 0).toISOString(), now)).toBe(
      '11 января 2027 в 08:00',
    );
  });

  it('пустой и нечитаемый срок не превращаются в «Invalid Date»', () => {
    expect(formatWakeAt('')).toBe('');
    expect(formatWakeAt('когда-нибудь')).toBe('');
  });
});
