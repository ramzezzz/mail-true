/**
 * Раздел «Перенос почты»: проверка связи, задания, ход работы, отчёты.
 *
 * Логику переноса здесь никто не повторяет — она целиком в packages/migrate
 * (сопоставление папок, дедупликация, докачка, разбор отказов сервера).
 * Эти маршруты только заводят задание, показывают его ход и дают его
 * остановить; выполняет задание работник (admin/migrate-runner.ts).
 *
 * ------------------------------------------------------------------
 * ПАРОЛИ И ЭТИ МАРШРУТЫ
 *
 * Правило одно и оно без исключений: пароль входит в API и не выходит.
 *
 *  - список ящиков разбирается на СЕРВЕРЕ, и предпросмотр отдаёт только
 *    адреса и признак «пароль в строке есть». Выгрузка Kerio содержит
 *    пароли всех сотрудников открытым текстом; отдать их в браузер
 *    значило бы разослать их по журналам прокси и по истории вкладок;
 *  - при запуске задания клиент присылает тот же ТЕКСТ списка заново,
 *    а не разобранные строки с паролями (ровно так же устроен импорт
 *    ящиков из CSV, см. routes/users.ts);
 *  - в ответах о ходе и в отчётах паролей нет ни открытых, ни в виде
 *    шифротекста: столбец secret_enc не покидает базу (см. db.ts);
 *  - в журнал аудита уходят только адреса и числа.
 *
 * Пароли ящиков-ПРИЁМНИКОВ не спрашиваются вовсе: панель входит в них
 * служебным доступом Dovecot, которым она и так открывает чужие ящики.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { probeEndpoint } from '@mail-true/migrate';
import { BadRequestError, NotFoundError } from '../../errors.js';
import { AdminUnavailableError } from '../errors.js';
import { audit, currentAdmin, requireAdmin } from '../guard.js';
import {
  packSecrets,
  parseMigrationList,
  rowsForApi,
  type MigrationSecrets,
  type SourceSettings,
} from '../migrate-jobs.js';
import type { AdminDb, MigrationItemRow, MigrationJobRow } from '../db.js';

/** Настройки исходного сервера, которые вводит человек. Секретов здесь нет. */
const sourceSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  /**
   * Свой сертификат. По умолчанию РАЗРЕШАЕМ: у внутренних Kerio и Exchange
   * сертификат почти всегда самоподписанный, и строгая проверка сделала бы
   * переезд невозможным без правки образа. Отключить проверку — осознанное
   * решение, поэтому флаг виден в интерфейсе и хранится в задании.
   */
  allowInsecureTls: z.boolean().default(true),
  /** Служебный пользователь источника — основной режим. */
  masterUser: z.string().trim().max(255).optional(),
  masterSeparator: z.string().trim().min(1).max(4).optional(),
});

/** Список ящиков: текст как есть плюс домены для адресов без «@». */
const listSchema = z.object({
  text: z.string().max(4 * 1024 * 1024),
  sourceDomain: z.string().trim().max(255).optional(),
  destDomain: z.string().trim().max(255).optional(),
});

const checkSchema = sourceSchema.extend({
  /** Чей ящик пробуем открыть (в служебном режиме — любой существующий). */
  user: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
});

const startSchema = z.object({
  source: sourceSchema,
  list: listSchema,
  /**
   * Пароль служебного пользователя источника. Обязателен в служебном
   * режиме и запрещён вне его: в режиме «пароль каждого ящика» он взялся
   * бы неоткуда и молча не применился.
   *
   * Проверяет это buildSecrets, а не схема: схема поля видит поле рядом
   * (source.masterUser), но обещание «запрещён вне служебного режима» жило
   * только в этом комментарии — пароль вне режима молча пропадал.
   */
  masterPassword: z.string().min(1).max(1024).optional(),
});

const retrySchema = z.object({
  masterPassword: z.string().min(1).max(1024).optional(),
  /** Тот же список — нужен, только если пароли берутся из него построчно. */
  list: listSchema.optional(),
});

/**
 * «1 ящик», «2 ящика», «5 ящиков».
 *
 * Метка задания попадает в журнал аудита, а его читают люди. «1 ящиков»
 * в строке о переносе чужой почты выглядит небрежностью ровно там, где
 * нужна аккуратность.
 */
