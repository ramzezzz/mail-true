// @vitest-environment jsdom
/**
 * Пустая папка.
 *
 * Было: единственная строка «В этой папке пока пусто», прижатая к верху
 * контейнера высотой 838px, — ни иллюстрации, ни центрирования. Плюс кнопки
 * «Выделить все» и «Отметить все прочитанными» оставались полностью
 * рабочими: выделять и отмечать было нечего, а кнопки обещали действие.
 *
 * Стало: экран с нарисованной кодом иллюстрацией и заголовком по центру
 * свободного места (как у mail.ru) и выключенные кнопки панели.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Folder } from '@mail-true/shared';
import { api } from '../src/api';
import { useUiStore } from '../src/app/store';
import { FolderPage } from '../src/pages/FolderPage';
import { emptyFolderCopy } from '../src/mail/EmptyFolder';

let host: HTMLDivElement;
let root: Root;

const trash: Folder = {
  id: 'trash',
  path: 'Trash',
  name: 'Trash',
  role: 'trash',
  parentId: null,
  depth: 0,
  unreadCount: 0,
  totalCount: 0,
  system: true,
  uidValidity: 1,
};

function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/trash/']}>
          <Routes>
            <Route path="/:folderId/" element={<FolderPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.textContent}`);
}

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ selectedIds: new Set<string>(), notice: null });
  vi.spyOn(api, 'getFolders').mockResolvedValue([trash]);
  vi.spyOn(api, 'getMessages').mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    limit: 100,
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('пустая папка', () => {
  it('показывает иллюстрацию и заголовок, а не одну строку текста', async () => {
    render();
    await waitFor(() => host.textContent!.includes('Корзина пуста'), 'экран пустой папки');

    // Иллюстрация нарисована кодом: это svg в разметке, а не картинка файлом
    const empty = host.querySelector('[class*="EmptyFolder"], [class*="_root_"]');
    expect(empty, 'блока пустого состояния нет').not.toBeNull();
    expect(host.querySelector('svg[viewBox="0 0 160 120"]'), 'иллюстрации нет').not.toBeNull();
    expect(host.querySelector('img'), 'растровых картинок здесь быть не должно').toBeNull();

    // Старой строки больше нет
    expect(host.textContent).not.toContain('В этой папке пока пусто');
  });

  it('кнопки «Выделить все» и «Отметить все прочитанными» выключены', async () => {
    render();
    await waitFor(() => host.textContent!.includes('Корзина пуста'), 'экран пустой папки');

    expect(button('Выделить все')?.disabled, 'выделять нечего').toBe(true);
    expect(button('Отметить все прочитанными')?.disabled, 'отмечать нечего').toBe(true);
  });
});

describe('подпись пустой папки зависит от её роли', () => {
  it('у корзины, спама и черновиков она своя', () => {
    expect(emptyFolderCopy('trash').title).toBe('Корзина пуста');
    expect(emptyFolderCopy('spam').title).toBe('Спама нет');
    expect(emptyFolderCopy('drafts').title).toBe('Черновиков нет');
    // Пользовательская папка — общий текст
    expect(emptyFolderCopy('user-folder-17').title).toBe('В этой папке пусто');
  });
});
