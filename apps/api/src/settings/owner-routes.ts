/**
 * Маршруты трёх разделов владельца ящика: «Вход и действия», «Выгрузка
 * ящика» и «Восстановление писем».
 *
 * Общее у них правило, ради которого они и собраны в один файл: адрес
 * ящика берётся ИЗ СЕССИИ, и передать чужой негде — не потому что мы это
 * проверяем, а потому что в запросах для него нет места. Для истории
 * входов это не удобство, а суть возможности: журнал доступа, в который
 * можно заглянуть чужими глазами, хуже отсутствующего.
 *
 * Второе общее правило — «кнопка появляется вместе с поведением». Каждый
 * раздел отвечает состоянием `{available, reason}` ДО того, как покажет
 * хоть один элемент управления. Не применена миграция, не настроен
 * служебный вход в Dovecot, выключена выгрузка на закрытом контуре —
 * интерфейс убирает раздел целиком и говорит почему, а не показывает
 * кнопку, которая ответит отказом.
 */
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
  UpstreamUnavailableError,
} from '../errors.js';
import type { MailSession } from '../types.js';
import { describeIp, type AccessEvent } from './access-log.js';
import { collectAccess } from './access-reader.js';
import { originOf } from './access-record.js';
import type { SettingsConfig } from './config.js';
import { ExportRunner, exportFileSize } from './export-runner.js';
import { isUniqueViolation, type ExportRow, type OwnerStore } from './owner-db.js';
import { DEFAULT_RECOVERY_DAYS, type RecoveryService } from './recovery-service.js';
import type { ServiceAddressBook } from './service-addresses.js';

/** Сколько событий истории отдаётся за один запрос. */
const ACCESS_PAGE = 100;
/** Сколько заданий выгрузки показывается в списке. */
const EXPORT_HISTORY = 10;
/** Сколько писем показывается в разделе восстановления. */
const RECOVERY_PAGE = 500;

export interface OwnerRoutesContext {
  settings: SettingsConfig;
  /** Хранилище; null — базы нет вовсе. */
  store: OwnerStore | null;
  /** Состояние каждой возможности после проверки схемы. */
  ready: { access: boolean; export: boolean; recovery: boolean };
  /** Причина, по которой возможности нет, — её увидит человек. */
  reasons: { access: string | null; export: string | null; recovery: string | null };
  exportRunner: ExportRunner | null;
  recovery: RecoveryService;
  /**
   * Память о собственных адресах сервера приложения: по ней служебные
   * подключения веб-интерфейса отличаются от входов человека. Читается на
   * КАЖДЫЙ запрос, а не запоминается при сборке маршрутов, — список
   * пополняется на ходу (см. service-addresses.ts).
   */
  serviceAddresses: ServiceAddressBook;
}

const accessQuery = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(ACCESS_PAGE).default(ACCESS_PAGE),
});

