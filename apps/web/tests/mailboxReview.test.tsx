// @vitest-environment jsdom
/**
 * Разбор ящика в интерфейсе: рассылки пачкой и массовая уборка.
 *
 * Проверяется здесь ровно то, из-за чего массовые действия опасны:
 *
 *   1. ни одно удаление не происходит с первого нажатия — сперва
 *      подтверждение, и в нём НАСТОЯЩЕЕ число писем, посчитанное
 *      сервером по тому же отбору, который и уедет;
 *   2. пока это число неизвестно, кнопка выполнения выключена —
 *      соглашаться можно только на известное;
 *   3. выполнение уносит письма в КОРЗИНУ и присылает серверу отметку
 *      разбора, который человек видел;
 *   4. «Отписаться» показывается только там, где отписаться есть чем;
 *   5. в режиме заглушек возможности нет вовсе и кнопки тоже.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Folder } from '@mail-true/shared';
import { ListToolbar } from '../src/mail/ListToolbar';
import { useMailboxReviewAvailable } from '../src/mail/useMailings';
import { MailboxReview } from '../src/mail/MailboxReview';
import {
  formatBytes,
  lastSeenText,
  mailingsApi,
  messagesWord,
  type CleanupState,
  type MailingGroup,
  type MailingsState,
} from '../src/mail/mailingsApi';

/* ------------------------------------------------------------------ */
/* Данные                                                              */
/* ------------------------------------------------------------------ */

const FOLDERS: Folder[] = [
  {
    id: 'inbox',
    path: 'INBOX',
    name: 'INBOX',
    role: 'inbox',
    parentId: null,
    depth: 0,
    unreadCount: 1,
    totalCount: 20,
    system: true,
    uidValidity: 1,
  },
  {
    id: 'archive',
    path: 'Archive',
    name: 'Archive',
    role: 'archive',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 0,
    system: true,
    uidValidity: 1,
  },
  {
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
  },
];

function group(patch: Partial<MailingGroup> = {}): MailingGroup {
  return {
    key: 'list:news.shop.example',
    kind: 'list',
    title: 'Скидки дня',
    address: 'news@shop.example',
    mailing: true,
    count: 12,
    unread: 1,
    bytes: 56_014,
    firstDate: '2025-01-01T00:00:00.000Z',
    lastDate: '2026-08-05T00:00:00.000Z',
    canUnsubscribe: true,
    oneClick: true,
    unsubscribeMessageId: 'inbox:21',
    folders: [{ folderId: 'inbox', count: 12 }],
    quotaShare: 0.05,
    ...patch,
  };
}

const SCAN_AT = '2026-08-06T18:38:47.683Z';

function mailingsState(groups: MailingGroup[]): MailingsState {
  return {
    available: true,
    reason: null,
    at: SCAN_AT,
    scanned: 30,
    total: 30,
    truncated: false,
    limit: 5000,
    quota: { usedBytes: 1_009_664, limitBytes: 1_073_741_824 },
    folders: [
      { folderId: 'inbox', name: 'INBOX', role: 'inbox', total: 26, scanned: 26, bytes: 1_002_568 },
    ],
    groups,
  };
}

function cleanupState(): CleanupState {
  return {
    available: true,
    reason: null,
    at: SCAN_AT,
    scanned: 30,
    total: 30,
    truncated: false,
    limit: 5000,
    quota: { usedBytes: 1_009_664, limitBytes: 1_073_741_824 },
    folders: [
      { folderId: 'inbox', name: 'INBOX', role: 'inbox', total: 26, scanned: 26, bytes: 1_002_568 },
    ],
    heaviest: [
      {
        id: 'inbox:44',
        folderId: 'inbox',
        subject: 'Отчёт за год со сканами',
        from: { name: 'Николай', address: 'nikolay@work.example' },
        date: '2024-12-14T00:00:00.000Z',
        size: 922_008,
        seen: true,
        flagged: false,
      },
    ],
    staleMailings: [],
  };
}

/* ------------------------------------------------------------------ */
/* Показ                                                               */
/* ------------------------------------------------------------------ */

let host: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
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
  throw new Error(`не дождались: ${what}\n${document.body.textContent ?? ''}`);
}

/** Окно рисуется порталом? Нет — прямо в host, но искать проще по документу. */
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

const click = (el: Element) =>
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

const text = (): string => document.body.textContent ?? '';

/**
 * Признак «разбор доступен» без показа компонента. Хук ничего не
 * спрашивает у сервера и состояния не держит — он просто отвечает
 * «мы не на заглушках», поэтому позвать его напрямую здесь законно.
 */
const useMailboxReviewAvailable_forTest = (): boolean => useMailboxReviewAvailable();

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Слова и числа                                                       */
/* ------------------------------------------------------------------ */

