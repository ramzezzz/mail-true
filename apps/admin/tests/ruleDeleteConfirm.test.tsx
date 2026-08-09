/**
 * Правило фильтрации удалялось одним нажатием — без вопроса.
 *
 * Соседний файл (destructiveConfirm.test.tsx) в шапке перечисляет три
 * действия «Удалить»: ящик, алиас и правило. Первые два защищены, третье
 * оставалось без ничего: значок корзины стоит вплотную к «Изменить»,
 * промах на один значок стирал правило сразу и насовсем.
 *
 * Вернуть его неоткуда — правила живут в sieve-файле ящика, а не в
 * журнале. Человек при этом настраивал их руками: условия, папку, порядок
 * в цепочке. И замечает пропажу не сразу, а когда письма перестают
 * раскладываться, — то есть тогда, когда связать это с промахом мышью уже
 * невозможно.
 *
 * Проверяется главное свойство, а не наличие окна: после нажатия на
 * корзину запрос на удаление НЕ уходит, пока человек не подтвердил.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deleteUserFilter = vi.fn(async () => undefined);

const RULE = {
  id: 'rule-7',
  enabled: true,
  auto: false,
  conditions: [{ field: 'subject' as const, operator: 'contains' as const, value: 'счёт' }],
  actions: {
    moveToFolderId: 'Buhgalteriya',
    markRead: false,
    markFlagged: false,
    applyToExistingFolderIds: [],
    forwardTo: null,
    autoReply: null,
    continueOtherFilters: false,
    applyToSpam: false,
  },
};

const BUNDLE = {
  mailbox: {
    id: 1,
    email: 'ivan@mail.local',
    displayName: 'Иван',
    domain: 'mail.local',
    active: true,
  },
  general: {
    senderName: 'Иван',
    signatures: [],
    defaultSignatureId: null,
    autoReply: { enabled: false, text: '', from: null, to: null },
    notifications: { browser: false, tabCounter: false },
    quoteOriginalOnReply: true,
    afterDelete: 'list' as const,
    autoCollectContacts: false,
  },
  filters: [RULE],
  folders: [
    { id: 'INBOX', name: 'Входящие', path: 'INBOX', depth: 0, role: 'inbox' },
    { id: 'Buhgalteriya', name: 'Бухгалтерия', path: 'Бухгалтерия', depth: 0, role: 'user' },
  ],
  foldersAvailable: true,
};

vi.mock('../src/api/client', () => ({
  // ErrorNotice сверяется с этим классом, когда мутация отдаёт ошибку.
  ApiError: class ApiError extends Error {},
  api: {
    userSettings: vi.fn(async () => BUNDLE),
    userSieveScript: vi.fn(async () => ({ script: '' })),
    saveUserGeneralSettings: vi.fn(async () => undefined),
    saveUserFilter: vi.fn(async () => undefined),
    deleteUserFilter: (...args: unknown[]) => deleteUserFilter(...(args as [])),
    reorderUserFilters: vi.fn(async () => undefined),
  },
}));

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, session: null }),
}));

vi.mock('../src/app/AdminLayout', () => ({
  PageTitle: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: '1' }) };
});

const { UserSettingsPage } = await import('../src/pages/UserSettingsPage');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  deleteUserFilter.mockClear();
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
          <UserSettingsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
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

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('удаление правила фильтрации', () => {
  it('одно нажатие на корзину НЕ удаляет правило', async () => {
    await render();
    await click(buttonByName(/Удалить/));
    expect(deleteUserFilter).not.toHaveBeenCalled();
  });

  it('в вопросе видно, какое именно правило исчезнет', async () => {
    await render();
    await click(buttonByName(/Удалить/));
    const dialog = document.body.textContent ?? '';
    expect(dialog).toContain('Удалить правило?');
    // Без описания правила вопрос «удалить?» ничего не проверяет: строки
    // в списке похожи, а промахнулись именно строкой.
    expect(dialog).toMatch(/Бухгалтерия|счёт/i);
  });

  it('после подтверждения удаление уходит на сервер', async () => {
    await render();
    await click(buttonByName(/Удалить/));
    const confirmButton = [...document.querySelectorAll('button')].filter(
      (b) => (b.textContent ?? '').trim() === 'Удалить',
    );
    await click(confirmButton[confirmButton.length - 1] as HTMLButtonElement);
    expect(deleteUserFilter).toHaveBeenCalledWith(1, RULE.id);
  });

  it('отмена закрывает вопрос и ничего не удаляет', async () => {
    await render();
    await click(buttonByName(/Удалить/));
    await click(buttonByName(/Отмена/));
    expect(deleteUserFilter).not.toHaveBeenCalled();
    expect(document.body.textContent ?? '').not.toContain('Удалить правило?');
  });
});
