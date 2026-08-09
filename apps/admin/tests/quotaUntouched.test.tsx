/**
 * Квота, которую не трогали, не имеет права измениться.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Форма правки ящика показывает квоту двумя полями: число и единица.
 * Некруглое значение в них не помещается — splitQuota округляет до двух
 * знаков, иначе в поле стояло бы «1.3969838619232178 ГБ». Обратный
 * перевод даёт ДРУГОЕ число: 1 500 000 000 байт превращаются в
 * 1 503 238 554.
 *
 * Из-за этого правка любого другого поля молча меняла квоту. Человек
 * поправил отображаемое имя, нажал «Сохранить» — ящику досталось на три
 * мегабайта больше. К квоте он не прикасался и в отчёте об этом ничего
 * не увидел.
 *
 * Некруглые квоты — не редкость: их ставят из CSV при импорте, через API
 * и при переносе с чужого сервера.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quotaToBytes, splitQuota } from '../src/lib/quota';

/** Квота, которая не ложится в поля без потерь. */
const AWKWARD = 1_500_000_000;

const updateUser = vi.fn(async () => ({}));

vi.mock('../src/api/client', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    users: vi.fn(async () => ({
      items: [
        {
          id: 1,
          email: 'ivan@mail.local',
          displayName: 'Иван',
          domain: 'mail.local',
          domainId: 1,
          active: true,
          quotaBytes: AWKWARD,
          usedBytes: 0,
          aliasCount: 0,
          createdAt: '2026-08-01T10:00:00.000Z',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    })),
    domains: vi.fn(async () => [{ id: 1, name: 'mail.local' }]),
    updateUser: (...args: unknown[]) => updateUser(...(args as [])),
    deleteUser: vi.fn(async () => ({})),
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
  updateUser.mockClear();
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

async function openEditForm(): Promise<void> {
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

  const edit = [...container.querySelectorAll('button')].find((b) =>
    /Изменить/.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  );
  if (!edit) throw new Error('нет кнопки «Изменить»');
  await act(async () => {
    edit.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function dialogButton(text: RegExp): HTMLButtonElement {
  const dialog = container.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('диалог не открылся');
  const found = [...dialog.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));
  if (!found) throw new Error(`нет кнопки ${String(text)}`);
  return found as HTMLButtonElement;
}

describe('правка ящика', () => {
  it('поля округляют квоту — это и создавало подмену', () => {
    // Условие, из которого растёт дефект. Если однажды поля научатся
    // показывать точное значение, проверка ниже станет лишней — и об
    // этом узнают отсюда.
    const shown = splitQuota(AWKWARD);
    expect(quotaToBytes(String(shown.amount), shown.unit)).not.toBe(AWKWARD);
  });

  it('сохранение без правки квоты отправляет прежние байты', async () => {
    await openEditForm();

    // Человек правит только имя.
    const dialog = container.querySelector('[role="dialog"]');
    const name = dialog?.querySelector('input.mt-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(name, 'Иван Петров');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      dialogButton(/Сохранить/).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(updateUser).toHaveBeenCalledTimes(1);
    const [, body] = updateUser.mock.calls[0] as unknown as [number, { quotaBytes?: number }];
    expect(body.quotaBytes, 'квоту не трогали — она обязана уйти байт в байт').toBe(AWKWARD);
  });

  it('изменённая квота уходит новым значением', async () => {
    await openEditForm();

    const amount = container.querySelector(
      '[role="dialog"] input[aria-label="Квота, число"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(amount, '2');
      amount.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      dialogButton(/Сохранить/).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const [, body] = updateUser.mock.calls[0] as unknown as [number, { quotaBytes?: number }];
    expect(body.quotaBytes).toBe(2 * 1024 ** 3);
  });
});
