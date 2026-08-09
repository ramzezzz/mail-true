/**
 * Маршруты сбора почты с других ящиков в форме, которую ждёт
 * веб-интерфейс (apps/web/src/api/settingsApi.ts, раздел
 * «Почта с других ящиков»).
 *
 * Это тонкая оболочка над теми же таблицами и тем же сборщиком, что
 * и /api/accounts/external: контракт интерфейса уже, чем внутренняя
 * модель (нет режима прямого подключения, нет охвата папок, нет
 * расписания), поэтому оболочка подставляет разумные значения
 * и переводит состояние сборщика в три состояния контракта.
 *
 * Отличия от контракта, о которых нужно знать (они честно перечислены
 * и в отчёте):
 *   - protocol: поддерживается только 'imap'. POP3 не реализован,
 *     и подключение с ним отклоняется, а не «сохраняется молча»;
 *   - leaveOnServer: письма на источнике не удаляются никогда, флаг
 *     сохраняется, но пока ни на что не влияет;
 *   - applyFilters: собранные письма кладутся IMAP-командой APPEND,
 *     а Sieve срабатывает только при доставке — поэтому правила к ним
 *     не применяются. Флаг сохраняется на будущее.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Folder } from '@mail-true/shared';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors.js';
import { listFolders } from '../imap/service.js';
import {
  folderIdOfPath,
  pathOfFolderId,
  toWebStatus,
  type WebCollector,
} from '../settings/webdto.js';
import type { MailSession } from '../types.js';
import { isUndefinedTable, isUniqueViolation } from './db.js';
import { AccountsUnavailableError, MIGRATION_HINT, type AccountsService } from './service.js';
import type { ExternalAccount, ExternalAccountInput } from './types.js';

const draftSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(1024),
  protocol: z.enum(['imap', 'pop3']).default('imap'),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  login: z.string().max(320).default(''),
  targetFolderId: z.string().max(512).default('inbox'),
  leaveOnServer: z.boolean().default(true),
  applyFilters: z.boolean().default(false),
});

const patchSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  password: z.string().min(1).max(1024).optional(),
  protocol: z.enum(['imap', 'pop3']).optional(),
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  login: z.string().max(320).optional(),
  targetFolderId: z.string().max(512).optional(),
  leaveOnServer: z.boolean().optional(),
  applyFilters: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const idParam = z.object({ id: z.string().min(1).max(64) });

function numericId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError(`Подключение не найдено: ${raw}`);
  return id;
}

/**
 * Признаки «оставлять на сервере» и «применять фильтры» контракту нужны,
 * а в наших таблицах отдельных столбцов под них нет: они не влияют на
 * работу сборщика. Держим их в метке подключения — так они переживают
 * перезапуск и возвращаются интерфейсу теми же, какими пришли.
 */
interface LabelFlags {
  label: string | null;
  leaveOnServer: boolean;
  applyFilters: boolean;
  protocol: 'imap' | 'pop3';
}

const FLAG_PREFIX = 'mt:';

export function encodeLabel(flags: LabelFlags): string {
  const bits = [
    flags.leaveOnServer ? 'leave' : '',
    flags.applyFilters ? 'filters' : '',
    flags.protocol === 'pop3' ? 'pop3' : '',
  ].filter(Boolean);
  return `${flags.label ?? ''}${FLAG_PREFIX}${bits.join(',')}`;
}

export function decodeLabel(raw: string | null): LabelFlags {
  if (raw === null) {
    return { label: null, leaveOnServer: true, applyFilters: false, protocol: 'imap' };
  }
  /*
   * Разделитель ищется С КОНЦА, потому что `encodeLabel` дописывает его
   * последним. Поиск с начала ломался о название, заданное человеком:
   * метку подключения принимает POST /api/accounts/external (до 255
   * символов любого текста), и «Почта mt: рабочая» разрезалась по ПЕРВОМУ
   * вхождению. Название обрубалось до «Почта », а флаги читались из
   * остатка — то есть «оставлять письма на сервере» молча слетало в
   * «нет», хотя в мастере стояла галочка.
   */
  const idx = raw.lastIndexOf(FLAG_PREFIX);
  if (idx < 0) return { label: raw, leaveOnServer: true, applyFilters: false, protocol: 'imap' };
  const label = raw.slice(0, idx);
  const bits = raw.slice(idx + FLAG_PREFIX.length).split(',');
  return {
    label: label === '' ? null : label,
    leaveOnServer: bits.includes('leave'),
    applyFilters: bits.includes('filters'),
    protocol: bits.includes('pop3') ? 'pop3' : 'imap',
  };
}

/** Внутреннее подключение -> DTO интерфейса. */
export function toWebCollector(account: ExternalAccount, folders: readonly Folder[]): WebCollector {
  const flags = decodeLabel(account.label);
  return {
    id: String(account.id),
    email: account.address,
    protocol: flags.protocol,
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    login: account.imap.user,
    targetFolderId: folderIdOfPath(folders, account.targetFolder) ?? account.targetFolder,
    leaveOnServer: flags.leaveOnServer,
    applyFilters: flags.applyFilters,
    enabled: account.enabled,
    status: toWebStatus(account.state.status),
    lastSyncAt: account.state.lastOkAt ?? account.state.lastRunAt,
    error: account.state.error,
  };
}

