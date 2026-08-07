/**
 * Вход в смену основного домена — на странице «Домены и DNS».
 *
 * Проверяется место, а не внешний вид. Место здесь и есть решение:
 *
 *   1. в главном меню пункта «Смена домена» НЕТ. Разовая операция с
 *      простоем и без полного отката, стоящая между «Пользователями» и
 *      «Журналами», однажды будет нажата по ошибке;
 *   2. вход живёт на странице доменов — там, где человек и так видит
 *      основной домен со всеми его записями;
 *   3. роли без права его не видно вовсе: ссылка, ведущая в отказ, хуже
 *      отсутствующей ссылки;
 *   4. сама страница по адресу /domain-change остаётся — прячется вход,
 *      а не возможность.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS } from '../src/lib/access';

vi.mock('../src/api/client', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    domains: () =>
      Promise.resolve({
        items: [
          {
            id: 1,
            name: 'staraya.ru',
            userCount: 12,
            aliasCount: 3,
            dkimSelector: 'mail',
            dkimPublicKey: null,
            dnsStatus: null,
            dnsCheckedAt: null,
            dnsOverall: 'unknown',
            createdAt: '2026-01-01T10:00:00.000Z',
            recommended: { mx: '', spf: '', dmarc: '', dkim: null, autoconfig: '' },
          },
        ],
      }),
  },
}));

/** Право проверяем через `can` — так же, как это делает страница. */
let granted: string[] = ['domains.read', 'domainchange.run'];
vi.mock('../src/app/session', () => ({
  useSession: () => ({
    can: (permission: string) => granted.includes(permission),
    session: { login: 'osmotr', permissions: granted },
  }),
}));

const { DomainsPage } = await import('../src/pages/DomainsPage');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  granted = ['domains.read', 'domainchange.run'];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
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
          <DomainsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('вход в смену домена', () => {
  it('в главном меню пункта «Смена домена» нет', () => {
    expect(NAV_ITEMS.map((i) => i.to)).not.toContain('/domain-change');
    expect(NAV_ITEMS.map((i) => i.title)).not.toContain('Смена домена');
  });

  it('вход стоит на странице «Домены и DNS» и назван тем, что произойдёт', async () => {
    await render();
    const link = container.querySelector('a[href="/domain-change"]');
    expect(link).toBeTruthy();
    const block = link?.closest('section');
    const text = block?.textContent ?? '';
    // Не «Дополнительно» и не «Ещё»: за безликим заголовком опасное
    // действие выглядит рядовым.
    expect(text).toContain('Смена основного домена');
    // Три вещи, которые человек должен узнать ДО перехода.
    expect(text).toContain('простоем');
    expect(text).toContain('не отменяется');
    expect(text).toContain('остаётся принимающим');
  });

  it('роли без права вход не показывается вовсе', async () => {
    granted = ['domains.read'];
    await render();
    expect(container.querySelector('a[href="/domain-change"]')).toBeNull();
    expect(container.textContent).not.toContain('Смена основного домена');
    // Список доменов при этом на месте: прячется вход, а не страница.
    expect(container.textContent).toContain('staraya.ru');
  });
});
