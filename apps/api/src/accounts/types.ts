/**
 * Типы подключения чужих ящиков и связывания своих.
 *
 * Два режима внешнего подключения (обоснование — docs/plan.md, этап 9):
 *
 *   collector — сборщик: периодически забирает почту с чужого сервера
 *               в папку нашего ящика. Письма доступны офлайн, попадают
 *               в общий поиск, к ним применяются фильтры и цепочки.
 *               Минус: занимают место дважды.
 *   direct    — прямое подключение: чужой ящик показывается отдельным
 *               деревом папок, письма читаются на лету. Место не
 *               занимается, состояние всегда актуальное. Минус: скорость
 *               зависит от чужого сервера, общий поиск по нему не идёт.
 */

export type ExternalMode = 'collector' | 'direct';
export type CollectScope = 'inbox' | 'all';
export type CollectorStatus = 'never' | 'running' | 'ok' | 'partial' | 'error';

/** Состояние сборщика: когда забирал, сколько писем, ошибки. */
export interface CollectorState {
  lastRunAt: string | null;
  lastOkAt: string | null;
  status: CollectorStatus;
  error: string | null;
  lastCopied: number;
  lastSkipped: number;
  lastFailed: number;
  lastDurationMs: number;
  totalCopied: number;
  runs: number;
}

/**
 * Внешний ящик в том виде, в каком его отдаёт API.
 * Пароля здесь нет и быть не может: наружу он не выходит никогда.
 */
export interface ExternalAccount {
  id: number;
  address: string;
  label: string | null;
  mode: ExternalMode;
  imap: { host: string; port: number; secure: boolean; user: string };
  smtp: { host: string; port: number; secure: boolean; user: string } | null;
  allowInsecureTls: boolean;
  targetFolder: string;
  collectScope: CollectScope;
  intervalMinutes: number;
  enabled: boolean;
  state: CollectorState;
  createdAt: string;
}

/** Данные для создания подключения. */
export interface ExternalAccountInput {
  address: string;
  label: string | null;
  mode: ExternalMode;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  password: string;
  allowInsecureTls: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  targetFolder: string;
  collectScope: CollectScope;
  intervalMinutes: number;
  enabled: boolean;
}

/** Изменяемая часть подключения. Пароль — отдельным полем и необязателен. */
export type ExternalAccountPatch = {
  [K in keyof Omit<ExternalAccountInput, 'address'>]?: ExternalAccountInput[K] | undefined;
};

/** Свой ящик, связанный с текущим: переключение без ввода пароля. */
export interface LinkedAccount {
  id: number;
  email: string;
  label: string | null;
  position: number;
  createdAt: string;
}

/** Строка счётчика непрочитанных для шапки. */
export interface UnreadEntry {
  /** Адрес ящика (свой или внешний). */
  email: string;
  /** 'own' — текущий, 'linked' — связанный свой, 'external' — чужой. */
  kind: 'own' | 'linked' | 'external';
  unread: number;
  /** Ошибка обращения к ящику (счётчик неизвестен). */
  error: string | null;
}