function mailboxCount(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  const word =
    tens >= 11 && tens <= 14
      ? 'ящиков'
      : ones === 1
        ? 'ящик'
        : ones >= 2 && ones <= 4
          ? 'ящика'
          : 'ящиков';
  return `${String(n)} ${word}`;
}

/** Числа приходят из Postgres строками (bigint) — приводим один раз в одном месте. */
function num(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/** Сколько адресов показать в отказе, прежде чем свернуть остаток в «и ещё N». */
const LIST_IN_ERROR = 10;

/** «a@b, c@d и ещё 7» — перечисление, которое не превращает отказ в простыню. */
function listSome(items: readonly string[]): string {
  if (items.length <= LIST_IN_ERROR) return items.join(', ');
  return `${items.slice(0, LIST_IN_ERROR).join(', ')} и ещё ${String(items.length - LIST_IN_ERROR)}`;
}

/**
 * Проверить ящики-приёмники ДО постановки задания в очередь.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЗДЕСЬ, А НЕ ВО ВРЕМЯ ПЕРЕНОСА
 * ------------------------------------------------------------------
 * Раньше адрес приёмника не проверялся вовсе: столбец dest_user был
 * простой строкой, ни с чем не связанной. Опечатка в столбце «куда»
 * выгрузки принималась молча, задание вставало в очередь на ночь, и
 * обнаруживалось это утром — по строке, до которой работник дошёл в
 * три часа. Список ящиков человек приносит ЦЕЛИКОМ и правит его тоже
 * целиком, поэтому и назвать ему надо все плохие адреса разом, а не
 * первый попавшийся.
 *
 * Отключённые ящики отклоняются наравне с несуществующими: Dovecot не
 * пускает в отключённый ящик даже служебным доступом (см. пояснение
 * у destMailboxProblem), то есть перенос в него заведомо не состоится.
 *
 * Возвращает номера строк ящиков, чтобы задание сохранило связь с базой.
 */
async function resolveDestinations(
  db: AdminDb,
  rows: ReadonlyArray<{ destUser: string }>,
): Promise<Map<string, number>> {
  const states = await db.findMailboxStates(rows.map((r) => r.destUser));
  const missing: string[] = [];
  const disabled: string[] = [];
  const ids = new Map<string, number>();
  for (const row of rows) {
    const key = row.destUser.trim().toLowerCase();
    const found = states.get(key);
    if (!found) {
      if (!missing.includes(row.destUser)) missing.push(row.destUser);
      continue;
    }
    if (!found.active) {
      if (!disabled.includes(row.destUser)) disabled.push(row.destUser);
      continue;
    }
    ids.set(key, found.id);
  }

  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `на сервере нет ${String(missing.length)} ящик(ов)-приёмник(ов): ${listSome(missing)} — ` +
        'заведите их (в том числе пакетно, разделом «Импорт») или поправьте столбец «куда» в списке',
    );
  }
  if (disabled.length > 0) {
    problems.push(
      `отключено ${String(disabled.length)} ящик(ов)-приёмник(ов): ${listSome(disabled)} — ` +
        'в отключённый ящик Dovecot не пускает даже служебным доступом, включите их',
    );
  }
  if (problems.length > 0) {
    throw new BadRequestError(`Перенос не начат: ${problems.join('; ')}.`);
  }
  return ids;
}

/**
 * ОДИН ЯЩИК — ОДНО ЖИВОЕ ЗАДАНИЕ.
 *
 * Дедупликация переноса снимочная: список «чего ещё нет в приёмнике»
 * собирается ОДИН раз на папку, до копирования. Два задания, стартовавшие
 * в одном окне, видят одинаково пустой ящик и оба дописывают все письма —
 * у человека каждое письмо в двух экземплярах, а отчёт «перенесено»
 * удвоен. Работник ведёт задания ПАРАЛЛЕЛЬНО (concurrency в
 * migrate-runner.ts), так что «в одном окне» — это обычный порядок вещей,
 * а не редкое совпадение.
 *
 * Замок вынесен в общую функцию намеренно. Он был написан только для
 * создания задания, а повтор неудавшихся заводит ТАКОЕ ЖЕ новое задание в
 * те же самые ящики-приёмники — и проходил мимо замка. Через панель кнопку
 * повтора при живом задании прячут, то есть защищён был интерфейс, а не
 * сервер: повтор из другой вкладки, из истории браузера или прямым
 * запросом давал людям дубли всей переписки.
 */
