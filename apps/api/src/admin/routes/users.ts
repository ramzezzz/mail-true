/**
 * Почтовые ящики: список, создание, изменение, блокировка, пароль, квота,
 * массовые операции и импорт из CSV.
 *
 * Пароли кладём в virtual_users.password в формате Dovecot
 * ({SHA512-CRYPT}$6$...) — том же, что делает infra/scripts/create-mailbox.sh.
 * Поэтому созданный отсюда ящик сразу рабочий: Dovecot пускает по IMAP,
 * Postfix принимает для него почту.
 */
import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../../errors.js';
import { errorInfo } from '../../log.js';
import { ConflictError } from '../errors.js';
import { buildAuditRecord, type AuditInput } from '../audit.js';
import { audit, currentAdmin, originOf, requireAdmin } from '../guard.js';
import { settingsOf } from '../server-settings.js';
import { dovecotHash, generatePassword } from '../passwords.js';
import { nulByteProblem, parseUserImport } from '../csv.js';
import { addressProblem, displayNameLengthProblem } from '@mail-true/shared';
import { packResult, unpackResult, type ImportJobResult } from '../import-jobs.js';
import { dropMailboxAccess as closeMailboxAccess } from '../mailbox-access.js';
import { maildirPathOf, quarantineMaildir } from '../mailbox-cleanup.js';
import { isUndefinedTable, type ImportJobRow, type MailUserRow } from '../db.js';
import { pathId } from '../../params.js';

/**
 * Форму и длину адреса здесь НЕ проверяем — этим занимается
 * address-limits.ts, и он объясняет отказ словами. У zod на всё про всё
 * одна общая фраза «Некорректные данные запроса»: из неё не видно ни что
 * не так, ни где. Особенно это било по кириллице — самой частой опечатке.
 */
const emailSchema = z.string().trim().toLowerCase().min(1).max(1024);

const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  domainId: z.coerce.number().int().positive().optional(),
  /**
   * all | active | blocked | overquota
   *
   * `overquota` — «ящик вот-вот перестанет принимать почту». Занятости в
   * базе нет, она приходит снимком показателей (metrics-collector), где
   * Dovecot пишет размер и лимит рядом. Раньше это значение было названо
   * в комментарии и в спецификации панели, а схема его не принимала —
   * фильтра не существовало ни на сервере, ни в интерфейсе.
   */
  status: z.enum(['all', 'active', 'blocked', 'overquota']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(8, 'Пароль короче 8 знаков')
    .max(1024, 'Пароль длиннее 1024 знаков')
    .optional(),
  // См. пояснение к emailSchema: предел здесь грубый, настоящий — ниже.
  displayName: z.string().trim().max(1024).optional(),
  quotaBytes: z.coerce.number().int().min(0).optional(),
  active: z.boolean().default(true),
  /** Создать домен, если его ещё нет (право domains.write проверяется отдельно). */
  createDomain: z.boolean().default(false),
});

