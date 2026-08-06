/**
 * Необратимые действия обязаны спрашивать.
 *
 * В панели три действия «Удалить»: ящик, алиас и правило фильтрации.
 * Удаление ящика было защищено набором адреса вручную, удаление алиаса —
 * ничем: одно нажатие на значок корзины 26×26, стоящий в двух точках от
 * соседней кнопки, стирало пересылку без вопроса и без отмены.
 *
 * Последствие тихое и потому злое: письма на прежний адрес начинают
 * отбиваться отправителям, а замечают это через дни — по жалобе снаружи.
 *
 * Проверяем не наличие модалки как таковой, а ГЛАВНОЕ СВОЙСТВО: после
 * нажатия на корзину запрос на удаление НЕ уходит, пока человек не
 * подтвердил, и уходит после подтверждения.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deleteAlias = vi.fn(async () => undefined);
const aliases = vi.fn(async () => ({
  items: [
    {
      id: 42,
      source: 'info@mail.local',
      destination: 'ivan@mail.local',
      domain: 'mail.local',
      domainId: 1,
      active: true,
      createdAt: '2026-08-01T10:00:00.000Z',
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
}));

vi.mock('../src/api/client', () => ({
  api: {
    aliases: (...args: unknown[]) => aliases(...(args as [])),
    deleteAlias: (...args: unknown[]) => deleteAlias(...(args as [])),
    setAliasActive: vi.fn(async () => undefined),
    createAlias: vi.fn(async () => undefined),
  },
}));

// Полный доступ: кнопки должны быть видны, иначе проверять нечего.
vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, session: null }),
}));

vi.mock('../src/app/AdminLayout', () => ({
  PageTitle: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

const { AliasesPage } = await import('../src/pages/AliasesPage');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  deleteAlias.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AliasesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Ждём, пока приедет список.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonByName(name: RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) =>
    name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  );
  if (!found) throw new Error(`нет кнопки ${String(name)}`);
  return found as HTMLButtonElement;
}

describe('удаление алиаса', () => {
  it('одно нажатие на корзину НЕ удаляет пересылку', async () => {
    await render();
    await act(async () => {
      buttonByName(/^Удалить: info@mail\.local$/).click();
    });
    expect(deleteAlias, 'запрос ушёл без подтверждения').not.toHaveBeenCalled();
  });

  it('спрашивает, и в вопросе видно, что именно перестанет работать', async () => {
    await render();
    await act(async () => {
      buttonByName(/^Удалить: info@mail\.local$/).click();
    });
    const text = container.textContent ?? '';
    // Человек должен прочитать ОБА адреса: «удалить алиас №42» ему
    // ни о чём не говорит, а «info@ перестанет приходить на ivan@» — да.
    expect(text).toContain('info@mail.local');
    expect(text).toContain('ivan@mail.local');
    expect(text).toMatch(/перестан/iu);
  });

  it('после подтверждения удаление уходит на сервер', async () => {
    await render();
    await act(async () => {
      buttonByName(/^Удалить: info@mail\.local$/).click();
    });
    await act(async () => {
      buttonByName(/^Удалить алиас$/).click();
    });
    expect(deleteAlias).toHaveBeenCalledWith(42);
  });

  it('отмена закрывает вопрос и ничего не удаляет', async () => {
    await render();
    await act(async () => {
      buttonByName(/^Удалить: info@mail\.local$/).click();
    });
    await act(async () => {
      buttonByName(/^Отмена$/).click();
    });
    expect(deleteAlias).not.toHaveBeenCalled();
    expect(container.textContent ?? '').not.toContain('Удалить алиас');
  });
});
