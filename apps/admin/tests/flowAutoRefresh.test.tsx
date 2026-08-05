/**
 * Автообновление вкладки «Обработанные» в разделе «Почтовый поток».
 *
 * Проверяется не «дёргается ли список», а три правила, без которых живая
 * лента вредит вместо пользы:
 *
 *   1. Новое ДОПИСЫВАЕТСЯ СВЕРХУ. История растёт от свежих к старым, и
 *      человек мог подгрузить прокруткой тысячу записей. Обычный
 *      перезапрос схлопнул бы их обратно в одну страницу, выдернув из-под
 *      глаз ровно то, что читают.
 *   2. Прилипание — ПО ПОЛОЖЕНИЮ ПРОКРУТКИ. Стоит человек в начале —
 *      новое появляется само. Отмотал вниз, разбирается в старом — ленту
 *      не трогаем, а показываем счётчик: иначе о новом можно не узнать.
 *   3. Выключенный флажок означает НИ ОДНОГО запроса. Автообновление —
 *      решение человека, а сервер тот же самый, что возит почту.
 *
 * На старом коде падают все: у вкладки «Обработанные» не было ни
 * автообновления, ни даже кнопки «Обновить».
 *
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoRefreshKey } from '../src/lib/autoRefresh';
import { FlowPage } from '../src/pages/FlowPage';
import { SessionProvider } from '../src/app/session';
import type { FlowEvent } from '../src/api/types';

let container: HTMLElement;
let root: Root;
/** Запросы, которые страница успела сделать. */
let requested: string[] = [];
/** Что отдавать на дочитывание новых записей. */
let freshQueue: FlowEvent[][] = [];

function event(id: string, recipient: string, at: string): FlowEvent {
  return {
    id,
    occurredAt: at,
    queueId: `4c2${id}`,
    direction: 'out',
    status: 'sent',
    sender: 'ivan@mail.local',
    recipient,
    relay: 'mx.example.org',
    delaySeconds: 1.2,
    sizeBytes: 2048,
    dsn: '2.0.0',
    reason: '250 2.0.0 Ok',
  };
}

const OLD = [
  event('30', 'third@example.org', '2026-08-05T20:30:03.000Z'),
  event('20', 'second@example.org', '2026-08-05T20:30:02.000Z'),
  event('10', 'first@example.org', '2026-08-05T20:30:01.000Z'),
];

function historyBody(items: FlowEvent[], hasMore = false): unknown {
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    nextBefore: hasMore && last ? { time: last.occurredAt, id: last.id } : null,
    limit: 50,
  };
}

function mockFetch(): void {
  vi.stubGlobal('fetch', async (url: string) => {
    requested.push(url);
    let body: unknown;
    if (url.includes('/queue/history/stats')) {
      body = {
        total: OLD.length,
        counts: { sent: OLD.length },
        collectingSince: '2026-08-01T00:00:00.000Z',
        retentionDays: 14,
        maxRows: 500_000,
        oldest: '2026-08-01T00:00:00.000Z',
      };
    } else if (url.includes('afterId=')) {
      body = historyBody(freshQueue.shift() ?? []);
    } else if (url.includes('/queue/history')) {
      body = historyBody(OLD);
    } else if (url.includes('/session')) {
      body = { user: { login: 'admin' }, permissions: ['overview.read', 'users.write'] };
    } else {
      body = { items: [], total: 0, byQueue: {} };
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openHistory(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <FlowPage />
        </SessionProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  const tab = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.includes('Обработанные'),
  );
  await act(async () => tab?.click());
  await settle();
}

/** Адресаты в том порядке, в каком они стоят в таблице. */
function recipients(): string[] {
  return [...container.querySelectorAll('tbody tr')]
    .map((tr) => tr.querySelectorAll('td')[4]?.textContent?.trim() ?? '')
    .filter((text) => text.includes('@'));
}

function checkbox(): HTMLInputElement {
  const box = [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('Автообновление'))
    ?.querySelector('input');
  expect(box, 'на вкладке «Обработанные» нет флажка автообновления').toBeTruthy();
  return box as HTMLInputElement;
}

beforeEach(() => {
  requested = [];
  freshQueue = [];
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Панель прокручивает КОЛОНКУ СОДЕРЖИМОГО, а не окно, — поэтому лента
  // живёт внутри прокручиваемого <main>, как в настоящей разметке.
  // На window.scrollY прилипание считать нельзя: он там всегда ноль.
  container = document.createElement('main');
  container.style.overflowY = 'auto';
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(container, 'scrollHeight', { value: 2400, configurable: true });
  Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true });
  container.scrollTo = vi.fn();
  document.body.append(container);
  root = createRoot(container);
  mockFetch();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  globalThis.scrollY = 0;
});

describe('вкладка «Обработанные»: автообновление', () => {
  it('флажок есть, и по умолчанию он выключен', async () => {
    await openHistory();
    expect(checkbox().checked).toBe(false);
    expect(requested.some((url) => url.includes('afterId='))).toBe(false);
  });

  it('выключенный флажок не порождает ни одного запроса на дочитывание', async () => {
    await openHistory();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await settle();
    expect(requested.filter((url) => url.includes('afterId='))).toHaveLength(0);
  });

  it('выбор запоминается отдельно от очереди', async () => {
    await openHistory();
    await act(async () => checkbox().click());
    expect(localStorage.getItem(autoRefreshKey('flow-history'))).toBe('1');
    expect(localStorage.getItem(autoRefreshKey('queue'))).not.toBe('1');
  });

  it('новая запись дописывается сверху, а показанное остаётся на месте', async () => {
    await openHistory();
    expect(recipients()).toEqual([
      'third@example.org',
      'second@example.org',
      'first@example.org',
    ]);

    freshQueue = [[event('40', 'fresh@example.org', '2026-08-05T20:30:09.000Z')]];
    await act(async () => checkbox().click());
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });
    await settle();

    expect(recipients()).toEqual([
      'fresh@example.org',
      'third@example.org',
      'second@example.org',
      'first@example.org',
    ]);
  });

  it('человек отмотал вниз — лента не дёргается, появляется счётчик', async () => {
    await openHistory();
    // Прокручена именно колонка содержимого. Окно при этом стоит на нуле:
    // на нём прилипание считать нельзя.
    container.scrollTop = 1200;
    globalThis.scrollY = 0;

    freshQueue = [[event('40', 'fresh@example.org', '2026-08-05T20:30:09.000Z')]];
    await act(async () => checkbox().click());
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });
    await settle();

    expect(recipients(), 'ленту трогать нельзя: человек читает старое').toEqual([
      'third@example.org',
      'second@example.org',
      'first@example.org',
    ]);
    const button = [...container.querySelectorAll('button')].find((b) =>
      /нова|новы/.test(b.textContent ?? ''),
    );
    expect(button, 'о новом не сообщили вовсе').toBeTruthy();
    expect(button?.textContent).toContain('1 новая запись');

    await act(async () => button?.click());
    await settle();
    expect(recipients()[0]).toBe('fresh@example.org');
  });
});
