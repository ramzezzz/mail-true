/**
 * Смена основного домена сервера.
 *
 * Два шага и ни одним меньше — ровно по той же причине, что у
 * восстановления копии (routes/backup.ts):
 *
 *   1) POST /domain-change/plan — считает и показывает ПЛАН. Ни одного
 *      изменения: ни строки в базе, ни файла на диске. Здесь же
 *      выпускается ключ DKIM и показываются записи, которые надо
 *      опубликовать ЗАРАНЕЕ;
 *   2) POST /domain-change/:id/apply — выполнение с подтверждением,
 *      которое нельзя нажать не глядя: подтверждением служит имя нового
 *      домена, набранное руками.
 *
 * Между шагами план ХРАНИТСЯ (в отличие от восстановления копии, где он
 * пересчитывается из принесённого файла). Причина в ключе DKIM: его надо
 * выпустить один раз, показать человеку и дать время опубликовать запись
 * в DNS. Ключ, выпускаемый заново на каждый показ плана, означал бы, что
 * опубликованная запись устарела к моменту нажатия кнопки.
 *
 * Право одно на всё — самое сильное. Смена домена меняет адрес каждого
 * человека в организации и на несколько часов роняет почту на всех
 * настроенных клиентах; делить это на «посмотреть» и «выполнить» незачем,
 * потому что смотреть здесь нечего, кроме того, что будет сделано.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../../errors.js';
import { AdminUnavailableError, ConflictError } from '../errors.js';
import { audit, currentAdmin, requireAdmin } from '../guard.js';
import { isDomainName, normalizeDomain } from '../domain-change.js';
import { buildDomainChangePlan } from '../domain-change-runner.js';
import {
  cancelJob,
  createDomainChangeJob,
  domainChangeSchemaReady,
  findJob,
  findLiveJob,
  listJobs,
  type DomainChangeJobRow,
} from '../domain-change-jobs.js';
import { dropTargetDomain } from '../domain-change-store.js';
import { pathId } from '../../params.js';

const planSchema = z.object({
  newDomain: z.string().trim().toLowerCase().min(3).max(255),
});

const applySchema = z.object({
  /**
   * Подтверждение — не «да», а имя нового домена целиком.
   *
   * Слово «да» набирают не читая; имя домена приходится взять с экрана,
   * то есть хотя бы раз посмотреть, ЧТО именно подтверждается. Тот же
   * приём, что у опасных команд в консоли, и он единственный работает.
   */
  confirm: z.string().trim().toLowerCase().min(1).max(255),
});

/** Требование к домену человеческими словами. */
function assertDomain(value: string): string {
  const domain = normalizeDomain(value);
  if (!isDomainName(domain)) {
    throw new BadRequestError(
      `«${value}» не похоже на доменное имя. Нужно имя вида example.ru — латиницей, ` +
        'без протокола, без слэшей и без пробелов. Для доменов с кириллицей укажите ' +
        'их запись в punycode (xn--…).',
    );
  }
  return domain;
}

