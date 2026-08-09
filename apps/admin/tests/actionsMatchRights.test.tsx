/**
 * Кнопка на экране обязана соответствовать праву на сервере.
 *
 * Раздел бывает открыт по одному праву, а действие внутри требует
 * другого. Тогда дежурный видит кнопку, нажимает и получает отказ — и это
 * худший вид отказа: он приходит ПОСЛЕ работы.
 *
 *   1. «Сквозная проверка доставки» в «Наблюдении». Раздел открыт по
 *      overview.read, а сам запуск требует services.restart (он
 *      отправляет настоящее письмо через живой Postfix). Поле и кнопка
 *      показывались всем: дежурный вводил адрес, ждал до сорока пяти
 *      секунд и получал 403.
 *
 *   2. Вкладка «Разбор письма» в «Антиспаме». Оба её действия —
 *      «Проверить» и обучение — требуют users.write. Вкладка была видна
 *      всем, а подсказка над полем обещала «проверка ничего не меняет»:
 *      обещание верное по сути и пустое на деле.
 *
 * Пустого места вместо кнопки тоже мало: без объяснения человек решит,
 * что панель сломана. Поэтому проверяется и то, что сказано, чего не
 * хватает и к кому идти.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/app/session';
import { MonitoringPage } from '../src/pages/MonitoringPage';
import { SpamPage } from '../src/pages/SpamPage';
import type { Permission } from '../src/api/types';

let container: HTMLElement;
let root: Root;

const READONLY: Permission[] = ['overview.read', 'users.read', 'audit.read'];
const OWNER: Permission[] = [...READONLY, 'users.write', 'services.restart', 'domains.write'];

const EMPTY_HEALTH = { checks: [], summary: { ok: 0, warn: 0, fail: 0, unknown: 0 } };

function mockFetch(permissions: Permission[]): void {
  vi.stubGlobal('fetch', async (url: string) => {
    let body: unknown = {};
    if (url.includes('/auth/session')) {
      body = {
        authenticated: true,
        login: 'dezhurnyy',
        displayName: null,
        role: permissions.includes('services.restart') ? 'owner' : 'readonly',
        roleLabel: 'Роль',
        permissions,
        masterAccess: false,
        theme: null,
      };
    } else if (url.includes('/monitoring/health') || url.includes('/monitoring/expiry')) {
      body = { ...EMPTY_HEALTH, shellOnly: [], shellOnlyNote: '' };
    } else if (url.includes('/monitoring/failures')) {
      body = { hours: 24, rejects: [], defers: [], rspamdErrors: [] };
    } else if (url.includes('/spam/overview')) {
      // Ровно столько, чтобы сводка нарисовалась: проверяем вкладки, а
      // не содержимое антиспама.
      body = {
        available: false,
        note: 'Антиспам не отвечает',
        period: null,
        periodNote: 'История пока не собрана',
        live: null,
        symbols: [],
        symbolsNote: '',
        manualLearns: { spam: 0, ham: 0 },
        collectingSince: null,
        counters: null,
      };
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

async function render(page: 'monitoring' | 'spam', permissions: Permission[]): Promise<void> {
  mockFetch(permissions);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <MemoryRouter>{page === 'monitoring' ? <MonitoringPage /> : <SpamPage />}</MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const text = (): string => container.textContent ?? '';

function hasControl(label: string): boolean {
  return [...container.querySelectorAll('button, [role="tab"]')].some((el) =>
    el.textContent?.includes(label),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('сквозная проверка доставки', () => {
  it('дежурному кнопки не показывают: у него на неё нет права', async () => {
    await render('monitoring', READONLY);
    expect(
      hasControl('Отправить проверочное письмо'),
      'кнопка ждёт 45 секунд и отвечает отказом по правам',
    ).toBe(false);
    expect(container.querySelector('input[type="email"]')).toBeNull();
  });

  it('дежурному сказано, чего не хватает и что делать', async () => {
    await render('monitoring', READONLY);
    expect(text()).toMatch(/только владелец|прав/iu);
    expect(text()).toMatch(/попросите|обратитесь/iu);
    // Объяснение самой проверки остаётся: понимать, чего раздел не
    // проверяет сам, дежурному нужно не меньше владельца.
    expect(text()).toContain('Сквозная проверка доставки');
  });

  it('владельцу кнопка на месте', async () => {
    await render('monitoring', OWNER);
    expect(hasControl('Отправить проверочное письмо')).toBe(true);
  });
});

describe('разбор письма в антиспаме', () => {
  it('без users.write вкладки нет вовсе', async () => {
    await render('spam', READONLY);
    expect(hasControl('Разбор письма'), 'вкладка обещает разбор, а сервер отвечает 403').toBe(
      false,
    );
    // Остальные вкладки дежурному видны: смотреть он вправе.
    expect(hasControl('Сводка')).toBe(true);
    expect(hasControl('Пороги')).toBe(true);
  });

  it('с users.write вкладка на месте', async () => {
    await render('spam', OWNER);
    expect(hasControl('Разбор письма')).toBe(true);
  });
});
