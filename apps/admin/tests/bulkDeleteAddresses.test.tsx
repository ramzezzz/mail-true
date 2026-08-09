/**
 * Массовое удаление показывало не те адреса, что удаляло.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Список адресов в подтверждении собирался из ТЕКУЩЕЙ страницы списка
 * (`items.filter((u) => selected.has(u.id))`), а сам выбор страницу
 * переживает: он не сбрасывается ни при перелистывании, ни при смене
 * поиска или фильтра.
 *
 * Отсюда и беда. Отметил двадцать ящиков, перелистнул, отметил ещё два,
 * открыл «Действия над 22 ящиками» — а в подтверждении показаны ДВА
 * адреса, те, что видны сейчас. Человек читает короткий список, набирает
 * «удалить» и сносит двадцать два ящика, из которых видел два.
 *
 * Удаление ящика необратимо в том смысле, который важен людям: почта
 * уходит в карантин, войти нельзя, алиасы разрушены.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗАКРЕПЛЕНО
 * ------------------------------------------------------------------
 * Что в подтверждении перечислены ВСЕ выбранные адреса, а не только
 * видимые сейчас, и что их ровно столько же, сколько уйдёт на удаление.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Две полные страницы: размер страницы в списке — 50, и без второй
 * страницы промах невоспроизводим.
 */
function mailbox(n: number): Record<string, unknown> {
  return {
    id: n,
    email: `user${String(n)}@mail.local`,
    displayName: null,
    domain: 'mail.local',
    domainId: 1,
    active: true,
    quotaBytes: 1073741824,
    usedBytes: 0,
    aliasCount: 0,
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

function page(offset: number): {
  items: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
} {
  const from = offset + 1;
  const items = Array.from({ length: 50 }, (_, i) => mailbox(from + i));
  return { items, total: 100, limit: 50, offset };
}

const users = vi.fn(async (params: { offset?: number }) => page(params.offset ?? 0));

vi.mock('../src/api/client', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    users: (...args: unknown[]) => users(...(args as [{ offset?: number }])),
    domains: vi.fn(async () => [{ id: 1, name: 'mail.local' }]),
    deleteUser: vi.fn(async () => ({})),
    updateUser: vi.fn(async () => ({})),
  },
}));

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, session: { masterAccess: false } }),
}));

vi.mock('../src/app/AdminLayout', () => ({
  PageTitle: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

const { UsersPage } = await import('../src/pages/UsersPage');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  users.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <UsersPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** Отмечает всю текущую страницу флажком в заголовке таблицы. */
async function checkVisibleRows(): Promise<void> {
  const head = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  if (!head) throw new Error('нет флажка «отметить все»');
  await act(async () => {
    head.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickText(text: RegExp): Promise<void> {
  const found = [...container.querySelectorAll('button')].find((b) =>
    text.test(b.textContent ?? ''),
  );
  if (!found) throw new Error(`нет кнопки ${String(text)}`);
  await act(async () => {
    found.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('массовые действия над ящиками', () => {
  it('в подтверждении удаления перечислены ВСЕ выбранные, а не только видимые', async () => {
    await render();
    await checkVisibleRows(); // 50 ящиков первой страницы
    await clickText(/Вперёд/);
    await settle();
    await checkVisibleRows(); // ещё 50 со второй

    await clickText(/Действия над/);
    await settle();

    // Режим выбирается списком: адреса показывает именно удаление.
    // Именно внутри диалога: на странице есть свои списки (фильтры), и
    // первый select — как раз один из них.
    const dialog = document.querySelector('[role="dialog"]');
    const select = dialog?.querySelector('select') as HTMLSelectElement | null;
    if (!select) throw new Error('нет выбора действия');
    await act(async () => {
      // Через нативный сеттер: React отслеживает прежнее значение и без
      // этого считает, что ничего не менялось.
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, 'delete');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const textarea = dialog?.querySelector('textarea') as HTMLTextAreaElement | null;
    const shown = textarea?.value ?? '';
    // Ящик с ПЕРВОЙ страницы: именно его и не было видно, когда список
    // собирался из текущей.
    expect(shown, 'в подтверждении нет ящика с первой страницы, а удалён он будет').toContain(
      'user1@mail.local',
    );
    expect(shown).toContain('user100@mail.local');
    expect(shown.split(/\r?\n/).filter((line) => line.trim() !== '')).toHaveLength(100);
  });
});
