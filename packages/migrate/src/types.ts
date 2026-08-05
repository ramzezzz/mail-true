/**
 * Общие типы модуля переноса почты.
 *
 * Перенос выполняется по схеме IMAP → IMAP: подключаемся к источнику
 * (Kerio Connect, Exchange, Zimbra, Dovecot, Яндекс, Gmail …) и к нашему
 * серверу, читаем письма и складываем их через APPEND с сохранением
 * флагов и внутренней даты (INTERNALDATE).
 */

/** Роль (служебное назначение) папки — совпадает с FolderRole в @mail-true/shared. */
export type SpecialRole =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'junk'
  | 'archive';

/** Параметры подключения к IMAP-серверу. */
export interface ImapEndpoint {
  host: string;
  port?: number;
  /** true — сразу TLS (обычно порт 993); false — открытое соединение/STARTTLS. */
  secure?: boolean;
  user: string;
  pass: string;
  /**
   * Не проверять сертификат сервера (самоподписанные сертификаты в dev
   * и на многих внутренних серверах Kerio).
   */
  allowInsecureTls?: boolean;
}

/** Настройки сопоставления папок источника и приёмника. */
export interface FolderMappingOptions {
  /**
   * Явные переопределения: полный путь папки в источнике → полный путь у нас.
   * Имеют приоритет над всеми автоматическими правилами.
   * Пример: { 'Public Folders/Общая': 'Общие/Архив' }
   */
  overrides?: Record<string, string>;
  /** Папки источника, которые переносить не нужно (полные пути). */
  exclude?: string[];
  /**
   * Куда класть письма спец-папок, если у приёмника такая папка называется
   * иначе, чем определилось автоматически.
   */
  roleTargets?: Partial<Record<SpecialRole, string>>;
  /**
   * Символы, недопустимые ВНУТРИ имени папки у приёмника, помимо его
   * разделителя иерархии. Для Maildir++ (наш Dovecot) это точка: имя
   * «Отчёт 2024.финал» сервер отвергает целиком. По умолчанию пусто —
   * непринятое имя чинится на лету при создании папки (см. migrator.ts),
   * а этот список позволяет сделать замену сразу и предсказуемо.
   */
  destUnsafeChars?: string[];
}

/** Описание папки, полученное по LIST. */
export interface SourceFolder {
  /** Полный путь на сервере-источнике, например 'INBOX/Проекты/2024'. */
  path: string;
  /** Разделитель иерархии источника ('/', '.', иногда '\\'). */
  delimiter: string;
  /** SPECIAL-USE флаг, если сервер его отдал: '\Sent', '\Trash' … */
  specialUse?: string;
  /** Папку нельзя открыть (флаг \Noselect) — переносим только детей. */
  noSelect: boolean;
}

/** Итог сопоставления одной папки. */
export interface FolderMapping {
  source: SourceFolder;
  /** Полный путь папки у нас (с разделителем приёмника). */
  destPath: string;
  /** Какая роль распознана (для отчёта). */
  role: SpecialRole | null;
  /** Откуда взялось решение (для отладки и отчёта). */
  reason: 'override' | 'special-use' | 'name' | 'hierarchy';
}

/** Настройки переноса одного ящика. */
export interface MigrateMailboxOptions {
  source: ImapEndpoint;
  dest: ImapEndpoint;
  mapping?: FolderMappingOptions;
  /**
   * Хранилище состояния (докачка). Если не задано, дедупликация выполняется
   * только по содержимому папки-приёмника (это медленнее, но тоже безопасно).
   */
  state?: import('./state.js').StateStore;
  /** Сколько писем переносить между записями курсора (по умолчанию 50). */
  batchSize?: number;
  /** Максимум попыток при обрыве соединения (по умолчанию 5). */
  maxAttempts?: number;
  /** Письма крупнее лимита пропускаются с пометкой в отчёте (байты; по умолчанию без лимита). */
  maxMessageSize?: number;
  /** Не копировать письма, только посчитать и показать план (dry run). */
  dryRun?: boolean;
  /** Колбэк прогресса (дублирует события MailboxMigrator). */
  onProgress?: (event: ProgressEvent) => void;
  /** Логгер pino; по умолчанию молчаливый. */
  logger?: import('pino').BaseLogger;
}

/** Событие прогресса переноса. */
export type ProgressEvent =
  | { type: 'start'; account: string; folders: number; messages: number }
  | { type: 'folders'; mappings: FolderMapping[] }
  | { type: 'folder-start'; sourcePath: string; destPath: string; toCopy: number; total: number }
  | {
      type: 'message';
      sourcePath: string;
      destPath: string;
      uid: number;
      /** copied — перенесено; skipped — уже было (дубль); failed — ошибка письма. */
      status: 'copied' | 'skipped' | 'failed';
      copied: number;
      skipped: number;
      failed: number;
      total: number;
    }
  | { type: 'folder-done'; sourcePath: string; destPath: string; copied: number; skipped: number; failed: number }
  | {
      type: 'retry';
      attempt: number;
      maxAttempts: number;
      error: string;
      /** Какую именно папку не удалось перенести с первого раза. */
      sourcePath?: string;
      destPath?: string;
    }
  /**
   * Имя папки-приёмника пришлось изменить: сервер не принял исходное
   * (в Maildir++ недопустима точка внутри имени папки).
   */
  | { type: 'folder-renamed'; destPath: string; usedPath: string; reason: string }
  | { type: 'done'; report: MailboxReport };

/** Итог переноса по одной папке. */
export interface FolderReport {
  sourcePath: string;
  destPath: string;
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/** Итог переноса одного ящика. */
export interface MailboxReport {
  sourceUser: string;
  destUser: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'ok' | 'partial' | 'failed';
  folders: FolderReport[];
  totalMessages: number;
  copied: number;
  skipped: number;
  failed: number;
  /** Ошибка уровня ящика (если status = failed). */
  error?: string;
}

/** Одна строка пакетного задания (список ящиков). */
export interface BatchAccount {
  source: ImapEndpoint;
  dest: ImapEndpoint;
  mapping?: FolderMappingOptions;
}

/** Итог пакетного переноса. */
export interface BatchReport {
  startedAt: string;
  finishedAt: string;
  accounts: MailboxReport[];
  ok: number;
  partial: number;
  failed: number;
}
