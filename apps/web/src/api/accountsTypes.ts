/**
 * Типы раздела «Ящики» (/api/accounts) — сняты с ответов живого сервера,
 * а не с ожиданий. Проверено curl-ом на стенде 127.0.0.1:8080:
 *
 *   GET /api/accounts
 *     {"current":"demo@mail.local",
 *      "linked":[{"id":23,"email":"test@mail.local","label":null,
 *                 "position":0,"createdAt":"2026-08-05T13:00:00.975Z"}],
 *      "external":[…],
 *      "secrets":{"available":true,"reason":null},
 *      "collector":{"scheduler":true,"masterConfigured":true}}
 *
 *   GET /api/accounts/unread
 *     {"total":342,"accounts":[
 *        {"email":"demo@mail.local","kind":"own","unread":6,"error":null},
 *        {"email":"test@mail.local","kind":"linked","unread":336,"error":null}]}
 *
 * Источник на стороне сервера — apps/api/src/accounts/types.ts.
 */

/** Свой ящик, связанный с текущим: переключение без ввода пароля. */
export interface LinkedAccount {
  id: number;
  email: string;
  label: string | null;
  position: number;
  createdAt: string;
}

/**
 * Чужой ящик, подключённый сборщиком или напрямую.
 *
 * Меню ящика показывает только адрес и режим, поэтому здесь описано ровно
 * то, на что интерфейс опирается: выдумывать остальные поля значило бы
 * обещать типами то, чего мы не проверяли.
 */
export interface ExternalAccountSummary {
  id: number;
  address: string;
  label: string | null;
  mode: 'collector' | 'direct';
  enabled: boolean;
}

/** Ответ GET /api/accounts. */
export interface AccountsOverview {
  /** Адрес ящика, чья сейчас сессия. */
  current: string;
  linked: LinkedAccount[];
  external: ExternalAccountSummary[];
  /**
   * Доступно ли хранилище паролей. Без него сервер откажет в связывании:
   * пароль связанного ящика хранить негде, а значит и переключаться нечем.
   */
  secrets: { available: boolean; reason: string | null };
  collector: { scheduler: boolean; masterConfigured: boolean };
}

/** Строка счётчика непрочитанных по одному ящику. */
export interface UnreadEntry {
  email: string;
  /** 'own' — текущий, 'linked' — связанный свой, 'external' — чужой. */
  kind: 'own' | 'linked' | 'external';
  unread: number;
  /** Ящик не ответил — счётчик неизвестен, но ящик в списке остаётся. */
  error: string | null;
}

/** Ответ GET /api/accounts/unread. */
export interface UnreadReport {
  total: number;
  accounts: UnreadEntry[];
}

/** Ответ POST /api/accounts/link и DELETE /api/accounts/link/:email. */
export interface LinkedListResponse {
  linked: LinkedAccount[];
}

/** Ответ POST /api/accounts/switch. */
export interface SwitchResponse {
  ok: boolean;
  email: string;
}
