/**
 * Заглушка раздела «Ящики».
 *
 * Форма ответов и, что важнее, форма ОТКАЗОВ списаны с живого сервера
 * (проверено curl-ом, 127.0.0.1:8080, ящик demo@mail.local):
 *
 *   POST /api/accounts/link  неверный пароль
 *     → 401 {"error":"AUTH_FAILED","message":"Неверный адрес или пароль"}
 *   POST /api/accounts/link  свой же адрес
 *     → 400 {"error":"BAD_REQUEST","message":"Это и есть текущий ящик"}
 *   POST /api/accounts/link  уже связанный ящик
 *     → 200 {"linked":[…]}   — сервер не жалуется, связь просто остаётся
 *   POST /api/accounts/switch  несвязанный ящик
 *     → 400 {"error":"BAD_REQUEST","message":"Этот ящик не связан…"}
 *   DELETE /api/accounts/link/:email  несуществующая связь
 *     → 200 {"linked":[…]}   — тоже без жалоб
 *
 * Заглушка, которая на неверный пароль отвечала бы «что-то пошло не так»,
 * скрыла бы ровно ту ошибку, ради которой всё это писалось.
 */

import type { AccountsApi } from '../api/accountsApi';
import type { AccountsOverview, LinkedAccount, UnreadReport } from '../api/accountsTypes';
import { ApiError } from '../api/http';
import { folders } from './mockApi';
import { mockAccount } from './mockData';

/** Пароли «известных» ящиков: без них нельзя проверить отказ 401. */
const KNOWN_PASSWORDS: Record<string, string> = {
  'rabota@mail.true': 'rabota12345',
  'lichnoe@mail.true': 'lichnoe12345',
};

/** Непрочитанные в связанных ящиках — их папки заглушке недоступны. */
const LINKED_UNREAD: Record<string, number> = {
  'rabota@mail.true': 12,
  'lichnoe@mail.true': 3,
};

let current = mockAccount.email;
let nextId = 1;
const linked: LinkedAccount[] = [];

const delay = (ms = 200) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const normalize = (email: string) => email.trim().toLowerCase();

/** Непрочитанные текущего ящика — из тех же папок, что и весь интерфейс. */
function ownUnread(): number {
  return folders.find((f) => f.role === 'inbox')?.unreadCount ?? 0;
}

/** Возврат к исходному состоянию — нужен проверкам, чтобы не влиять друг на друга. */
export function resetMockAccounts(): void {
  current = mockAccount.email;
  nextId = 1;
  linked.length = 0;
}

export const mockAccountsApi: AccountsApi = {
  async getAccounts(): Promise<AccountsOverview> {
    await delay(120);
    return {
      current,
      linked: linked.map((a) => ({ ...a })),
      external: [],
      secrets: { available: true, reason: null },
      collector: { scheduler: true, masterConfigured: true },
    };
  },

  async linkAccount(email, password, label = null) {
    await delay(400);
    const address = normalize(email);
    if (address === normalize(current)) {
      throw new ApiError(400, '/api/accounts/link', 'Это и есть текущий ящик', 'BAD_REQUEST');
    }
    if (KNOWN_PASSWORDS[address] !== password) {
      throw new ApiError(401, '/api/accounts/link', 'Неверный адрес или пароль', 'AUTH_FAILED');
    }
    if (!linked.some((a) => a.email === address)) {
      linked.push({
        id: nextId++,
        email: address,
        label,
        position: linked.length,
        createdAt: new Date().toISOString(),
      });
    }
    return { linked: linked.map((a) => ({ ...a })) };
  },

  async unlinkAccount(email) {
    await delay(200);
    const address = normalize(email);
    const index = linked.findIndex((a) => a.email === address);
    if (index >= 0) linked.splice(index, 1);
    return { linked: linked.map((a) => ({ ...a })) };
  },

  async switchAccount(email) {
    await delay(300);
    const address = normalize(email);
    if (address === normalize(current)) return { ok: true, email: current };
    if (!linked.some((a) => a.email === address)) {
      throw new ApiError(
        400,
        '/api/accounts/switch',
        'Этот ящик не связан с текущим. Сначала добавьте его с вводом пароля.',
        'BAD_REQUEST',
      );
    }
    // Сервер меняет сессию местами: прежний ящик становится связанным.
    const previous = current;
    const entry = linked.find((a) => a.email === address);
    if (entry) entry.email = previous;
    current = address;
    return { ok: true, email: address };
  },

  async getUnread(): Promise<UnreadReport> {
    await delay(250);
    const accounts: UnreadReport['accounts'] = [
      { email: current, kind: 'own', unread: ownUnread(), error: null },
      ...linked.map((a) => ({
        email: a.email,
        kind: 'linked' as const,
        unread: LINKED_UNREAD[a.email] ?? 0,
        error: null,
      })),
    ];
    return { total: accounts.reduce((sum, a) => sum + a.unread, 0), accounts };
  },
};