const patchSchema = z.object({
  displayName: z.string().trim().max(1024).nullable().optional(),
  quotaBytes: z.coerce.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

const passwordSchema = z.object({
  password: z
    .string()
    .min(8, 'Пароль короче 8 знаков')
    .max(1024, 'Пароль длиннее 1024 знаков')
    .optional(),
});

/**
 * Массовая правка ящиков — ЧАСТЯМИ, а не тысячей за раз.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ДВЕСТИ, А НЕ ТЫСЯЧА
 * ------------------------------------------------------------------
 * Обработчик идёт по ящикам по одному, и на каждый приходится чтение,
 * запись, при блокировке — закрытие доступа (Redis, пул соединений,
 * наблюдатель) и одна-две записи в журнал. Тысяча таких кругов — это
 * заметно больше минуты, а nginx перед панелью ждёт ответа сто двадцать
 * секунд (proxy_read_timeout). По истечении он рвёт соединение: панель
 * показывает «сервер не ответил», а правка при этом ПРОДОЛЖАЕТСЯ — и
 * человек не знает ни сколько ящиков успело измениться, ни можно ли
 * нажать ещё раз.
 *
 * Двести круга укладываются в таймаут с запасом даже на медленном диске.
 * Панель шлёт длинный список частями и показывает, сколько сделано
 * (см. UsersPage: BULK_CHUNK). Отдельного задания в очереди, как у
 * импорта, здесь не заводим: правка идёт секунды, а не минуты, и цена
 * такого механизма несоразмерна.
 */
const BULK_MAX_IDS = 200;

const bulkSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(BULK_MAX_IDS),
  quotaBytes: z.coerce.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

const importSchema = z.object({
  csv: z
    .string()
    .min(1)
    .max(4 * 1024 * 1024),
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
    /*
     * «Превысившие квоту» — отбор по СНИМКУ показателей, а не по базе.
     *
     * Занятости ящика в базе нет вовсе: её измеряет Dovecot и пишет рядом
     * с письмами, а к нам она приезжает снимком (metrics-collector). Порог
     * — девять десятых: ящик, забитый под завязку, перестанет принимать
     * почту завтра, и именно его ищут в этом фильтре, а не тот, который
     * уже отбивает письма.
     *
     * Снимка может не быть (сбор показателей выключен настройкой) — тогда
     * фильтр честно отдаёт пусто, а не делает вид, что превысивших нет.
     */
    /*
     * СНИМКА НЕТ — ЭТО НЕ «НИКТО НЕ ПЕРЕПОЛНЕН».
     *
     * Занятости ящика в базе нет вовсе, она приходит из снимка
     * показателей, а сбор показателей выключается настройкой. Отбор в
     * обоих случаях отдавал пустой список, и панель писала «Ящиков пока
     * нет» — то есть отвечала «переполненных нет» там, где ответа не
     * знает никто. Администратор, ищущий, у кого кончилось место, уходил
     * со спокойной душой.
     */
    const metricsMissing = q.status === 'overquota' && !ctx.metrics?.latest;

    const overquota =
      q.status === 'overquota'
        ? ((ctx.metrics?.latest?.mailboxes.items ?? [])
            .filter(
              (box) => box.limitBytes && box.limitBytes > 0 && box.bytes / box.limitBytes >= 0.9,
            )
            .map((box) => box.email.toLowerCase()) as string[])
        : undefined;

    const { rows, total } = await ctx.db.listMailUsers({
      search: q.search,
      domainId: q.domainId,
      active: q.status === 'all' || q.status === 'overquota' ? undefined : q.status === 'active',
      ...(overquota ? { emails: overquota } : {}),
      limit: q.limit,
      offset: q.offset,
    });
    return {
      items: rows.map(toDto),
      total,
      limit: q.limit,
      offset: q.offset,
      /** Отбор «почти заполненные» невозможен: снимка показателей нет. */
      ...(metricsMissing ? { metricsMissing: true } : {}),
    };
  });

  /* --- карточка ---------------------------------------------------- */
  app.get<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: requireAdmin(app, 'users.read') },
    async (request) => {
      const id = pathId(request.params.id, 'ящика');
      const row = await ctx.db.findMailUserById(id);
      if (!row) throw new NotFoundError('Ящик не найден');
      /*
       * СПИСОК АДРЕСОВ МОЖЕТ БЫТЬ НЕПОЛНЫМ — И ОБ ЭТОМ ГОВОРИТСЯ.
       *
       * Берётся сотня записей, а у активного человека одноразовых адресов
       * легко больше: их заводят по одному на каждый сайт. Признака
       * усечения не было, зато в списке ящиков рядом стоит колонка
       * «Алиасов» с полным числом — и карточка показывала девяносто с
       * лишним строк там, где в колонке значилось двести. Понять, каких
       * именно не хватает, было нельзя никак.
       */
      const ALIAS_LIMIT = 100;
      const aliases = await ctx.db.listAliases({
        search: row.email,
        limit: ALIAS_LIMIT + 1,
        offset: 0,
      });
      const mine = aliases.rows.filter(
        (a) => a.source === row.email || a.destination === row.email,
      );
      const truncated = mine.length > ALIAS_LIMIT;
      return {
        ...toDto(row),
        /** Показаны не все адреса — их больше, чем помещается в карточку. */
        aliasesTruncated: truncated,
        aliases: mine.slice(0, ALIAS_LIMIT).map((a) => ({
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
      const id = pathId(request.params.id, 'ящика');
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

    // Форма и длина — до всего остального: незачем ходить в базу за
    // адресом, который всё равно не примут.
    const bad =
      addressProblem(body.email) ??
      (body.displayName === undefined ? null : displayNameLengthProblem(body.displayName));
    if (bad) throw new BadRequestError(bad);

    const existing = await ctx.db.findMailUserByEmail(body.email);
    if (existing) throw new ConflictError(`Ящик ${body.email} уже существует`);

    /*
     * АДРЕС ЗАНЯТ ПЕРЕНАПРАВЛЕНИЕМ — ящик получится пустым навсегда.
     *
     * Postfix разбирает карту алиасов РАНЬШЕ карты ящиков
     * (`virtual_alias_maps` до `virtual_mailbox_maps` в main.cf), поэтому
     * письмо, пришедшее на такой адрес, уходит по перенаправлению и до
     * ящика не доходит вовсе. Ящик при этом выглядит полностью рабочим:
     * он создан, виден в списке, в него можно войти по IMAP — просто в нём
     * никогда ничего не появляется.
     *
     * Обратное направление (алиас поверх живого ящика) заблокировано
     * наглухо и подробно объяснено в alias-check.ts. Это же направление не
     * проверялось вовсе, хотя ломает ровно так же и диагностируется так же
     * тяжело: без знания про порядок карт причину не найти.
     */
    const aliasTarget = await ctx.db.aliasTargetOf(body.email);
    if (aliasTarget !== null) {
      throw new ConflictError(
        `Адрес ${body.email} уже занят перенаправлением на ${aliasTarget}. ` +
          'Почта на него уходит туда, и заведённый ящик остался бы пустым навсегда: ' +
          'Postfix разбирает перенаправления раньше ящиков. ' +
          'Сначала удалите перенаправление в разделе «Алиасы».',
      );
    }

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
      // Квота по умолчанию читается из настроек сервера, а не из
      // окружения: она объявлена «действует сразу», и следующий заведённый
      // ящик обязан получить то число, которое стоит в панели сейчас.
      quotaBytes: body.quotaBytes ?? (await settingsOf(ctx).int('ADMIN_DEFAULT_QUOTA_BYTES')),
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
      const id = pathId(request.params.id, 'ящика');
      const body = patchSchema.parse(request.body);
      if (body.displayName !== undefined && body.displayName !== null) {
        const tooLong = displayNameLengthProblem(body.displayName);
        if (tooLong) throw new BadRequestError(tooLong);
      }
      const before = await ctx.db.findMailUserById(id);
      if (!before) throw new NotFoundError('Ящик не найден');

      const patch: { displayName?: string | null; quotaBytes?: number; active?: boolean } = {};
      if (body.displayName !== undefined) patch.displayName = body.displayName;
      if (body.quotaBytes !== undefined) patch.quotaBytes = body.quotaBytes;
      if (body.active !== undefined) patch.active = body.active;

      const after = await ctx.db.updateMailUser(id, patch);
      if (!after) throw new NotFoundError('Ящик не найден');

      /*
       * Блокировка обязана выгонять СЕЙЧАС, а не при следующем входе.
       * Dovecot отсеивает заблокированных в проверке пароля, поэтому
       * уволенный сотрудник с открытой вкладкой продолжал читать почту.
       */
      if (body.active === false && before.active) {
        await dropMailboxAccess(after.email, 'ящик заблокирован');
      }

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
  /**
   * Закрывает доступ к ящику здесь и сейчас.
   *
   * Сам замок живёт в admin/mailbox-access.ts — там же и разбор, почему
   * его мало поставить в одном месте: смена пароля и блокировка не
   * единственные пути, меняющие пароль и признак «включён» (тем же
   * занимается восстановление копии).
   */
  const dropMailboxAccess = (email: string, why: string): Promise<void> =>
    closeMailboxAccess(app, email, why);

  app.post<{ Params: { id: string } }>(
    '/users/:id/password',
    { preHandler: requireAdmin(app, 'users.password') },
    async (request) => {
      const id = pathId(request.params.id, 'ящика');
      const body = passwordSchema.parse(request.body ?? {});
      const row = await ctx.db.findMailUserById(id);
      if (!row) throw new NotFoundError('Ящик не найден');

      const password = body.password ?? generatePassword();
      await ctx.db.setMailUserPassword(id, dovecotHash(password));
      // Старые сессии и соединения — закрыть: иначе смена пароля не
      // выгоняет никого (см. dropMailboxAccess).
      await dropMailboxAccess(row.email, 'смена пароля');
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
   *      и убрать индексы полнотекстового поиска будет уже нечем.
   *      Делается ТОЛЬКО при нулевой отсрочке — см. ниже.
   *   2. Запись об удалении — до самого удаления, чтобы след остался
   *      даже если следующий шаг упадёт.
   *   3. Служебные строки и строка ящика.
   *   4. Карантин каталога: мгновенное переименование. С этого момента
   *      воскресший ящик с тем же адресом гарантированно пуст.
   *
   * Физическое удаление дерева делает уборщик (см. janitor.ts) — почему
   * именно так, подробно объяснено в mailbox-cleanup.ts.
   *
   * ------------------------------------------------------------------
   * ОТСРОЧКА И ШАГ 1: ЧТО ЗДЕСЬ БЫЛО СЛОМАНО
   * ------------------------------------------------------------------
   * Настройка ADMIN_MAILBOX_PURGE_DELAY_MINUTES описана в панели словами
   * «даёт время передумать: письма из Maildir не восстанавливаются ничем,
   * кроме резервной копии». Обещание не выполнялось ни на минуту: шаг 1
   * зовёт purgeMail(), а тот через IMAP удаляет ВСЕ папки и делает
   * messageDelete({all:true}) по INBOX. К моменту карантина уносить в
   * карантин было уже нечего — туда уезжал пустой каталог, а отсрочка
   * откладывала удаление пустоты. Человек, удаливший не тот ящик и
   * прибежавший через минуту, терял всю переписку сотрудника, хотя панель
   * обещала ему сутки на размышление.
   *
   * Поэтому при ненулевой отсрочке ящик через IMAP НЕ чистится: письма
   * доживают до карантина настоящими. Индексы Dovecot и данные поиска при
   * этом убираются с диска напрямую — том индексов у сервера приложения
   * примонтирован ровно ради удаления ящика (infra/docker-compose.yml), а
   * индексы производны от писем: вернувшийся из карантина каталог Dovecot
   * переиндексирует сам.
   *
   * При нулевой отсрочке (значение по умолчанию) порядок прежний: уборщик
   * убирает каталог ближайшим проходом, сохранять нечего, а очистка
   * средствами самого Dovecot надёжнее нашего знания о его каталогах.
   */
  app.delete<{ Params: { id: string }; Querystring: { reason?: string } }>(
    '/users/:id',
    { preHandler: requireAdmin(app, 'users.delete') },
    async (request) => {
      const id = pathId(request.params.id, 'ящика');
      const row = await ctx.db.findMailUserById(id);
      if (!row) throw new NotFoundError('Ящик не найден');
      const admin = currentAdmin(request);
      const reason =
        typeof request.query.reason === 'string' && request.query.reason.trim() !== ''
          ? request.query.reason.trim().slice(0, 2000)
          : null;

      /*
       * Доступ закрываем ПЕРВЫМ делом — до того, как трогать письма.
       *
       * Удаление ящика доступ не закрывало вовсе, хотя блокировка —
       * действие заведомо более слабое — закрывает. Получалось нелепое:
       * ящика уже нет, а cookie по-прежнему проходит проверку сессии, и
       * наблюдатель до суток держит соединение с паролем удалённого
       * ящика, продолжая слать события о новых письмах. Заодно это
       * снимает гонку с самим удалением: открытая сессия в этот момент
       * читает и пишет в каталог, который мы вот-вот унесём в карантин.
       */
      await dropMailboxAccess(row.email, 'удаление ящика');

      const purgeDelayMinutes = await settingsOf(ctx).int('ADMIN_MAILBOX_PURGE_DELAY_MINUTES');
      /** Отсрочка обещает «время передумать» — значит письма обязаны дожить. */
      const keepMailForUndo = purgeDelayMinutes > 0;

      // 1. Индексы и данные Dovecot — руками самого Dovecot.
      let imapPurged = false;
      let imapError: string | null = null;
      if (keepMailForUndo) {
        // Не ошибка, а осознанный пропуск: purgeMail уничтожает письма, а
        // при отсрочке они обязаны доехать до карантина целыми (см. шапку).
        imapError = null;
      } else if (ctx.mailbox.configured) {
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
          purgeDelayMinutes,
        });
      } catch (err) {
        if (!isUndefinedTable(err)) throw err;
        request.log.warn(
          'Нет таблицы mailbox_deletions: примените миграцию 0006_admin_cleanup.sql',
        );
      }

      /*
       * 3. Архивы выгрузки — С ДИСКА, до того как уйдут строки из базы.
       *
       * Владелец мог заказать выгрузку ящика: готовый ZIP лежит в томе и
       * содержит ВСЮ его переписку в открытом виде. Строку о нём уносит
       * `purgeMailboxData` ниже, а файл удаляет только уборщик по сроку —
       * и берёт путь из той же строки. То есть после удаления ящика архив
       * оставался в томе навсегда, попадал во все резервные копии, и
       * найти его было нечем: обхода каталога выгрузок в продукте нет.
       *
       * Порядок важен: сперва файлы, потом строки. Наоборот — и пути
       * потеряны безвозвратно.
       */
      const exportFiles = await ctx.db.listExportFiles(row.email);
      let exportsRemoved = 0;
      for (const path of exportFiles) {
        try {
          await rm(path, { force: true });
          exportsRemoved += 1;
        } catch (err) {
          // Не повод отменять удаление ящика: файла может уже не быть.
          request.log.warn(errorInfo(err, { path }), 'Архив выгрузки удалить не удалось');
        }
      }
      if (exportsRemoved > 0) {
        request.log.info(
          { email: row.email, files: exportsRemoved },
          'Удаление ящика: убраны архивы выгрузки',
        );
      }

      // 4. Всё, что принадлежит ящику в базе.
      const purged = await ctx.db.purgeMailboxData(row.email);
      const dbRowsRemoved = purged.rows;
      await ctx.db.deleteMailUser(id);

      // 5. Каталог — в карантин.
      const tag = deletionId > 0 ? String(deletionId) : String(Date.now());
      const quarantine = await quarantineMaildir(ctx.config.ADMIN_MAIL_ROOT, row.email, tag);
      /*
       * 6. Индексы Dovecot — с диска, раз через IMAP их не убирали.
       *
       * Только в режиме отсрочки: при нулевой их уже убрал сам Dovecot
       * вместе с папками. Индексы и данные полнотекстового поиска
       * производны от писем и на порядки меньше их; каталог ящика,
       * возвращённый из карантина руками, Dovecot переиндексирует сам.
       * Оставить их было бы мусором, который копится и никем больше не
       * убирается: после удаления строки ящика о нём не знает никто.
       *
       * Итог кладётся в тот же imapPurged: и запись об удалении, и панель
       * отвечают им на один вопрос — «убраны ли индексы Dovecot». Заведи
       * мы под это второе поле, панель продолжала бы писать «очистить не
       * удалось, уберите вручную» над каталогом, который только что убран.
       */
      let indexRemoved = false;
      if (keepMailForUndo) {
        const indexDir = maildirPathOf(ctx.config.ADMIN_MAIL_INDEX_ROOT, row.email);
        if (indexDir !== null) {
          try {
            await rm(indexDir, { recursive: true, force: true });
            indexRemoved = true;
          } catch (err) {
            // Не повод отменять удаление: письма уже в карантине, а
            // индекс без них Dovecot всё равно перестроит.
            request.log.warn(
              errorInfo(err, { email: row.email, path: indexDir }),
              'Каталог индексов удалённого ящика убрать не удалось',
            );
            imapError =
              `Каталог индексов ${indexDir} убрать не удалось: ` +
              (err instanceof Error ? err.message : String(err));
          }
        }
        imapPurged = indexRemoved;
      }

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
          /*
           * Пересылки, ведшие в этот ящик, — поимённо.
           *
           * Общее число строк их не показывало: они шли вперемешку с
           * одноразовыми адресами и настройками. То есть годами
           * работавшая пересылка «info@ -> ivan@» умирала вместе с ящиком
           * молча, и восстановить её было неоткуда — в панели она больше
           * нигде не показана. У удаления домена такой список есть давно.
           */
          aliases_removed: purged.aliases,
          maildir_quarantined: quarantine.quarantinePath !== null,
          /** Отсрочка: письма лежат в карантине целыми, их ещё можно вернуть. */
          mail_kept_minutes: keepMailForUndo ? purgeDelayMinutes : 0,
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
        /**
         * Письма ЦЕЛЫМИ ждут в карантине столько минут — ровно то, что
         * обещает настройка отсрочки. 0 означает «уборщик уберёт их
         * ближайшим проходом».
         */
        mailKeptMinutes: keepMailForUndo ? purgeDelayMinutes : 0,
        /**
         * Каталог индексов Dovecot убран нами, а не через IMAP. Только в
         * режиме отсрочки: без него было бы непонятно, почему imapPurged
         * стоит при том, что ящик через IMAP не чистили.
         */
        indexRemoved,
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
      /*
       * Заблокировали — закрываем доступ, как и при одиночной блокировке.
       *
       * Без этого массовая правка меняла только строку в базе. Dovecot
       * отсеивает `active` лишь при проверке пароля, а у вошедшего
       * проверять нечего: сессия в Redis продлевается на каждом запросе,
       * соединение пула переиспользуется без сверки, наблюдатель держит
       * своё и продолжает слать события о новых письмах. То есть человек,
       * снявший галку «активен» у целого отдела в пятницу вечером, не
       * менял для них ничего: они читали почту дальше сколько угодно.
       * Одиночная блокировка это делала — массовая проходила мимо.
       */
      if (body.active === false && before.active) {
        await dropMailboxAccess(after.email, 'массовая блокировка ящика');
      }
      /*
       * Одна правка — одна запись НА КАЖДОЕ действие.
       *
       * Здесь стояло «квота, а иначе блокировка»: при правке, где заданы
       * оба поля, в журнал уходила только user.bulk.quota. Массовая
       * блокировка сотни ящиков в журнале не отражалась вовсе — а это то
       * самое действие, ради которого журнал и открывают: «кто отключил
       * отдел в пятницу вечером». Найти его было нечем: отбор по действию
       * «Массовая блокировка/разблокировка» не показывал ничего.
       */
      const actions: Array<'user.bulk.quota' | 'user.bulk.active'> = [];
      if (body.quotaBytes !== undefined) actions.push('user.bulk.quota');
      if (body.active !== undefined) actions.push('user.bulk.active');
      for (const action of actions) {
        await audit(ctx, request, {
          action,
          targetType: 'user',
          targetId: id,
          targetLabel: after.email,
          before: snapshot(before),
          after: snapshot(after),
        });
      }
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
    // Нулевой байт база не примет ни в одном поле: отказываем сразу и
    // словами, а не 500-м посреди импорта.
    const nul = nulByteProblem(csv);
    if (nul) throw new BadRequestError(nul);

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
      defaultQuotaBytes:
        defaultQuotaBytes ?? (await settingsOf(ctx).int('ADMIN_DEFAULT_QUOTA_BYTES')),
    });
  }

  /* --- импорт: значения по умолчанию -------------------------------- */
  /**
   * Квота, которая достанется строкам без своей колонки `quota`.
   * Интерфейс обязан показать это число ДО импорта: раньше оно жило только
   * в ADMIN_DEFAULT_QUOTA_BYTES и человеку было неоткуда о нём узнать.
   */
  app.get('/users/import/defaults', { preHandler: requireAdmin(app, 'users.write') }, async () => ({
    defaultQuotaBytes: await settingsOf(ctx).int('ADMIN_DEFAULT_QUOTA_BYTES'),
  }));

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
        rows: preview.rows.map((r) => ({
          ...r,
          password: undefined,
          hasPassword: r.password !== null,
        })),
        /** Квота, доставшаяся строкам без своей, — ровно та, что применится. */
        defaultQuotaBytes:
          body.defaultQuotaBytes ?? (await settingsOf(ctx).int('ADMIN_DEFAULT_QUOTA_BYTES')),
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
  app.post(
    '/users/import',
    { preHandler: requireAdmin(app, 'users.write') },
    async (request, reply) => {
      const body = importSchema.parse(request.body);
      const admin = currentAdmin(request);
      const allowNewDomains = effectiveAllowNewDomains(body.allowNewDomains, admin.role);
      const preview = await parseImport(body.csv, allowNewDomains, body.defaultQuotaBytes);
      /*
       * Квота для строк без своей колонки снимается ОДИН раз, до начала
       * работы, а не спрашивается на каждый ящик. Импорт идёт долго и в
       * фоне: изменись настройка посреди него, часть ящиков получила бы
       * одну квоту, часть другую — и по отчёту было бы не понять, почему.
       * Значение то же, что показал предпросмотр.
       */
      const importDefaultQuota =
        body.defaultQuotaBytes ?? (await settingsOf(ctx).int('ADMIN_DEFAULT_QUOTA_BYTES'));

      /*
       * Пароли будет негде сохранить — отказываемся ДО работы.
       *
       * ------------------------------------------------------------------
       * ЧТО БЫЛО
       * ------------------------------------------------------------------
       * Без секрета шифрования результат задания не сохраняется вовсе
       * (packResult отдаёт null), и маршрут отчёта возвращает пустые
       * списки. То есть импорт создавал триста ящиков, в базе оставались
       * одни хэши, а на экране человек читал «Пароли на сервере не
       * сохранены — сохраните их сейчас» НАД таблицей со строкой «Ничего
       * не создано». Паролей не было ни у кого и взять их было неоткуда:
       * ящики есть, войти в них нельзя, остаётся сбрасывать каждый руками.
       *
       * Соседний раздел — перенос почты — при том же пустом секрете
       * отказывается работать целиком и называет причину. Импорт этого не
       * делал.
       *
       * Отказ касается только СГЕНЕРИРОВАННЫХ паролей: если они заданы в
       * файле, они у человека уже есть, и хранить их серверу незачем.
       */
      if (!ctx.importBox && preview.rows.some((row) => row.errors.length === 0 && !row.password)) {
        throw new BadRequestError(
          'Импорт с генерацией паролей недоступен: не задан ADMIN_SESSION_SECRET/SESSION_SECRET, ' +
            'и сгенерированные пароли негде хранить зашифрованными. Ящики были бы созданы, а ' +
            'пароли потеряны — войти в них не смог бы никто. Задайте секрет в настройках сервера ' +
            'или укажите пароли колонкой в файле.',
        );
      }

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
          /** Придумал ли пароль сервер: такую строку сохраняем немедленно. */
          let generatedThisRow = false;
          if (row.errors.length > 0) {
            result.failed.push({ line: row.line, email: row.email, error: row.errors.join('; ') });
          } else {
            try {
              const domainName = row.email.slice(row.email.indexOf('@') + 1);
              const domain = await ctx.db.resolveDomain(domainName, allowNewDomains);
              // Тот же замок, что и при создании ящика поодиночке: адрес,
              // занятый перенаправлением, дал бы ящик, в который никогда
              // ничего не придёт. В импорте это особенно тихо — тысяча
              // строк заезжает без единого взгляда на каждую.
              const takenBy = domain ? await ctx.db.aliasTargetOf(row.email) : null;
              if (!domain) {
                result.failed.push({
                  line: row.line,
                  email: row.email,
                  error: `Домен «${domainName}» не заведён`,
                });
              } else if (takenBy !== null) {
                result.failed.push({
                  line: row.line,
                  email: row.email,
                  error:
                    `Адрес занят перенаправлением на ${takenBy}: ящик остался бы пустым — ` +
                    'Postfix разбирает перенаправления раньше ящиков',
                });
              } else {
                const generated = row.password === null;
                generatedThisRow = generated;
                const password = row.password ?? generatePassword();
                const user = await ctx.db.createMailUser({
                  domainId: domain.id,
                  email: row.email,
                  passwordHash: dovecotHash(password),
                  displayName: row.displayName,
                  quotaBytes: row.quotaBytes ?? importDefaultQuota,
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
          /*
           * Промежуточное сохранение.
           *
           * Раз в 25 строк — этого мало там, где пароль ПРИДУМАЛ СЕРВЕР:
           * ящик уже создан и закоммичен, а пароль к нему живёт только в
           * памяти процесса. Падение или перезапуск на 99-й строке
           * означали 24 созданных ящика, в которые не может войти никто:
           * в базе хэш, а восстановить пароль неоткуда. Шапка
           * import-jobs.ts при этом обещает обратное — «обрыв связи
           * теперь не значит ничего».
           *
           * Поэтому такие строки сохраняются сразу же. Строки с паролем
           * из файла терять нечего: он есть у того, кто этот файл принёс.
           */
          if (generatedThisRow || processed % 25 === 0) await save('running', processed);
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
    },
  );

  /* --- импорт: результат ------------------------------------------- */
  app.get('/users/import/jobs', { preHandler: requireAdmin(app, 'users.write') }, async () => {
    const rows = await ctx.db.listImportJobs(50);
    return { items: rows.map(jobDto) };
  });

  app.get<{ Params: { id: string } }>(
    '/users/import/jobs/:id',
    { preHandler: requireAdmin(app, 'users.write') },
    async (request) => {
      const row = await ctx.db.findImportJob(pathId(request.params.id, 'ящика'));
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
