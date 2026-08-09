/**
 * Общие типы модуля переноса почты.
 *
 * Перенос выполняется по схеме IMAP → IMAP: подключаемся к источнику
 * (Kerio Connect, Exchange, Zimbra, Dovecot, Яндекс, Gmail …) и к нашему
 * серверу, читаем письма и складываем их через APPEND с сохранением
 * флагов и внутренней даты (INTERNALDATE).
 */

/** Роль (служебное назначение) папки — совпадает с FolderRole в @mail-true/shared. */
export type SpecialRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive';

/** Параметры подключения к IMAP-серверу. */
export interface ImapEndpoint {
  host: string;
  port?: number;
  /** true — сразу TLS (обычно порт 993); false — открытое соединение/STARTTLS. */
  secure?: boolean;
  user: string;
  /**
   * Пароль. В служебном режиме (masterUser задан) здесь пароль СЛУЖЕБНОГО
   * пользователя, а не владельца ящика: пароль владельца в этом режиме
   * не нужен вовсе.
   */
  pass: string;
  /**
   * Служебный пользователь (master user) — вход в чужой ящик без его пароля.
   *
   * Зачем: перенос сотни ящиков иначе требует сотни паролей. Их надо где-то
   * взять, куда-то положить на всё время переноса (часы) и потом отовсюду
   * убрать. Один служебный пароль вместо сотни чужих — это на два порядка
   * меньше секретов в обороте, и ни один пароль владельца ящика при этом
   * не покидает свой сервер.
   *
   * Механизм тот же, что у нас в Dovecot (см. apps/api/src/admin/mailbox.ts):
   * вход выполняется под именем `ящик<разделитель>служебный_пользователь`
   * с паролем служебного пользователя. Так умеют Dovecot, Zimbra, Kerio
   * Connect (там это «Login as user»), Exchange через имперсонацию.
   */
  masterUser?: string;
  /**
   * Разделитель между ящиком и служебным пользователем в имени входа.
   * У Dovecot задаётся auth_master_user_separator, по умолчанию «*».
   */
  masterSeparator?: string;
  /**
   * Не проверять сертификат сервера (самоподписанные сертификаты в dev
   * и на многих внутренних серверах Kerio).
   */
  allowInsecureTls?: boolean;
}

/**
 * Имя для входа: обычное или служебное («ящик*служебный_пользователь»).
 *
 * Отдельная функция, а не строчка внутри createClient, потому что это
 * же имя должно попадать в сообщения об отказе и в проверку связи —
 * человеку надо видеть, ПОД КАКИМ именем сервер отказал.
 */
export function loginNameOf(endpoint: ImapEndpoint): string {
  if (!endpoint.masterUser) return endpoint.user;
  return `${endpoint.user}${endpoint.masterSeparator ?? '*'}${endpoint.masterUser}`;
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
  /**
   * Сколько писем папки читать и переносить за один заход (порция).
   *
   * ЗАЧЕМ. Раньше метаописания ВСЕХ писем папки собирались в один массив
   * до начала копирования. INBOX на 300–500 тысяч писем — это сотни
   * мегабайт при потолке кучи в 512 МБ (infra/docker-compose.yml), да ещё
   * умноженных на число одновременно переносимых ящиков. Работник переноса
   * живёт в процессе api, поэтому падал не «перенос», а вся веб-почта
   * вместе с админкой; контейнер поднимался, работник брал то же задание
   * и падал снова. Порция превращает «прочитать всё → перенести всё» в
   * «прочитать немного → перенести → записать курсор», и расход памяти
   * перестаёт зависеть от размера ящика.
   *
   * ПОЧЕМУ ДВЕ ТЫСЯЧИ. Порция держит в памяти только метаописания
   * (UID, размер, флаги, дата, ключ дедупликации) — около 300 байт на
   * письмо, то есть меньше мегабайта на порцию даже с запасом. Меньше
   * брать невыгодно: на каждую порцию приходится обращение к серверу и
   * запись курсора, и на порции в сотню писем эти накладные расходы уже
   * заметны на ящике в полмиллиона писем.
   */
  chunkSize?: number;
  /** Максимум попыток при обрыве соединения (по умолчанию 5). */
  maxAttempts?: number;
  /** Письма крупнее лимита пропускаются с пометкой в отчёте (байты; по умолчанию без лимита). */
  maxMessageSize?: number;
  /** Не копировать письма, только посчитать и показать план (dry run). */
  dryRun?: boolean;
  /**
   * Остановка задания человеком.
   *
   * Перенос идёт часами, и решение «хватит» принимается по ходу: не тот
   * ящик, не тот сервер, началось рабочее время. Убить процесс — не выход:
   * задание должно закончиться ОТЧЁТОМ о том, что успело переехать, иначе
   * непонятно, с чего продолжать. Поэтому остановка проверяется между
   * письмами и между папками — на границе, где состояние уже записано
   * и повторный запуск продолжит ровно отсюда.
   */
  signal?: AbortSignal;
  /** Колбэк прогресса (дублирует события MailboxMigrator). */
  onProgress?: (event: ProgressEvent) => void;
  /** Логгер pino; по умолчанию молчаливый. */
  logger?: import('pino').BaseLogger;
}

/** Событие прогресса переноса. */
export type ProgressEvent =
  | { type: 'start'; account: string; folders: number; messages: number }
  | { type: 'folders'; mappings: FolderMapping[] }
  /**
   * Начата папка. toCopy — сколько писем предстоит РАЗОБРАТЬ (прочитать
   * и решить, дубль или нет), а не сколько поедет: точное число известно
   * только после разбора всей папки, а разбирать её целиком до начала
   * переноса — ровно то, от чего процесс и падал по памяти.
   */
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
  | {
      type: 'folder-done';
      sourcePath: string;
      destPath: string;
      copied: number;
      skipped: number;
      failed: number;
    }
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
  /**
   * stopped — перенос прерван человеком. Это НЕ ошибка и не успех: часть
   * писем переехала, состояние записано, продолжить можно тем же заданием.
   * Отдельное значение нужно, чтобы отчёт не врал ни «всё хорошо», ни
   * «не получилось».
   */
  status: 'ok' | 'partial' | 'failed' | 'stopped';
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
  /** Сколько ящиков прервано человеком (см. MailboxReport.status). */
  stopped: number;
}

/**
 * Итог проверки связи с сервером ДО начала переноса.
 *
 * Проверка существует потому, что отказ на входе — самое частое место
 * отказа вообще: адрес, порт и пароль вводят руками. Узнавать об опечатке
 * через шесть часов, когда задание встало на первом же ящике, — потеря
 * целой ночи переноса.
 */
export interface ProbeResult {
  ok: boolean;
  /** Под каким именем входили (служебное имя показывается как есть). */
  loginName: string;
  /** Сколько папок отдал сервер по LIST (только при ok). */
  folders?: number;
  /** Сколько писем во всех папках (только при ok). */
  messages?: number;
  /** Человеческое объяснение отказа: «сервер не принял логин или пароль» и т. п. */
  error?: string;
}
