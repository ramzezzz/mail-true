// @vitest-environment jsdom
/**
 * Панель выделения писем.
 *
 * Меню «В папку» — единственное место, где забыли `folderTitle()`, и
 * пользователь видел там служебные имена IMAP: INBOX, Sent, Drafts.
 * Меню раскрывается только по нажатию, поэтому и тест — с настоящим DOM.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import type { Folder } from '@mail-true/shared';
import { ListToolbar, type ListToolbarProps } from '../src/mail/ListToolbar';

let host: HTMLDivElement;
let root: Root;

/** Папки в том виде, в каком их отдаёт сервер: IMAP-имена как есть. */
const folders: Folder[] = [
  {
    id: 'inbox',
    path: 'INBOX',
    name: 'INBOX',
    role: 'inbox',
    parentId: null,
    depth: 0,
    unreadCount: 3,
    totalCount: 187,
    system: true,
    uidValidity: 1,
  },
  {
    id: 'sent',
    path: 'Sent',
    name: 'Sent',
    role: 'sent',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 41,
    system: true,
    uidValidity: 1,
  },
  {
    id: 'drafts',
    path: 'Drafts',
    name: 'Drafts',
    role: 'drafts',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 3,
    system: true,
    uidValidity: 1,
  },
  {
    id: '1',
    path: 'Важное',
    name: 'Важное',
    role: 'custom',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 6,
    system: false,
    uidValidity: 1,
  },
];

const noop = () => undefined;

function props(patch: Partial<ListToolbarProps> = {}): ListToolbarProps {
  return {
    selectedCount: 2,
    filter: 'all',
    onFilterChange: noop,
    folders,
    onSelectAll: noop,
    onClearSelection: noop,
    onMarkAllRead: noop,
    onDelete: noop,
    onArchive: noop,
    onMoveTo: noop,
    onUnsubscribe: noop,
    onMarkUnread: noop,
    onToggleFlag: noop,
    onSpam: noop,
    onPrint: noop,
    onCreateFilter: noop,
    onForwardAsAttachment: noop,
    ...patch,
  };
}

function render(p: ListToolbarProps) {
  act(() => root.render(<ListToolbar {...p} />));
}

/** Кнопка по видимому тексту. */
function button(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('меню «В папку»', () => {
  it('показывает русские названия папок, а не имена IMAP', () => {
    render(props());
    const trigger = button('В папку');
    expect(trigger).toBeDefined();
    act(() => trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const menu = host.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const text = menu!.textContent ?? '';

    expect(text).toContain('Входящие');
    expect(text).toContain('Отправленные');
    expect(text).toContain('Черновики');
    // Пользовательская папка сохраняет собственное имя
    expect(text).toContain('Важное');

    expect(text).not.toContain('INBOX');
    expect(text).not.toContain('Sent');
    expect(text).not.toContain('Drafts');
  });
});

describe('кнопка выделения', () => {
  it('без подписи ведёт себя как раньше', () => {
    render(props({ selectedCount: 0 }));
    expect(button('Выделить все')).toBeDefined();
  });

  it('когда загружено не всё, кнопка говорит об этом честно', () => {
    render(props({ selectedCount: 0, selectAllLabel: 'Выделить загруженные (100 из 187)' }));
    expect(button('Выделить загруженные (100 из 187)')).toBeDefined();
  });
});