async function ensureDestinationsFree(
  db: AdminDb,
  rows: ReadonlyArray<{ destUser: string }>,
): Promise<void> {
  const busy = new Set((await db.listActiveMigrationDestinations()).map((e) => e.toLowerCase()));
  const clash = rows.map((row) => row.destUser.trim().toLowerCase()).filter((e) => busy.has(e));
  if (clash.length === 0) return;
  const shown = [...new Set(clash)].slice(0, 5).join(', ');
  throw new BadRequestError(
    `Эти ящики уже переносятся прямо сейчас: ${shown}` +
      (clash.length > 5 ? ` и ещё ${String(clash.length - 5)}` : '') +
      '. Дождитесь окончания или остановите текущее задание — иначе письма ' +
      'скопируются повторно и у людей окажутся дубли.',
  );
}

/** Строка задания для интерфейса. Столбца с секретом здесь нет по построению. */
function jobForApi(row: MigrationJobRow): Record<string, unknown> {
  return {
    id: Number(row.id),
    adminLogin: row.admin_login,
    state: row.state,
    stopRequested: row.stop_requested,
    sourceHost: row.source_host,
    sourcePort: row.source_port,
    sourceSecure: row.source_secure,
    /** Имя служебного пользователя — не секрет, а способ понять, чем ходили. */
    masterUser: row.source_master_user,
    total: row.total,
    done: row.done_count,
    copied: num(row.copied),
    skipped: num(row.skipped),
    failed: num(row.failed),
    error: row.error,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    /**
     * Ведёт ли задание живой работник. По этому признаку интерфейс
     * отличает «идёт» от «подхватывается после перезапуска» — иначе
     * замершие на минуту числа читаются как поломка.
     */
    live: row.runner !== null,
  };
}

