/** Типы ответов админского API (apps/api/src/admin). */

export type AdminRole = 'owner' | 'user_manager' | 'readonly';

export type Permission =
  | 'overview.read'
  | 'users.read'
  | 'users.write'
  | 'users.password'
  | 'users.delete'
  | 'aliases.read'
  | 'aliases.write'
  | 'domains.read'
  | 'domains.write'
  | 'domains.dnscheck'
  | 'audit.read'
  | 'mailbox.impersonate'
  /** Настройки чужого ящика: смотреть, менять, ставить подписи пачкой. */
  | 'usersettings.read'
  | 'usersettings.write'
  | 'usersettings.bulk'
  /** Своё оформление входа (OEM): логотип и подписи страниц входа. */
  | 'branding.read'
  | 'branding.write'
  /** Резервная копия настроек: выгрузка отдельно от восстановления. */
  | 'backup.export'
  | 'backup.restore'
  /** Перенос почты с чужого сервера: смотреть ход отдельно от запуска. */
  | 'migration.read'
  | 'migration.run'
  /**
   * Настройки сервера: смотреть отдельно от «менять». Оба права — у
   * владельца: в списке стоят адреса и порты внутренней сети и то, какие
   * возможности на сервере выключены, то есть карта установки.
   */
  | 'serversettings.read'
  | 'serversettings.write'
  /** Смена основного домена сервера. Право одно и только у владельца. */
  | 'domainchange.run'
  /**
   * Перезапуск служб из панели — и всё, что перезапуском является по
   * сути. Сюда же входит сквозная проверка доставки: она отправляет
   * настоящее письмо через живой Postfix.
   *
   * В этом перечне права не было вовсе, поэтому панель не могла его и
   * спросить: кнопки, требующие его, показывались всем, а отказ по
   * правам приходил уже после нажатия — у сквозной проверки через сорок
   * пять секунд ожидания.
   */
  | 'services.restart'
  | 'admins.manage';

export interface AdminSession {
  authenticated: true;
  login: string;
  displayName: string | null;
  role: AdminRole;
  roleLabel: string;
  permissions: Permission[];
  masterAccess: boolean;
  /**
   * Тема оформления, запомненная за ЭТОЙ учётной записью (миграция 0009).
   * null — администратор темы не выбирал: панель берёт свою по умолчанию.
   * Строка приходит как есть: незнакомое имя панель заменяет умолчанием
   * сама, поэтому тип здесь широкий, а не перечисление тем.
   */
  theme: string | null;
}

export interface LoginResult {
  ok: true;
  login: string;
  displayName: string | null;
  role: AdminRole;
  roleLabel: string;
  permissions: Permission[];
}

export interface MailUser {
  id: number;
  email: string;
  domain: string;
  domainId: number;
  displayName: string | null;
  quotaBytes: number;
  active: boolean;
  aliasCount: number;
  createdAt: string;
  updatedAt: string;
  /** Приходит только сразу после создания или сброса пароля. */
  generatedPassword?: string | null;
}

export interface MailUserPage {
  items: MailUser[];
  total: number;
  limit: number;
  offset: number;
  /**
   * Отбор «почти заполненные» невозможен: снимка показателей нет.
   *
   * Занятости ящика в базе нет, она приходит из снимка, а сбор
   * показателей выключается настройкой. Без этого признака пустой ответ
   * читался как «переполненных нет» — то есть как ответ на вопрос, на
   * который никто не отвечал.
   */
  metricsMissing?: boolean;
}

export interface Alias {
  id: number;
  source: string;
  destination: string;
  domain: string;
  domainId: number;
  active: boolean;
  createdAt: string;
  /**
   * Непреграждающая беда, которую нашёл сервер при создании.
   *
   * Например: «Ящика „ivn@ourdomain.ru“ нет, письма будут отбиваться» —
   * типовая опечатка в адресате. Отказывать нельзя (ящик могут завести
   * следующим действием, а пересылка на внешний адрес — обычное дело),
   * но и молчать нельзя: раньше панель показывала зелёное «Алиас создан»,
   * а письма на новый адрес начинали отбиваться.
   */
  warning?: string;
}

export interface AliasPage {
  items: Alias[];
  total: number;
  limit: number;
  offset: number;
}

export type DnsStatus = 'ok' | 'warn' | 'fail' | 'unknown';

/**
 * Вывод по записи. Отличается от статуса тем, что различает «записи нет»
 * и «запись есть, но не та»: у первого лечение — завести запись,
 * у второго — исправить значение.
 */
export type DnsVerdict = 'ok' | 'missing' | 'mismatch' | 'warn' | 'unreachable';

/** Разделы, на которые поделены записи (как в docs/install.md). */
export type DnsGroup = 'core' | 'web' | 'client';

export interface DnsCheck {
  id: string;
  group: DnsGroup;
  title: string;
  /** Зачем нужна запись. */
  purpose: string;
  /** Что сломается, если её нет. */
  impact: string;
  recordName: string;
  recordType: string;
  /** Готовое значение для копирования. */
  expected: string;
  /** Можно ли скопировать значение к регистратору (у PTR — нельзя). */
  copyable: boolean;
  /** Что опубликовано на самом деле. */
  actual: string[];
  status: DnsStatus;
  verdict: DnsVerdict;
  /** В чём именно расхождение. */
  diff: string | null;
  /** Как исправить. */
  hint: string;
  required: boolean;
  /** Какой резольвер ответил. */
  askedVia: string | null;
  /** Когда получен ответ именно по этой записи. */
  checkedAt: string;
}

/** Ответ на перепроверку одной записи. */
export interface DnsCheckOne {
  check: DnsCheck;
  resolver: DnsResolverInfo;
  overall: DnsStatus;
}

export interface DnsResolverInfo {
  servers: string[];
  answeredBy: string[];
  reachable: boolean;
}

export interface DnsReport {
  domain: string;
  checkedAt: string;
  overall: DnsStatus;
  resolver: DnsResolverInfo;
  checks: DnsCheck[];
}

export interface Domain {
  id: number;
  name: string;
  userCount: number;
  aliasCount: number;
  dkimSelector: string;
  dkimPublicKey: string | null;
  dnsStatus: DnsReport | null;
  dnsCheckedAt: string | null;
  dnsOverall: DnsStatus;
  createdAt: string;
  recommended: {
    mx: string;
    spf: string;
    dmarc: string;
    dkim: string | null;
    autoconfig: string;
  };
}

