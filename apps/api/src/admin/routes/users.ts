/**
 * Почтовые ящики: список, создание, изменение, блокировка, пароль, квота,
 * массовые операции и импорт из CSV.
 *
 * Пароли кладём в virtual_users.password в формате Dovecot
 * ({SHA512-CRYPT}$6$...) — том же, что делает infra/scripts/create-mailbox.sh.
 * Поэтому созданный отсюда ящик сразу рабочий: Dovecot пускает по IMAP,
 * Postfix принимает для него почту.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../../errors.js';
import { errorInfo } from '../../log.js';
import { ConflictError } from '../errors.js';
import { buildAuditRecord, type AuditInput } from '../audit.js';
import { audit, currentAdmin, originOf, requireAdmin } from '../guard.js';
import { dovecotHash, generatePassword } from '../passwords.js';
import { parseUserImport } from '../csv.js';
import { packResult, unpackResult, type ImportJobResult } from '../import-jobs.js';
import { quarantineMaildir } from '../mailbox-cleanup.js';
import { isUndefinedTable, type ImportJobRow, type MailUserRow } from '../db.js';

const emailSchema = z.string().trim().toLowerCase().email().max(255);

const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  domainId: z.coerce.number().int().positive().optional(),
  /** all | active | blocked | overquota */
  status: z.enum(['all', 'active', 'blocked']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createSchema = z.object({
  email: emailSchema,
  password: z.string().min(8).max(1024).optional(),
  displayName: z.string().trim().max(255).optional(),
  quotaBytes: z.coerce.number().int().min(0).optional(),
  active: z.boolean().default(true),
  /** Создать домен, если его ещё нет (право domains.write проверяется отдельно). */
  createDomain: z.boolean().default(false),
});

const patchSchema = z.object({
  displayName: z.string().trim().max(255).nullable().optional(),
  quotaBytes: z.coerce.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

const passwordSchema = z.object({
  password: z.string().min(8).max(1024).optional(),
});

const bulkSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(1000),
  quotaBytes: z.coerce.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

const importSchema = z.object({
  csv: z.string().min(1).max(4 * 1024 * 1024),
  defaultQuotaBytes: z.coerce.number().int().min(0).optional(),
  allowNewDomains: z.boolean().default(false),
});

/** Представление ящика для интерфейса. */
function toDto(row: MailUserRow): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email,
    domain: row.domain,
    domainId: row.domain_id,
    displayName: row.display_name,
    quotaBytes: Number(row.quota_bytes),
    active: row.active,
    aliasCount: Number(row.alias_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Снимок для журнала аудита (без пароля). */
function snapshot(row: MailUserRow): Record<string, unknown> {
  return {
    email: row.email,
    display_name: row.display_name,
    quota_bytes: Number(row.quota_bytes),
    active: row.active,
  };
}

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;

  /* --- список ------------------------------------------------------ */
  app.get('/users', { preHandler: requireAdmin(app, 'users.read') }, async (request) => {
    const q = listQuerySchema.parse(request.query);
    const { rows, total } = await ctx.db.listMailUsers({
      search: q.search,
      domainId: q.domainId,
      active: q.status === 'all' ? undefined : q.status === 'active',
      limit: q.limit,
      offset: q.offset,
    });
    return { items: rows.map(toDto), total, limit: q.limit, offset: q.offset };
  });

  /* --- карточка ---------------------------------------------------- */
  app.get<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: requireAdmin(app, 'users.read') },
    async (request) => {
      const id = Number(request.params.id);
      const row = await ctx.db.findMailUserById(id);
      if (!row) throw new NotFoundError('Ящик не найден');
      const aliases = await ctx.db.listAliases({ search: row.email, limit: 100, offset: 0 });
      return {
        ...toDto(row),
        aliases: aliases.rows
          .filter((a) => a.source === row.email || a.destination === row.email)
          .map((a) => ({
            id: a.id,
            source: a.source,
            destination: a.destination,
            active: a.active,
          })),
      };
    },
  );

  /* --- размер ящика (по служебному доступу Dovecot) ---------------- */
  app.get<{ Params: { id: string } }>(
    '/users/:id/usage',
    { preHandler: requireAdmin(app, 'users.read') },
    async (request) => {
      const id = Number(request.params.id);
      const row = await ctx.db.findMailUserById(id);
      if (!row) throw new NotFoundError('Ящик не найден');
      if (!ctx.mailbox.configured) {
        return { available: false, messages: 0, bytes: 0 };
      }
      const usage = await ctx.mailbox.usage(row.email);
      return { available: true, ...usage };
    },
  );

  /* --- создание ---------------------------------------------------- */
  app.post('/users', { preHandler: requireAdmin(app, 'users.write') }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const admin = currentAdmin(request);

    const existing = await ctx.db.findMailUserByEmail(body.email);
    if (existing) throw new ConflictError(`Ящик ${body.email} уже существует`);

    const domainName = body.email.slice(body.email.indexOf('@') + 1);
    const allowCreateDomain = body.createDomain && admin.role === 'owner';
    const domain = await ctx.db.resolveDomain(domainName, allowCreateDomain);
    if (!domain) {
      throw new BadRequestError(
        `Домен «${domainName}» не заведён. Сначала добавьте его в разделе «Домены».`,
      );
    }

    const password = body.password ?? generatePassword();
    const created = await ctx.db.createMailUser({
      domainId: domain.id,
      email: body.email,
      passwordHash: dovecotHash(password),
      displayName: body.displayName ?? null,
      quotaBytes: body.quotaBytes ?? ctx.config.ADMIN_DEFAULT_QUOTA_BYTES,
      active: body.active,
    });

    await audit(ctx, request, {
      action: 'user.create',
      targetType: 'user',
      targetId: created.id,
      targetLabel: created.email,
      after: snapshot(created),
    });

    reply.status(201);
    // Сгенерированный пароль показываем ОДИН раз — сохранить его больше негде
    return { ...toDto(created), generatedPassword: body.password ? null : password };
  });

  /* --- изменение --------------------------------------------------- */
  app.patch<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: requireAdmin(app, 'users.write') },
    async (request) => {
      const id = Number(request.params.id);
      const body = patchSchema.parse(request.body);
      const before = await ctx.db.findMailUserById(id);
      if (!before) throw new NotFoundError('Ящик не найден');

      const patch: { displayName?: string | null; quotaBytes?: number; active?: boolean } = {};
      if (body.displayName !== undefined) patch.displayName = body.displayName;
      if (body.quotaBytes !== undefined) patch.quotaBytes = body.quotaBytes;
      if (body.active !== undefined) patch.active = body.active;

      const after = await ctx.db.updateMailUser(id, patch);
      if (!after) throw new NotFoundError('Ящик не найден');

      const action =
        body.active === false && before.active
          ? 'user.block'
          : body.active === true && !before.active
            ? 'user.unblock'
            : 'user.update';
      await audit(ctx, request, {
        action,
        targetType: 'user',
        targetId: id,
        targetLabel: after.email,
        before: snapshot(before),
        after: snapshot(after),
      });
      return toDto(after);
    },
  );

  /* --- смена пароля ------------------------------------------------ */
  app.post<{ Params: { id: string } }>(
    '/users/:id/password',
    { preHandler: requireAdmin(app, 'users.password') },
    async (request) => {
      const id = Number(request.params.id);
      const body = passwordSchema.parse(request.body ?? {});
      const row = await ctx.db.findMailUserById(id);
      if (!row) throw new NotFoundError('Ящик не найден');

      const password = body.password ?? generatePassword();
      await ctx.db.setMailUserPassword(id, dovecotHash(password));
      await audit(ctx, request, {
        action: 'user.password',
        targetType: 'user',
        targetId: id,
        targetLabel: row.email,
        before: { password: 'старый' },
        after: { password: 'новый' },
      });
      return { ok: true, email: row.email, generatedPassword: body.password ? null : password };
    },
  );

  /* --- удаление ---------------------------------------------------- */
  /**
   * Удаление ящика убирает ящик целиком, а не одну строку в таблице.
   *
   * Раньше уходила только строка virtual_users. Maildir оставался на диске
   * (18 МБ на ящик по замеру на стенде), оставались каталоги индексов
   * и сотни строк в служебных таблицах переноса — и, что хуже всего,
   * при повторном создании ящика с тем же адресом человек видел ЧУЖУЮ
   * старую почту: Dovecot просто открывал уцелевший каталог.
   *
   * Порядок шагов важен и выбран не случайно:
   *
   *   1. Очистка средствами Dovecot — ПОКА ящик ещё есть в базе. После
   *      удаления строки Dovecot не пустит даже служебного пользователя,
   *      и убрать индексы полнотекстового поиска (они в отдельном томе,
   *      куда у API доступа нет) будет уже нечем.
   *   2. Запись об удалении — до самого удаления, чтобы след остался
   *      даже если следующий шаг упадёт.
   *   3. Служебные строки и строка ящика.
   *   4. Карантин каталога: мгновенное переименование. С этого момента
   *      воскресший ящик с тем же адресом гарантированно пуст.
   *
   * Физическое удаление дерева делает уборщик (см. janitor.ts) — почему
   * именно так, подробно объяснено в mailbox-cleanup.ts.
   */
  app.delete<{ Params: { id: string }; Querystring: { reason?: string } }>(
    '/users/:id',
    { preHandler: requireAdmin(app, 'users.delete') },
    async (request) => {
      const id = Number(request.params.id);
      const row = await ctx.db.findMailUserById(id);
      if (!row) throw new NotFoundError('Ящик не найден');
      const admin = currentAdmin(request);
      const reason =
        typeof request.query.reason === 'string' && request.query.reason.trim() !== ''
          ? request.query.reason.trim().slice(0, 2000)
          : null;

      // 1. Индексы и данные Dovecot — руками самого Dovecot.
      let imapPurged = false;
      let imapError: string | null = null;
      if (ctx.mailbox.configured) {
        const outcome = await ctx.mailbox.purgeMail(row.email);
        imapPurged = outcome.ok;
        imapError = outcome.error;
      } else {
        imapError = 'Служебный доступ Dovecot не настроен: индексы придётся убрать вручную';
      }

      // 2. Запись об удалении. Нет таблицы (миграция 0006 не применена) —
      //    удаление всё равно должно работать, просто без учёта уборки.
      let deletionId = 0;
      try {
        deletionId = await ctx.db.recordMailboxDeletion({
          email: row.email,
          domain: row.domain,
          adminLogin: admin.login,
          reason,
          purgeDelayMinutes: ctx.config.ADMIN_MAILBOX_PURGE_DELAY_MINUTES,
        });
      } catch (err) {
        if (!isUndefinedTable(err)) throw err;
        request.log.warn('Нет таблицы mailbox_deletions: примените миграцию 0006_admin_cleanup.sql');
      }

      // 3. Всё, что принадлежит ящику в базе.
      const dbRowsRemoved = await ctx.db.purgeMailboxData(row.email);
      await ctx.db.deleteMailUser(id);

      // 4. Каталог — в карантин.
      const tag = deletionId > 0 ? String(deletionId) : String(Date.now());
      const quarantine = await quarantineMaildir(ctx.config.ADMIN_MAIL_ROOT, row.email, tag);
      if (deletionId > 0) {
        await ctx.db.updateMailboxDeletion(deletionId, {
          maildirPath: quarantine.maildirPath,
          quarantinePath: quarantine.quarantinePath,
          imapPurged,
          dbRowsRemoved,
          // Каталога не было — убирать нечего, состояние сразу конечное.
          ...(quarantine.existed ? {} : { state: 'purged' as const, purged: true }),
          error: quarantine.error ?? imapError,
        });
      }
      if (quarantine.error) {
        request.log.warn(
          { email: row.email, error: quarantine.error },
          'Каталог ящика не удалось увести в карантин',
        );
      }

      await audit(ctx, request, {
        action: 'user.delete',
        targetType: 'user',
        targetId: id,
        targetLabel: row.email,
        before: snapshot(row),
        // Поля снимка повторены пустыми: журнал сравнивает «было -> стало»
        // и отбрасывает то, чего нет в «стало». Без этого из записи об
        // удалении пропал бы сам удалённый ящик.
        after: {
          email: null,
          display_name: null,
          quota_bytes: null,
          active: null,
          deletion_id: deletionId,
          imap_purged: imapPurged,
          db_rows_removed: dbRowsRemoved,
          maildir_quarantined: quarantine.quarantinePath !== null,
          reason,
        },
      });

      return {
        ok: true,
        /** Каталог уведён из-под нового ящика с тем же адресом. */
        mailDirQuarantined: quarantine.quarantinePath !== null,
        /** Каталога не было вовсе — ящик ни разу не открывали. */
        mailDirMissing: !quarantine.existed,
        imapPurged,
        dbRowsRemoved,
        deletionId,
      };
    },
  );

  /* --- массовые операции ------------------------------------------- */
  app.post('/users/bulk', { preHandler: requireAdmin(app, 'users.write') }, async (request) => {
    const body = bulkSchema.parse(request.body);
    if (body.quotaBytes === undefined && body.active === undefined) {
      throw new BadRequestError('Не указано, что менять: quotaBytes или active');
    }
    let changed = 0;
    for (const id of body.ids) {
      const before = await ctx.db.findMailUserById(id);
      if (!before) continue;
      const patch: { quotaBytes?: number; active?: boolean } = {};
      if (body.quotaBytes !== undefined) patch.quotaBytes = body.quotaBytes;
      if (body.active !== undefined) patch.active = body.active;
      const after = await ctx.db.updateMailUser(id, patch);
      if (!after) continue;
      changed += 1;
      await audit(ctx, request, {
        action: body.quotaBytes !== undefined ? 'user.bulk.quota' : 'user.bulk.active',
        targetType: 'user',
        targetId: id,
        targetLabel: after.email,
        before: snapshot(before),
        after: snapshot(after),
      });
    }
    return { ok: true, changed };
  });

  /**
   * Создавать ли отсутствующие домены на самом деле.
   *
   * Право одно и то же и в предпросмотре, и в импорте: раньше предпросмотр
   * передавал разрешение как есть, а импорт дополнительно требовал роль
   * владельца. Роль «управление пользователями» видела в предпросмотре
   * строки без ошибок и обещание «домен будет создан», а импорт их
   * отбрасывал. Спецификация требует «предварительный показ того, что
   * будет создано» — значит, показывать надо ровно то, что произойдёт.
   */
  const effectiveAllowNewDomains = (requested: boolean, role: string): boolean =>
    requested && role === 'owner';

  /** Разбор файла в двух проходах: второй знает о занятых адресах. */
  async function parseImport(
    csv: string,
    allowNewDomains: boolean,
    defaultQuotaBytes: number | undefined,
  ): Promise<ReturnType<typeof parseUserImport>> {
    const domains = await ctx.db.listDomains();
    const knownDomains = domains.map((d) => d.name);
    // Сначала разбираем без сведений о занятых адресах, чтобы узнать,
    // какие адреса вообще встречаются, и спросить о них базу одним запросом
    const rough = parseUserImport(csv, { knownDomains, allowNewDomains });
    const existing = await ctx.db.listEmailsIn(rough.rows.map((r) => r.email).filter(Boolean));
    return parseUserImport(csv, {
      knownDomains,
      existingEmails: existing,
      allowNewDomains,
      defaultQuotaBytes: defaultQuotaBytes ?? ctx.config.ADMIN_DEFAULT_QUOTA_BYTES,
    });
  }

  /* --- импорт: предварительный показ ------------------------------- */
  app.post(
    '/users/import/preview',
    { preHandler: requireAdmin(app, 'users.write') },
    async (request) => {
      const body = importSchema.parse(request.body);
      const admin = currentAdmin(request);
      const allowNewDomains = effectiveAllowNewDomains(body.allowNewDomains, admin.role);
      const preview = await parseImport(body.csv, allowNewDomains, body.defaultQuotaBytes);
      // Пароли в предпросмотр не отдаём — только признак, задан ли он
      return {
        ...preview,
        rows: preview.rows.map((r) => ({ ...r, password: undefined, hasPassword: r.password !== null })),
        /** Будут ли создаваться новые домены на самом деле. */
        allowNewDomains,
        /**
         * Просили создавать домены, но роль не позволяет. Интерфейс должен
         * сказать об этом прямо, а не показывать несбыточное обещание.
         */
        newDomainsDenied: body.allowNewDomains && !allowNewDomains,
      };
    },
  );

  /* --- импорт: выполнение ------------------------------------------ */
  /**
   * Импорт — задание, а не один длинный запрос.
   *
   * Ответ приходит сразу с номером задания, а результат (включая
   * сгенерированные пароли) дописывается в базу по ходу работы и забирается
   * отдельным запросом. Раньше пароли существовали только в теле ответа:
   * оборвалась связь на 87-й секунде импорта 5000 строк — ящики созданы,
   * паролей нет ни у кого и восстановить их неоткуда. Подробности —
   * в src/admin/import-jobs.ts.
   */
  app.post('/users/import', { preHandler: requireAdmin(app, 'users.write') }, async (request, reply) => {
    const body = importSchema.parse(request.body);
    const admin = currentAdmin(request);
    const allowNewDomains = effectiveAllowNewDomains(body.allowNewDomains, admin.role);
    const preview = await parseImport(body.csv, allowNewDomains, body.defaultQuotaBytes);

    const jobId = await ctx.db.createImportJob({
      adminId: admin.adminId,
      adminLogin: admin.login,
      total: preview.rows.length,
    });

    const result: ImportJobResult = { created: [], failed: [] };
    const box = ctx.importBox;
    const origin = originOf(request);
    const auditRow = (input: AuditInput): Promise<void> =>
      ctx.db.writeAudit(
        buildAuditRecord({ id: admin.adminId, login: admin.login }, origin, input),
      );

    const save = async (state: 'running' | 'done', processed: number): Promise<void> => {
      await ctx.db.updateImportJob(jobId, {
        state,
        processed,
        createdCount: result.created.length,
        failedCount: result.failed.length,
        resultEnc: packResult(box, result),
        ...(state === 'done' ? { finished: true } : {}),
      });
    };

    // Сама работа. Запрос её не ждёт: обрыв связи больше ничего не значит.
    const run = async (): Promise<void> => {
      let processed = 0;
      for (const row of preview.rows) {
        processed += 1;
        if (row.errors.length > 0) {
          result.failed.push({ line: row.line, email: row.email, error: row.errors.join('; ') });
        } else {
          try {
            const domainName = row.email.slice(row.email.indexOf('@') + 1);
            const domain = await ctx.db.resolveDomain(domainName, allowNewDomains);
            if (!domain) {
              result.failed.push({
                line: row.line,
                email: row.email,
                error: `Домен «${domainName}» не заведён`,
              });
            } else {
              const generated = row.password === null;
              const password = row.password ?? generatePassword();
              const user = await ctx.db.createMailUser({
                domainId: domain.id,
                email: row.email,
                passwordHash: dovecotHash(password),
                displayName: row.displayName,
                quotaBytes: row.quotaBytes ?? ctx.config.ADMIN_DEFAULT_QUOTA_BYTES,
                active: true,
              });
              result.created.push({
                email: user.email,
                generatedPassword: generated ? password : null,
              });
              await auditRow({
                action: 'user.create',
                targetType: 'user',
                targetId: user.id,
                targetLabel: user.email,
                after: snapshot(user),
              });
            }
          } catch (err) {
            result.failed.push({
              line: row.line,
              email: row.email,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // Промежуточное сохранение: падение процесса на середине не должно
        // уносить с собой пароли уже созданных ящиков.
        if (processed % 25 === 0) await save('running', processed);
      }
      await save('done', processed);
      await auditRow({
        action: 'user.import',
        targetType: 'user',
        targetId: jobId,
        targetLabel: `${String(result.created.length)} из ${String(preview.rows.length)}`,
        after: { job_id: jobId, created: result.created.length, failed: result.failed.length },
      });
    };

    void run().catch(async (err: unknown) => {
      request.log.error(errorInfo(err, { jobId }), 'Импорт ящиков упал');
      await ctx.db
        .updateImportJob(jobId, {
          state: 'failed',
          error: err instanceof Error ? err.message : String(err),
          resultEnc: packResult(box, result),
          createdCount: result.created.length,
          failedCount: result.failed.length,
          finished: true,
        })
        .catch(() => undefined);
    });

    reply.status(202);
    return {
      ok: true,
      jobId,
      state: 'running',
      total: preview.rows.length,
      allowNewDomains,
      /** Где забрать результат — в том числе после обрыва связи. */
      resultUrl: `/api/admin/users/import/jobs/${String(jobId)}`,
      passwordsStored: box !== null,
    };
  });

  /* --- импорт: результат ------------------------------------------- */
  app.get('/users/import/jobs', { preHandler: requireAdmin(app, 'users.write') }, async () => {
    const rows = await ctx.db.listImportJobs(50);
    return { items: rows.map(jobDto) };
  });

  app.get<{ Params: { id: string } }>(
    '/users/import/jobs/:id',
    { preHandler: requireAdmin(app, 'users.write') },
    async (request) => {
      const row = await ctx.db.findImportJob(Number(request.params.id));
      if (!row) throw new NotFoundError('Задание импорта не найдено');
      const result = unpackResult(ctx.importBox, row.result_enc);
      return {
        ...jobDto(row),
        // Пароли отдаём столько раз, сколько попросят: пока задание живо,
        // администратор должен иметь возможность забрать их после обрыва.
        created: result?.created ?? [],
        failed: result?.failed ?? [],
        passwordsStored: ctx.importBox !== null && row.result_enc !== null,
      };
    },
  );
}

function jobDto(row: ImportJobRow): Record<string, unknown> {
  return {
    id: Number(row.id),
    adminLogin: row.admin_login,
    state: row.state,
    total: row.total,
    processed: row.processed,
    createdCount: row.created_count,
    failedCount: row.failed_count,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
  };
}