describe('числа разбора называются по-русски', () => {
  it('окончание слова «письмо» согласуется с числом', () => {
    expect(messagesWord(1)).toBe('1 письмо');
    expect(messagesWord(3)).toBe('3 письма');
    expect(messagesWord(12)).toBe('12 писем');
    expect(messagesWord(21)).toBe('21 письмо');
    expect(messagesWord(112)).toBe('112 писем');
    expect(messagesWord(0)).toBe('0 писем');
  });

  it('размер берётся у нижней строки состояния, а не пишется заново', () => {
    // Разбор и строка состояния показывают ОДНО И ТО ЖЕ занятое место,
    // и «1,00 ГБ» рядом с «1 ГБ» выглядело бы небрежностью. Здесь это
    // прибито к общему переводчику байт в текст.
    expect(formatBytes(512)).toBe('512 Б');
    expect(formatBytes(2048)).toBe('2 КБ');
    expect(formatBytes(1024 ** 3)).toBe('1 ГБ');
    // Русская запятая, а не точка
    expect(formatBytes(Math.round(3.2 * 1024 ** 3))).toBe('3,2 ГБ');
  });

  it('«последнее письмо» называется словами, а не датой', () => {
    const now = new Date('2026-08-06T12:00:00.000Z');
    expect(lastSeenText('2026-08-06T09:00:00.000Z', now)).toBe('сегодня');
    expect(lastSeenText('2026-08-05T09:00:00.000Z', now)).toBe('вчера');
    expect(lastSeenText('2026-08-01T09:00:00.000Z', now)).toBe('5 дней назад');
    expect(lastSeenText('2024-08-01T09:00:00.000Z', now)).toBe('2 года назад');
  });
});

/* ------------------------------------------------------------------ */
/* Кнопка появляется вместе с поведением                               */
/* ------------------------------------------------------------------ */

describe('кнопка «Разобрать ящик»', () => {
  const toolbarProps = {
    selectedCount: 0,
    filter: 'all' as const,
    onFilterChange: () => undefined,
    folders: FOLDERS,
    onSelectAll: () => undefined,
    onClearSelection: () => undefined,
    onMarkAllRead: () => undefined,
    onDelete: () => undefined,
    onArchive: () => undefined,
    onMoveTo: () => undefined,
    onUnsubscribe: () => undefined,
    onMarkUnread: () => undefined,
    onToggleFlag: () => undefined,
    onSpam: () => undefined,
    onPrint: () => undefined,
    onCreateFilter: () => undefined,
    onForwardAsAttachment: () => undefined,
  };

  it('без возможности кнопки нет вовсе', () => {
    render(<ListToolbar {...toolbarProps} />);
    expect(button('Разобрать ящик')).toBeUndefined();
  });

  it('с возможностью кнопка есть и открывает разбор', () => {
    let opened = 0;
    render(<ListToolbar {...toolbarProps} onReview={() => (opened += 1)} />);
    const control = button('Разобрать ящик');
    expect(control).toBeDefined();
    click(control!);
    expect(opened).toBe(1);
  });
});

