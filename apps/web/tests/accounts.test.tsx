// @vitest-environment jsdom
/**
 * Несколько ящиков в одном интерфейсе.
 *
 * Сервер умеет это давно — `/api/accounts/*` (apps/api/src/accounts/routes.ts,
 * docs/api.md), — а в вебе не было ни одного обращения к этим маршрутам:
 * возможность существовала и была человеку недоступна.
 *
 * Все ответы и отказы ниже сняты с живого стенда (127.0.0.1:8080, ящики
 * demo@mail.local и test@mail.local):
 *
 *   GET  /api/accounts
 *     {"current":"demo@mail.local",
 *      "linked":[{"id":23,"email":"test@mail.local","label":null,
 *                 "position":0,"createdAt":"2026-08-05T13:00:00.975Z"}],
 *      "external":[…],"secrets":{"available":true,"reason":null},
 *      "collector":{"scheduler":true,"masterConfigured":true}}
 *   GET  /api/accounts/unread
 *     {"total":342,"accounts":[
 *        {"email":"demo@mail.local","kind":"own","unread":6,"error":null},
 *        {"email":"test@mail.local","kind":"linked","unread":336,"error":null}]}
 *   POST /api/accounts/link  {"email":"test@mail.local","password":"wrongpass"}
 *     → 401 {"error":"AUTH_FAILED","message":"Неверный адрес или пароль"}
 *   POST /api/accounts/link  свой же адрес
 *     → 400 {"error":"BAD_REQUEST","message":"Это и есть текущий ящик"}
 *   POST /api/accounts/link  уже связанный ящик
 *     → 200 {"linked":[…]}  — сервер молча оставляет всё как было
 *   POST /api/accounts/switch {"email":"test@mail.local"}
 *     → {"ok":true,"email":"test@mail.local"} и новая cookie сессии
 *   DELETE /api/accounts/link/demo%40mail.local → 200 {"linked":[]}
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Account, Folder } from '@mail-true/shared';
import { accountsApi, api, settingsApi } from '../src/api';
import { httpAccountsApi } from '../src/api/accountsApi';
import type { AccountsOverview, UnreadReport } from '../src/api/accountsTypes';
import { ApiError, setUnauthorizedHandler } from '../src/api/http';
import type { GeneralSettings } from '../src/api/settingsTypes';
import { MailNotifications } from '../src/app/MailNotifications';
import { SessionProvider } from '../src/app/session';
import { AccountMenu, badgeText } from '../src/layout/AccountMenu';
import { linkErrorText } from '../src/lib/errorText';
import { mockAccountsApi, resetMockAccounts } from '../src/mocks/mockAccounts';

let host: HTMLDivElement;
let root: Root;

/* ------------------------------------------------------------------ */
/* Данные живого стенда                                                 */
/* ------------------------------------------------------------------ */

const account: Account = {
  id: 'demo@mail.local',
  email: 'demo@mail.local',
  displayName: 'Демо Пользователь',
  avatarUrl: null,
  quotaUsedBytes: 34_644_992,
  quotaLimitBytes: 1_073_741_824,
  signature: '',
  createdAt: '2026-08-05T01:56:56.454Z',
};

const overview: AccountsOverview = {
  current: 'demo@mail.local',
  linked: [
    {
      id: 23,
      email: 'test@mail.local',
      label: null,
      position: 0,
      createdAt: '2026-08-05T13:00:00.975Z',
    },
  ],
  external: [],
  secrets: { available: true, reason: null },
  collector: { scheduler: true, masterConfigured: true },
};

const unread: UnreadReport = {
  total: 342,
  accounts: [
    { email: 'demo@mail.local', kind: 'own', unread: 6, error: null },
    { email: 'test@mail.local', kind: 'linked', unread: 336, error: null },
  ],
};

const folders: Folder[] = [
  {
    id: 'inbox',
    path: 'INBOX',
    name: 'INBOX',
    role: 'inbox',
    parentId: null,
    depth: 0,
    unreadCount: 6,
    totalCount: 295,
    system: true,
    uidValidity: 1_785_895_020,
  },
];

