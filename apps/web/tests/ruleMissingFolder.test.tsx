// @vitest-environment jsdom
/**
 * Правило указывает на папку, которой в ящике больше нет.
 *
 * Так бывает после переименования папки МИМО нашей почты: по IMAP это
 * разрешено из любой почтовой программы, и правило остаётся указывать на
 * старый путь. Дальше `fileinto :create` при первом же письме заводит
 * папку со старым именем заново — рядом с переименованной. Человек видит
 * две похожие папки, почта раскладывается в обе, и понять причину
 * невозможно.
 *
 * Молча перенести правило нельзя: папку могли не переименовать, а
 * удалить, и любая догадка о новом месте была бы выдумкой. Поэтому
 * проверяется, что о поломке СКАЗАНО и названа сама папка.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FiltersPage } from '../src/pages/settings/FiltersPage';
import { settingsApi } from '../src/api';
import { emptyRule, type FilterRule } from '../src/lib/filterRules';

let host: HTMLDivElement;
let root: Root;

const BROKEN: FilterRule = {
  ...emptyRule(),
  id: 'r-1',
  conditions: [{ field: 'from', operator: 'contains', value: 'bank@example.com' }],
  missingFolder: 'Счета 2024',
};

const LIVE: FilterRule = {
  ...emptyRule(),
  id: 'r-2',
  conditions: [{ field: 'from', operator: 'contains', value: 'kolya@example.com' }],
};

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <FiltersPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  for (let i = 0; i < 20; i += 1) {
    if (host.textContent?.includes('bank@example.com')) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.restoreAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('пропавшая папка-приёмник', () => {
  it('строка правила называет папку, которой больше нет', async () => {
    vi.spyOn(settingsApi, 'getFilterRules').mockResolvedValue([BROKEN]);
    await render();

    expect(host.textContent).toContain('Счета 2024');
    expect(host.textContent).toContain('в ящике нет');
  });

  it('исправным правилам ничего не приписывается', async () => {
    vi.spyOn(settingsApi, 'getFilterRules').mockResolvedValue([LIVE]);
    await render();

    expect(host.textContent).not.toContain('в ящике нет');
  });
});
