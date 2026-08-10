/**
 * Полный провал массовой правки показывался ЗЕЛЁНОЙ плашкой успеха.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Обработчик массовой операции ловит все отказы внутрь себя — иначе один
 * упавший ящик отменил бы работу над остальными. Из-за этого запрос
 * ВСЕГДА завершался успешно: `onError` не срабатывал никогда, а итог
 * объявлялся безусловно.
 *
 * Выходило вот что. Администратор полчаса собирал выборку из тысячи
 * ящиков по страницам, за это время истекла сессия (или перезапустили
 * сервер) — все части отвечают отказом, — и он читает ЗЕЛЁНУЮ плашку
 * «Изменено 0 ящиков, не удалось — 1000». Окно закрывается, выбор
 * стирается, причина не названа. Ни понять, ни повторить.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗАКРЕПЛЕНО
 * ------------------------------------------------------------------
 *  1. при неудаче окно НЕ закрывается и выбор не стирается;
 *  2. причины отказов видны (раньше их собирали и выбрасывали: список
 *     появлялся в том же кадре, в котором окно размонтировалось);
 *  3. удачная правка по-прежнему закрывает окно и сообщает итог.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const bulkUsers = vi.fn(async () => ({ ok: true as const, changed: 3 }));

vi.mock('../src/api/client', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    users: vi.fn(async () => ({
      items: [mailbox(1), mailbox(2), mailbox(3)],
      total: 3,
      limit: 50,
      offset: 0,
    })),
    domains: vi.fn(async () => [{ id: 1, name: 'mail.local' }]),
    bulkUsers: (...args: unknown[]) => bulkUsers(...(args as [])),
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
  bulkUsers.mockClear();
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

/** Отмечает все строки флажком в заголовке таблицы. */
async function checkAll(): Promise<void> {
  const head = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  if (!head) throw new Error('нет флажка «отметить все»');
  await act(async () => {
    head.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Открывает окно массовых операций и выбирает «Заблокировать». */
async function openBulkBlock(): Promise<void> {
  await checkAll();
  await clickText(/Действия над/);
  const select = container.querySelector('select.mt-select') as HTMLSelectElement | null;
  if (!select) throw new Error('нет списка «Что сделать»');
  await act(async () => {
    select.value = 'block';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('массовая правка: провал не выдаётся за успех', () => {
  it('окно остаётся открытым, причина названа, выбор цел', async () => {
    bulkUsers.mockRejectedValue(new Error('Сессия истекла — войдите заново'));
    await render();
    await openBulkBlock();

    await clickText(/^Применить$/);
    await settle();

    const text = container.textContent ?? '';
    // Окно на месте: значит и выбор цел, и повторить есть чем.
    expect(text, 'окно закрылось на полном провале').toContain('Массовая операция над');
    expect(text).toContain('не удалось — 3');
    // Причина отказа названа. Раньше её собирали и выбрасывали: список
    // появлялся в том же кадре, в котором окно размонтировалось.
    expect(text, 'причина отказа не показана').toContain('Сессия истекла');
  });

  it('удачная правка закрывает окно и сообщает итог', async () => {
    bulkUsers.mockResolvedValue({ ok: true as const, changed: 3 });
    await render();
    await openBulkBlock();

    await clickText(/^Применить$/);
    await settle();

    const text = container.textContent ?? '';
    expect(text, 'окно осталось открытым после удачной правки').not.toContain(
      'Массовая операция над',
    );
    expect(text).toContain('Изменено 3 ящика');
  });
});