function itemForApi(row: MigrationItemRow): Record<string, unknown> {
  let errors: string[] = [];
  if (row.errors !== null) {
    try {
      const parsed: unknown = JSON.parse(row.errors);
      if (Array.isArray(parsed)) errors = parsed.map((e) => String(e));
    } catch {
      errors = [row.errors];
    }
  }
  return {
    position: row.position,
    sourceUser: row.source_user,
    destUser: row.dest_user,
    /**
     * Что с ящиком-приёмником ПРЯМО СЕЙЧАС: 'ok' | 'missing' | 'disabled'.
     * Отчёт по завершённому заданию тоже читают, и «ящик с тех пор удалён»
     * там объясняет расхождение чисел лучше, чем пустая строка.
     */
    destState: row.dest_active === null ? 'missing' : row.dest_active ? 'ok' : 'disabled',
    state: row.state,
    total: row.total,
    copied: row.copied,
    skipped: row.skipped,
    failed: row.failed,
    currentFolder: row.current_folder,
    errors,
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export async function adminMigrateRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;

  /**
   * Раздел работоспособен только целиком: без служебного доступа к нашему
   * Dovecot писать письма в ящики нечем, без секрета — хранить пароли
   * исходных ящиков негде, без миграции 0011 — негде хранить само задание.
   * Отвечаем словами, что именно не готово: «перенос недоступен» без
   * причины отправляет искать неисправность наугад.
   */
  const requireReady = async (): Promise<void> => {
    const problems: string[] = [];
    if (!ctx.config.masterConfigured) {
      problems.push(
        'не настроен служебный доступ Dovecot (DOVECOT_MASTER_USER/DOVECOT_MASTER_PASSWORD) — ' +
          'без него писать письма в ящики нечем',
      );
    }
    if (!ctx.migrationBox) {
      problems.push(
        'не задан ADMIN_SESSION_SECRET/SESSION_SECRET — пароли исходных ящиков негде ' +
          'хранить зашифрованными, а открытыми они храниться не будут',
      );
    }
    if (!(await ctx.db.migrationSchemaReady())) {
      problems.push('не применена миграция infra/postgres/migrations/0001_baseline.sql');
    }
    if (problems.length > 0) {
      throw new AdminUnavailableError(`Перенос почты недоступен: ${problems.join('; ')}.`);
    }
  };

  /* --- готовность раздела --------------------------------------- */
  app.get('/migrate/settings', { preHandler: requireAdmin(app, 'migration.read') }, async () => {
    const schemaReady = await ctx.db.migrationSchemaReady().catch(() => false);
    return {
      /** Готов ли раздел работать; если нет — reasons объясняют, чего не хватает. */
      ready:
        ctx.config.masterConfigured &&
        Boolean(ctx.migrationBox) &&
        schemaReady &&
        Boolean(ctx.migrationDest),
      masterConfigured: ctx.config.masterConfigured,
      secretConfigured: Boolean(ctx.migrationBox),
      schemaReady,
      /** Наш сервер — чтобы человек видел, куда именно поедет почта. */
      destHost: ctx.migrationDest?.host ?? null,
      destPort: ctx.migrationDest?.port ?? null,
      /** Разделитель служебного имени по умолчанию — тот же, что у нас. */
      defaultMasterSeparator: ctx.migrationDest?.masterSeparator ?? '*',
    };
  });

  /* --- проверка связи -------------------------------------------- */
  /**
   * Проверка ДО начала. Отдельный маршрут, а не «попробуем и посмотрим»:
   * задание запускают на ночь, а опечатка в имени сервера или неверный
   * пароль обнаруживались бы утром — потеряв ночь переноса.
   */
  app.post(
    '/migrate/check',
    { preHandler: requireAdmin(app, 'migration.run') },
    async (request) => {
      const body = checkSchema.parse(request.body);
      const result = await probeEndpoint(
        {
          host: body.host,
          port: body.port,
          secure: body.secure,
          user: body.user,
          pass: body.password,
          ...(body.masterUser ? { masterUser: body.masterUser } : {}),
          ...(body.masterUser && body.masterSeparator
            ? { masterSeparator: body.masterSeparator }
            : {}),
          ...(body.allowInsecureTls ? { allowInsecureTls: true } : {}),
        },
        { role: 'исходному' },
      );

      // Обращение к чужому серверу с чужими учётными данными — действие,
      // и след от него нужен. Пароля в записи нет: пишутся адрес, порт и
      // имя входа, то есть ровно то, что и так видно в задании.
      await audit(ctx, request, {
        action: 'migration.check',
        targetType: 'migration',
        targetLabel: `${body.host}:${String(body.port)}`,
        after: { host: body.host, port: body.port, login: result.loginName, ok: result.ok },
      });

      return {
        ok: result.ok,
        loginName: result.loginName,
        folders: result.folders ?? null,
        messages: result.messages ?? null,
        /** Уже разобранное объяснение отказа, а не код и не «ошибка». */
        error: result.error ?? null,
      };
    },
  );

  /* --- разбор списка ящиков --------------------------------------- */
  /**
   * Предпросмотр списка. Ответ БЕЗ паролей — см. rowsForApi. Выгрузка
   * Kerio содержит пароли всех сотрудников открытым текстом, и место им
   * только в памяти сервера между разбором и шифрованием.
   */
  app.post(
    '/migrate/parse',
    { preHandler: requireAdmin(app, 'migration.run') },
    async (request) => {
      const body = listSchema.parse(request.body);
      const parsed = parseMigrationList(body.text, {
        ...(body.sourceDomain !== undefined ? { sourceDomain: body.sourceDomain } : {}),
        ...(body.destDomain !== undefined ? { destDomain: body.destDomain } : {}),
      });
      return {
        format: parsed.format,
        total: parsed.rows.length,
        withPassword: parsed.withPassword,
        problems: parsed.problems,
        rows: rowsForApi(parsed.rows),
      };
    },
  );

  /* --- запуск задания --------------------------------------------- */
  app.post(
    '/migrate/jobs',
    { preHandler: requireAdmin(app, 'migration.run') },
    async (request, reply) => {
      await requireReady();
      const body = startSchema.parse(request.body);
      const admin = currentAdmin(request);
      const box = ctx.migrationBox;
      if (!box) throw new AdminUnavailableError('Перенос почты недоступен');

      const parsed = parseMigrationList(body.list.text, {
        ...(body.list.sourceDomain !== undefined ? { sourceDomain: body.list.sourceDomain } : {}),
        ...(body.list.destDomain !== undefined ? { destDomain: body.list.destDomain } : {}),
      });
      if (parsed.rows.length === 0) {
        throw new BadRequestError(
          'В списке нет ни одного ящика. Ожидается выгрузка Kerio (CSV или users.cfg), ' +
            'CSV с парами «откуда → куда» или просто список адресов по одному в строке.',
        );
      }

      const masterUser = body.source.masterUser ?? '';
      const secrets = buildSecrets(masterUser, body.masterPassword, parsed.rows);
      // Ящики-приёмники проверяются ДО постановки в очередь: см. resolveDestinations.
      const destIds = await resolveDestinations(ctx.db, parsed.rows);

      // Один ящик — одно живое задание (объяснение у ensureDestinationsFree).
      await ensureDestinationsFree(ctx.db, parsed.rows);

      const jobId = await ctx.db.createMigrationJob({
        adminId: admin.adminId,
        adminLogin: admin.login,
        source: {
          host: body.source.host,
          port: body.source.port,
          secure: body.source.secure,
          allowInsecureTls: body.source.allowInsecureTls,
          masterUser: masterUser === '' ? null : masterUser,
          masterSeparator: masterUser === '' ? null : (body.source.masterSeparator ?? '*'),
        },
        secretEnc: packSecrets(box, secrets),
        mailboxes: parsed.rows.map((r) => ({
          sourceUser: r.sourceUser,
          destUser: r.destUser,
          destUserId: destIds.get(r.destUser.trim().toLowerCase()) ?? null,
        })),
      });

      // В журнале — кто, откуда, сколько ящиков и каким доступом. Ни одного
      // пароля: buildAuditRecord вычистил бы их и сам, но их сюда и не кладут.
      await audit(ctx, request, {
        action: 'migration.start',
        targetType: 'migration',
        targetId: jobId,
        targetLabel: `${body.source.host} → ${mailboxCount(parsed.rows.length)}`,
        after: {
          job_id: jobId,
          source_host: body.source.host,
          source_port: body.source.port,
          mailboxes: parsed.rows.length,
          master_user: masterUser === '' ? null : masterUser,
          mode: masterUser === '' ? 'пароль каждого ящика' : 'служебный доступ',
        },
      });

      // Работник заберёт задание ближайшим проходом. Запрос его не ждёт:
      // перенос идёт часами, а ответ нужен сейчас.
      ctx.migrationRunner?.nudge();

      reply.status(202);
      return { ok: true, jobId, total: parsed.rows.length, state: 'queued' };
    },
  );

  /* --- список и подробности --------------------------------------- */
  app.get('/migrate/jobs', { preHandler: requireAdmin(app, 'migration.read') }, async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .parse(request.query);
    if (!(await ctx.db.migrationSchemaReady())) return { jobs: [], schemaReady: false };
    const rows = await ctx.db.listMigrationJobs(query.limit);
    return { jobs: rows.map(jobForApi), schemaReady: true };
  });

  app.get(
    '/migrate/jobs/:id',
    { preHandler: requireAdmin(app, 'migration.read') },
    async (request) => {
      const id = jobIdOf(request);
      const job = await ctx.db.findMigrationJob(id);
      if (!job) throw new NotFoundError('Задание переноса не найдено');
      const items = await ctx.db.listMigrationItems(id);
      return { job: jobForApi(job), items: items.map(itemForApi) };
    },
  );

  /* --- остановка --------------------------------------------------- */
  /**
   * Остановка — просьба, а не убийство процесса. Работник читает флаг
   * между письмами: оборвать APPEND на середине значило бы положить
   * в ящик половину письма. Поэтому ответ приходит сразу, а задание
   * останавливается на ближайшей безопасной границе.
   */
  app.post(
    '/migrate/jobs/:id/stop',
    { preHandler: requireAdmin(app, 'migration.run') },
    async (request) => {
      const id = jobIdOf(request);
      const job = await ctx.db.findMigrationJob(id);
      if (!job) throw new NotFoundError('Задание переноса не найдено');
      if (job.state !== 'queued' && job.state !== 'running') {
        throw new BadRequestError(`Задание уже завершено (${job.state}) — останавливать нечего`);
      }
      await ctx.db.requestMigrationStop(id);
      await audit(ctx, request, {
        action: 'migration.stop',
        targetType: 'migration',
        targetId: id,
        targetLabel: `${job.source_host} → ${mailboxCount(job.total)}`,
        after: { job_id: id, done: job.done_count, copied: num(job.copied) },
      });
      return { ok: true, stopRequested: true };
    },
  );

  /* --- повторить только неудавшиеся -------------------------------- */
  /**
   * Новое задание из ящиков, которые не доехали.
   *
   * Пароль спрашивается ЗАНОВО, и это не недоработка: пароли исчезают
   * вместе с завершённым заданием, и хранить их «на случай повтора»
   * означало бы хранить их бессрочно. Повтор безопасен: уже перенесённые
   * письма пропускаются дедупликацией и состоянием переноса.
   */
  app.post(
    '/migrate/jobs/:id/retry',
    { preHandler: requireAdmin(app, 'migration.run') },
    async (request, reply) => {
      await requireReady();
      const id = jobIdOf(request);
      const body = retrySchema.parse(request.body);
      const admin = currentAdmin(request);
      const box = ctx.migrationBox;
      if (!box) throw new AdminUnavailableError('Перенос почты недоступен');

      const job = await ctx.db.findMigrationJob(id);
      if (!job) throw new NotFoundError('Задание переноса не найдено');

      /*
       * ПОВТОРЯТЬ МОЖНО ТОЛЬКО ЗАКОНЧЕННОЕ ЗАДАНИЕ.
       *
       * Здесь не было ни одной из двух проверок, которые стоят при
       * создании задания, и обе они здесь нужны ровно по той же причине —
       * дубли писем у людей:
       *
       *   1. Состояние исходного задания не смотрели вовсе. У ИДУЩЕГО
       *      задания «неудавшимися» числятся и все ящики в состоянии
       *      queued — то есть те, до которых очередь просто ещё не дошла.
       *      Повтор забирал их себе, работник запускал оба задания
       *      параллельно, и каждое письмо этих ящиков приезжало дважды:
       *      дедупликация снимочная и второго задания не видит.
       *
       *   2. Замок по ящикам-приёмникам (ensureDestinationsFree) —
       *      страховка на случай, когда те же ящики переносит СОСЕДНЕЕ
       *      задание, а не это.
       *
       * Поэтому: живое задание сперва останавливают, и только потом
       * повторяют то, что действительно не доехало.
       */
      if (job.state === 'queued' || job.state === 'running') {
        throw new BadRequestError(
          'Это задание ещё не закончено — повторять пока нечего. Дождитесь окончания или ' +
            'нажмите «Остановить»: ящики, до которых очередь не дошла, сейчас числятся ' +
            'неудавшимися, и второе задание на те же ящики переписало бы людям всю почту ' +
            'по второму разу.',
        );
      }

      const items = await ctx.db.listMigrationItems(id);
      const bad = items.filter(
        (i) =>
          i.state === 'failed' ||
          i.state === 'partial' ||
          i.state === 'stopped' ||
          i.state === 'queued',
      );
      if (bad.length === 0) {
        throw new BadRequestError('В этом задании нет ящиков, которые стоило бы повторить');
      }

      // Пароли берём заново: из тела запроса (служебный доступ) или из
      // присланного заново списка (режим «пароль каждого ящика»).
      const masterUser = job.source_master_user ?? '';
      const fromList =
        body.list !== undefined
          ? parseMigrationList(body.list.text, {
              ...(body.list.sourceDomain !== undefined
                ? { sourceDomain: body.list.sourceDomain }
                : {}),
              ...(body.list.destDomain !== undefined ? { destDomain: body.list.destDomain } : {}),
            }).rows
          : [];
      const byAddress = new Map(fromList.map((r) => [r.sourceUser.toLowerCase(), r.password]));

      const rows = bad.map((item, index) => ({
        position: index,
        sourceUser: item.source_user,
        destUser: item.dest_user,
        password: byAddress.get(item.source_user.toLowerCase()),
      }));
      const secrets = buildSecrets(masterUser, body.masterPassword, rows);
      // Повтор — такое же новое задание, и ящики для него проверяются заново:
      // за время неудачного прогона приёмник могли и удалить, и отключить.
      await ensureDestinationsFree(ctx.db, rows);
      const destIds = await resolveDestinations(ctx.db, rows);

      const jobId = await ctx.db.createMigrationJob({
        adminId: admin.adminId,
        adminLogin: admin.login,
        source: {
          host: job.source_host,
          port: job.source_port,
          secure: job.source_secure,
          allowInsecureTls: job.source_insecure_tls,
          masterUser: masterUser === '' ? null : masterUser,
          masterSeparator: job.source_master_separator,
        },
        secretEnc: packSecrets(box, secrets),
        mailboxes: rows.map((r) => ({
          sourceUser: r.sourceUser,
          destUser: r.destUser,
          destUserId: destIds.get(r.destUser.trim().toLowerCase()) ?? null,
        })),
      });

      await audit(ctx, request, {
        action: 'migration.start',
        targetType: 'migration',
        targetId: jobId,
        targetLabel: `повтор задания ${String(id)}: ${mailboxCount(rows.length)}`,
        after: {
          job_id: jobId,
          retry_of: id,
          mailboxes: rows.length,
          source_host: job.source_host,
        },
      });

      ctx.migrationRunner?.nudge();
      reply.status(202);
      return { ok: true, jobId, total: rows.length, state: 'queued', retryOf: id };
    },
  );
}