function serverSettings(patch: Partial<GeneralSettings> = {}): GeneralSettings {
  return {
    senderName: '',
    signatures: [],
    defaultSignatureId: null,
    autoReply: { enabled: false, text: '', from: null, to: null },
    notifications: { browser: false, tabCounter: true },
    quoteOriginalOnReply: true,
    afterDelete: 'list',
    autoCollectContacts: true,
    ...patch,
  };
}

/* ------------------------------------------------------------------ */
/* Оснастка                                                             */
/* ------------------------------------------------------------------ */

/** Подменяет fetch и запоминает, что именно ушло на сервер. */
function stubFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'stub',
        json: async () => response,
      } as unknown as Response;
    }),
  );
  return calls;
}

let client: QueryClient;

/** Меню ящика живёт внутри сессии: переключение — её работа. */
function render(ui: React.ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SessionProvider>{ui}</SessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`не дождались: ${what}`);
}

const text = () => host.textContent ?? '';

function buttonWith(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(label),
  );
  if (!found) throw new Error(`нет кнопки «${label}» (есть: ${text()})`);
  return found as HTMLButtonElement;
}

/** Открывает меню ящика и дожидается списка. */
async function openMenu() {
  const avatar = host.querySelector<HTMLButtonElement>('button[aria-label^="Меню ящика"]');
  if (!avatar) throw new Error('в шапке нет кнопки меню ящика');
  await act(async () => {
    avatar.click();
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  resetMockAccounts();
  vi.spyOn(api, 'getAccount').mockResolvedValue(account);
  vi.spyOn(api, 'getFolders').mockResolvedValue(folders);
  vi.spyOn(api, 'getSession').mockResolvedValue({ authenticated: true, email: account.email });
  vi.spyOn(api, 'subscribe').mockReturnValue(() => {});
  vi.spyOn(api, 'getAiState').mockResolvedValue({
    enabled: false,
  } as unknown as Awaited<ReturnType<typeof api.getAiState>>);
  vi.spyOn(accountsApi, 'getAccounts').mockResolvedValue(overview);
  vi.spyOn(accountsApi, 'getUnread').mockResolvedValue(unread);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setUnauthorizedHandler(null);
  resetMockAccounts();
  document.title = 'Почта — Mail.True';
});

/* ------------------------------------------------------------------ */
/* Договор с сервером                                                   */
/* ------------------------------------------------------------------ */

describe('клиент раздела «Ящики» ходит по настоящим маршрутам сервера', () => {
  it('список ящиков читается с GET /api/accounts', async () => {
    const calls = stubFetch(overview);
    await expect(httpAccountsApi.getAccounts()).resolves.toEqual(overview);
    expect(calls[0]?.url).toBe('/api/accounts');
  });

  it('общий счётчик читается с GET /api/accounts/unread', async () => {
    const calls = stubFetch(unread);
    await expect(httpAccountsApi.getUnread()).resolves.toEqual(unread);
    expect(calls[0]?.url).toBe('/api/accounts/unread');
  });

  it('связывание уходит на POST /api/accounts/link с адресом, паролем и меткой', async () => {
    const calls = stubFetch({ linked: overview.linked });
    await httpAccountsApi.linkAccount('test@mail.local', 'test12345');
    expect(calls[0]?.url).toBe('/api/accounts/link');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: 'test@mail.local',
      password: 'test12345',
      label: null,
    });
  });

  it('переключение уходит на POST /api/accounts/switch', async () => {
    const calls = stubFetch({ ok: true, email: 'test@mail.local' });
    await httpAccountsApi.switchAccount('test@mail.local');
    expect(calls[0]?.url).toBe('/api/accounts/switch');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ email: 'test@mail.local' });
  });

  it('отвязка уходит на DELETE /api/accounts/link/:адрес и БЕЗ тела', async () => {
    const calls = stubFetch({ linked: [] });
    await httpAccountsApi.unlinkAccount('demo@mail.local');
    expect(calls[0]?.url).toBe('/api/accounts/link/demo%40mail.local');
    expect(calls[0]?.init?.method).toBe('DELETE');
    // Заявленный JSON при пустом теле сервер отвергает — на этом здесь
    // уже обжигались девятью операциями сразу (см. api/http.ts)
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(
      (calls[0]?.init?.headers as Record<string, string> | undefined)?.['Content-Type'],
    ).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Отказ 401 при добавлении ящика                                       */
/* ------------------------------------------------------------------ */

describe('неверный пароль добавляемого ящика', () => {
  it('не выбрасывает человека из почты: 401 AUTH_FAILED — про чужой пароль, а не про нашу сессию', async () => {
    const kicked = vi.fn();
    setUnauthorizedHandler(kicked);
    stubFetch({ error: 'AUTH_FAILED', message: 'Неверный адрес или пароль' }, 401);

    await expect(httpAccountsApi.linkAccount('test@mail.local', 'wrongpass')).rejects.toThrow(
      'Неверный адрес или пароль',
    );
    // Раньше любой 401 вне /api/auth/ означал «сессии больше нет», и опечатка
    // в пароле добавляемого ящика уводила на экран входа
    expect(kicked).not.toHaveBeenCalled();
  });

  it('а вот 401 UNAUTHORIZED — это уже про нашу сессию, и он уводит на вход', async () => {
    const kicked = vi.fn();
    setUnauthorizedHandler(kicked);
    stubFetch({ error: 'UNAUTHORIZED', message: 'Требуется вход в систему' }, 401);

    await expect(httpAccountsApi.getAccounts()).rejects.toThrow('Требуется вход в систему');
    expect(kicked).toHaveBeenCalledTimes(1);
  });

  it('называется словами сервера, а не «Сессия закончилась — войдите заново»', () => {
    const error = new ApiError(
      401,
      '/api/accounts/link',
      'Неверный адрес или пароль',
      'AUTH_FAILED',
    );
    expect(linkErrorText(error)).toBe('Неверный адрес или пароль');
    expect(linkErrorText(error)).not.toContain('Сессия');
  });
});

/* ------------------------------------------------------------------ */
/* Меню ящика в шапке                                                   */
/* ------------------------------------------------------------------ */

describe('меню ящика в шапке', () => {
  it('показывает привязанные ящики и непрочитанные у каждого', async () => {
    render(<AccountMenu />);
    await waitFor(() => text().includes('ДП'), 'загрузку ящика');
    await openMenu();

    // Раньше в меню был один пункт-надпись с адресом и «Выйти»
    expect(text()).toContain('demo@mail.local');
    expect(text()).toContain('test@mail.local');
    // 336 непрочитанных связанного ящика — то, что отдал сервер
    await waitFor(() => text().includes('99+'), 'счётчик связанного ящика');
  });

  it('общий счётчик по всем ящикам виден на значке в шапке', async () => {
    render(<AccountMenu />);
    // 342 = 6 своих + 336 связанного, ровно как в ответе /api/accounts/unread
    await waitFor(
      () =>
        host.querySelector('button[aria-label^="Меню ящика"]')?.getAttribute('aria-label') ===
        'Меню ящика, непрочитанных во всех ящиках: 342',
      'общий счётчик на аватаре',
    );
    // В кружок помещается «99+», а не «342»
    expect(badgeText(342)).toBe('99+');
    expect(badgeText(6)).toBe('6');
  });

  it('предлагает добавить ящик и выйти', async () => {
    render(<AccountMenu />);
    await waitFor(() => text().includes('ДП'), 'загрузку ящика');
    await openMenu();
    expect(() => buttonWith('Добавить ящик')).not.toThrow();
    expect(() => buttonWith('Выйти')).not.toThrow();
  });

  it('ящик, который не ответил, показан со знаком, а не с нулём непрочитанных', async () => {
    vi.spyOn(accountsApi, 'getUnread').mockResolvedValue({
      total: 6,
      accounts: [
        { email: 'demo@mail.local', kind: 'own', unread: 6, error: null },
        {
          email: 'test@mail.local',
          kind: 'linked',
          unread: 0,
          error: 'Invalid credentials',
        },
      ],
    });
    render(<AccountMenu />);
    await waitFor(() => text().includes('ДП'), 'загрузку ящика');
    await openMenu();
    await waitFor(
      () => host.querySelector('[title="Invalid credentials"]') !== null,
      'знак недоступного ящика',
    );
  });
});

/* ------------------------------------------------------------------ */
/* Переключение                                                         */
/* ------------------------------------------------------------------ */

describe('переключение на другой ящик', () => {
  it('нажатие на ящик в меню переключает сессию на сервере', async () => {
    const doSwitch = vi
      .spyOn(accountsApi, 'switchAccount')
      .mockResolvedValue({ ok: true, email: 'test@mail.local' });
    vi.spyOn(api, 'getSession').mockResolvedValue({
      authenticated: true,
      email: 'test@mail.local',
    });

    render(<AccountMenu />);
    await waitFor(() => text().includes('ДП'), 'загрузку ящика');
    await openMenu();
    await waitFor(() => text().includes('test@mail.local'), 'список ящиков');

    await act(async () => {
      buttonWith('test@mail.local').click();
    });
    expect(doSwitch).toHaveBeenCalledWith('test@mail.local');
  });

  it('после переключения меню закрывается, а не висит поверх новой почты', async () => {
    vi.spyOn(accountsApi, 'switchAccount').mockResolvedValue({
      ok: true,
      email: 'test@mail.local',
    });
    render(<AccountMenu />);
    await waitFor(() => text().includes('ДП'), 'загрузку ящика');
    await openMenu();
    await waitFor(() => text().includes('test@mail.local'), 'список ящиков');
    expect(host.querySelector('[role=menu]')).not.toBeNull();

    await act(async () => {
      buttonWith('test@mail.local').click();
    });
    // Строка ящика нарисована не через MenuItem и сама себя не закрывала
    await waitFor(() => host.querySelector('[role=menu]') === null, 'закрытие меню');
  });

  it('после переключения в кэше не остаётся писем прежнего ящика', async () => {
    vi.spyOn(accountsApi, 'switchAccount').mockResolvedValue({
      ok: true,
      email: 'test@mail.local',
    });
    vi.spyOn(api, 'getSession').mockResolvedValue({
      authenticated: true,
      email: 'test@mail.local',
    });

    render(<AccountMenu />);
    await waitFor(() => text().includes('ДП'), 'загрузку ящика');

    // Письма прежнего ящика в кэше — за ними никто не следит, сами они
    // не перезапросятся, и без явной очистки они пережили бы переключение
    const stale = ['messages', 'list', 'inbox', 'all', false];
    client.setQueryData(stale, { pages: [{ items: [{ id: 'inbox:1' }] }] });
    expect(client.getQueryData(stale)).toBeDefined();

    await openMenu();
    await waitFor(() => text().includes('test@mail.local'), 'список ящиков');
    await act(async () => {
      buttonWith('test@mail.local').click();
    });

    expect(client.getQueryData(stale)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Добавление ящика                                                     */
/* ------------------------------------------------------------------ */

describe('окно «Добавить ящик»', () => {
  async function openDialog() {
    render(<AccountMenu />);
    await waitFor(() => text().includes('ДП'), 'загрузку ящика');
    await openMenu();
    await act(async () => {
      buttonWith('Добавить ящик').click();
    });
  }

  function fill(email: string, password: string) {
    const [address, secret] = [
      host.querySelector<HTMLInputElement>('input[type="email"]'),
      host.querySelector<HTMLInputElement>('input[type="password"]'),
    ];
    if (!address || !secret) throw new Error('в окне нет полей адреса и пароля');
    act(() => {
      setInputValue(address, email);
      setInputValue(secret, password);
    });
  }

  it('на неверный пароль показывает текст сервера, а не «что-то пошло не так»', async () => {
    vi.spyOn(accountsApi, 'linkAccount').mockRejectedValue(
      new ApiError(401, '/api/accounts/link', 'Неверный адрес или пароль', 'AUTH_FAILED'),
    );
    await openDialog();
    fill('drugoi@mail.local', 'nepravilnyi');
    await act(async () => {
      buttonWith('Добавить').click();
    });
    await waitFor(() => text().includes('Неверный адрес или пароль'), 'текст отказа');
    expect(text()).not.toContain('Что-то пошло не так');
    expect(text()).not.toContain('Сессия закончилась');
  });

  it('уже привязанный ящик второй раз на сервер не отправляет', async () => {
    const link = vi.spyOn(accountsApi, 'linkAccount');
    await openDialog();
    // Сервер на повторное связывание отвечает 200 и молча ничего не меняет —
    // человек нажал бы «Добавить» и не понял, почему ничего не произошло
    fill('test@mail.local', 'test12345');
    await act(async () => {
      buttonWith('Добавить').click();
    });
    await waitFor(() => text().includes('Этот ящик уже добавлен'), 'отказ про дубль');
    expect(link).not.toHaveBeenCalled();
  });

  it('свой же адрес на сервер не отправляет', async () => {
    const link = vi.spyOn(accountsApi, 'linkAccount');
    await openDialog();
    fill('demo@mail.local', 'demo12345');
    await act(async () => {
      buttonWith('Добавить').click();
    });
    await waitFor(() => text().includes('Это и есть текущий ящик'), 'отказ про свой ящик');
    expect(link).not.toHaveBeenCalled();
  });

  it('связывает ящик и просит пароль ровно один раз', async () => {
    const link = vi
      .spyOn(accountsApi, 'linkAccount')
      .mockResolvedValue({ linked: overview.linked });
    await openDialog();
    fill('vtoroi@mail.local', 'vtoroi12345');
    await act(async () => {
      buttonWith('Добавить').click();
    });
    expect(link).toHaveBeenCalledWith('vtoroi@mail.local', 'vtoroi12345', null);
  });
});

/** Ввод в поле React: голая присвоенная value не поднимает onChange. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ------------------------------------------------------------------ */
/* Отвязка                                                              */
/* ------------------------------------------------------------------ */

describe('отвязка ящика', () => {
  it('спрашивает подтверждение и снимает связь на сервере', async () => {
    const remove = vi.spyOn(accountsApi, 'unlinkAccount').mockResolvedValue({ linked: [] });
    render(<AccountMenu />);
    await waitFor(() => text().includes('ДП'), 'загрузку ящика');
    await openMenu();
    await waitFor(() => text().includes('test@mail.local'), 'список ящиков');

    const unlink = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Отвязать ящик test@mail.local"]',
    );
    expect(unlink, 'кнопки отвязки нет в меню').not.toBeNull();
    await act(async () => {
      unlink!.click();
    });

    // Связь рвётся в обе стороны и без пароля обратно не восстановится —
    // спрашиваем прежде, чем делать
    expect(text()).toContain('Отвязать test@mail.local?');
    expect(remove).not.toHaveBeenCalled();

    await act(async () => {
      buttonWith('Отвязать').click();
    });
    expect(remove).toHaveBeenCalledWith('test@mail.local');
  });
});

/* ------------------------------------------------------------------ */
/* Общий счётчик во вкладке                                             */
/* ------------------------------------------------------------------ */

describe('счётчик непрочитанных в заголовке вкладки', () => {
  beforeEach(() => {
    document.title = 'Почта — Mail.True';
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings());
  });

  it('считает по всем ящикам, а не только по текущему', async () => {
    render(<MailNotifications />);
    // Раньше в заголовок шли только «Входящие» текущего ящика — (6),
    // и о 336 письмах в связанном ящике человек не узнавал вовсе
    await waitFor(() => document.title === '(342) Почта — Mail.True', 'общий счётчик');
  });

  it('пока общий счётчик не пришёл, показывает непрочитанные текущего ящика', async () => {
    // Раздел ящиков на сервере может быть не поднят (нет миграции) —
    // счётчик не должен исчезать совсем
    vi.spyOn(accountsApi, 'getUnread').mockRejectedValue(new Error('нет раздела ящиков'));
    render(<MailNotifications />);
    await waitFor(() => document.title === '(6) Почта — Mail.True', 'запасной счётчик');
  });
});

/* ------------------------------------------------------------------ */
/* Заглушка отвечает как сервер                                         */
/* ------------------------------------------------------------------ */

describe('заглушка ящиков отвечает так же, как сервер', () => {
  // Подмены из общего beforeEach сидят на том же объекте (в проверках
  // `accountsApi` — это и есть заглушка), и без их снятия мы проверяли бы
  // сами подмены, а не заглушку.
  beforeEach(() => {
    vi.restoreAllMocks();
    resetMockAccounts();
  });

  it('на неверный пароль — 401 AUTH_FAILED', async () => {
    await expect(
      mockAccountsApi.linkAccount('rabota@mail.true', 'nepravilnyi'),
    ).rejects.toMatchObject({ status: 401, code: 'AUTH_FAILED' });
  });

  it('на свой же адрес — 400 «Это и есть текущий ящик»', async () => {
    const { current } = await mockAccountsApi.getAccounts();
    await expect(mockAccountsApi.linkAccount(current, 'lyuboi')).rejects.toMatchObject({
      status: 400,
      message: 'Это и есть текущий ящик',
    });
  });

  it('повторное связывание принимает молча — как сервер', async () => {
    await mockAccountsApi.linkAccount('rabota@mail.true', 'rabota12345');
    const again = await mockAccountsApi.linkAccount('rabota@mail.true', 'rabota12345');
    expect(again.linked.filter((a) => a.email === 'rabota@mail.true')).toHaveLength(1);
  });

  it('на переключение в несвязанный ящик — 400 с объяснением', async () => {
    await expect(mockAccountsApi.switchAccount('chuzhoi@mail.true')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('отвязка несуществующей связи проходит без жалоб — как сервер', async () => {
    await expect(mockAccountsApi.unlinkAccount('nikogo@mail.true')).resolves.toEqual({
      linked: [],
    });
  });

  it('общий счётчик — сумма по всем ящикам', async () => {
    await mockAccountsApi.linkAccount('rabota@mail.true', 'rabota12345');
    const report = await mockAccountsApi.getUnread();
    expect(report.total).toBe(report.accounts.reduce((sum, a) => sum + a.unread, 0));
    expect(report.accounts.map((a) => a.kind)).toEqual(['own', 'linked']);
  });
});

/* ------------------------------------------------------------------ */
/* Узкий экран                                                          */
/* ------------------------------------------------------------------ */

const readCss = (file: string) => readFileSync(resolve(__dirname, '..', 'src', file), 'utf8');

/** Правила внутри @media (max-width: <= width). */
function narrowRules(css: string, width: number): string {
  let out = '';
  const re = /@media[^{]*\(max-width:\s*(\d+)px\)[^{]*\{/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    if (Number(match[1]) > width) continue;
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') depth -= 1;
    }
    out += css.slice(re.lastIndex, i - 1);
  }
  return out;
}

describe('меню ящика на узком экране', () => {
  it('не шире экрана телефона', () => {
    const css = readCss('layout/AccountMenu.module.css');
    // 300px меню у правого края 390px экрана вылезало бы за границу
    expect(css).toMatch(/\.menu\s*\{[^}]*max-width:\s*calc\(100vw - 16px\)/);
    expect(narrowRules(css, 480)).toMatch(/\.menu\s*\{[^}]*width:\s*calc\(100vw - 16px\)/);
  });

  it('цели касания на телефоне не меньше 44px', () => {
    const narrow = narrowRules(readCss('layout/AccountMenu.module.css'), 480);
    expect(narrow).toMatch(/\.avatar\s*\{[^}]*height:\s*44px/);
    expect(narrow).toMatch(/\.mailbox,\s*\.unlink\s*\{[^}]*height:\s*44px/);
  });

  it('кнопка отвязки достижима там, где наведения нет вовсе', () => {
    const css = readCss('layout/AccountMenu.module.css');
    // На сенсорном экране :hover не наступает, и спрятанная кнопка была бы
    // недоступна навсегда
    expect(css).toMatch(/@media\s*\(hover:\s*none\)\s*\{[^}]*\.unlink\s*\{[^}]*opacity:\s*1/);
  });
});
