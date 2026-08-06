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
import { applyRuleToMailbox } from './apply.js';
import { getAppearance, saveAppearance } from './appearance.js';
import { isUndefinedColumn, isUndefinedTable } from './db.js';
import { saveGeneralWithSignatures } from './general.js';
import {
  APPEARANCE_MIGRATION_HINT,
  MIGRATION_HINT,
  SettingsUnavailableError,
  type SettingsService,
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
  undoSendSeconds: z
    .union([z.literal(0), z.literal(5), z.literal(10), z.literal(30)])
    .optional(),
});

const conditionSchema = z.object({
  field: z.enum(['from', 'to', 'subject', 'cc', 'size', 'resent-from', 'resent-to']),
  operator: z.enum(['contains', 'not-contains', 'equals', 'greater', 'less']).default('contains'),
  value: z.string().min(1).max(1000),
});

const actionsSchema = z.object({
  moveToFolderId: z.string().max(512).nullable().default(null),
  markRead: z.boolean().default(false),
  markFlagged: z.boolean().default(false),
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
    await service.syncSieve(session.email);
    return result;
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
    return appearanceGuard(() =>
      saveAppearance(service.requireDb(), session.email, request.body),
    );
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
    await service.syncSieve(session.email);
    await applyToExisting(session, created.id, dto, folders);
    return toWebRule(created, folders);
  });

  app.put('/filters/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const dto = ruleSchema.parse(request.body) as WebFilterRule;
    const db = service.requireDb();
    const folders = await foldersOf(session);
    const updated = await guard(() =>
      db.updateFilter(session.email, numericId(id), fromWebRule(dto, folders)),
    );
    if (!updated) throw new NotFoundError('Правило не найдено');
    await service.syncSieve(session.email);
    await applyToExisting(session, updated.id, dto, folders);
    return toWebRule(updated, folders);
  });

  app.delete('/filters/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const removed = await guard(() => service.requireDb().deleteFilter(session.email, numericId(id)));
    if (!removed) throw new NotFoundError('Правило не найдено');
    await service.syncSieve(session.email);
    return { ok: true };
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
    if (rule.actions.folder === null && !rule.actions.markRead && !rule.actions.flag) {
      throw new BadRequestError(
        'К уже полученным письмам применяются только «в папку», «прочитано» и «флажок»',
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
