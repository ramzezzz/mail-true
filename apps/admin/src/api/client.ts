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
  BackupPreviewResponse,
  BackupRestoreResponse,
  BackupSectionsResponse,
  BrandingSettings,
  SenderLogoDomainState,
  SenderLogoList,
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
  MigrationCheck,
  MigrationJob,
  MigrationJobDetails,
  MigrationListInput,
  MigrationListPreview,
  MigrationSettings,
  MigrationSource,
  MigrationStarted,
  Overview,
  OverviewHistory,
  OverviewMail,
  OverviewMailboxes,
  OverviewResources,
  OverviewSecurity,
  OverviewUsers,
  QueuePage,
  SieveSyncState,
  SignatureBulkPreview,
  SignatureBulkRequest,
  SignatureBulkResult,
  SignatureVariable,
  UserDeleteResult,
  UserFilterRule,
  UserGeneralSettings,
  UserSettingsBundle,
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

/**
 * Часовой пояс браузера в виде имени IANA («Europe/Moscow»).
 *
 * Именем, а не смещением: смещение меняется дважды в год, и окно в
 * тридцать суток может захватить перевод часов — тогда постоянная поправка
 * сдвинула бы половину графика. Postgres знает историю переходов, ему
 * достаточно имени. Не узнали имя — не шлём ничего, сервер честно считает
 * по UTC и говорит об этом подписью.
 */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Форму (загрузка логотипа, файл копии настроек) заголовком не помечаем:
  // границу multipart браузер выбирает сам, а заданный вручную
  // Content-Type её затирает, и на сервере тело перестаёт разбираться.
  const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const headers: Record<string, string> =
    init?.body && !isForm ? { 'Content-Type': 'application/json' } : {};
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
const put = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' });

/**
 * Отправка файла формой. Content-Type здесь НЕ ставим руками: границу
 * multipart браузер выбирает сам, и заданный вручную заголовок ломает
 * разбор на сервере — тело приезжает без границы.
 */
const sendForm = <T>(path: string, form: FormData): Promise<T> =>
  request<T>(path, { method: 'POST', body: form });

