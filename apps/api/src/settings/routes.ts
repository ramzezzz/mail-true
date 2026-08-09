/**
 * Маршруты настроек ящика.
 *
 * Формы запросов и ответов повторяют контракт веб-интерфейса
 * (apps/web/src/api/settingsApi.ts): интерфейс уже написан и покрыт
 * тестами, поэтому подстраивается сервер, а не наоборот. Само
 * преобразование между контрактом и внутренней моделью собрано
 * в webdto.ts и покрыто тестами.
 *
 * Все маршруты требуют почтовую сессию и работают только со своим
 * ящиком: адрес берётся из сессии, а не из тела запроса. Передать чужой
 * адрес нельзя — не потому что «проверяем», а потому что его негде указать.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Folder } from '@mail-true/shared';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors.js';
import { listFolders } from '../imap/service.js';
import { isUserLabelKey } from '../mail/labels.js';
import { applyRuleToMailbox } from './apply.js';
import { getAppearance, saveAppearance } from './appearance.js';
import { isUndefinedColumn, isUndefinedTable } from './db.js';
import { saveGeneralWithSignatures } from './general.js';
import {
  APPEARANCE_MIGRATION_HINT,
  MIGRATION_HINT,
  SettingsUnavailableError,
  type SettingsService,
  type SieveSyncState,
} from './service.js';
import type { MailSession } from '../types.js';
import {
  fromWebRule,
  pathOfFolderId,
  toWebGeneral,
  toWebRule,
  type WebFilterRule,
  type WebGeneralSettings,
} from './webdto.js';

/* ------------------------------------------------------------------ */
/* Схемы контракта интерфейса                                           */
/* ------------------------------------------------------------------ */

const signatureSchema = z.object({
  id: z.string().max(64).default(''),
  name: z.string().max(255).default(''),
  text: z.string().max(100_000).default(''),
});

export const generalSchema = z.object({
  senderName: z.string().max(255).default(''),
  signatures: z.array(signatureSchema).max(20).default([]),
  defaultSignatureId: z.string().max(64).nullable().default(null),
  autoReply: z
    .object({
      enabled: z.boolean().default(false),
      text: z.string().max(20_000).default(''),
      from: z.string().nullable().default(null),
      to: z.string().nullable().default(null),
    })
    .default({ enabled: false, text: '', from: null, to: null }),
  notifications: z
    .object({ browser: z.boolean().default(false), tabCounter: z.boolean().default(true) })
    .default({ browser: false, tabCounter: true }),
  quoteOriginalOnReply: z.boolean().default(true),
  afterDelete: z.enum(['next-message', 'list']).default('list'),
  autoCollectContacts: z.boolean().default(true),
  /*
   * Логотипы доменов в кружках списка писем.
   *
   * БЕЗ `.default()` — и это не небрежность. Zod выбрасывает поля, которых
   * нет в схеме, поэтому без этой строки настройка не доходила до базы
   * вовсе: интерфейс её слал, сервер отвечал «сохранено», а в базе
   * оставалось прежнее значение. Найдено на живом стенде.
   *
   * Но и значение по умолчанию здесь ставить нельзя: этот же маршрут
   * (и этот же контракт) правит админка, которая о поле не знает. С
   * `.default(false)` каждое сохранение из админки молча выключало бы
   * человеку логотипы. `undefined` означает «не трогать» — так это и
   * разбирает fromWebGeneral.
   */
  showSenderLogos: z.boolean().optional(),
  /*
   * Секунды на отмену отправки. Без `.default()` по той же причине, что
   * и у поля выше: этот контракт правит и админка, а с умолчанием каждое
   * сохранение оттуда молча возвращало бы человеку отправку без отмены.
   *
   * Список значений здесь, а не `z.number()`: сервер держит письмо ровно
   * столько, сколько сказано, и принимать «3600» от кого угодно значило бы
   * заводить способ задержать чужую почту на час.
   */
  undoSendSeconds: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(30)]).optional(),
  /*
   * Группировка писем в переписки. Без `.default()` — по той же причине,
   * что у двух полей выше: этот же контракт правит админка, и с умолчанием
   * каждое сохранение оттуда молча переставляло бы человеку вид списка.
   * `undefined` означает «не трогать».
   */
  groupByThread: z.boolean().optional(),
});