/** Номер задания из адреса. */
function jobIdOf(request: FastifyRequest): number {
  const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
  return params.id;
}

/**
 * Собрать свёрток паролей.
 *
 * Служебный режим и построчный — взаимоисключающие, и смешивать их нельзя:
 * иначе задание с опечаткой в имени служебного пользователя молча уехало бы
 * на пароли из выгрузки (или наоборот), а человек считал бы, что работает
 * служебный доступ.
 */
function buildSecrets(
  masterUser: string,
  masterPassword: string | undefined,
  rows: ReadonlyArray<{ position?: number; password?: string | undefined }>,
): MigrationSecrets {
  if (masterUser !== '') {
    if (masterPassword === undefined || masterPassword === '') {
      throw new BadRequestError(
        'Задан служебный пользователь исходного сервера, но не задан его пароль. ' +
          'Это единственный пароль, который нужен для всего переноса.',
      );
    }
    return { masterPassword };
  }
  /*
   * Пароль служебного пользователя без самого служебного пользователя.
   *
   * Раньше он молча отбрасывался: схема запрета не знала, а здесь ветка
   * «служебного нет» до него просто не доходила. Со стороны человека это
   * выглядело так — он ввёл единственный пароль, которым, как он думал,
   * и делается весь перенос, забыл (или не понял, что надо) заполнить имя
   * служебного пользователя, и получил задание, которое пошло по паролям
   * из выгрузки. Если выгрузка была без паролей — отказ «ни у одного
   * ящика нет пароля» при заполненном поле пароля; если с паролями —
   * ночной перенос не тем доступом, чем он рассчитывал.
   *
   * Обратная ошибка (имя есть, пароля нет) отказывает выше — значит и эта
   * обязана отказывать, а не угадывать.
   */
  if (masterPassword !== undefined && masterPassword !== '') {
    throw new BadRequestError(
      'Задан пароль служебного пользователя исходного сервера, но не задан он сам. ' +
        'Либо укажите имя служебного пользователя (тогда весь перенос идёт этим одним ' +
        'паролем), либо уберите пароль: без имени он не применится ни к одному ящику, ' +
        'и переносить придётся паролями из списка.',
    );
  }
  const mailboxPasswords: Record<string, string> = {};
  rows.forEach((row, index) => {
    if (row.password !== undefined && row.password !== '') {
      mailboxPasswords[String(row.position ?? index)] = row.password;
    }
  });
  if (Object.keys(mailboxPasswords).length === 0) {
    throw new BadRequestError(
      'Ни у одного ящика нет пароля. Либо укажите служебного пользователя исходного ' +
        'сервера (один пароль на весь перенос), либо принесите список с паролями — ' +
        'например, выгрузку пользователей Kerio Connect.',
    );
  }
  return { mailboxPasswords };
}

export type { SourceSettings };
