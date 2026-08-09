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
 * Состояние сборщика по одному подключению.
 * `status: 'error'` вместе с `error` — то, что интерфейс обязан показать
 * вместо вечного «идёт синхронизация».
 */
export interface ExternalAccountState {
  lastRunAt: string | null;
  lastOkAt: string | null;
  status: 'never' | 'running' | 'ok' | 'partial' | 'error';
  error: string | null;
  lastCopied: number;
  totalCopied: number;
}

/**
 * Чужой ящик, подключённый сборщиком или напрямую.
 *
 * Описано то, на что опирается интерфейс: адрес и режим для списка,
 * состояние — для строки «когда забирали и что пошло не так», наличие
 * `smtp` — для выбора отправителя в окне письма (без чужого SMTP
 * отправлять с этого адреса не с чего).
 */
export interface ExternalAccountSummary {
  id: number;
  address: string;
  label: string | null;
  mode: 'collector' | 'direct';
  enabled: boolean;
  state: ExternalAccountState;
  smtp: { host: string; port: number; secure: boolean; user: string } | null;
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
  /**
   * Ящик, из которого сюда переключились, — и куда можно вернуться без
   * пароля. null, если переключения не было.
   *
   * Связь между ящиками односторонняя, поэтому из связанного ящика
   * исходный в `linked` не виден: без этого поля вернуться было НЕЧЕМ, и
   * человек вводил пароль своего ящика заново — заводя обратную связь,
   * которую продукт намеренно не заводит.
   */
  returnTo: { email: string } | null;
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

/**
 * Тело POST /api/accounts/external/:id/send.
 *
 * Уже, чем обычная отправка: у чужого SMTP нет ни нашей очереди
 * (значит, ни отмены, ни отложенной отправки), ни наших черновиков.
 * Обещать типами то, чего маршрут не умеет, — худший вид неправды.
 */
export interface ExternalSendRequest {
  to: { name: string | null; address: string }[];
  cc: { name: string | null; address: string }[];
  bcc: { name: string | null; address: string }[];
  subject: string;
  bodyHtml: string;
  attachmentIds: string[];
  fromName?: string | null;
  inReplyTo?: string;
  references?: string[];
  /**
   * Письма, пересылаемые целиком. Раньше этого поля здесь не было, и
   * «Переслать как вложение» с чужого адреса молча теряло вложения:
   * плашки в окне были, письмо уходило без них, а человеку говорили
   * «Письмо отправлено с адреса …».
   */
  attachMessageIds?: string[];
  /** Просьба уведомить о прочтении — уведомление вернётся на чужой адрес. */
  requestReadReceipt?: boolean;
}

/** Ответ POST /api/accounts/external/:id/send. */
export interface ExternalSendResponse {
  ok: boolean;
  /** Адрес, с которого письмо ушло. */
  from: string;
}
