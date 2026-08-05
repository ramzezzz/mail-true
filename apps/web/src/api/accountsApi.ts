/**
 * Клиент раздела «Ящики» (/api/accounts).
 *
 * В отличие от `settingsApi.ts`, все маршруты ниже на сервере ЕСТЬ и
 * проверены запросами (apps/api/src/accounts/routes.ts, docs/api.md):
 *
 *   GET    /api/accounts               → текущий, связанные свои, чужие
 *   POST   /api/accounts/link          ← {email, password, label}
 *   DELETE /api/accounts/link/:email   → {linked: […]}
 *   POST   /api/accounts/switch        ← {email} → новая сессия в cookie
 *   GET    /api/accounts/unread        → общий счётчик по всем ящикам
 *
 * Отдельный клиент, а не часть `MailApi`: это работа с ящиками целиком,
 * а не с почтой внутри одного ящика.
 */

import { apiFetch } from './http';
import type {
  AccountsOverview,
  LinkedListResponse,
  SwitchResponse,
  UnreadReport,
} from './accountsTypes';

export interface AccountsApi {
  /** Текущий ящик, связанные свои и подключённые чужие. */
  getAccounts(): Promise<AccountsOverview>;
  /**
   * Связать свой второй ящик. Пароль проверяется настоящим IMAP-логином,
   * поэтому отказ 401 `AUTH_FAILED` значит «неверный пароль ЭТОГО ящика»,
   * а вовсе не «наша сессия закончилась».
   */
  linkAccount(email: string, password: string, label?: string | null): Promise<LinkedListResponse>;
  /** Разорвать связь (сервер рвёт её в обе стороны). */
  unlinkAccount(email: string): Promise<LinkedListResponse>;
  /** Переключиться на связанный ящик: сервер заводит новую сессию. */
  switchAccount(email: string): Promise<SwitchResponse>;
  /** Непрочитанные по всем ящикам разом. */
  getUnread(): Promise<UnreadReport>;
}

export const httpAccountsApi: AccountsApi = {
  getAccounts: () => apiFetch('/api/accounts'),

  linkAccount: (email, password, label = null) =>
    apiFetch('/api/accounts/link', {
      method: 'POST',
      body: JSON.stringify({ email, password, label }),
    }),

  // Тела нет намеренно: apiFetch не ставит Content-Type без тела, а с
  // заявленным JSON и пустым телом сервер отвечает отказом.
  unlinkAccount: (email) =>
    apiFetch(`/api/accounts/link/${encodeURIComponent(email)}`, { method: 'DELETE' }),

  switchAccount: (email) =>
    apiFetch('/api/accounts/switch', { method: 'POST', body: JSON.stringify({ email }) }),

  getUnread: () => apiFetch('/api/accounts/unread'),
};