const conditionSchema = z
  .object({
    field: z.enum([
      'from',
      'to',
      'subject',
      'cc',
      'size',
      'body',
      'attachment',
      'resent-from',
      'resent-to',
    ]),
    operator: z
      .enum(['contains', 'not-contains', 'equals', 'greater', 'less', 'has', 'has-not'])
      .default('contains'),
    /*
     * Значение больше не обязательно, и это не послабление проверки.
     * У условия «есть вложение» значения нет вовсе — спрашивается наличие,
     * а не совпадение. Для всех прочих полей пустое значение по-прежнему
     * запрещено (проверка ниже): условие «Тема содержит ничего» подошло бы
     * любому письму, а правило с таким условием человек завёл бы по ошибке.
     */
    value: z.string().max(1000).default(''),
  })
  .refine((c) => c.field === 'attachment' || c.value.trim().length > 0, {
    message: 'Условию нужно значение',
    path: ['value'],
  });

const actionsSchema = z.object({
  moveToFolderId: z.string().max(512).nullable().default(null),
  markRead: z.boolean().default(false),
  markFlagged: z.boolean().default(false),
  /*
   * Метки правила — ключевые слова IMAP, и `addflag` в Sieve примет любое
   * слово. Поэтому здесь стоит ТА ЖЕ проверка, что и на маршруте простановки
   * меток: прислать `\Deleted` или `$Snoozed` нельзя — правило с такой
   * «меткой» стирало бы почту или прятало письма в «Отложенные».
   *
   * БЕЗ `.default()` — по той же причине, что и у showSenderLogos выше.
   * Этот же контракт и эту же схему использует админка (admin/routes/
   * user-settings.ts), а её форма правил о метках не знает. С умолчанием
   * `[]` первое же сохранение чужого правила из админки молча снимало бы
   * с него метку, и человек узнал бы об этом, только не найдя писем.
   * `undefined` означает «не трогать» — так это и разбирает fromWebRule.
   */
  labelKeys: z
    .array(z.string().max(64).refine(isUserLabelKey, { message: 'Это не ключ своей метки' }))
    .max(20)
    .optional(),
  /*
   * Удаление. Без `.default()` по той же причине — и здесь она весит
   * больше всего: с умолчанием `null` сохранение из админки сняло бы
   * с правила удаление и почта, которую человек велел выбрасывать, начала
   * бы копиться; а с умолчанием 'trash' форма, не знающая о поле, завела
   * бы правило, стирающее почту. Верно только «не трогать».
   */
  deleteMode: z.enum(['trash', 'purge']).nullable().optional(),
  applyToExistingFolderIds: z.array(z.string().min(1).max(512)).max(50).default([]),
  forwardTo: z.string().trim().email().max(320).nullable().default(null),
  autoReply: z.string().max(20_000).nullable().default(null),
  continueOtherFilters: z.boolean().default(true),
  applyToSpam: z.boolean().default(false),
});

export const ruleSchema = z.object({
  id: z.string().max(64).default(''),
  enabled: z.boolean().default(true),
  auto: z.boolean().default(false),
  conditions: z.array(conditionSchema).max(20).default([]),
  actions: actionsSchema,
});

export const orderSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(200) });

const idParam = z.object({ id: z.string().min(1).max(64) });

/** Числовой идентификатор из строкового: контракт интерфейса строковый. */
function numericId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError(`Правило не найдено: ${raw}`);
  return id;
}

/* ------------------------------------------------------------------ */
/* Маршруты                                                             */
/* ------------------------------------------------------------------ */

/**
 * Приписывает к ответу предупреждение о том, что файл правил не доехал.
 *
 * `syncSieve` намеренно не бросает: правило (или автоответчик) уже
 * сохранено в базе, и отменять сохранение из-за недоступного Dovecot
 * неправильно — человек потеряет работу на ровном месте. Но и молчать
 * нельзя: раскладывать почту, отвечать в отпуске и заглушать переписки
 * умеет ИМЕННО файл правил в ящике. Пока он не записан, настройка есть, а
 * поведения нет.
 *
 * Раньше состояние возвращалось наружу и там же выбрасывалось: маршруты
 * звали `await service.syncSieve(...)` и не смотрели на результат вовсе.
 * Человек видел зелёное «Настройки сохранены», уезжал в отпуск — а
 * отвечать было некому. Причина при этом существовала и была сформирована
 * (выключенный транспорт, недоступный контейнер Dovecot, ошибка
 * компиляции, отказ записи файла), но оставалась в журнале сервера.
 */