const exportBody = z.object({
  includeSpam: z.boolean().default(false),
  includeTrash: z.boolean().default(false),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const recoveryDaysBody = z.object({ days: z.coerce.number().int().min(0) });

const recoveryIdsBody = z.object({
  ids: z.array(z.number().int().positive()).max(5000).optional(),
  /** Ответ на «удалить всё» — только явным словом, а не пустым списком. */
  all: z.boolean().default(false),
});

export async function ownerRoutes(app: FastifyInstance, ctx: OwnerRoutesContext): Promise<void> {
  const { pool, logger } = app.deps;

  const sessionOf = (request: { mailSession: MailSession | null }): MailSession => {
    if (!request.mailSession) throw new UnauthorizedError();
    return request.mailSession;
  };

  /* ---------------------------------------------------------------- */
  /* Вход и действия                                                   */
  /* ---------------------------------------------------------------- */

  app.get('/access-log', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { before, limit } = accessQuery.parse(request.query);

    if (!ctx.store || !ctx.ready.access) {
      return {
        available: false,
        reason:
          ctx.reasons.access ??
          'История входов недоступна: не применена миграция ' +
            'infra/postgres/migrations/0001_baseline.sql',
        items: [],
        retentionDays: ctx.settings.MAILBOX_ACCESS_LOG_DAYS,
        hasMore: false,
      };
    }

    const own = await ctx.store.listAccess(session.email, limit, before ?? null);
    const items = await collectAccess({
      dir: ctx.settings.MAIL_LOG_DIR,
      email: session.email,
      limit,
      own,
      serviceAddresses: ctx.serviceAddresses.known,
      /*
       * Журналы служб подмешиваются только к ПЕРВОЙ странице.
       *
       * Дальше листается своя таблица (курсор `before` — это её время), а
       * журналы читаются с конца и своего курсора у них нет: попытавшись
       * листать оба источника разом, мы показали бы одни и те же строки
       * журнала на каждой странице. Честнее отдать журнальные события
       * один раз, вместе со свежими.
       */
      withLogs: before === undefined,
    });

    return {
      available: true,
      reason: null,
      retentionDays: ctx.settings.MAILBOX_ACCESS_LOG_DAYS,
      items: items.map(describeEvent),
      // Есть ли что листать дальше, определяет НАША таблица: журналы к
      // этому моменту уже отданы целиком.
      hasMore: own.length >= limit,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Выгрузка ящика                                                    */
  /* ---------------------------------------------------------------- */

  const exportState = () => {
    if (!ctx.settings.MAILBOX_EXPORT_ENABLED) {
      return { available: false, reason: 'Выгрузка ящика выключена администратором сервера' };
    }
    if (!ctx.store || !ctx.ready.export) {
      return {
        available: false,
        reason:
          ctx.reasons.export ??
          'Выгрузка недоступна: не применена миграция ' +
            'infra/postgres/migrations/0001_baseline.sql',
      };
    }
    if (!ctx.exportRunner) {
      return {
        available: false,
        reason:
          'Выгрузка недоступна: не настроен служебный пользователь Dovecot ' +
          '(DOVECOT_MASTER_USER/DOVECOT_MASTER_PASSWORD). Без него сервер не сможет ' +
          'читать ящик после того, как вы закроете вкладку.',
      };
    }
    return { available: true, reason: null };
  };

  const requireExport = (): OwnerStore => {
    const state = exportState();
    if (!state.available || !ctx.store)
      throw new BadRequestError(state.reason ?? 'Выгрузка недоступна');
    return ctx.store;
  };

  app.get('/export', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const state = exportState();
    if (!state.available || !ctx.store) {
      return { ...state, jobs: [], ttlHours: ctx.settings.MAILBOX_EXPORT_TTL_HOURS };
    }
    const jobs = await ctx.store.listExports(session.email, EXPORT_HISTORY);
    return {
      ...state,
      ttlHours: ctx.settings.MAILBOX_EXPORT_TTL_HOURS,
      maxBytes: ctx.settings.MAILBOX_EXPORT_MAX_BYTES,
      jobs: jobs.map(describeJob),
    };
  });

  app.post('/export', { preHandler: app.requireSession }, async (request, reply) => {
    const session = sessionOf(request);
    const store = requireExport();
    const body = exportBody.parse(request.body);
    let job: ExportRow;
    try {
      job = await store.createExport(session.email, body.includeSpam, body.includeTrash);
    } catch (err) {
      // Частичный уникальный индекс: живое задание у ящика уже есть.
      // Это не ошибка человека — это второе нажатие или повтор запроса
      // при обрыве связи, и отвечать надо тем, что уже идёт.
      if (isUniqueViolation(err)) {
        const existing = (await store.listExports(session.email, EXPORT_HISTORY)).find(
          (row) => row.state === 'queued' || row.state === 'running',
        );
        if (existing) return describeJob(existing);
      }
      throw err;
    }
    app.deps.accessLog?.record({
      accountEmail: session.email,
      kind: 'export',
      detail: 'Заказана выгрузка ящика',
      ...originOf(request),
    });
    // Не ждём таймера: человек нажал кнопку и смотрит на экран.
    void ctx.exportRunner?.tick();
    void reply.status(201);
    return describeJob(job);
  });

  app.post('/export/:id/cancel', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const store = requireExport();
    const { id } = idParam.parse(request.params);
    const job = await store.findExport(id);
    if (!job || job.accountEmail.toLowerCase() !== session.email.toLowerCase()) {
      throw new NotFoundError('Задание не найдено');
    }
    if (job.state !== 'queued' && job.state !== 'running') {
      throw new BadRequestError('Это задание уже закончилось — отменять нечего');
    }
    /*
     * Путь к недописанному архиву НЕ стираем.
     *
     * Раньше здесь вызывался finishExport без поля filePath, а запрос
     * писал `patch.filePath ?? null` — то есть путь исчезал из базы, а
     * файл со всей уже собранной перепиской оставался на диске. Удалить
     * его успевал только живой работник; если процесс перезапустили
     * посреди выгрузки, а отмену нажали в ближайшие десять минут, файл не
     * убирал уже никто: выборки уборщика смотрят на 'ready', перезахват —
     * на 'queued'/'running'. Теперь путь остаётся, и остаток архива
     * заберёт уборщик работника.
     */
    await store.finishExport(id, { state: 'cancelled' });
    void ctx.exportRunner?.tick();
    return { ok: true };
  });

  /**
   * Удаление готового архива по требованию человека.
   *
   * Раньше убрать его было нечем: отмена работает только с идущей
   * выгрузкой, а готовый файл лежал до истечения срока хранения — по
   * умолчанию двое суток. В нём вся переписка ящика в открытом виде, и
   * попадает он заодно в каждую резервную копию, снятую за это время.
   * Человек, скачавший архив себе, не мог убрать копию с сервера вообще
   * никак — только просить администратора лезть в том с файлами.
   *
   * Тот же приём уже принят в «Восстановлении писем»: там есть «Удалить
   * всё сейчас» ровно с этим смыслом.
   *
   * Состояние ставим `expired`, а не удаляем строку: человек должен
   * увидеть, что архива больше нет, а не гадать, куда делось задание.
   * Уборщик по сроку такие строки просто не выберет — у них нет файла.
   */
  app.delete('/export/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const store = requireExport();
    const { id } = idParam.parse(request.params);
    const job = await store.findExport(id);
    if (!job || job.accountEmail.toLowerCase() !== session.email.toLowerCase()) {
      throw new NotFoundError('Задание не найдено');
    }
    if (job.state === 'queued' || job.state === 'running') {
      throw new BadRequestError('Эта выгрузка ещё собирается — сначала отмените её');
    }
    /*
     * Забыть путь можно только после того, как файла ДЕЙСТВИТЕЛЬНО нет.
     *
     * `force: true` гасит лишь «файла и так не было». Настоящий отказ —
     * том смонтирован только на чтение, файл держит идущее скачивание,
     * чужой владелец — это исключение. Проглотив его и всё равно
     * записав `state: 'expired', file_path: NULL`, мы теряли путь
     * навсегда: уборщик по сроку берёт только `state = 'ready'`, то есть
     * такую строку не возьмёт уже никто. Архив со всей перепиской в
     * открытом виде оставался на диске бессрочно и попадал в каждую
     * резервную копию — притом что человеку сказали «удалён», а в
     * журнале записано «удалён по просьбе владельца». Раньше его хотя бы
     * сносил уборщик через двое суток; молчаливое проглатывание сделало
     * худший случай хуже, чем до появления самой кнопки.
     *
     * Поэтому отказ отдаётся наверх: строка остаётся `ready` с путём,
     * файл заберёт уборщик по сроку, а человек увидит, что дело не
     * сделано, и сможет позвать администратора.
     */
    if (job.filePath) {
      try {
        await rm(job.filePath, { force: true });
      } catch (err) {
        request.log.error({ err, exportId: id }, 'не удалось стереть архив выгрузки');
        throw new UpstreamUnavailableError(
          'Не удалось стереть архив с диска. Он остаётся на сервере — обратитесь к администратору.',
        );
      }
    }
    await store.finishExport(id, { state: 'expired', filePath: null });
    app.deps.accessLog?.record({
      accountEmail: session.email,
      kind: 'export',
      detail: 'Архив выгрузки удалён по просьбе владельца',
      ...originOf(request),
    });
    return { ok: true };
  });

  /**
   * Скачивание готового архива.
   *
   * Проверок здесь две, и обе обязательны: задание принадлежит этому
   * ящику и файл ещё существует. Вторая не «на всякий случай» — срок
   * хранения мог выйти между тем, как человек увидел список, и тем, как
   * он нажал «Скачать».
   */
  app.get('/export/:id/file', { preHandler: app.requireSession }, async (request, reply) => {
    const session = sessionOf(request);
    const store = requireExport();
    const { id } = idParam.parse(request.params);
    const job = await store.findExport(id);
    if (!job || job.accountEmail.toLowerCase() !== session.email.toLowerCase()) {
      throw new NotFoundError('Задание не найдено');
    }
    if (job.state !== 'ready' || !job.filePath) {
      throw new NotFoundError('Архив ещё не готов или его срок хранения вышел');
    }
    const size = await exportFileSize(job.filePath);
    if (size === null) throw new NotFoundError('Файл выгрузки уже удалён');

    const name = `${session.email.replace(/[^a-z0-9._@-]/gi, '_')}-${job.id}.zip`;
    void reply.header('Content-Type', 'application/zip');
    void reply.header('Content-Length', String(size));
    // Имя файла и в ASCII, и в UTF-8: старые клиенты читают первое,
    // современные — второе. Без ASCII-варианта часть браузеров сохраняет
    // файл под именем маршрута («file»).
    void reply.header(
      'Content-Disposition',
      `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    // Архив — копия всей переписки. Ни промежуточные узлы, ни браузер
    // не должны оставлять его у себя.
    void reply.header('Cache-Control', 'private, no-store');
    void reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(job.filePath));
  });

  /* ---------------------------------------------------------------- */
  /* Восстановление писем                                              */
  /* ---------------------------------------------------------------- */

  const recoveryState = () => {
    if (!ctx.store || !ctx.ready.recovery) {
      return {
        available: false,
        reason:
          ctx.reasons.recovery ??
          'Восстановление недоступно: не применена миграция ' +
            'infra/postgres/migrations/0001_baseline.sql',
      };
    }
    return { available: true, reason: null };
  };

  const requireRecovery = (): OwnerStore => {
    const state = recoveryState();
    if (!state.available || !ctx.store) {
      throw new BadRequestError(state.reason ?? 'Восстановление недоступно');
    }
    return ctx.store;
  };

  app.get('/recovery', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const state = recoveryState();
    if (!state.available || !ctx.store) {
      return {
        ...state,
        days: 0,
        maxDays: ctx.settings.TRASH_RECOVERY_MAX_DAYS,
        scheduledPurge: false,
        items: [],
        totals: { count: 0, bytes: 0 },
      };
    }
    const days = (await ctx.store.getRecoveryDays(session.email)) ?? DEFAULT_RECOVERY_DAYS;
    const [items, totals] = await Promise.all([
      ctx.store.listRecovery(session.email, RECOVERY_PAGE),
      ctx.store.recoveryTotals(session.email),
    ]);
    return {
      ...state,
      days,
      maxDays: ctx.settings.TRASH_RECOVERY_MAX_DAYS,
      /*
       * Удаление по сроку требует служебного входа в Dovecot. Без него
       * письма СОХРАНЯТЬ можно, а удалить их в срок будет некому — то есть
       * ящик тихо забьётся. Интерфейс обязан сказать об этом до того, как
       * человек включит хранение, а не после.
       */
      scheduledPurge: ctx.recovery.scheduledPurgeAvailable,
      items: items.map((row) => ({
        id: row.id,
        subject: row.subject,
        from: row.fromAddress,
        sentAt: row.sentAt,
        sizeBytes: row.sizeBytes,
        deletedAt: row.deletedAt,
        purgeAt: row.purgeAt,
      })),
      totals,
    };
  });

  app.put('/recovery', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const store = requireRecovery();
    const { days } = recoveryDaysBody.parse(request.body);
    const max = ctx.settings.TRASH_RECOVERY_MAX_DAYS;
    if (days > max) {
      throw new BadRequestError(
        `Больше ${max} дн. хранить нельзя: место в ящике не бесконечно. ` +
          'Потолок задаёт администратор сервера (TRASH_RECOVERY_MAX_DAYS).',
      );
    }
    await store.setRecoveryDays(session.email, days);
    app.deps.accessLog?.record({
      accountEmail: session.email,
      kind: 'settings',
      detail:
        days === 0
          ? 'Хранение очищенной корзины выключено'
          : `Срок хранения очищенной корзины — ${days} дн.`,
      ...originOf(request),
    });
    return { ok: true, days };
  });

  app.post('/recovery/restore', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    requireRecovery();
    const body = recoveryIdsBody.parse(request.body);
    const ids = body.ids ?? [];
    if (ids.length === 0) throw new BadRequestError('Не выбрано ни одного письма');
    const result = await pool.withClient(session.email, session.password, (client) =>
      ctx.recovery.restore(client, session.email, ids),
    );
    /*
     * В журнал идут и потери, а не только успех.
     *
     * Раньше писалось одно `restored`, и запись «Восстановлено писем: 12»
     * после выбора сорока выглядела нормальной строкой — по ней нельзя
     * было понять, что двадцать восемь писем не вернулись. Журнал доступа
     * человек читает именно тогда, когда разбирается, куда что делось.
     */
    app.deps.accessLog?.record({
      accountEmail: session.email,
      kind: 'trash',
      detail: describeRestore(ids.length, result),
      ...originOf(request),
    });
    return result;
  });

  app.post('/recovery/purge', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    requireRecovery();
    const body = recoveryIdsBody.parse(request.body);
    if (!body.all && (body.ids ?? []).length === 0) {
      throw new BadRequestError('Не выбрано ни одного письма');
    }
    const result = await pool.withClient(session.email, session.password, (client) =>
      ctx.recovery.purgeNow(client, session.email, body.all ? 'all' : (body.ids ?? [])),
    );
    app.deps.accessLog?.record({
      accountEmail: session.email,
      kind: 'trash',
      detail:
        result.failed > 0
          ? `Удалено окончательно: ${result.purged}; не удалось удалить: ${result.failed}`
          : `Удалено окончательно: ${result.purged}`,
      ...originOf(request),
    });
    logger.info(
      { account: session.email, purged: result.purged, failed: result.failed },
      'Очищенные письма удалены по просьбе человека',
    );
    return result;
  });
}

/** Строка журнала о возврате: сколько просили, сколько вернулось и что нет. */
function describeRestore(
  asked: number,
  result: { restored: number; missing: number; failed: number },
): string {
  const tail: string[] = [];
  if (result.missing > 0) tail.push(`уже не было в ящике: ${result.missing}`);
  if (result.failed > 0) tail.push(`не удалось вернуть: ${result.failed}`);
  const head = `Восстановлено писем: ${result.restored} из ${asked}`;
  return tail.length === 0 ? head : `${head} (${tail.join(', ')})`;
}

/** Событие в том виде, в каком его читает интерфейс. */
function describeEvent(event: AccessEvent) {
  return {
    at: event.at,
    channel: event.channel,
    success: event.success,
    ip: event.ip,
    where: describeIp(event.ip),
    userAgent: event.userAgent,
    service: event.service,
    detail: event.detail,
    origin: event.origin,
  };
}

/** Задание выгрузки в том виде, в каком его читает интерфейс. */
function describeJob(job: ExportRow) {
  return {
    id: job.id,
    state: job.state,
    includeSpam: job.includeSpam,
    includeTrash: job.includeTrash,
    totalMessages: job.totalMessages,
    doneMessages: job.doneMessages,
    doneBytes: job.doneBytes,
    skipped: job.skipped,
    fileBytes: job.fileBytes,
    error: job.lastError,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    expiresAt: job.expiresAt,
  };
}