export const api = {
  /* --- вход --- */
  session: () => get<AdminSession>('/auth/session'),
  login: (login: string, password: string) => post<LoginResult>('/auth/login', { login, password }),
  logout: () => post<{ ok: true }>('/auth/logout'),
  /** Запомнить тему за вошедшим администратором; null — вернуть умолчание. */
  saveTheme: (theme: string | null) =>
    put<{ ok: true; theme: string | null }>('/auth/theme', { theme }),

  /* --- сводка --- */
  overview: () => get<Overview>('/overview'),

  /*
   * Дашборд наблюдения. Разделов пять, а не один большой ответ, и это
   * не дробление ради дробления: они стоят разного времени. Ресурсы
   * отдаются из памяти сборщика мгновенно, агрегаты по сотням тысяч
   * строк — десятки миллисекунд, занятость ящиков — обход хранилища,
   * сертификаты — сетевые соединения с таймаутом. Одним ответом весь
   * экран ждал бы самого медленного из них.
   */
  overviewResources: () => get<OverviewResources>('/overview/resources'),
  overviewHistory: (hours: number) =>
    get<OverviewHistory>(`/overview/history${query({ hours })}`),
  /**
   * Почтовый поток. Часовой пояс браузера уходит на сервер: график
   * «Пиковые часы» считается запросом (по всему окну, а не по точкам),
   * и без пояса он молча оказывался в UTC — на три часа мимо московского
   * вечера, тогда как соседний график того же экрана подписан временем
   * браузера. Пик обслуживания планируют по этому графику, и расхождение
   * между двумя графиками одной страницы читается как ошибка данных.
   */
  overviewMail: (hours: number) =>
    get<OverviewMail>(`/overview/mail${query({ hours, tz: browserTimeZone() })}`),
  overviewUsers: (params: {
    hours?: number | undefined;
    sort?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }) => get<OverviewUsers>(`/overview/users${query(params)}`),
  overviewMailboxes: (limit?: number) =>
    get<OverviewMailboxes>(`/overview/mailboxes${query({ limit })}`),
  overviewSecurity: () => get<OverviewSecurity>('/overview/security'),

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

  /* --- настройки чужого ящика --- */
  /**
   * Всё разом: общие настройки с подписями, фильтры, папки. Одним запросом,
   * а не тремя: это единственная точка входа в чужие настройки, и запись
   * в журнале аудита должна появляться один раз на открытие раздела.
   */
  userSettings: (id: number) => get<UserSettingsBundle>(`/users/${id}/settings`),
  saveUserGeneral: (id: number, body: UserGeneralSettings) =>
    put<UserGeneralSettings & { sieve: SieveSyncState }>(`/users/${id}/settings/general`, body),
  createUserFilter: (id: number, body: UserFilterRule) =>
    post<UserFilterRule & { sieve: SieveSyncState }>(`/users/${id}/settings/filters`, body),
  updateUserFilter: (id: number, filterId: string, body: UserFilterRule) =>
    put<UserFilterRule & { sieve: SieveSyncState }>(
      `/users/${id}/settings/filters/${filterId}`,
      body,
    ),
  deleteUserFilter: (id: number, filterId: string) =>
    del<{ ok: true; sieve: SieveSyncState }>(`/users/${id}/settings/filters/${filterId}`),
  reorderUserFilters: (id: number, ids: string[]) =>
    put<UserFilterRule[]>(`/users/${id}/settings/filters/order`, { ids }),
  /** Текст действующего файла правил — доказательство, что правка доехала. */
  userSieve: (id: number) =>
    get<{ transport: string; path: string; script: string | null }>(`/users/${id}/settings/sieve`),

  /* --- подписи по шаблону --- */
  signatureVariables: () => get<{ items: SignatureVariable[] }>('/signatures/template/variables'),
  signatureBulkPreview: (body: SignatureBulkRequest) =>
    post<SignatureBulkPreview>('/signatures/bulk/preview', body),
  signatureBulkApply: (body: SignatureBulkRequest) =>
    post<SignatureBulkResult>('/signatures/bulk/apply', body),

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
  aliases: (params: {
    search?: string | undefined;
    domainId?: number | undefined;
    limit?: number | undefined;
    offset?: number;
  }) => get<AliasPage>(`/aliases${query(params)}`),
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
    del<{ ok: true; aliasesRemoved: number }>(
      `/domains/${id}${query({ force: force || undefined })}`,
    ),
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
  mailboxAccess: (params: {
    mailbox?: string | undefined;
    limit?: number | undefined;
    offset?: number;
  }) => get<MailboxAccessPage>(`/audit/mailbox-access${query(params)}`),

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
  mailboxFolders: () => get<{ mailboxEmail: string; folders: MailboxFolder[] }>('/mailbox/folders'),
  mailboxMessages: (path: string, limit = 30, offset = 0) =>
    get<{ mailboxEmail: string; items: MailboxMessage[]; total: number }>(
      `/mailbox/messages${query({ path, limit, offset })}`,
    ),
  mailboxMessage: (path: string, uid: number) =>
    get<{
      message: {
        uid: number;
        subject: string;
        from: string;
        to: string;
        date: string | null;
        text: string;
      };
    }>(`/mailbox/message${query({ path, uid })}`),
  mailboxLeave: () => post<{ ok: true }>('/mailbox/leave'),

  /* --- своё оформление входа (OEM) --- */
  branding: () => get<BrandingSettings>('/branding'),
  uploadLogo: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return sendForm<BrandingSettings>('/branding/logo', form);
  },
  /** «Вернуть стандартный». Обязательная кнопка: OEM не должен быть в один конец. */
  resetLogo: () => del<BrandingSettings>('/branding/logo'),
  saveBrandingTexts: (body: { companyName?: string | null; productName?: string | null }) =>
    patch<BrandingSettings>('/branding', body),

  /* --- логотипы доменов отправителей --- */
  senderLogos: (params: { q?: string; limit: number; offset: number }) =>
    get<SenderLogoList>(`/sender-logos${query(params)}`),
  /**
   * Адрес предпросмотра. Отпечаток в адресе обязателен: без него браузер
   * показывал бы прежнюю картинку из своего кэша, и замена логотипа
   * выглядела бы неработающей.
   */
  senderLogoImageUrl: (domain: string, version: string | null) =>
    `${BASE}/sender-logos/${encodeURIComponent(domain)}/image${version ? `?v=${version}` : ''}`,
  uploadSenderLogo: (domain: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return sendForm<SenderLogoDomainState>(
      `/sender-logos/${encodeURIComponent(domain)}/image`,
      form,
    );
  },
  /** Убрать свою картинку — домен вернётся к найденной автоматически. */
  resetSenderLogo: (domain: string) =>
    del<SenderLogoDomainState>(`/sender-logos/${encodeURIComponent(domain)}/image`),
  /** Запретить домену логотип или снять запрет. Это НЕ то же, что убрать свою. */
  setSenderLogoBlocked: (domain: string, blocked: boolean) =>
    put<SenderLogoDomainState>(`/sender-logos/${encodeURIComponent(domain)}/blocked`, { blocked }),

  /* --- резервная копия НАСТРОЕК (письма — install/backup.sh) --- */
  backupSections: () => get<BackupSectionsResponse>('/backup/sections'),
  /**
   * Выгрузка. Мимо общего разбора ответа: тело — файл, который нужно
   * отдать браузеру на сохранение, а не показать.
   */
  backupExport: async (): Promise<{ blob: Blob; filename: string }> => {
    const response = await fetch(`${BASE}/backup/export`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) {
      let message = response.statusText;
      let code = 'ERROR';
      try {
        const body = (await response.json()) as { error?: string; message?: string };
        if (body.message) message = body.message;
        if (body.error) code = body.error;
      } catch {
        /* тело не JSON */
      }
      throw new ApiError(response.status, code, message);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const found = /filename="([^"]+)"/u.exec(disposition);
    return { blob: await response.blob(), filename: found?.[1] ?? 'mailtrue-settings.json' };
  },
  /** Разбор копии БЕЗ изменений: ответ — план, что произойдёт. */
  backupPreview: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return sendForm<BackupPreviewResponse>('/backup/preview', form);
  },
  /** Восстановление. Подтверждение обязательно — план человек уже видел. */
  backupRestore: (file: File, sections: readonly string[]) => {
    const form = new FormData();
    form.append('file', file);
    form.append('sections', sections.join(','));
    form.append('confirm', 'yes');
    return sendForm<BackupRestoreResponse>('/backup/restore', form);
  },

  /* --- перенос почты с чужого сервера ---
   *
   * Пароли идут ТОЛЬКО в одну сторону: в теле запроса на сервер. Обратно
   * они не приходят никогда — ни в предпросмотре списка, ни в ходе работы,
   * ни в отчёте. Поэтому и список ящиков отправляется ТЕКСТОМ (сервер
   * разбирает его сам): выгрузка Kerio содержит пароли всех сотрудников
   * открытым текстом, и разбирать её в браузере значило бы держать их
   * в памяти вкладки и слать обратно на каждый шаг.
   */
  migrateSettings: () => get<MigrationSettings>('/migrate/settings'),
  /** Проверка связи ДО начала: секунда сейчас против потерянной ночи потом. */
  migrateCheck: (body: MigrationSource & { user: string; password: string }) =>
    post<MigrationCheck>('/migrate/check', body),
  migrateParse: (list: MigrationListInput) => post<MigrationListPreview>('/migrate/parse', list),
  migrateStart: (body: {
    source: MigrationSource;
    list: MigrationListInput;
    masterPassword?: string;
  }) => post<MigrationStarted>('/migrate/jobs', body),
  migrateJobs: (limit?: number) =>
    get<{ jobs: MigrationJob[]; schemaReady: boolean }>(`/migrate/jobs${query({ limit })}`),
  migrateJob: (id: number) => get<MigrationJobDetails>(`/migrate/jobs/${String(id)}`),
  migrateStop: (id: number) =>
    post<{ ok: true; stopRequested: true }>(`/migrate/jobs/${String(id)}/stop`),
  /**
   * Повторить только неудавшиеся ящики. Пароль спрашивается заново —
   * он исчез вместе с завершённым заданием, и это не недоработка.
   */
  migrateRetry: (id: number, body: { masterPassword?: string; list?: MigrationListInput }) =>
    post<MigrationStarted>(`/migrate/jobs/${String(id)}/retry`, body),
};