export async function collectorRoutes(
  app: FastifyInstance,
  service: AccountsService,
): Promise<void> {
  const { pool } = app.deps;

  const sessionOf = (request: { mailSession: MailSession | null }): MailSession => {
    if (!request.mailSession) throw new UnauthorizedError();
    return request.mailSession;
  };

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (isUndefinedTable(err)) throw new AccountsUnavailableError(MIGRATION_HINT);
      if (isUniqueViolation(err)) throw new BadRequestError('Такой ящик уже подключён');
      throw err;
    }
  };

  const foldersOf = (session: MailSession): Promise<Folder[]> =>
    pool.withClient(session.email, session.password, (client) => listFolders(client));

  app.get('/', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const accounts = await guard(() => service.requireDb().listExternal(session.email));
    const folders = await foldersOf(session);
    /*
     * Раздел «Почта с других ящиков» — только про СБОР.
     *
     * ------------------------------------------------------------------
     * ЧТО БЫЛО
     * ------------------------------------------------------------------
     * `listExternal` отдаёт все подключения ящика подряд, без разбора
     * режима, — в отличие от выборки для работника (`listDueCollectors`,
     * там фильтр есть). Поэтому здесь показывались и подключения ПРЯМОГО
     * доступа, где сбор не нужен и намеренно запрещён, а кнопка
     * «Проверить» рядом с ними начинала копировать чужой ящик во
     * «Входящие» — ровно то дублирование почты, ради отказа от которого
     * прямой режим и выбирают.
     */
    return accounts.filter((a) => a.mode !== 'direct').map((a) => toWebCollector(a, folders));
  });

  app.post('/', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const draft = draftSchema.parse(request.body);
    if (draft.protocol === 'pop3') {
      throw new BadRequestError(
        'Сбор по POP3 пока не реализован — подключите ящик по IMAP. ' +
          'Молча сохранить настройку, которая не заработает, мы не станем.',
      );
    }
    const db = service.requireDb();
    const box = service.requireSecretBox();
    const folders = await foldersOf(session);
    const targetFolder = pathOfFolderId(folders, draft.targetFolderId) ?? 'INBOX';

    const input: ExternalAccountInput = {
      address: draft.email,
      label: encodeLabel({
        label: null,
        leaveOnServer: draft.leaveOnServer,
        applyFilters: draft.applyFilters,
        protocol: draft.protocol,
      }),
      mode: 'collector',
      imapHost: draft.host,
      imapPort: draft.port,
      imapSecure: draft.secure,
      imapUser: draft.login.trim() === '' ? draft.email : draft.login,
      password: draft.password,
      // Проверку сертификата чужого сервера задаёт общая настройка
      // сервера: в контракте интерфейса такого флажка нет.
      allowInsecureTls: service.defaultAllowInsecureTls,
      smtpHost: null,
      smtpPort: null,
      smtpSecure: false,
      smtpUser: null,
      targetFolder,
      collectScope: 'inbox',
      intervalMinutes: 15,
      enabled: true,
    };

    // Проверяем подключение ДО сохранения: мастер обязан сказать
    // «работает» или «не работает», а не «сохранено, посмотрим завтра».
    await service.verifySettings(input, draft.password);
    const account = await guard(() =>
      db.createExternal(session.email, input, box.encrypt(draft.password)),
    );
    return toWebCollector(account, folders);
  });

  app.patch('/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const patch = patchSchema.parse(request.body);
    const db = service.requireDb();
    const found = await guard(() => db.findExternal(session.email, numericId(id)));
    if (!found) throw new NotFoundError('Подключение не найдено');

    const flags = decodeLabel(found.account.label);
    const folders = await foldersOf(session);
    const next: Parameters<typeof db.updateExternal>[2] = {
      label: encodeLabel({
        label: flags.label,
        leaveOnServer: patch.leaveOnServer ?? flags.leaveOnServer,
        applyFilters: patch.applyFilters ?? flags.applyFilters,
        protocol: patch.protocol ?? flags.protocol,
      }),
    };
    if (patch.host !== undefined) next.imapHost = patch.host;
    if (patch.port !== undefined) next.imapPort = patch.port;
    if (patch.secure !== undefined) next.imapSecure = patch.secure;
    if (patch.login !== undefined) next.imapUser = patch.login;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.targetFolderId !== undefined) {
      next.targetFolder = pathOfFolderId(folders, patch.targetFolderId) ?? 'INBOX';
    }

    const passwordEnc =
      patch.password !== undefined ? service.requireSecretBox().encrypt(patch.password) : undefined;
    const account = await guard(() =>
      db.updateExternal(session.email, numericId(id), next, passwordEnc),
    );
    if (!account) throw new NotFoundError('Подключение не найдено');
    await service.externalPool.close(session.email, numericId(id));
    return toWebCollector(account, folders);
  });

  app.delete('/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const removed = await guard(() =>
      service.requireDb().deleteExternal(session.email, numericId(id)),
    );
    if (!removed) throw new NotFoundError('Подключение не найдено');
    await service.externalPool.close(session.email, numericId(id));
    return { ok: true };
  });

  /**
   * Забрать почту прямо сейчас.
   *
   * Пароль владельца берётся из сессии: это позволяет собирать вручную
   * даже там, где служебный доступ Dovecot не настроен.
   */
  app.post('/:id/sync', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const db = service.requireDb();
    const found = await guard(() => db.findExternal(session.email, numericId(id)));
    if (!found) throw new NotFoundError('Подключение не найдено');
    /*
     * Тот же замок, что и на соседнем маршруте (accounts/routes.ts): у
     * прямого доступа сбора нет по устройству, и запускать его — значит
     * дублировать чужую почту в свой ящик.
     */
    if (found.account.mode === 'direct') {
      throw new BadRequestError('Это подключение работает в режиме прямого доступа, сбор не нужен');
    }

    await service.collect(session.email, found.account, found.passwordEnc, session.password);
    const after = await db.findExternal(session.email, numericId(id));
    const folders = await foldersOf(session);
    if (!after) throw new NotFoundError('Подключение не найдено');
    return toWebCollector(after.account, folders);
  });
}