function toDto(job: DomainChangeJobRow): Record<string, unknown> {
  return {
    id: job.id,
    state: job.state,
    adminLogin: job.adminLogin,
    oldDomain: job.oldDomain,
    newDomain: job.newDomain,
    oldHostname: job.oldHostname,
    newHostname: job.newHostname,
    dkimSelector: job.dkimSelector,
    dkimPublicKey: job.dkimPublicKey,
    plan: job.plan,
    steps: job.steps,
    /** Пройдена ли точка невозврата — от этого зависит, есть ли отмена. */
    pointOfNoReturnAt: job.pointOfNoReturnAt,
    cancellable: job.state === 'planned' && job.pointOfNoReturnAt === null,
    mailboxes: job.mailboxes,
    aliases: job.aliases,
    messages: job.messages,
    bytes: job.bytes,
    backupPath: job.backupPath,
    backupBytes: job.backupBytes,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export async function adminDomainChangeRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;

  /** Раздел без своей таблицы работать не может — и говорит это словами. */
  const requireSchema = async (): Promise<void> => {
    if (!(await domainChangeSchemaReady(ctx.db))) {
      throw new AdminUnavailableError(
        'Раздел «Смена домена» не готов: не применена миграция 0033_domain_change.sql. ' +
          'Примените её на сервере и обновите страницу.',
      );
    }
  };

  /* --- состояние раздела ------------------------------------------ */

  app.get('/domain-change', { preHandler: requireAdmin(app, 'domainchange.run') }, async () => {
    const ready = await domainChangeSchemaReady(ctx.db);
    if (!ready) {
      return {
        ready: false,
        reason:
          'Не применена миграция 0033_domain_change.sql — заданию смены домена негде храниться.',
        currentDomain: ctx.config.MAIL_DOMAIN,
        currentHostname: ctx.config.MAIL_HOSTNAME,
        live: null,
        history: [],
      };
    }
    const live = await findLiveJob(ctx.db);
    const history = await listJobs(ctx.db, 20);
    return {
      ready: true,
      reason: null,
      currentDomain: ctx.config.MAIL_DOMAIN,
      currentHostname: ctx.config.MAIL_HOSTNAME,
      /**
       * Секрет шифрования нужен, чтобы сохранить приватный ключ DKIM.
       * Без него смена домена не запрещена — но ключ придётся выпускать
       * на сервере руками, и человек должен узнать это ДО, а не после.
       */
      canStoreKey: ctx.domainChangeBox != null,
      live: live ? toDto(live) : null,
      history: history.map(toDto),
    };
  });

  app.get<{ Params: { id: string } }>(
    '/domain-change/:id',
    { preHandler: requireAdmin(app, 'domainchange.run') },
    async (request) => {
      await requireSchema();
      const job = await findJob(ctx.db, pathId(request.params.id, 'плана переезда'));
      if (!job) throw new NotFoundError('Задание смены домена не найдено');
      return toDto(job);
    },
  );

  /* --- шаг 1: план ------------------------------------------------- */

  app.post(
    '/domain-change/plan',
    {
      preHandler: requireAdmin(app, 'domainchange.run'),
      // Каждый показ плана — это обход всех адресных таблиц и запросы к
      // публичным резольверам. Дёшево, но не бесплатно.
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      await requireSchema();
      const body = planSchema.parse(request.body);
      const newDomain = assertDomain(body.newDomain);
      const oldDomain = normalizeDomain(ctx.config.MAIL_DOMAIN);
      if (newDomain === oldDomain) {
        throw new BadRequestError(
          `Основной домен уже ${oldDomain}. Менять его на самого себя не на что.`,
        );
      }

      const existing = await findLiveJob(ctx.db);
      if (existing) {
        throw new ConflictError(
          existing.state === 'running'
            ? 'Смена домена уже выполняется — дождитесь её окончания.'
            : `План смены домена на ${existing.newDomain} уже составлен. Выполните его или ` +
                'отмените, прежде чем составлять новый: ключ DKIM выпускается один раз, и два ' +
                'плана означали бы два разных ключа при одной записи в DNS.',
        );
      }

      const built = await buildDomainChangePlan(ctx, { newDomain });
      const dkim = built.dkim;

      /*
       * Приватный ключ ложится в базу шифротекстом. Если секрета
       * шифрования на сервере нет (пустые SESSION_SECRET и
       * ADMIN_SESSION_SECRET), ключ НЕ сохраняется вовсе: приватный ключ
       * подписи в базе открытым текстом — это подпись от имени
       * организации, доступная всякому, кто дотянулся до дампа.
       */
      const privateEnc =
        dkim.privatePem !== undefined && ctx.domainChangeBox != null
          ? ctx.domainChangeBox.encrypt(dkim.privatePem)
          : null;
      const plan =
        privateEnc === null
          ? {
              ...built.plan,
              warnings: [
                ...built.plan.warnings,
                'Секрета шифрования на сервере нет, поэтому приватный ключ DKIM не сохранён. ' +
                  'После смены домена выпустите ключ на сервере командой rspamadm dkim_keygen ' +
                  'и опубликуйте ЕГО запись — показанная здесь работать не будет.',
              ],
            }
          : built.plan;

      const job = await createDomainChangeJob(ctx.db, {
        adminId: currentAdmin(request).adminId,
        adminLogin: currentAdmin(request).login,
        oldDomain,
        newDomain,
        oldHostname: normalizeDomain(ctx.config.MAIL_HOSTNAME),
        newHostname: plan.newHostname,
        dkimSelector: plan.dkim.selector,
        dkimPublicKey: plan.dkim.publicKey,
        dkimPrivateEnc: privateEnc,
        plan,
      });

      /*
       * План пишется в журнал аудита наравне с выполнением. Его ответ —
       * это состав сервера числами и новый ключ подписи; и то, и другое
       * достаточно ценно, чтобы через полгода можно было ответить на
       * вопрос «кто и когда собирался менять домен».
       */
      await audit(ctx, request, {
        action: 'domainchange.plan',
        targetType: 'domain',
        targetId: job.id,
        targetLabel: `${oldDomain} → ${newDomain}`,
        after: {
          new_domain: newDomain,
          mailboxes: plan.counts.mailboxes,
          aliases: plan.counts.aliases,
          messages: plan.counts.messages,
          bytes: plan.counts.bytes,
          blockers: plan.blockers.map((b) => b.id).join(',') || null,
          dkim_selector: plan.dkim.selector,
        },
      });

      reply.status(201);
      return toDto(job);
    },
  );

  /* --- отмена до точки невозврата ---------------------------------- */

  app.delete<{ Params: { id: string } }>(
    '/domain-change/:id',
    { preHandler: requireAdmin(app, 'domainchange.run') },
    async (request) => {
      await requireSchema();
      const id = pathId(request.params.id, 'плана переезда');
      const job = await findJob(ctx.db, id);
      if (!job) throw new NotFoundError('Задание смены домена не найдено');
      if (job.pointOfNoReturnAt !== null) {
        throw new BadRequestError(
          'Точка невозврата пройдена: письма и адреса уже переехали. Отменить это нельзя — ' +
            'можно только сменить домен обратно, и тогда почта, пришедшая на новый адрес, ' +
            'останется в ящиках, а прежний домен снова станет основным.',
        );
      }
      const cancelled = await cancelJob(ctx.db, id);
      if (!cancelled) {
        throw new ConflictError(
          'Отменить не удалось: задание уже выполняется или завершено. Обновите страницу.',
        );
      }
      /*
       * Подчищаем новый домен, если он всё-таки успел появиться.
       *
       * В обычной жизни его ещё нет: домен заводится третьим шагом уже
       * ВНУТРИ выполнения, а до него отменять и нечего. Строка нужна для
       * случая, когда выполнение сорвалось между «завёл домен» и
       * «перенёс письма»: домен без ящиков означает, что сервер молча
       * принимает почту для имени, смену на которое отменили, и отбивает
       * её как «нет такого ящика». Удаляется только пустой — непустой
       * унесло бы каскадом вместе с ящиками.
       */
      /*
       * НЕ ТРОГАЕМ ДОМЕН, КОТОРЫЙ ЗАВЁЛ НЕ МЫ.
       *
       * План не отклоняется, если домен на сервере уже есть: он кладёт
       * блокировку `domain-taken` и советует убрать домен вручную. То
       * есть отменённое задание могло вовсе ничего не заводить — а
       * уборка удаляла домен по имени, вместе со строкой `domain_settings`
       * (каскадом): селектор, публичный ключ и готовая запись DKIM.
       * Опубликованная в DNS запись переставала соответствовать, а
       * Postfix — принимать почту для этого имени. В ответе это выглядело
       * успешной уборкой: `target_domain_removed: true`.
       *
       * Признак «домен был чужим» лежит прямо в плане задания.
       */
      const wasTaken = (job.plan?.blockers ?? []).some((b) => b.id === 'domain-taken');
      const dropped = wasTaken ? false : await dropTargetDomain(ctx.db, job.newDomain);
      await audit(ctx, request, {
        action: 'domainchange.cancel',
        targetType: 'domain',
        targetId: id,
        targetLabel: `${job.oldDomain} → ${job.newDomain}`,
        before: { state: job.state },
        after: { state: 'cancelled', target_domain_removed: dropped },
      });
      return { ok: true, targetDomainRemoved: dropped };
    },
  );

  /* --- шаг 2: выполнение ------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/domain-change/:id/apply',
    {
      preHandler: requireAdmin(app, 'domainchange.run'),
      config: { rateLimit: { max: 5, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      await requireSchema();
      const id = pathId(request.params.id, 'плана переезда');
      const body = applySchema.parse(request.body);
      const job = await findJob(ctx.db, id);
      if (!job) throw new NotFoundError('Задание смены домена не найдено');
      if (job.state !== 'planned') {
        throw new BadRequestError(
          `Это задание уже в состоянии «${job.state}» — запускать нечего. Составьте новый план.`,
        );
      }
      if (normalizeDomain(body.confirm) !== normalizeDomain(job.newDomain)) {
        throw new BadRequestError(
          `Для запуска наберите имя нового домена целиком: ${job.newDomain}. ` +
            'Это не формальность: смена домена меняет адрес каждого человека в организации ' +
            'и отменить её после переноса писем нельзя.',
        );
      }

      // Препятствия перепроверяются и внутри работника, перед первым
      // изменением. Здесь — чтобы отказать сразу и понятной ошибкой,
      // а не заданием, которое немедленно свалится.
      const fresh = await buildDomainChangePlan(ctx, {
        newDomain: job.newDomain,
        dkim: { selector: job.dkimSelector, publicKey: job.dkimPublicKey ?? '' },
        checkDns: false,
      });
      const blockers = fresh.plan.blockers.filter((b) => b.id !== 'domain-taken');
      if (blockers.length > 0) {
        throw new BadRequestError(
          `Начинать нельзя: ${blockers.map((b) => `${b.message} ${b.fix}`).join(' ')}`,
        );
      }

      const runner = ctx.domainChangeRunner;
      if (!runner) {
        throw new AdminUnavailableError(
          'Работник смены домена не запущен — раздел недоступен. Проверьте журнал сервера.',
        );
      }

      await audit(ctx, request, {
        action: 'domainchange.apply',
        targetType: 'domain',
        targetId: id,
        targetLabel: `${job.oldDomain} → ${job.newDomain}`,
        before: { domain: job.oldDomain, hostname: job.oldHostname },
        after: {
          domain: job.newDomain,
          hostname: job.newHostname,
          mailboxes: fresh.plan.counts.mailboxes,
          aliases: fresh.plan.counts.aliases,
          bytes: fresh.plan.counts.bytes,
          dkim_selector: job.dkimSelector,
        },
      });

      runner.start(id);
      reply.status(202);
      return { ok: true, id, state: 'running' };
    },
  );
}