describe('режим заглушек', () => {
  /*
   * Проверки идут в том же режиме, что и dev-сборка, — на заглушках
   * (VITE_API_MOCK не выставлен). Это и позволяет проверить главное:
   * разбор в этом режиме НЕ ходит в настоящий /api. Пошёл бы — получил
   * бы 401 без сессии, и общий обработчик увёл бы человека на экран
   * входа из режима, где входа не предполагается.
   */
  it('на заглушках запроса нет вовсе, а возможность честно выключена', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const state = await mailingsApi.getMailings();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.available).toBe(false);
    expect(state.reason).toBe('На заглушечных данных ящик разбирать нечего');
    // «Возможности нет» — это не «рассылок нет»: список пуст, но окно
    // при available: false и не должно открываться.
    expect(state.groups).toEqual([]);

    const cleanup = await mailingsApi.getCleanup();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cleanup.available).toBe(false);

    // И кнопки в панели тоже нет — её включает та же самая проверка
    expect(useMailboxReviewAvailable_forTest()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Отписка                                                             */
/* ------------------------------------------------------------------ */

describe('отписка пачкой', () => {
  it('кнопки «Отписаться» нет там, где отписаться нечем', async () => {
    vi.spyOn(mailingsApi, 'getMailings').mockResolvedValue(
      mailingsState([
        group({ key: 'from:kolya@example.com', title: 'Коллега', canUnsubscribe: false }),
      ]),
    );
    render(<MailboxReview onClose={() => undefined} folders={FOLDERS} />);
    await waitFor(() => text().includes('Коллега'), 'строка разбора');
    expect(button('Отписаться')).toBeUndefined();
    // Обратный ход: удалить всё от него всё равно можно
    expect(button('Удалить все')).toBeDefined();
  });

  it('отписка уходит по ключу группы и не трогает письма', async () => {
    vi.spyOn(mailingsApi, 'getMailings').mockResolvedValue(mailingsState([group()]));
    const unsubscribe = vi.spyOn(mailingsApi, 'unsubscribe').mockResolvedValue({
      ok: true,
      method: 'one-click',
      url: 'https://shop.example/u/1',
      key: 'list:news.shop.example',
      title: 'Скидки дня',
    });
    const sweep = vi.spyOn(mailingsApi, 'sweep');

    render(<MailboxReview onClose={() => undefined} folders={FOLDERS} />);
    await waitFor(() => Boolean(button('Отписаться')), 'кнопка отписки');
    click(button('Отписаться')!);
    await waitFor(() => unsubscribe.mock.calls.length === 1, 'запрос отписки');
    expect(unsubscribe.mock.calls[0]?.[0]).toBe('list:news.shop.example');
    // Отписка и удаление — два разных действия: письма не тронуты
    expect(sweep).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Массовое удаление — самое опасное место                             */
/* ------------------------------------------------------------------ */

describe('массовое удаление', () => {
  it('первое нажатие только считает и показывает число ДО удаления', async () => {
    vi.spyOn(mailingsApi, 'getMailings').mockResolvedValue(mailingsState([group()]));
    const sweep = vi.spyOn(mailingsApi, 'sweep').mockResolvedValue({
      dryRun: true,
      at: SCAN_AT,
      count: 12,
      bytes: 56_014,
      oldest: '2025-01-01T00:00:00.000Z',
      newest: '2026-08-05T00:00:00.000Z',
      unread: 1,
      flagged: 0,
      moved: 0,
      targetFolderId: null,
    });

    render(<MailboxReview onClose={() => undefined} folders={FOLDERS} />);
    await waitFor(() => Boolean(button('Удалить все')), 'кнопка удаления');
    click(button('Удалить все')!);

    await waitFor(() => sweep.mock.calls.length === 1, 'сухой прогон');
    // Первый запрос ОБЯЗАН быть сухим: нажатие «Удалить все» ничего не удаляет
    expect(sweep.mock.calls[0]?.[0]).toMatchObject({
      dryRun: true,
      groupKey: 'list:news.shop.example',
      targetFolderId: 'trash',
      scanAt: SCAN_AT,
    });

    // И человек видит настоящее число, а не «вы уверены?»
    await waitFor(() => text().includes('12 писем'), 'число в подтверждении');
    expect(text()).toContain('Уедет в корзину');
    expect(text()).toContain('из них непрочитанных: 1');
  });

  it('пока число неизвестно, соглашаться не на что: кнопка выключена', async () => {
    vi.spyOn(mailingsApi, 'getMailings').mockResolvedValue(mailingsState([group()]));
    // Сухой прогон, который никогда не отвечает
    vi.spyOn(mailingsApi, 'sweep').mockReturnValue(new Promise(() => undefined));

    render(<MailboxReview onClose={() => undefined} folders={FOLDERS} />);
    await waitFor(() => Boolean(button('Удалить все')), 'кнопка удаления');
    click(button('Удалить все')!);
    await waitFor(() => text().includes('Считаем'), 'подсчёт');
    expect(button('Убрать')?.hasAttribute('disabled')).toBe(true);
  });

  it('подтверждение уносит письма в корзину и присылает отметку разбора', async () => {
    vi.spyOn(mailingsApi, 'getMailings').mockResolvedValue(mailingsState([group()]));
    const sweep = vi.spyOn(mailingsApi, 'sweep').mockImplementation((request) =>
      Promise.resolve({
        dryRun: request.dryRun,
        at: SCAN_AT,
        count: 12,
        bytes: 56_014,
        oldest: null,
        newest: null,
        unread: 0,
        flagged: 0,
        moved: request.dryRun ? 0 : 12,
        targetFolderId: request.dryRun ? null : 'trash',
      }),
    );

    render(<MailboxReview onClose={() => undefined} folders={FOLDERS} />);
    await waitFor(() => Boolean(button('Удалить все')), 'кнопка удаления');
    click(button('Удалить все')!);
    await waitFor(() => text().includes('12 писем'), 'число в подтверждении');

    click(button('Убрать')!);
    await waitFor(() => sweep.mock.calls.length === 2, 'выполнение');
    const run = sweep.mock.calls[1]?.[0];
    expect(run).toMatchObject({
      dryRun: false,
      groupKey: 'list:news.shop.example',
      // Только в корзину — необратимого удаления отсюда не бывает
      targetFolderId: 'trash',
      // Отметка разбора: сервер откажет, если числа с тех пор изменились
      scanAt: SCAN_AT,
    });
  });

  it('отмена в подтверждении не выполняет ничего', async () => {
    vi.spyOn(mailingsApi, 'getMailings').mockResolvedValue(mailingsState([group()]));
    const sweep = vi.spyOn(mailingsApi, 'sweep').mockResolvedValue({
      dryRun: true,
      at: SCAN_AT,
      count: 12,
      bytes: 56_014,
      oldest: null,
      newest: null,
      unread: 0,
      flagged: 0,
      moved: 0,
      targetFolderId: null,
    });

    render(<MailboxReview onClose={() => undefined} folders={FOLDERS} />);
    await waitFor(() => Boolean(button('Удалить все')), 'кнопка удаления');
    click(button('Удалить все')!);
    await waitFor(() => text().includes('12 писем'), 'число в подтверждении');
    click(button('Отмена')!);
    await waitFor(() => Boolean(button('Удалить все')), 'возврат к списку');
    // Сухой прогон был, выполнения не было
    expect(sweep.mock.calls.every((call) => call[0].dryRun)).toBe(true);
  });

  it('«кроме последнего» просит сервер сохранить самое свежее письмо', async () => {
    vi.spyOn(mailingsApi, 'getMailings').mockResolvedValue(mailingsState([group()]));
    const sweep = vi.spyOn(mailingsApi, 'sweep').mockResolvedValue({
      dryRun: true,
      at: SCAN_AT,
      count: 11,
      bytes: 51_000,
      oldest: null,
      newest: null,
      unread: 0,
      flagged: 0,
      moved: 0,
      targetFolderId: null,
    });

    render(<MailboxReview onClose={() => undefined} folders={FOLDERS} />);
    await waitFor(() => Boolean(button('Кроме последнего')), 'кнопка');
    click(button('Кроме последнего')!);
    await waitFor(() => sweep.mock.calls.length === 1, 'сухой прогон');
    expect(sweep.mock.calls[0]?.[0]).toMatchObject({ keepLatest: 1, dryRun: true });
  });
});

/* ------------------------------------------------------------------ */
/* Свободное место                                                     */
/* ------------------------------------------------------------------ */

describe('свободное место', () => {
  it('квота показывается числами почтового сервера, а не суммой размеров', async () => {
    vi.spyOn(mailingsApi, 'getCleanup').mockResolvedValue(cleanupState());
    render(<MailboxReview onClose={() => undefined} folders={FOLDERS} initialTab="space" />);
    await waitFor(() => text().includes('Занято'), 'квота');
    expect(text()).toContain('986 КБ');
    expect(text()).toContain('1 ГБ');
    expect(text()).toContain('Считает сам почтовый сервер');
  });

  it('кнопка удаления тяжёлых писем называет число и место до нажатия', async () => {
    vi.spyOn(mailingsApi, 'getCleanup').mockResolvedValue(cleanupState());
    render(<MailboxReview onClose={() => undefined} folders={FOLDERS} initialTab="space" />);
    await waitFor(() => text().includes('Отчёт за год'), 'тяжёлое письмо');
    // Пока ничего не выбрано, кнопка не обещает действия
    expect(button('Выберите письма')).toBeDefined();

    // Флажок строки письма — тот, у которого нет подписи: подписанные
    // флажки в этом окне принадлежат условиям уборки.
    const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => (input.closest('label')?.textContent ?? '') === '',
    );
    expect(checkbox).toBeTruthy();
    act(() => checkbox!.click());
    await waitFor(() => Boolean(button('Убрать в корзину')), 'кнопка с числом');
    expect(button('Убрать в корзину')?.textContent).toContain('1 письмо');
    expect(button('Убрать в корзину')?.textContent).toContain('900 КБ');
  });

  it('уборка старого предупреждает, что корзину и черновики не трогает', async () => {
    vi.spyOn(mailingsApi, 'getCleanup').mockResolvedValue(cleanupState());
    render(<MailboxReview onClose={() => undefined} folders={FOLDERS} initialTab="space" />);
    await waitFor(() => text().includes('Убрать всё старое'), 'раздел уборки');
    expect(text()).toContain('Корзина, черновики и отложенные письма не убираются никогда');
  });
});

/* ------------------------------------------------------------------ */
/* Честность чисел                                                     */
/* ------------------------------------------------------------------ */

describe('разбор не выдаёт часть ящика за весь', () => {
  it('усечённый осмотр говорит об этом прямо', async () => {
    vi.spyOn(mailingsApi, 'getMailings').mockResolvedValue({
      ...mailingsState([group()]),
      scanned: 5000,
      total: 21_000,
      truncated: true,
    });
    render(<MailboxReview onClose={() => undefined} folders={FOLDERS} />);
    await waitFor(() => text().includes('это не весь ящик'), 'предупреждение');
    expect(text()).toContain('Осмотрено 5000 писем из 21000');
  });
});
