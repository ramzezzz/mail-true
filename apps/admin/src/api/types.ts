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
}

export interface Alias {
  id: number;
  source: string;
  destination: string;
  domain: string;
  domainId: number;
  active: boolean;
  createdAt: string;
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
}

export interface BrandingSettings {
  companyName: string | null;
  productName: string | null;
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
  sieve: { resynced: number; errors: string[] };
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
  hours: number;
  stepSeconds: number;
  buckets: Array<{ at: string; counts: Record<string, number> }>;
  totals: Record<string, number>;
  byDirection: Record<string, number>;
  spamRejected: number;
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