export interface AuditEntry {
  id: string;
  adminLogin: string;
  action: string;
  actionLabel: string;
  targetType: string;
  targetId: number | null;
  targetLabel: string | null;
  ip: string | null;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditPage {
  items: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface MailboxAccessEntry {
  id: string;
  adminLogin: string;
  mailboxEmail: string;
  reason: string;
  ip: string | null;
  startedAt: string;
  endedAt: string | null;
  /** leave | logout | replaced | expired; null вместе с endedAt — сеанс идёт. */
  endReason: string | null;
  active: boolean;
}

export interface MailboxAccessPage {
  items: MailboxAccessEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface ServiceStatus {
  id: string;
  title: string;
  state: 'ok' | 'fail' | 'unknown';
  detail: string;
}

export interface Overview {
  healthy: boolean;
  problems: string[];
  services: ServiceStatus[];
  counters: {
    domains: number;
    users: number;
    usersActive: number;
    usersBlocked: number;
    aliases: number;
    admins: number;
    quotaTotal: number;
    auditToday: number;
    impersonations7d: number;
  };
  domains: Array<{
    id: number;
    name: string;
    userCount: number;
    dnsOverall: DnsStatus;
    dnsCheckedAt: string | null;
  }>;
  recentAudit: Array<{
    id: string;
    adminLogin: string;
    action: string;
    actionLabel: string;
    targetLabel: string | null;
    createdAt: string;
  }>;
}

export interface ImportRowPreview {
  line: number;
  email: string;
  displayName: string | null;
  quotaBytes: number | null;
  hasPassword: boolean;
  errors: string[];
  warnings: string[];
}

export interface ImportPreview {
  rows: ImportRowPreview[];
  validCount: number;
  invalidCount: number;
  domains: string[];
  hasHeader: boolean;
  /** Файл длиннее предела — разобраны не все строки. */
  truncated: boolean;
  /** Сколько строк с данными в файле всего, включая неразобранные. */
  totalDataRows: number;
  /** Сколько строк разбирается за один раз. */
  maxRows: number;
  /** Квота, доставшаяся строкам без своей колонки `quota`. */
  defaultQuotaBytes: number;
  /** Будут ли на самом деле создаваться новые домены (право проверено). */
  allowNewDomains: boolean;
  /** Просили создавать домены, но роль не позволяет — показываем прямо. */
  newDomainsDenied: boolean;
}

/** Ответ на запуск импорта: работа идёт, результат забирается по номеру. */
export interface ImportStarted {
  ok: true;
  jobId: number;
  state: 'running';
  total: number;
  allowNewDomains: boolean;
  resultUrl: string;
  /** false — секрета для шифрования нет, пароли не сохраняются. */
  passwordsStored: boolean;
}

/** Состояние задания импорта. Результат переживает обрыв связи. */
export interface ImportJob {
  id: number;
  adminLogin: string;
  state: 'running' | 'done' | 'failed';
  total: number;
  processed: number;
  createdCount: number;
  failedCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  expiresAt: string;
  created: Array<{ email: string; generatedPassword: string | null }>;
  failed: Array<{ line: number; email: string; error: string }>;
  passwordsStored: boolean;
}

/** Что осталось после удаления ящика. */
export interface UserDeleteResult {
  ok: true;
  /** Каталог уведён из-под нового ящика с тем же адресом. */
  mailDirQuarantined: boolean;
  mailDirMissing: boolean;
  /** Ящик очищен средствами Dovecot — вместе с индексами поиска. */
  imapPurged: boolean;
  dbRowsRemoved: number;
  deletionId: number;
}

export interface MailboxEnterResult {
  ok: true;
  mailboxEmail: string;
  displayName: string | null;
  reason: string;
  accessId: number;
  adminSession: true;
  readOnly: true;
  canSend: false;
  expiresInSeconds: number;
}

export interface MailboxFolder {
  path: string;
  name: string;
  specialUse: string | null;
  messages: number;
  unseen: number;
}

export interface MailboxMessage {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  size: number;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

/* ------------------------------------------------------------------ */
/* Помощник ИИ (apps/api/src/ai/admin.ts)                               */
/* ------------------------------------------------------------------ */

/** Возможность помощника глазами пользователя. */
export type AiFeatureKey = 'summary' | 'classify' | 'reply' | 'extract' | 'translate' | 'search';

export interface AiFeatureInfo {
  key: AiFeatureKey;
  title: string;
  description: string;
  /** Что именно уходит наружу при использовании — дословно с сервера. */
  sends: string;
  /** Технические возможности пакета: под этими именами обращения попадают в журнал. */
  technical: string[];
  defaultOn: boolean;
}

export interface AiReference {
  features: AiFeatureInfo[];
  /** Что не отправляется никогда, ни при одной возможности. */
  neverSent: string[];
  /** false — не задана AI_ENCRYPTION_KEY, ключ внешнего сервиса сохранить нельзя. */
  canStoreApiKey: boolean;
  /** Почему нельзя — показывается администратору дословно. */
  apiKeyReason: string | null;
}

export interface AiDomain {
  domainId: number;
  domain: string;
  enabled: boolean;
  /** Адрес совместимого API, например http://127.0.0.1:11434/v1 */
  baseUrl: string | null;
  chatPath: string;
  /** Ключ сохранён. Самого ключа сервер не отдаёт никогда. */
  hasApiKey: boolean;
  /** Хвост ключа, например «…a3f9» — чтобы отличить один ключ от другого. */
  apiKeyHint: string | null;
  model: string | null;
  /** Человекочитаемое название сервиса — его увидит пользователь. */
  providerLabel: string;
  /** Модель внутри периметра: письма не покидают сервер. */
  local: boolean;
  maxBodyChars: number;
  timeoutMs: number;
  maxOutputTokens: number;
  /** Окно учёта расходов, мс. */
  periodMs: number;
  /** null — без предела. */
  maxTokensPerPeriod: number | null;
  maxRequestsPerPeriod: number | null;
  maxTokensPerRequest: number | null;
  /** null — разрешены все возможности; пустой список — не разрешена ни одна. */
  featuresAllowed: string[] | null;
  updatedAt: string;
}

/** Изменение настроек: неупомянутые поля сервер не трогает. */
export interface AiDomainPatch {
  enabled?: boolean;
  baseUrl?: string | null;
  chatPath?: string;
  /** Новый ключ; null — стереть сохранённый; поле отсутствует — не трогать. */
  apiKey?: string | null;
  model?: string | null;
  providerLabel?: string;
  local?: boolean;
  maxBodyChars?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  periodMs?: number;
  maxTokensPerPeriod?: number | null;
  maxRequestsPerPeriod?: number | null;
  maxTokensPerRequest?: number | null;
  featuresAllowed?: string[] | null;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** true — сервис не сообщил расход, число получено оценкой. */
  estimated: boolean;
}

/**
 * Список моделей у поставщика.
 *
 * Отказ здесь — не ошибка панели, а ответ чужого сервиса, поэтому он
 * приезжает полем, а не исключением: человеку у формы нужно знать, какое
 * поле поправить (401 — ключ, 404 — адрес без /v1), а не увидеть красную
 * плашку «запрос не удался».
 */
export interface AiModelList {
  ok: boolean;
  /** Адрес, у которого спрашивали, — его видно в подсказке. */
  endpoint: string;
  status: number | null;
  message: string | null;
  models: string[];
}

/**
 * Несохранённые значения формы для проверки связи.
 *
 * Чего нет — берётся из записи в базе. Поэтому сменить один адрес и
 * проверить его СО СТАРЫМ ключом можно, не набирая ключ заново: в
 * браузер он не приезжает вовсе.
 */
export interface AiTestDraft {
  baseUrl?: string;
  chatPath?: string;
  model?: string;
  providerLabel?: string;
  apiKey?: string;
}

export type AiTestResult =
  | {
      ok: true;
      endpoint: string;
      model: string;
      local: boolean;
      /** Ответ модели на служебный текст — настоящие письма при проверке не уходят. */
      summary: string;
      usage: AiUsage;
      durationMs: number;
    }
  | {
      ok: false;
      reason: string;
      message: string;
      status?: number | null | undefined;
      durationMs?: number | undefined;
    };

export interface AiAuditEntry {
  at: string;
  accountId: string;
  messageId: string | null;
  /** Техническое имя возможности: summarize.message, reply.variants и т. п. */
  feature: string;
  promptVersion: string;
  endpoint: string;
  model: string;
  local: boolean;
  usage: AiUsage;
  /** true — ответ взят из кэша, наружу ничего не уходило. */
  cached: boolean;
  outboundChars: number;
  durationMs: number;
  ok: boolean;
  errorKind: string | null;
}

export interface AiAuditTotals {
  requests: number;
  cachedRequests: number;
  failedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  outboundChars: number;
}

export interface AiAuditPage {
  items: AiAuditEntry[];
  totals: AiAuditTotals;
}

/* ------------------------------------------------------------------ */
/* Почтовый поток: очередь, история обработанных, журналы               */
/* ------------------------------------------------------------------ */

/** Адресат письма из очереди и последняя причина отсрочки для него. */
export interface QueueRecipient {
  address: string;
  delayReason: string | null;
}

/** Письмо, лежащее в очереди Postfix прямо сейчас. */
export interface QueueMessage {
  queueId: string;
  /** incoming | active | deferred | hold | corrupt — где именно лежит. */
  queueName: string;
  arrivalTime: string;
  sizeBytes: number;
  sender: string;
  recipients: QueueRecipient[];
  reason: string | null;
}

export interface QueuePage {
  items: QueueMessage[];
  total: number;
  limit: number;
  offset: number;
  /** Сколько писем в очереди всего, без учёта отбора. */
  queueTotal: number;
  byQueue: Record<string, number>;
  /** Очередь длиннее предела разбора — показанное неполно. */
  truncated: boolean;
  takenAt: string;
}

export type FlowStatus = 'sent' | 'deferred' | 'bounced' | 'expired' | 'rejected' | 'held';
export type FlowDirection = 'in' | 'out' | 'unknown';

/** Одна попытка доставки одному адресату — строка истории. */
export interface FlowEvent {
  id: string;
  occurredAt: string;
  queueId: string | null;
  direction: FlowDirection;
  status: FlowStatus;
  sender: string | null;
  recipient: string | null;
  relay: string | null;
  delaySeconds: number | null;
  sizeBytes: number | null;
  dsn: string | null;
  reason: string | null;
}

export interface FlowHistoryPage {
  items: FlowEvent[];
  hasMore: boolean;
  /** Курсор ленивой подгрузки; null — старее ничего нет. */
  nextBefore: { time: string; id: string } | null;
  limit: number;
}

export interface FlowHistoryStats {
  hours: number;
  counts: Partial<Record<FlowStatus, number>>;
  total: number;
  oldest: string | null;
  newest: string | null;
  /** С какого момента вообще ведётся разбор журнала. */
  collectingSince: string | null;
  retentionDays: number;
  maxRows: number;
  queueAgentConfigured: boolean;
}

export interface LogSourceInfo {
  source: string;
  fileName: string;
  present: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
  /** Сколько провёрнутых кусков лежит рядом (раздел их не читает). */
  rotatedFiles: number;
}

export interface LogSourcesResponse {
  dir: string;
  levels: string[];
  items: LogSourceInfo[];
}

export interface LogLine {
  /** Строка написана системой про саму себя: проверка живости, служебное соединение. */
  service?: boolean;
  /** Смещение строки в файле — из него получается курсор. */
  offset: number;
  level: 'error' | 'warn' | 'info' | 'debug';
  at: string | null;
  component: string;
  queueId: string | null;
  text: string;
}

export interface LogPage {
  source: string;
  items: LogLine[];
  nextBefore: number | null;
  /** С этого места дочитываются новые строки при автообновлении. */
  tailOffset: number;
  fileId: string;
  sizeBytes: number;
  /** Журнал провернулся между запросами — страница отдана с начала. */
  rotated: boolean;
  /** Просмотр упёрся в потолок, подходящих строк не найдено. */
  budgetExhausted: boolean;
}

/** Дочитанное новое: строки от старых к новым. */
export interface LogTailPage {
  source: string;
  items: LogLine[];
  nextAfter: number;
  fileId: string;
  sizeBytes: number;
  /** Журнал провернулся — прежнее место ничего не значит. */
  rotated: boolean;
  /** Новых строк было больше предела: остальное придёт следующим запросом. */
  more: boolean;
}

/* ------------------------------------------------------------------ */
/* Настройки чужого ящика                                              */
/* ------------------------------------------------------------------ */

/**
 * Формы ниже повторяют контракт ПОЛЬЗОВАТЕЛЬСКИХ настроек
 * (apps/web/src/api/settingsTypes.ts): админка правит те же самые
 * настройки тем же самым телом запроса. Своего диалекта здесь нет
 * намеренно — иначе сохранённое админкой пришлось бы переводить
 * обратно для формы пользователя.
 */
export interface UserSignature {
  id: string;
  name: string;
  text: string;
}

export interface UserGeneralSettings {
  senderName: string;
  signatures: UserSignature[];
  defaultSignatureId: string | null;
  autoReply: { enabled: boolean; text: string; from: string | null; to: string | null };
  notifications: { browser: boolean; tabCounter: boolean };
  quoteOriginalOnReply: boolean;
  afterDelete: 'next-message' | 'list';
  autoCollectContacts: boolean;
}

export type UserFilterField =
  'from' | 'to' | 'subject' | 'cc' | 'size' | 'resent-from' | 'resent-to';
export type UserFilterOperator = 'contains' | 'not-contains' | 'equals' | 'greater' | 'less';

export interface UserFilterCondition {
  field: UserFilterField;
  operator: UserFilterOperator;
  value: string;
}

export interface UserFilterRule {
  id: string;
  enabled: boolean;
  auto: boolean;
  conditions: UserFilterCondition[];
  actions: {
    moveToFolderId: string | null;
    markRead: boolean;
    markFlagged: boolean;
    applyToExistingFolderIds: string[];
    forwardTo: string | null;
    autoReply: string | null;
    continueOtherFilters: boolean;
    applyToSpam: boolean;
  };
  /**
   * Путь папки-приёмника, которой в ящике больше нет.
   *
   * Приходит только у сломанных правил — так бывает после переименования
   * папки мимо продукта, по IMAP из любой почтовой программы. Правило про
   * это не знает и при первом же письме заведёт папку со старым именем
   * заново; администратору, который смотрит чужие правила, знать об этом
   * нужно не меньше, чем владельцу ящика.
   */
  missingFolder?: string;
}

/** Папка ящика в модели почтового API: идентификатор, путь, вложенность. */
export interface UserMailFolder {
  id: string;
  path: string;
  name: string;
  role: string;
  depth: number;
  unreadCount: number;
  totalCount: number;
  system: boolean;
}

export interface UserSettingsBundle {
  mailbox: {
    id: number;
    email: string;
    displayName: string | null;
    domain: string;
    active: boolean;
  };
  general: UserGeneralSettings;
  filters: UserFilterRule[];
  folders: UserMailFolder[];
  /** Служебный доступ Dovecot не настроен — папок нет, настройки работают. */
  foldersAvailable: boolean;
  foldersError: string | null;
}

/** Состояние переписывания личного файла правил Sieve после правки. */
export interface SieveSyncState {
  transport: string;
  path: string;
  activeRules: number;
  /** Файл записан И проверен компилятором. */
  ok: boolean;
  /**
   * Файл правил лежит в ящике и будет применён к почте. Отдельно от `ok`:
   * без sievec рядом с сервером приложения правила записаны и работают,
   * а вот при ошибке компиляции действующий файл намеренно не подменяется.
   */
  written: boolean;
  error: string;
}

/* ------------------------------------------------------------------ */
/* Групповая установка подписей по шаблону                             */
/* ------------------------------------------------------------------ */

export type SignatureBulkMode = 'replace' | 'append' | 'skip-existing';
export type SignatureBulkOutcome = 'add' | 'replace' | 'skip-existing' | 'skip-incomplete';

export interface SignatureBulkRequest {
  ids?: number[];
  domainId?: number;
  template: string;
  name?: string;
  mode: SignatureBulkMode;
  makeDefault?: boolean;
  extras?: Record<string, string>;
  skipIncomplete?: boolean;
  previewEmail?: string;
}

export interface SignatureBulkRow {
  id: number;
  email: string;
  displayName: string | null;
  /** Сколько подписей у человека уже есть. */
  existing: number;
  outcome: SignatureBulkOutcome;
  /** Подстановки, значения которых у этого человека нет. */
  missing: string[];
}

/** Счётчики, которые администратор обязан увидеть ДО применения. */
export interface SignatureBulkCounts {
  total: number;
  willAdd: number;
  willReplace: number;
  willSkipExisting: number;
  willSkipIncomplete: number;
  /** Сколько чужих подписей будет уничтожено. */
  signaturesReplaced: number;
  withExistingSignatures: number;
}

export interface SignatureBulkPreview extends SignatureBulkCounts {
  /** Шаблон применять нельзя — здесь сказано, почему. */
  problem: string | null;
  mode: SignatureBulkMode;
  rows: SignatureBulkRow[];
  rowsTruncated: number;
  sample: {
    email: string;
    displayName: string | null;
    outcome: SignatureBulkOutcome;
    missing: string[];
    text: string;
  } | null;
}

export interface SignatureBulkResult extends SignatureBulkCounts {
  ok: true;
  applied: number;
  failed: Array<{ email: string; error: string }>;
}

export interface SignatureVariable {
  name: string;
  hint: string;
  /** Значение задаёт администратор, а не карточка ящика. */
  manual: boolean;
}

/* ------------------------------------------------------------------ */
/* Своё оформление входа (OEM)                                          */
/* ------------------------------------------------------------------ */

export interface BrandingLimits {
  maxBytes: number;
  maxBytesText: string;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  formats: string[];
  nameMax: number;
  /** Предел на свой текст в подвале входа. */
  footerMax: number;
}

export interface BrandingSettings {
  companyName: string | null;
  productName: string | null;
  /** Свой текст в подвале страницы входа. null — строки продукта. */
  loginFooter: string | null;
  logo: {
    /** Адрес с отпечатком содержимого: смена файла меняет адрес. */
    url: string;
    mime: string;
    width: number;
    height: number;
    size: number;
    version: string;
    updatedAt: string;
  } | null;
  /** Пределы называются интерфейсом ДО загрузки, а не только в отказе. */
  limits: BrandingLimits;
}

/* ------------------------------------------------------------------ */
/* Резервная копия НАСТРОЕК (не писем: письма — install/backup.sh)      */
/* ------------------------------------------------------------------ */

export interface BackupSectionInfo {
  id: string;
  title: string;
}

export interface BackupSectionsResponse {
  formatVersion: number;
  sections: BackupSectionInfo[];
  /** Что внутри файла из секретов — показывается рядом с кнопкой. */
  secretsNote: string;
}

export interface BackupSectionPlan {
  id: string;
  title: string;
  /** Появится заново. */
  create: string[];
  /** Будет перезаписано — то самое «что именно». */
  overwrite: string[];
  /** Есть здесь, но в копии нет: восстановление это не трогает. */
  untouched: number;
  warnings: string[];
}

export interface BackupRestorePlan {
  version: number;
  createdAt: string;
  source: { hostname: string; domain: string };
  sections: BackupSectionPlan[];
  warnings: string[];
}

export interface BackupPreviewResponse {
  plan: BackupRestorePlan;
  counts: Record<string, number>;
}

export interface BackupRestoreResponse {
  ok: true;
  applied: Record<string, { created: number; updated: number }>;
  plan: BackupRestorePlan;
  sieve: {
    resynced: number;
    errors: string[];
    /**
     * Ящики, чьи правила дособираются в фоне: в теле запроса не успели.
     * Пока это идёт, письма у них раскладываются по старым правилам.
     */
    pending: number;
  };
  /**
   * Почему не применилось оформление; null — применилось или не просили.
   * Отдельно от общей ошибки: всё остальное к этому моменту уже записано,
   * и ответ обязан сказать, что именно доехало.
   */
  brandingError: string | null;
  /**
   * Перенаправления, которые копия НЕ завела: их исходный адрес занят
   * живым ящиком, и такой алиас увёл бы всю его входящую почту.
   *
   * Сервер это предупреждение формировал давно — а в типе его не было,
   * значит на экран оно не попадало вовсе. Человек видел, что часть
   * перенаправлений не вернулась, и решал, что копия неполная.
   */
  aliasWarning: string | null;
  /**
   * Ящики, которые копия не завела: адрес занят перенаправлением.
   * Причина зеркальная aliasWarning — Postfix разбирает алиасы раньше
   * ящиков, и такой ящик стоял бы пустым.
   */
  mailboxWarning?: string | null;
  /**
   * Что копия сделала с идущим переносом почты: в отключённый ящик
   * Dovecot не пускает даже служебным доступом, и перенос встанет.
   *
   * Тоже терялось по дороге. Перенос останавливается через час после
   * восстановления, и связать одно с другим уже не с чем.
   */
  migrationWarning: string | null;
  note: string | null;
}

/* ------------------------------------------------------------------ */
/* Дашборд наблюдения                                                   */
/*                                                                      */
/* Показатель здесь — это ПАРА «значение или null» и строка о том,       */
/* откуда оно взято. Голое число не годится: сервер приложения живёт     */
/* в контейнере и часть показателей увидеть не может, а прочерк без      */
/* причины выглядит как поломка панели, а не как честное «недоступно».   */
/* ------------------------------------------------------------------ */

export interface Measured {
  value: number | null;
  /** Файл, из которого прочитано, или объяснение, почему не прочитано. */
  source: string;
}

export interface VolumeUsage {
  path: string;
  device: number | null;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

/** Статья расхода места: письма, индексы, база, журналы, очередь. */
export interface DiskSlice {
  id: string;
  title: string;
  bytes: number | null;
  source: string;
}

export interface QueueBrief {
  available: boolean;
  total: number | null;
  deferred: number | null;
  oldestSeconds: number | null;
  topDeferredDomains: Array<{ domain: string; count: number }>;
  /** Очередь длиннее предела разбора: показанные числа неполны. */
  truncated: boolean;
  note: string;
}

export interface OverviewResources {
  takenAt: string | null;
  intervalSeconds: number;
  cpu: {
    nodePercent: Measured;
    apiPercent: Measured;
    cores: Measured;
    apiLimit: Measured;
    load1: Measured;
  } | null;
  memory: { total: Measured; used: Measured; api: Measured; apiLimit: Measured } | null;
  volumes: VolumeUsage[];
  singleDevice: boolean;
  slices: DiskSlice[];
  queue: QueueBrief | null;
  /** Что недоступно из контейнера и почему — показывается словами. */
  unavailable: string[];
}

export interface MetricPoint {
  at: string;
  cpuNodePercent: number | null;
  cpuApiPercent: number | null;
  load1: number | null;
  memUsedPercent: number | null;
  memApiBytes: number | null;
  diskUsedPercent: number | null;
  vmailBytes: number | null;
  dbBytes: number | null;
  queueTotal: number | null;
  queueDeferred: number | null;
  queueOldestSeconds: number | null;
}

export interface OverviewHistory {
  available: boolean;
  note: string;
  hours: number;
  stepSeconds: number;
  points: MetricPoint[];
}

export interface OverviewMail {
  /** false — не применена миграция разобранного журнала; в note причина. */
  available: boolean;
  note: string;
  hours: number;
  stepSeconds: number;
  buckets: Array<{ at: string; counts: Record<string, number> }>;
  totals: Record<string, number>;
  byDirection: Record<string, number>;
  spamRejected: number;
  /**
   * Различных ПИСЕМ за окно — знаменатель доли спама.
   *
   * Не сумма totals: там строки журнала, то есть попытки доставки, и
   * письмо, отложенное трижды, даёт четыре строки. Доля спама, посчитанная
   * от них, тем сильнее занижена, чем хуже работала связь.
   */
  messages: number;
  spamNote: string;
  rejectReasons: Array<{ reason: string; count: number }>;
  deferReasons: Array<{ reason: string; count: number }>;
  sizes: {
    messages: number;
    totalBytes: number;
    avgBytes: number | null;
    medianBytes: number | null;
    maxBytes: number | null;
  };
  hourly: Array<{ hour: number; count: number }>;
  /** В каком часовом поясе посчитаны часы: без подписи график сдвинут молча. */
  hourlyTimeZone: string;
  historyStartsAt: string | null;
  historyEndsAt: string | null;
  mailboxesTotal: number;
  mailboxesActive: number;
  activityNote: string;
}

export type UserTrafficSort =
  | 'sentMessages'
  | 'sentBytes'
  | 'receivedMessages'
  | 'receivedBytes'
  | 'totalMessages'
  | 'totalBytes';

export interface UserTrafficRow {
  id: number;
  email: string;
  active: boolean;
  quotaBytes: number;
  sentMessages: number;
  sentBytes: number;
  receivedMessages: number;
  receivedBytes: number;
}

export interface OverviewUsers {
  hours: number;
  sort: UserTrafficSort;
  limit: number;
  offset: number;
  total: number;
  /**
   * Сколько ящиков за период не отправили и не получили ничего.
   *
   * Число СЕРВЕРНОЕ, по всем ящикам. Панель считала его сама по items, а
   * это запрошенная страница из 25 строк, отсортированная по трафику по
   * убыванию: молчавшие стоят в хвосте и в первую страницу не попадают
   * никогда. На сервере со 143 ящиками подпись всегда говорила «Молчали
   * за период: 0» — и выглядела при этом измеренной.
   */
  silent: number;
  items: UserTrafficRow[];
}

export interface MailboxDiskRow {
  email: string;
  bytes: number;
  messages: number;
  quotaBytes: number;
  /** Доля квоты в процентах; null — квоты нет вовсе. */
  usedPercent: number | null;
  active: boolean;
  known: boolean;
}

export interface OverviewMailboxes {
  available: boolean;
  note: string;
  takenAt: string | null;
  totalBytes: number;
  withoutAccounting: number;
  total: number;
  items: MailboxDiskRow[];
}

export interface TlsCertificate {
  title: string;
  host: string;
  port: number;
  available: boolean;
  subject: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysLeft: number | null;
  selfSigned: boolean;
  names: string[];
  error: string | null;
}

export interface OverviewSecurity {
  warnDays: number;
  certificateNote: string;
  certificates: TlsCertificate[];
  domains: Array<{
    id: number;
    name: string;
    dnsOverall: DnsStatus;
    dnsCheckedAt: string | null;
    dkimSelector: string | null;
    dkimConfigured: boolean;
  }>;
}

/* --- Логотипы доменов отправителей ---------------------------------- */

/**
 * Что действует у домена сейчас:
 *   blocked — логотип запрещён администратором, в кружке буква;
 *   manual  — картинка загружена вручную (она сильнее найденной);
 *   auto    — найдено само (BIMI или значок сайта);
 *   none    — не нашлось ничего, в кружке буква.
 */
export type SenderLogoState = 'blocked' | 'manual' | 'auto' | 'none';

export interface SenderLogoRow {
  domain: string;
  state: SenderLogoState;
  /** Откуда взята автоматическая картинка: 'bimi' | 'favicon' | 'ai'. */
  autoSource: string | null;
  /** Своя картинка есть — даже если домен запрещён и её не видно. */
  hasManual: boolean;
  width: number | null;
  height: number | null;
  /** Отпечаток действующей картинки: с ним предпросмотр не берётся из кэша. */
  version: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SenderLogoList {
  items: SenderLogoRow[];
  total: number;
  limit: number;
  offset: number;
  limits: {
    maxBytes: number;
    maxBytesText: string;
    minWidth: number;
    minHeight: number;
    maxWidth: number;
    maxHeight: number;
  };
}

/** Ответ на изменение: состояние одного домена после действия. */
export interface SenderLogoDomainState {
  domain: string;
  state: SenderLogoState;
  autoSource: string | null;
  hasManual: boolean;
  version: string | null;
}

/* --- Перенос почты с чужого сервера ---------------------------------- */

/**
 * Готовность раздела. Раздел работает только целиком, поэтому вместо
 * одного «недоступно» показываются все три условия по отдельности:
 * человеку нужно знать, что именно настроить.
 */
export interface MigrationSettings {
  ready: boolean;
  /** Служебный доступ к нашему Dovecot: без него писать в ящики нечем. */
  masterConfigured: boolean;
  /** Секрет шифрования: без него пароли исходных ящиков негде хранить. */
  secretConfigured: boolean;
  /** Применена ли миграция 0011. */
  schemaReady: boolean;
  destHost: string | null;
  destPort: number | null;
  defaultMasterSeparator: string;
}

/** Итог проверки связи с исходным сервером. */
export interface MigrationCheck {
  ok: boolean;
  /** Имя, под которым входили: в служебном режиме «ящик*служебный». */
  loginName: string;
  folders: number | null;
  messages: number | null;
  /** Разобранное объяснение отказа — не код и не «ошибка». */
  error: string | null;
}

/** Строка разобранного списка. Пароля здесь нет и быть не может. */
export interface MigrationRowPreview {
  sourceUser: string;
  destUser: string;
  /** Принесла ли строка пароль. Сам пароль остаётся на сервере. */
  hasPassword: boolean;
}

export interface MigrationListPreview {
  format: 'kerio-csv' | 'kerio-cfg' | 'pairs-csv' | 'plain';
  total: number;
  withPassword: number;
  problems: string[];
  rows: MigrationRowPreview[];
}

export type MigrationJobState = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export interface MigrationJob {
  id: number;
  adminLogin: string;
  state: MigrationJobState;
  stopRequested: boolean;
  sourceHost: string;
  sourcePort: number;
  sourceSecure: boolean;
  /** Имя служебного пользователя источника (не секрет). */
  masterUser: string | null;
  total: number;
  done: number;
  copied: number;
  skipped: number;
  failed: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Ведёт ли задание живой работник — иначе числа замрут не из-за поломки. */
  live: boolean;
}

export type MigrationItemState = 'queued' | 'running' | 'ok' | 'partial' | 'failed' | 'stopped';

export interface MigrationItem {
  position: number;
  sourceUser: string;
  destUser: string;
  state: MigrationItemState;
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  /** Папка, которая переносится прямо сейчас. */
  currentFolder: string | null;
  errors: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

export interface MigrationJobDetails {
  job: MigrationJob;
  items: MigrationItem[];
}

export interface MigrationStarted {
  ok: true;
  jobId: number;
  total: number;
  state: 'queued';
  retryOf?: number;
}

/** Настройки исходного сервера, которые вводит человек. Секретов здесь нет. */
export interface MigrationSource {
  host: string;
  port: number;
  secure: boolean;
  allowInsecureTls: boolean;
  masterUser?: string;
  masterSeparator?: string;
}

/** Список ящиков: текст как есть, разбирает его сервер. */
export interface MigrationListInput {
  text: string;
  sourceDomain?: string;
  destDomain?: string;
}

/* ================================================================== */
/* Антиспам: статистика, пороги, списки, обучение                      */
/* ================================================================== */

/** Сколько раз сработало правило rspamd и сколько оно весит. */
export interface SpamSymbol {
  symbol: string;
  weight: number;
  hits: number;
}

/** Разность счётчиков за выбранное окно (по снимкам, миграция 0022). */
export interface SpamPeriod {
  scanned: number;
  reject: number;
  addHeader: number;
  rewriteSubject: number;
  greylist: number;
  softReject: number;
  noAction: number;
  learned: number;
  /** Сколько раз за окно перезапускали rspamd — по ним видны разрывы. */
  restarts: number;
  samples: number;
  from: string | null;
  to: string | null;
  /** Признано спамом = отклонено + помечено. */
  spam: number;
  spamPercent: number | null;
}

export interface SpamOverview {
  hours: number;
  available: boolean;
  unavailable: string | null;
  live: {
    version: string;
    uptimeSeconds: number;
    scanned: number;
    learned: number;
    actions: Record<string, number>;
    bayes: Array<{ symbol: string; type: string; revision: number }>;
  } | null;
  period: SpamPeriod | null;
  periodNote: string;
  collectingSince: string | null;
  /** null — прочитать журнал не удалось; это НЕ то же самое, что ноль. */
  manualLearns: { spam: number; ham: number } | null;
  symbols: SpamSymbol[];
  symbolsNote: string;
  selfProbeNote: string;
}

export interface SpamHistoryItem {
  at: string;
  action: string;
  actionTitle: string;
  score: number;
  requiredScore: number | null;
  subject: string;
  sender: string;
  /*
   * Получателей и адрес отправителя сервер больше НЕ отдаёт: это чужая
   * переписка, а экран их не показывает. Поля оставлены необязательными,
   * чтобы обращение к ним не притворялось безопасным при сборке.
   */
  recipients?: string[];
  ip?: string;
  /** Непустое — письмо нашего аутентифицированного пользователя. */
  user: string;
  sizeBytes: number;
  symbols: Array<{ name: string; score: number; description: string }>;
}

export interface SpamHistory {
  available: boolean;
  note: string;
  total: number;
  items: SpamHistoryItem[];
}

export interface SpamList {
  id: string;
  title: string;
  tone: 'allow' | 'deny';
  value: 'address' | 'domain' | 'ip';
  symbol: string;
  score: number;
  editable: boolean;
  hint: string;
  /** Зачем список заводят — текст для пустой таблицы. */
  purpose: string;
  /** Пример записи: и в подсказке поля ввода, и в пустой таблице. */
  example: string;
  file: string;
  entries: string[];
  /** Почему список не прочитан; null — прочитан. */
  problem: string | null;
}

/* ------------------------------------------------------------------ */
/* Пороги                                                              */
/* ------------------------------------------------------------------ */

/** Один рубеж: с какого балла что происходит и чем грозит сдвиг. */
export interface SpamThresholdItem {
  id: string;
  title: string;
  /** Балл, с которого действие срабатывает; null — действие выключено. */
  value: number | null;
  effect: string;
  visible: string;
  higher: string;
  lower: string;
  off: string;
  /** Рекомендуемый коридор [от, до]; null — рекомендации нет. */
  advice: [number, number] | null;
  /** Значение вне коридора: повод перепроверить, а не ошибка. */
  unusual: boolean;
}

/**
 * Набор порогов для одного вида отправителей.
 *
 * Их два, и это не украшение: у писем собственных аутентифицированных
 * отправителей пороги свои, более мягкие, и без второго профиля экран не
 * объясняет, почему письмо сотрудника с той же оценкой в спам не ушло.
 */
export interface SpamThresholdProfile {
  id: 'common' | 'own';
  title: string;
  note: string;
  items: SpamThresholdItem[];
  /** Противоречия внутри набора — то, чего не видно по числам порознь. */
  warnings: string[];
  /** true — числа получены прогоном пробного письма, а не у контроллера. */
  measured: boolean;
  problem: string | null;
}

export interface SpamThresholds {
  available: boolean;
  unavailable: string | null;
  profiles: SpamThresholdProfile[];
  /** Всегда false: почему — в whyReadonly, и это объяснение обязано быть видно. */
  editable: boolean;
  whyReadonly: string;
  howTo: { file: string; format: string; command: string; note: string };
  probeNote: string;
  scaleNote: string;
}

export interface SpamListsResponse {
  available: boolean;
  unavailable: string | null;
  items: SpamList[];
  note: string;
}

export interface SpamListChange {
  ok: true;
  /** false — запись уже была (или её уже не было): ничего не изменилось. */
  changed: boolean;
  entries: string[];
}

export interface SpamCheckResult {
  as: 'outside' | 'own';
  /** Отправитель конверта — взят из заголовка From самого письма. */
  sender: string;
  score: number;
  action: string;
  actionTitle: string;
  thresholds: Record<string, number>;
  symbols: Array<{ name: string; score: number; description: string }>;
  note: string;
}

export interface SpamLearnResult {
  ok: true;
  kind: 'spam' | 'ham';
  note: string;
}

/** Ошибка из журнала самого rspamd — GET /spam/errors. */
export interface SpamErrorEntry {
  at: string;
  type: string;
  message: string;
}

export interface SpamErrors {
  available: boolean;
  items: SpamErrorEntry[];
  note: string;
}

export interface SpamSettings {
  controller: string;
  configured: boolean;
  mailDomain: string;
  resolver: string;
  smtpHost: string;
}

/* ================================================================== */
/* Наблюдение: исправность сервера                                     */
/* ================================================================== */

export type CheckState = 'ok' | 'warn' | 'fail' | 'unknown';

export interface HealthCheck {
  id: string;
  group: string;
  title: string;
  state: CheckState;
  detail: string;
  hint?: string;
}

export interface CheckSummary {
  state: CheckState;
  ok: number;
  warn: number;
  fail: number;
  unknown: number;
}

export interface MonitoringHealth {
  takenAt: string;
  summary: CheckSummary;
  checks: HealthCheck[];
  /** Что умеет только install/selfcheck.sh — и почему. */
  shellOnly: Array<{ title: string; why: string }>;
  shellOnlyNote: string;
}

/** Один шаг сквозной проверки доставки: отправка, доставка, подпись, уборка. */
export interface MailRoundtripStep {
  id: 'send' | 'deliver' | 'dkim' | 'cleanup';
  title: string;
  state: 'ok' | 'warn' | 'fail';
  detail: string;
  hint?: string;
}

export interface MailRoundtrip {
  ok: boolean;
  mailbox: string;
  /** Сколько секунд письмо шло до ящика; null — не дошло. */
  seconds: number | null;
  steps: MailRoundtripStep[];
}

export interface MonitoringExpiry {
  takenAt: string;
  warnDays: number;
  summary: CheckSummary;
  checks: HealthCheck[];
  certificateNote: string;
  dnsNote: string;
}

export interface MonitoringFailures {
  available: boolean;
  note: string;
  hours: number;
  counts: Record<string, number>;
  items: Array<{
    id: string;
    at: string;
    status: string;
    sender: string | null;
    recipient: string | null;
    dsn: string | null;
    reason: string | null;
  }>;
  rspamdErrors: Array<{ at: string; type: string; module: string; message: string }>;
}

/* ------------------------------------------------------------------ */
/* Смена основного домена                                               */
/* ------------------------------------------------------------------ */

/** Почему смену домена запускать нельзя. Пока список непуст — отказ. */
export interface DomainChangeBlocker {
  id: string;
  message: string;
  fix: string;
}

/** Запись DNS, которую надо опубликовать ДО начала. */
export interface DomainChangeDnsRecord {
  name: string;
  type: string;
  value: string;
  required: boolean;
  why: string;
}

/** Строк с адресом в одной таблице продукта. */
export interface DomainChangeTableMove {
  table: string;
  column: string;
  what: string;
  rows: number;
}

export interface DomainChangePlan {
  createdAt: string;
  oldDomain: string;
  newDomain: string;
  oldHostname: string;
  newHostname: string;
  counts: {
    mailboxes: number;
    aliases: number;
    disposableAliases: number;
    messages: number;
    bytes: number;
    rows: number;
    tables: DomainChangeTableMove[];
    freeTextHits: Array<{ what: string; rows: number }>;
  };
  space: {
    path: string;
    freeBytes: number;
    totalBytes: number;
    requiredBytes: number;
    renameOnly: boolean;
    ok: boolean;
  };
  dkim: { selector: string; recordName: string; publicKey: string; record: string };
  dnsToPublish: DomainChangeDnsRecord[];
  dnsReady: boolean;
  dnsSummary: string;
  blockers: DomainChangeBlocker[];
  breaks: string[];
  manual: string[];
  keeps: Array<{ what: string; why: string }>;
  downtimeSeconds: { min: number; max: number };
  warnings: string[];
}

export type DomainChangeState = 'planned' | 'running' | 'done' | 'failed' | 'cancelled';

/** Шаг выполнения — строка в ходе работ. */
export interface DomainChangeStep {
  id: string;
  title: string;
  state: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DomainChangeJob {
  id: number;
  state: DomainChangeState;
  adminLogin: string;
  oldDomain: string;
  newDomain: string;
  oldHostname: string;
  newHostname: string;
  dkimSelector: string;
  dkimPublicKey: string | null;
  plan: DomainChangePlan | null;
  steps: DomainChangeStep[];
  pointOfNoReturnAt: string | null;
  /** Можно ли ещё отказаться без последствий. */
  cancellable: boolean;
  mailboxes: number;
  aliases: number;
  messages: number;
  bytes: number;
  backupPath: string | null;
  backupBytes: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DomainChangeOverview {
  ready: boolean;
  reason: string | null;
  currentDomain: string;
  currentHostname: string;
  /** Есть ли чем зашифровать приватный ключ DKIM. */
  canStoreKey?: boolean;
  live: DomainChangeJob | null;
  /**
   * Смена домена прошла, а обязательный шаг на сервере — ещё нет.
   *
   * Определяется расхождением: в базе домен уже новый, а сервер
   * приложения читает MAIL_DOMAIN из окружения, и меняет его ровно тот
   * самый скрипт. Совпали — плашка исчезает сама.
   */
  pendingManual?: {
    jobId: number;
    newDomain: string;
    newHostname: string;
    currentDomain: string;
    finishedAt: string | null;
  } | null;
  history: DomainChangeJob[];
}

/* ================================================================== */
/* Настройки сервера                                                   */
/* ================================================================== */

/** Когда изменение начинает действовать (apps/api server-settings-registry). */
export type SettingGroup = 'live' | 'restart' | 'recreate' | 'locked';

/** Тип значения — разбирается так же, как переменная окружения. */
export type SettingKind = 'int' | 'bool' | 'string' | 'enum';

/** Единица измерения: панели — чтобы подписать поле и перевести в часы. */
export type SettingUnit =
  'bytes' | 'ms' | 'seconds' | 'minutes' | 'hours' | 'days' | 'rows' | 'count' | 'perMinute';

/** Откуда взято действующее значение. */
export type SettingSource = 'db' | 'env' | 'default';

export type SettingValue = string | number | boolean;

export interface ServerSetting {
  /** Имя переменной окружения — то же, что в infra/.env.example. */
  key: string;
  section: string;
  group: SettingGroup;
  kind: SettingKind;
  unit: SettingUnit | null;
  /**
   * Пустое значение допустимо: «адрес наружу определяем сами», «свои
   * резольверы не заданы». Без этого признака панель отвергала любую
   * пустую строку, и однажды заданную настройку нельзя было очистить
   * обратно — а кнопки «вернуть к умолчанию» у значения из infra/.env
   * нет.
   */
  allowEmpty: boolean;
  min: number | null;
  max: number | null;
  options: string[] | null;
  /** Описание по-русски: зачем настройка и чем грозит её смена. */
  description: string;
  /** Почему не меняется из веба. Только у группы locked. */
  reason: string | null;
  editable: boolean;
  /** Секрет: значение наружу не выходит, известно лишь «задан или нет». */
  secret: boolean;
  /**
   * ОБЕЩАНИЕ: изменение подействует только после перезапуска api.
   * Это свойство самой настройки, оно верно всегда.
   */
  requiresRestart: boolean;
  /**
   * ФАКТ: значение уже сохранено, а живой процесс работает по-старому.
   * Не путать с requiresRestart — тот говорит «когда-нибудь понадобится
   * перезапуск», этот — «перезапуск нужен прямо сейчас и вот из-за чего».
   */
  pendingRestart: boolean;
  /**
   * Что именно включит эту настройку — поимённо и в порядке выполнения.
   *
   * Общего «перезапустить всё» в продукте нет: остановка Postfix и
   * остановка nginx означают для людей совсем разное. Панель обязана
   * показать рядом с полем, ЧТО человек остановит, а подробности о
   * каждой службе взять из GET /restart (RestartTarget ниже) — второй
   * набор формулировок для одной службы однажды разошёлся бы с первым.
   */
  applies: SettingApply[];
  /** null у секрета — значения нет ни в каком виде. */
  value: SettingValue | null;
  default: SettingValue | null;
  /** Только у секретов: задан он или нет. У остальных null. */
  configured: boolean | null;
  source: SettingSource;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ServerSettingsSection {
  id: string;
  title: string;
  note: string | null;
  settings: ServerSetting[];
}

export interface ServerSettingsCounts {
  total: number;
  live: number;
  restart: number;
  /** Настройки чужих контейнеров: им мало перезапуска, нужно пересоздание. */
  recreate: number;
  locked: number;
  /** Сколько настроек задано в панели, а не взято из файла окружения. */
  overridden: number;
  /** Сколько уже сохранено, но ждёт перезапуска контейнера api. */
  pendingRestart: number;
}

export interface ServerSettingsResponse {
  sections: ServerSettingsSection[];
  counts: ServerSettingsCounts;
}

export interface ServerSettingsBulkResult extends ServerSettingsResponse {
  /** Сколько настроек действительно изменилось (совпавшие не в счёт). */
  changed: number;
}

/** Секрет, который можно выпустить заново. Значения у него нет и не будет. */
export interface RotatableSecret {
  key: string;
  title: string;
  /** Что произойдёт сразу после нажатия — до него, а не после. */
  impact: string;
  /** Какие службы пересоздаются, в порядке выполнения. */
  services: string[];
}

export interface RotatableSecretsResponse {
  /** Есть ли посредник: без него писать новое значение в infra/.env некому. */
  available: boolean;
  secrets: RotatableSecret[];
}

/* ================================================================== */
/* Перезапуск служб                                                    */
/* ================================================================== */

/**
 * Что делаем со службой.
 *
 *   restart  — перезапуск процесса в том же контейнере;
 *   recreate — пересоздание контейнера. Нужно, когда служба читает
 *              настройку из окружения: окружение задаётся при СОЗДАНИИ
 *              контейнера, и перезапуск процесса его не меняет.
 */
export type RestartAction = 'restart' | 'recreate';

/** Один шаг применения настройки: какую службу и как тронуть. */
export interface SettingApply {
  /** Имя из закрытого перечня RestartTarget.id. */
  target: string;
  action: RestartAction;
}

/** Служба, которую панель умеет перезапускать. Перечень задан на сервере. */
export interface RestartTarget {
  id: string;
  title: string;
  actions: RestartAction[];
  /** Сервер приложения перезапускает сам себя — посредник ему не нужен. */
  self: boolean;
  /** Что именно перестанет работать. Своё у каждой службы. */
  impact: string;
  /** Насколько. Отдельно от impact: это первое, что ищут глазами. */
  downtime: string;
  /** Что НЕ пострадает: половина страха перед кнопкой — незнание границ. */
  safe: string;
  /** Можно ли нажать прямо сейчас. */
  available: boolean;
  /** Почему нельзя — словами. null, когда можно. */
  unavailableReason: string | null;
  /** Команда для консоли по каждому действию: на случай «посредника нет». */
  commands: Partial<Record<RestartAction, string>>;
}

/** Заявка на перезапуск: что заказали и чем кончилось. */
export interface RestartJob {
  id: string;
  service: string;
  action: RestartAction | 'boot';
  requestedBy: string | null;
  requestedAt: string;
  finishedAt: string | null;
  status: 'pending' | 'ok' | 'failed';
  /** Чем кончилось, человеческим текстом. У неудачи — с хвостом журнала. */
  detail: string | null;
}

export interface RestartState {
  /**
   * Метка ЖИВОГО процесса сервера приложения.
   *
   * Ради неё всё и сделано: панель запоминает метку до нажатия и
   * опрашивает сервер, пока не увидит другую. Только это доказывает, что
   * перед ней уже новый процесс, а не тот же самый, который задумался.
   */
  bootId: string | null;
  startedAt: string | null;
  restartPending: boolean;
  agent: { configured: boolean; ok: boolean; error: string | null };
  /** Применена ли миграция журнала перезапусков. */
  journal: boolean;
  targets: RestartTarget[];
  jobs: RestartJob[];
}

/** Ответ на заявку: 202 и номер, по которому спрашивают результат. */
export interface RestartAccepted {
  id: string;
  service: string;
  action: RestartAction;
  self: boolean;
  bootId: string | null;
  status: 'pending';
}

/** Состояние заявки плюс метка процесса, отвечающего прямо сейчас. */
export interface RestartJobState extends RestartJob {
  bootId: string | null;
}

/* ------------------------------------------------------------------
 * Раздел «Сертификат»
 *
 * Приватного ключа здесь нет ни в одном поле — и не появится: сервер его
 * не отдаёт вовсе (apps/api/src/admin/routes/tls.ts). Наверх приезжают
 * только сведения о сертификате и разбор того, что человек принёс.
 * ------------------------------------------------------------------ */

export type TlsIssueLevel = 'ok' | 'warn' | 'fail';

export interface TlsIssue {
  id: string;
  level: TlsIssueLevel;
  title: string;
  detail: string;
  hint?: string;
}

export interface TlsCertificateInfo {
  commonName: string;
  subject: string;
  issuer: string;
  names: string[];
  validFrom: string;
  validTo: string;
  daysLeft: number;
  serialNumber: string;
  fingerprint256: string;
  selfSigned: boolean;
}

export interface TlsCheckResult {
  ok: boolean;
  issues: TlsIssue[];
  certificate: TlsCertificateInfo | null;
  chain: TlsCertificateInfo[];
  missingNames: string[];
}

/* ------------------------------------------------------------------
 * Автопродление: не срок сертификата, а состояние того, что его двигает.
 *
 * Сведения приходят из отчёта, который оставляет install/renew-certs.sh
 * на хосте (infra/data/certs/renewal.json). Поля НЕ перечисления, а
 * строки, и это осознанно: хост и контейнер обновляются порознь, и
 * новое значение итога, приехавшее от свежего скрипта, не должно
 * ломать разбор в старой панели.
 * ------------------------------------------------------------------ */

export interface RenewalAttempt {
  /** Когда была попытка, ISO 8601. */
  at: string;
  /** Чем запущена: timer | manual | install. */
  trigger: string;
  /** С каким ключом: renew | force | deploy. */
  mode: string;
  /** Чем кончилась: renewed | not-due | deployed | issued | failed | skipped-custom. */
  outcome: string;
  /** До какого числа действует сертификат после попытки. Пусто — неизвестно. */
  validTo: string;
  seconds: number;
  /** Причина словами — то единственное, что остаётся от неудачного прогона. */
  message: string;
}

export interface RenewalTimer {
  /** systemd | cron | none. */
  kind: string;
  unit: string;
  enabled: boolean;
  /** Пусто, если следующего запуска нет или он неизвестен. */
  nextRunAt: string;
  detail: string;
}

export interface RenewalReport {
  version: number;
  updatedAt: string;
  certSource: string;
  timer: RenewalTimer;
  /** Новые сверху. Хранится последний десяток. */
  attempts: RenewalAttempt[];
}

export interface RenewalVerdict {
  state: CheckState;
  detail: string;
  hint?: string;
}

export interface TlsRenewal {
  /** null, если отчёта нет или он не разобрался; тогда смотреть problem. */
  report: RenewalReport | null;
  problem: string;
  verdict: RenewalVerdict;
  /** Команды для консоли. Приходят с сервера: путь к скрипту знает он. */
  commands: { renew: string; force: string; installTimer: string };
}

export interface TlsOverview {
  source: 'selfsigned' | 'letsencrypt' | 'custom' | 'unknown';
  sourceLabel: string;
  expectedNames: string[];
  optionalNames: string[];
  /** Пусто, если сертификат прочитался. Иначе — почему не прочитался. */
  unreadable: string;
  current: TlsCheckResult | null;
  renewal: TlsRenewal;
}

export interface TlsApplyResult {
  ok: true;
  applied: TlsCheckResult;
  source: 'custom';
  /** Через сколько секунд службы перечитают файл. */
  reloadSeconds: number;
}

export interface TlsBundleInputDto {
  certificate: string;
  privateKey: string;
  chain?: string;
}

/**
 * Что за версия продукта стоит на сервере и какие образы у служб.
 *
 * Обновления в продукте не было как явления: обновиться можно только
 * руками по ssh, базовые образы прибиты тегами, а версии в панели не
 * видно вовсе. Сервер, поставленный полгода назад, крутит полугодовалый
 * nginx — и владелец об этом не узнает.
 */
export interface VersionInfo {
  commit: string;
  /** Коротко — его и показываем человеку. */
  short: string;
  branch: string;
  committedAt: string;
  /** Заголовок коммита: он говорит больше, чем набор букв. */
  subject: string;
  /**
   * В рабочем дереве правки руками. Обновление их затрёт или упрётся в
   * конфликт — сказать об этом надо ДО кнопки.
   */
  dirty: boolean;
  /** Сколько скачанных коммитов ещё не применено. */
  behind: number;
  ahead: number;
  pending: Array<{ hash: string; at: string; subject: string }>;
  /**
   * Тег («nginx:1.27-alpine») ничего не говорит: под ним за полгода
   * лежит другой слепок, и разница видна только по digest.
   */
  images: Array<{ service: string; image: string; digest: string; created: string }>;
}

/**
 * Ход обновления.
 *
 * `idle` — ничего не идёт и не шло; `running` — работа в стороне;
 * `done`/`failed` — чем кончилось прошлое. Состояние живёт в отдельном
 * контейнере обновления, а не в посреднике: посредник во время
 * обновления пересоздаётся сам и всё, что помнил, теряет. Поэтому
 * страницу можно закрыть и вернуться — ход не пропадёт.
 */
export interface UpdateStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  mode: 'code' | 'images' | null;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  /** Вывод как есть — его читают, когда обновление не задалось. */
  log: string;
}

/**
 * Учётная запись администратора панели (`GET /admins`).
 *
 * Раньше этот список никем не запрашивался: управление администраторами
 * жило только в консоли (admin/cli.ts), то есть отключить уволенного
 * можно было лишь с доступом к серверу.
 */
export interface AdminAccount {
  id: number;
  login: string;
  displayName: string | null;
  role: AdminRole;
  roleLabel: string;
  active: boolean;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  lockedUntil: string | null;
  createdAt: string;
}