export function withSieveWarning<T extends object>(payload: T, state: SieveSyncState): T {
  if (state.ok) return payload;
  const reason = state.error.trim();
  return {
    ...payload,
    sieveWarning: reason
      ? `Сохранено, но правила пока не применяются на сервере: ${reason}`
      : 'Сохранено, но правила пока не применяются на сервере',
  };
}

export async function settingsUserRoutes(
  app: FastifyInstance,
  service: SettingsService,
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
      if (isUndefinedTable(err)) throw new SettingsUnavailableError(MIGRATION_HINT);
      throw err;
    }
  };

  /** Список папок ящика: нужен для перевода id папки в путь IMAP и обратно. */
  const foldersOf = (session: MailSession): Promise<Folder[]> =>
    pool.withClient(session.email, session.password, (client) => listFolders(client));

  /* -------------------------------------------------------------- */
  /* Общие настройки                                                  */
  /* -------------------------------------------------------------- */

  app.get('/general', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const db = service.requireDb();
    return guard(async () =>
      toWebGeneral(await db.getSettings(session.email), await db.listSignatures(session.email)),
    );
  });

  /**
   * Сохранение общих настроек вместе с подписями.
   *
   * Само согласование списка подписей живёт в general.ts: те же настройки
   * правит админка, и второй экземпляр этого правила рано или поздно
   * разошёлся бы с первым.
   */
  app.put('/general', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const dto = generalSchema.parse(request.body) as WebGeneralSettings;
    const db = service.requireDb();

    const result = await guard(() => saveGeneralWithSignatures(db, session.email, dto));

    // Автоответчик живёт в том же файле Sieve, что и правила.
    const sieve = await service.syncSieve(session.email);
    return withSieveWarning(result as object, sieve);
  });

  /* -------------------------------------------------------------- */
  /* Оформление                                                       */
  /* -------------------------------------------------------------- */

  /*
   * Тема и фон живут за учётной записью, а не в браузере: требование
   * заказчика — «тема оформления должна запоминаться для каждого юзера»
   * (см. appearance.ts и миграцию 0009).
   *
   * Отдельный `appearanceGuard` вместо общего `guard`: если 0009 ещё не
   * применена, таблицы настроек НА МЕСТЕ и всё остальное работает —
   * не работает только запоминание оформления, и подсказка про миграцию
   * тут своя.
   */
  const appearanceGuard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (isUndefinedTable(err)) throw new SettingsUnavailableError(MIGRATION_HINT);
      if (isUndefinedColumn(err)) throw new SettingsUnavailableError(APPEARANCE_MIGRATION_HINT);
      throw err;
    }
  };

  app.get('/appearance', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    return appearanceGuard(() => getAppearance(service.requireDb(), session.email));
  });

  app.put('/appearance', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    return appearanceGuard(() => saveAppearance(service.requireDb(), session.email, request.body));
  });

  /* -------------------------------------------------------------- */
  /* Правила фильтрации                                               */
  /* -------------------------------------------------------------- */

  app.get('/filters', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const db = service.requireDb();
    const rules = await guard(() => db.listFilters(session.email));
    const folders = await foldersOf(session);
    return rules.map((rule) => toWebRule(rule, folders));
  });

  /**
   * Порядок правил. Отдельный маршрут: стрелки в интерфейсе двигают
   * сразу два правила, и делать это двумя запросами нельзя.
   * Объявлен ДО '/filters/:id', хотя маршрутизатор и сам предпочёл бы
   * точное совпадение — так это видно и человеку.
   */
  app.put('/filters/order', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { ids } = orderSchema.parse(request.body);
    const db = service.requireDb();
    const rules = await guard(() =>
      db.reorderFilters(
        session.email,
        ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0),
      ),
    );
    await service.syncSieve(session.email);
    const folders = await foldersOf(session);
    return rules.map((rule) => toWebRule(rule, folders));
  });

  app.post('/filters', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const dto = ruleSchema.parse(request.body) as WebFilterRule;
    const db = service.requireDb();
    const folders = await foldersOf(session);
    const created = await guard(() => db.createFilter(session.email, fromWebRule(dto, folders)));
    const sieve = await service.syncSieve(session.email);
    await applyToExisting(session, created.id, dto, folders);
    return withSieveWarning(toWebRule(created, folders), sieve);
  });

  app.put('/filters/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const dto = ruleSchema.parse(request.body) as WebFilterRule;
    const db = service.requireDb();
    const folders = await foldersOf(session);
    // Правило читается ДО правки: поля, которых нет в запросе (метки,
    // удаление), должны остаться как были, а не обнулиться. См. fromWebRule.
    const previous = await guard(() => db.getFilter(session.email, numericId(id)));
    if (!previous) throw new NotFoundError('Правило не найдено');
    const updated = await guard(() =>
      db.updateFilter(session.email, numericId(id), fromWebRule(dto, folders, previous)),
    );
    if (!updated) throw new NotFoundError('Правило не найдено');
    const sieve = await service.syncSieve(session.email);
    await applyToExisting(session, updated.id, dto, folders);
    return withSieveWarning(toWebRule(updated, folders), sieve);
  });

  app.delete('/filters/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const removed = await guard(() =>
      service.requireDb().deleteFilter(session.email, numericId(id)),
    );
    if (!removed) throw new NotFoundError('Правило не найдено');
    const sieve = await service.syncSieve(session.email);
    return withSieveWarning({ ok: true }, sieve);
  });

  /**
   * «Применить к письмам, которые уже находятся в папках».
   *
   * Sieve работает только при доставке, поэтому новое правило на старую
   * почту не действует. Интерфейс передаёт список папок прямо в правиле
   * (`applyToExistingFolderIds`), и это разовое действие: в сохранённом
   * правиле список не остаётся.
   */
  async function applyToExisting(
    session: MailSession,
    ruleId: number,
    dto: WebFilterRule,
    folders: Folder[],
  ): Promise<void> {
    const paths = dto.actions.applyToExistingFolderIds
      .map((id) => pathOfFolderId(folders, id))
      .filter((p): p is string => p !== null);
    if (paths.length === 0) return;
    const rule = await service.requireDb().getFilter(session.email, ruleId);
    if (!rule) return;
    await pool.withClient(session.email, session.password, (client) =>
      applyRuleToMailbox(client, {
        rule,
        folderPaths: paths,
        maxMessages: service.config.FILTER_APPLY_MAX_MESSAGES,
      }),
    );
  }

  /**
   * Прогон правила по уже полученной почте отдельным запросом.
   * Нужен, когда правило уже сохранено, а применить его к старым письмам
   * решили позже — в контракте интерфейса такого маршрута нет, но
   * без него нельзя ни проверить работу, ни повторить действие.
   */
  app.post('/filters/:id/apply', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const body = z
      .object({ folders: z.array(z.string().min(1).max(512)).max(50).default([]) })
      .parse(request.body ?? {});
    const rule = await guard(() => service.requireDb().getFilter(session.email, numericId(id)));
    if (!rule) throw new NotFoundError('Правило не найдено');
    if (
      rule.actions.folder === null &&
      !rule.actions.markRead &&
      !rule.actions.flag &&
      rule.actions.labels.length === 0 &&
      rule.actions.deleteMessage === null
    ) {
      throw new BadRequestError(
        'К уже полученным письмам применяются «в папку», «прочитано», «флажок», метки и удаление',
      );
    }
    const result = await pool.withClient(session.email, session.password, async (client) => {
      const all = await listFolders(client);
      let paths = body.folders
        .map((fid) => pathOfFolderId(all, fid) ?? (all.some((f) => f.path === fid) ? fid : null))
        .filter((p): p is string => p !== null);
      if (paths.length === 0) {
        const inbox = all.find((f) => f.role === 'inbox');
        paths = inbox ? [inbox.path] : [];
      }
      return applyRuleToMailbox(client, {
        rule,
        folderPaths: paths,
        maxMessages: service.config.FILTER_APPLY_MAX_MESSAGES,
      });
    });
    return { result };
  });

  /* -------------------------------------------------------------- */
  /* Диагностика                                                      */
  /* -------------------------------------------------------------- */

  /**
   * Текст действующего файла правил. Пользователю полезно увидеть, что
   * в итоге получилось, а проверке — доказать, что правило доехало
   * до Dovecot, а не осталось в базе.
   */
  app.get('/sieve', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    return {
      transport: service.store.transport,
      path: service.store.activePath(session.email),
      script: await service.readSieve(session.email),
    };
  });

  /** Состояние синхронизации правил с почтовым хранилищем. */
  app.post('/sieve/sync', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    return service.syncSieve(session.email);
  });
}
