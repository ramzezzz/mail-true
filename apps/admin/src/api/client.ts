/**
 * Клиент админского API. Все запросы идут с cookie (credentials: include),
 * поэтому отдельного токена в памяти держать не нужно.
 */
import type {
  AiAuditPage,
  AiDomain,
  AiDomainPatch,
  AiReference,
  AiTestResult,
  Alias,
  AliasPage,
  AdminSession,
  AuditPage,
  DnsCheckOne,
  DnsReport,
  Domain,
  FlowHistoryPage,
  FlowHistoryStats,
  ImportJob,
  ImportPreview,
  ImportStarted,
  LogPage,
  LogSourcesResponse,
  LogTailPage,
  LoginResult,
  MailboxAccessPage,
  MailboxEnterResult,
  MailboxFolder,
  MailboxMessage,
  MailUser,
  MailUserPage,
  Overview,
  QueuePage,
  UserDeleteResult,
} from './types';

const BASE = '/api/admin';

/** Ошибка API: код и понятное сообщение с сервера. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Требуется вход. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** Прав не хватает — вход есть, но роль не та. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

type Query = Record<string, string | number | boolean | undefined>;

function query(params: Query): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = init?.body ? { 'Content-Type': 'application/json' } : {};
  const response = await fetch(BASE + path, { credentials: 'include', headers, ...init });
  if (!response.ok) {
    let code = 'ERROR';
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      /* тело не JSON — оставляем statusText */
    }
    throw new ApiError(response.status, code, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const get = <T>(path: string): Promise<T> => request<T>(path);
const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' });

export const api = {
  /* --- вход --- */
  session: () => get<AdminSession>('/auth/session'),
  login: (login: string, password: string) =>
    post<LoginResult>('/auth/login', { login, password }),
  logout: () => post<{ ok: true }>('/auth/logout'),

  /* --- сводка --- */
  overview: () => get<Overview>('/overview'),

  /* --- пользователи --- */
  users: (params: {
    search?: string | undefined;
    domainId?: number | undefined;
    status?: 'all' | 'active' | 'blocked' | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }) => get<MailUserPage>(`/users${query(params)}`),
  user: (id: number) => get<MailUser & { aliases: Alias[] }>(`/users/${id}`),
  userUsage: (id: number) =>
    get<{ available: boolean; messages: number; bytes: number }>(`/users/${id}/usage`),
  createUser: (body: {
    email: string;
    password?: string;
    displayName?: string;
    quotaBytes?: number;
    active?: boolean;
  }) => post<MailUser>('/users', body),
  updateUser: (
    id: number,
    body: { displayName?: string | null; quotaBytes?: number; active?: boolean },
  ) => patch<MailUser>(`/users/${id}`, body),
  setUserPassword: (id: number, password?: string) =>
    post<{ ok: true; email: string; generatedPassword: string | null }>(
      `/users/${id}/password`,
      password ? { password } : {},
    ),
  deleteUser: (id: number, reason?: string) =>
    del<UserDeleteResult>(`/users/${id}${query({ reason })}`),
  bulkUsers: (body: { ids: number[]; quotaBytes?: number; active?: boolean }) =>
    post<{ ok: true; changed: number }>('/users/bulk', body),

  /* --- импорт --- */
  /** Квота для строк без своей колонки `quota` — показывается до импорта. */
  importDefaults: () => get<{ defaultQuotaBytes: number }>('/users/import/defaults'),
  importPreview: (csv: string, allowNewDomains = false, defaultQuotaBytes?: number) =>
    post<ImportPreview>('/users/import/preview', {
      csv,
      allowNewDomains,
      ...(defaultQuotaBytes !== undefined ? { defaultQuotaBytes } : {}),
    }),
  /**
   * Запуск импорта. Ответ приходит сразу с номером задания: сам импорт
   * идёт на сервере и его результат (включая сгенерированные пароли)
   * лежит в базе. Обрыв связи больше не уносит пароли с собой.
   */
  importRun: (csv: string, allowNewDomains = false, defaultQuotaBytes?: number) =>
    post<ImportStarted>('/users/import', {
      csv,
      allowNewDomains,
      ...(defaultQuotaBytes !== undefined ? { defaultQuotaBytes } : {}),
    }),
  importJob: (id: number) => get<ImportJob>(`/users/import/jobs/${id}`),
  importJobs: () => get<{ items: ImportJob[] }>('/users/import/jobs'),

  /* --- алиасы --- */
  aliases: (params: { search?: string | undefined; domainId?: number | undefined; limit?: number | undefined; offset?: number }) =>
    get<AliasPage>(`/aliases${query(params)}`),
  createAlias: (source: string, destination: string) =>
    post<Alias>('/aliases', { source, destination }),
  setAliasActive: (id: number, active: boolean) => patch<Alias>(`/aliases/${id}`, { active }),
  deleteAlias: (id: number) => del<{ ok: true }>(`/aliases/${id}`),

  /* --- домены --- */
  domains: () => get<{ items: Domain[] }>('/domains'),
  createDomain: (name: string) => post<Domain>('/domains', { name }),
  updateDomain: (
    id: number,
    body: { dkimSelector?: string; dkimPublicKey?: string | null; notes?: string | null },
  ) => patch<Domain>(`/domains/${id}`, body),
  /**
   * Удаление домена. Без force сервер откажет, если в домене есть алиасы:
   * каскад уничтожил бы их молча. С force они удаляются, а их список
   * попадает в журнал аудита.
   */
  deleteDomain: (id: number, force = false) =>
    del<{ ok: true; aliasesRemoved: number }>(`/domains/${id}${query({ force: force || undefined })}`),
  dnsCheck: (id: number) => post<DnsReport>(`/domains/${id}/dns-check`),
  /**
   * Перепроверка одной записи. Отдельный запрос, а не общий: записи
   * правят у регистратора по одной, и ждать полтора десятка ответов
   * ради одного — плохая сделка.
   */
  dnsCheckOne: (id: number, checkId: string) =>
    post<DnsCheckOne>(`/domains/${id}/dns-check/${encodeURIComponent(checkId)}`),

  /* --- журналы --- */
  audit: (params: {
    action?: string | undefined;
    adminLogin?: string | undefined;
    targetType?: string | undefined;
    search?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }) => get<AuditPage>(`/audit${query(params)}`),
  mailboxAccess: (params: { mailbox?: string | undefined; limit?: number | undefined; offset?: number }) =>
    get<MailboxAccessPage>(`/audit/mailbox-access${query(params)}`),

  /* --- помощник ИИ --- */
  aiReference: () => get<AiReference>('/ai/features'),
  aiDomains: () => get<{ items: AiDomain[] }>('/ai/domains'),
  aiDomain: (id: number) => get<AiDomain>(`/ai/domains/${id}`),
  updateAiDomain: (id: number, body: AiDomainPatch) => patch<AiDomain>(`/ai/domains/${id}`, body),
  /** Живая проверка связи: один настоящий вызов сервиса на служебном тексте. */
  aiTest: (id: number) => post<AiTestResult>(`/ai/domains/${id}/test`),
  aiAudit: (params: {
    accountId?: string | undefined;
    feature?: string | undefined;
    since?: string | undefined;
    limit?: number | undefined;
  }) => get<AiAuditPage>(`/ai/audit${query(params)}`),

  /* --- почтовый поток: очередь и история --- */
  queue: (params: {
    search?: string | undefined;
    queueName?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }) => get<QueuePage>(`/queue${query(params)}`),
  queueMessage: (id: string) =>
    get<{ queueId: string; text: string; truncated: boolean }>(`/queue/${id}/message`),
  queueFlush: (id: string) => post<{ ok: true }>(`/queue/${id}/flush`),
  queueDelete: (id: string) => post<{ ok: true }>(`/queue/${id}/delete`),
  flowHistory: (params: {
    hours?: number | undefined;
    status?: string | undefined;
    direction?: string | undefined;
    search?: string | undefined;
    limit?: number | undefined;
    beforeTime?: string | undefined;
    beforeId?: string | undefined;
    afterTime?: string | undefined;
    afterId?: string | undefined;
  }) => get<FlowHistoryPage>(`/queue/history${query(params)}`),
  flowStats: (hours: number) => get<FlowHistoryStats>(`/queue/history/stats${query({ hours })}`),

  /* --- журналы служб --- */
  logSources: () => get<LogSourcesResponse>('/logs/sources'),
  logs: (params: {
    source?: string | undefined;
    level?: string | undefined;
    search?: string | undefined;
    limit?: number | undefined;
    before?: number | undefined;
    fileId?: string | undefined;
  }) => get<LogPage>(`/logs${query(params)}`),

  /**
   * Только то, что дописано после `after`.
   *
   * Отдельный запрос, а не перечитывание первой страницы: перечитывание
   * не отличает новое от уже показанного и на быстром журнале теряет
   * строки между опросами.
   */
  logsNew: (params: {
    source: string;
    level?: string | undefined;
    search?: string | undefined;
    after: number;
    limit?: number | undefined;
    fileId?: string | undefined;
  }) => get<LogTailPage>(`/logs/new${query(params)}`),

  /* --- вход в чужой ящик --- */
  mailboxEnter: (email: string, reason: string) =>
    post<MailboxEnterResult>('/mailbox/enter', { email, reason }),
  mailboxSession: () =>
    get<{ active: true; mailboxEmail: string; reason: string; startedAt: string }>(
      '/mailbox/session',
    ),
  mailboxFolders: () =>
    get<{ mailboxEmail: string; folders: MailboxFolder[] }>('/mailbox/folders'),
  mailboxMessages: (path: string, limit = 30, offset = 0) =>
    get<{ mailboxEmail: string; items: MailboxMessage[]; total: number }>(
      `/mailbox/messages${query({ path, limit, offset })}`,
    ),
  mailboxMessage: (path: string, uid: number) =>
    get<{
      message: { uid: number; subject: string; from: string; to: string; date: string | null; text: string };
    }>(`/mailbox/message${query({ path, uid })}`),
  mailboxLeave: () => post<{ ok: true }>('/mailbox/leave'),
};
