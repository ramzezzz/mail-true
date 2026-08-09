// @vitest-environment jsdom
/**
 * Очистка корзины и порядок правил в списке фильтров.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО С КОРЗИНОЙ
 * ------------------------------------------------------------------
 * Очистить корзину было нельзя НИГДЕ. В таблице папок у корзины не было
 * кнопки «Очистить» (роль trash не давала права canClear), в самой папке
 * такого действия нет, а «Удалить всё сейчас» в «Восстановлении писем»
 * стирает уже ОЧИЩЕННОЕ, а не корзину. Корзина росла без предела и
 * честно ела квоту ящика.
 *
 * Заодно мёртвым лежал весь раздел «Восстановление писем»: его список
 * наполняет ровно очистка корзины (единственный вызов recovery.sweep во
 * всём коде), а позвать её было неоткуда — и настройка «Сколько хранить
 * очищенное» ни на что не влияла. При этом список писем отправлял
 * человека очищать корзину именно «в настройки, в раздел „Восстановление
 * писем“».
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО СО СТРЕЛКАМИ ПОРЯДКА
 * ------------------------------------------------------------------
 * Автофильтры спрятаны под флажком, а стрелка двигала правило на одну
 * позицию в ПОЛНОМ списке: под видимым правилом мог стоять скрытый
 * автофильтр — и «Ниже» меняло местами их. На экране не менялось ничего,
 * а порядок применения фильтров уезжал.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Folder } from '@mail-true/shared';
import { api, settingsApi } from '../src/api';
import { ownerApi } from '../src/settings/ownerApi';
import { useUiStore } from '../src/app/store';
import { FoldersPage } from '../src/pages/settings/FoldersPage';
import { FiltersPage } from '../src/pages/settings/FiltersPage';
import { RecoveryPage } from '../src/pages/settings/RecoveryPage';
import type { FilterRule } from '../src/lib/filterRules';

let host: HTMLDivElement;
let root: Root;

function folder(patch: Partial<Folder> & Pick<Folder, 'id' | 'path' | 'name' | 'role'>): Folder {
  return {
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 0,
    system: true,
    uidValidity: 1,
    ...patch,
  };
}

const INBOX = folder({ id: 'inbox', path: 'INBOX', name: 'INBOX', role: 'inbox', totalCount: 12 });
const TRASH = folder({ id: 'trash', path: 'Trash', name: 'Trash', role: 'trash', totalCount: 41 });

function rule(id: string, auto: boolean): FilterRule {
  return {
    id,
    enabled: true,
    auto,
    conditions: [{ field: 'from', operator: 'contains', value: `${id}@почта` }],
    actions: {
      moveToFolderId: null,
      markRead: true,
      markFlagged: false,
      labelKeys: [],
      deleteMode: null,
      applyToExistingFolderIds: [],
      forwardTo: null,
      autoReply: null,
      continueOtherFilters: true,
      applyToSpam: false,
    },
  };
}

function render(node: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

const buttonByLabel = (label: string): HTMLButtonElement[] =>
  [...host.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === label);

const click = (el: Element | null | undefined): void => {
  if (!el) throw new Error('нечего нажимать');
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.textContent ?? ''}`);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ notice: null });
  vi.restoreAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('очистка корзины в разделе «Папки»', () => {
  it('у корзины есть «Очистить», и она чистит именно корзину', async () => {
    vi.spyOn(api, 'getFolders').mockResolvedValue([INBOX, TRASH]);
    const clear = vi.spyOn(settingsApi, 'clearFolder').mockResolvedValue({ removed: 41, kept: 41 });

    render(<FoldersPage />);
    await waitFor(() => (host.textContent ?? '').includes('Корзина'), 'таблицу папок');

    // Кнопок «Очистить» две: у «Входящих» и у «Корзины». Раньше у корзины
    // её не было вовсе.
    const rows = [...host.querySelectorAll('tbody tr')];
    const trashRow = rows.find((r) => (r.textContent ?? '').includes('Корзина'));
    expect(trashRow, 'строки корзины нет').toBeTruthy();
    const clearButton = [...(trashRow?.querySelectorAll('button') ?? [])].find(
      (b) => b.getAttribute('aria-label') === 'Очистить',
    );
    expect(clearButton, 'у корзины нет кнопки «Очистить»').toBeTruthy();

    click(clearButton);
    expect(clear, 'до подтверждения ничего не удаляется').not.toHaveBeenCalled();
    // В вопросе сказано, куда идти за возвратом писем.
    expect(host.textContent).toContain('Очистить корзину?');
    expect(host.textContent).toContain('Восстановление писем');

    click(buttonByText('Очистить'));
    await waitFor(() => clear.mock.calls.length > 0, 'очистку после подтверждения');
    expect(clear.mock.calls[0]?.[0]).toBe('trash');
  });
});

describe('очистка корзины в разделе «Восстановление писем»', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getFolders').mockResolvedValue([INBOX, TRASH]);
    vi.spyOn(ownerApi, 'getRecovery').mockResolvedValue({
      available: true,
      reason: null,
      days: 7,
      maxDays: 30,
      items: [],
      totals: { count: 0, bytes: 0 },
      scheduledPurge: null,
    } as never);
  });

  it('кнопка есть, спрашивает и зовёт очистку корзины', async () => {
    const clear = vi.spyOn(settingsApi, 'clearFolder').mockResolvedValue({ removed: 41, kept: 41 });

    render(<RecoveryPage />);
    // Именно сюда отправляет человека список писем: «очистить её целиком
    // можно в настройках, в разделе „Восстановление писем“».
    await waitFor(() => Boolean(buttonByText('Очистить корзину (41)')), 'кнопку очистки корзины');

    click(buttonByText('Очистить корзину (41)'));
    expect(clear, 'до подтверждения ничего не удаляется').not.toHaveBeenCalled();
    expect(host.textContent).toContain('Очистить корзину?');
    // Срок хранения назван прямо: от него зависит, можно ли будет вернуть.
    expect(host.textContent).toContain('7 дней');

    click(buttonByText('Очистить'));
    await waitFor(() => clear.mock.calls.length > 0, 'очистку после подтверждения');
    expect(clear.mock.calls[0]?.[0]).toBe('trash');
  });
});

describe('стрелки порядка правил', () => {
  it('двигают правило по видимому списку, а не через скрытый автофильтр', async () => {
    vi.spyOn(api, 'getFolders').mockResolvedValue([INBOX, TRASH]);
    vi.spyOn(settingsApi, 'getFilterRules').mockResolvedValue([
      rule('a', false),
      rule('auto', true),
      rule('b', false),
    ]);
    const reorder = vi.spyOn(settingsApi, 'reorderFilterRules').mockResolvedValue([]);

    render(<FiltersPage />);
    await waitFor(() => (host.textContent ?? '').includes('a@почта'), 'список правил');

    // На экране два правила: автофильтр спрятан под флажком.
    expect(host.textContent).not.toContain('auto@почта');

    click(buttonByLabel('Ниже')[0]);
    await waitFor(() => reorder.mock.calls.length > 0, 'сохранение порядка');
    expect(
      reorder.mock.calls[0]?.[0],
      'видимые правила меняются местами, скрытый автофильтр остаётся на своём месте',
    ).toEqual(['b', 'auto', 'a']);
  });
});
