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
  | 'admins.manage';

export interface AdminSession {
  authenticated: true;
  login: string;
  displayName: string | null;
  role: AdminRole;
  roleLabel: string;
  permissions: Permission[];
  masterAccess: boolean;
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
