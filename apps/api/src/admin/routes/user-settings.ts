/**
 * Настройки ЧУЖОГО ящика из админки: подписи, автоответчик, фильтры
 * (в том числе пересылка), папки.
 *
 * Требование заказчика дословно: «Нужна возможность получить доступ к
 * настройкам ящиков (как у юзера) из админки — подписи, фильтры и другое.
 * Возможность групповой установки подписей по шаблону».
 *
 * Ключевое слово — «как у юзера». Второго набора правил здесь нет:
 *
 *  - схемы запросов те же самые (generalSchema, ruleSchema из
 *    settings/routes.ts) — форма, сохранённая администратором, обязана
 *    читаться пользовательской формой без переводчика;
 *  - согласование списка подписей — общая функция saveGeneralWithSignatures;
 *  - перевод правила в модель базы и обратно — тот же webdto.ts;
 *  - файл Sieve после любой правки переписывается тем же
 *    SettingsService.syncSieve. Иначе админка меняла бы базу, а Dovecot
 *    продолжал фильтровать по старому файлу, и «правило не работает»
 *    выяснялось бы на живом письме.
 *
 * Отличий от пользовательских маршрутов ровно три, и все вынужденные:
 *
 *  1. Адрес ящика берётся из :id, а не из сессии. Поэтому каждый маршрут
 *     проверяет право и пишет в журнал аудита, ЧЕЙ ящик тронут.
 *  2. Список папок читается служебным доступом Dovecot (пароля владельца
 *     у админки нет и быть не должно). Если служебный доступ не настроен,
 *     папки недоступны — маршрут отвечает без них, а не падает.
 *  3. «Применить правило к уже полученным письмам» здесь нет. Это
 *     перекладывание чужой почты по всем папкам, и делать его от лица
 *     администратора без ведома владельца мы не будем.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  renderSignatureFor,
  signatureBulkOutcome,
  signatureTemplateProblem,
  SIGNATURE_BULK_MODES,
  SIGNATURE_EXTRA_VARIABLES,
  SIGNATURE_VARIABLES,
  SIGNATURE_VARIABLE_HINTS,
  type Folder,
  type SignatureBulkMode,
  type SignatureBulkOutcome,
} from '@mail-true/shared';
import { BadRequestError, NotFoundError } from '../../errors.js';
import { isUndefinedTable } from '../../settings/db.js';
import { saveGeneralWithSignatures } from '../../settings/general.js';
import {
  MIGRATION_HINT,
  SettingsUnavailableError,
  type SettingsService,
} from '../../settings/service.js';
import { generalSchema, orderSchema, ruleSchema } from '../../settings/routes.js';
import {
  fromWebRule,
  toWebGeneral,
  toWebRule,
  type WebFilterRule,
  type WebGeneralSettings,
} from '../../settings/webdto.js';
import { audit, requireAdmin } from '../guard.js';
import type { MailUserRow } from '../db.js';
import type { AdminContext } from '../types.js';

/**
 * Откуда берётся сервис настроек.
 *
 * Функцией, а не значением: настройки регистрируются в приложении ПОСЛЕ
 * админки (см. src/app.ts), и на момент подключения этих маршрутов
 * app.settingsService ещё не существует. Раскрываем его в момент запроса.
 */
export type SettingsServiceSource = () => SettingsService | undefined;

/** Предел выборки для групповой операции. */
const BULK_MAX = 2000;

/** Сколько строк выборки показываем в предпросмотре поимённо. */
const PREVIEW_ROWS = 50;

const idParams = z.object({ id: z.coerce.number().int().positive() });
const filterParams = z.object({
  id: z.coerce.number().int().positive(),
  filterId: z.coerce.number().int().positive(),
});

const bulkSchema = z
  .object({
    /** Явно выбранные ящики (галочки в списке). */
    ids: z.array(z.coerce.number().int().positive()).max(BULK_MAX).default([]),
    /** Либо весь домен целиком. */
    domainId: z.coerce.number().int().positive().optional(),
    template: z.string().min(1).max(100_000),
    name: z.string().trim().min(1).max(255).default('Корпоративная подпись'),
    mode: z.enum(SIGNATURE_BULK_MODES),
    /** Сделать новую подпись основной (её подставляет форма нового письма). */
    makeDefault: z.boolean().default(true),
    /**
     * Общие значения подстановок (должность, отдел…). Их в базе нет:
     * задаются один раз на всю рассылку.
     */
    extras: z.record(z.string().max(500)).default({}),
    /**
     * Пропускать ящики, у которых не хватает данных для подстановки.
     * Выключить это можно, но по умолчанию — пропускаем: подпись,
     * начинающаяся с пустой строки, хуже отсутствия подписи.
     */
    skipIncomplete: z.boolean().default(true),
    /** На ком показать предпросмотр (адрес из выборки). */
    previewEmail: z.string().trim().toLowerCase().max(320).optional(),
  })
  .strict();

type BulkBody = z.infer<typeof bulkSchema>;

/** Снимок общих настроек для журнала аудита. */
function generalSnapshot(dto: WebGeneralSettings): Record<string, unknown> {
  const def = dto.signatures.find((s) => s.id === dto.defaultSignatureId) ?? null;
  return {
    sender_name: dto.senderName,
    // В журнал кладём имена и тексты подписей: «изменены подписи» без
    // самих подписей не отвечает на вопрос «что именно сделали».
    signatures: dto.signatures.map((s) => ({ name: s.name, text: s.text })),
    default_signature: def ? def.name : null,
    autoreply_enabled: dto.autoReply.enabled,
    autoreply_text: dto.autoReply.text,
    autoreply_from: dto.autoReply.from,
    autoreply_until: dto.autoReply.to,
    notify_browser: dto.notifications.browser,
    notify_tab: dto.notifications.tabCounter,
    quote_on_reply: dto.quoteOriginalOnReply,
    after_delete: dto.afterDelete,
    collect_contacts: dto.autoCollectContacts,
  };
}

/** Снимок правила для журнала аудита. */
function ruleSnapshot(rule: WebFilterRule): Record<string, unknown> {
  return {
    enabled: rule.enabled,
    conditions: rule.conditions.map((c) => `${c.field} ${c.operator} ${c.value}`),
    move_to_folder: rule.actions.moveToFolderId,
    mark_read: rule.actions.markRead,
    mark_flagged: rule.actions.markFlagged,
    forward_to: rule.actions.forwardTo,
    auto_reply: rule.actions.autoReply,
    apply_to_spam: rule.actions.applyToSpam,
    continue_other_filters: rule.actions.continueOtherFilters,
  };
}

export async function adminUserSettingsRoutes(
  app: FastifyInstance,
  source: SettingsServiceSource,
): Promise<void> {
  const ctx: AdminContext = app.adminCtx;

  /** Сервис настроек или понятный отказ вместо 500. */
  const settings = (): SettingsService => {
    const service = source();
    if (!service) throw new SettingsUnavailableError();
    return service;
  };

  /** Отсутствующая таблица — это непринятая миграция, а не авария. */
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (isUndefinedTable(err)) throw new SettingsUnavailableError(MIGRATION_HINT);
      throw err;
    }
  };

  /** Ящик по номеру из адреса запроса. */
  const mailboxOf = async (id: number): Promise<MailUserRow> => {
    const row = await ctx.db.findMailUserById(id);
    if (!row) throw new NotFoundError('Ящик не найден');
    return row;
  };

  /**
   * Папки ящика служебным доступом.
   *
   * Молчаливый пустой список вместо ошибки: без папок настройки всё равно
   * читаются и правятся, теряется только перевод «идентификатор папки ->
   * путь». Ронять из-за этого весь раздел нельзя — чаще всего служебный
   * доступ просто не настроен на стенде.
   */
  const foldersOf = async (
    email: string,
  ): Promise<{ folders: Folder[]; available: boolean; error: string | null }> => {
    if (!ctx.mailbox.configured) {
      return {
        folders: [],
        available: false,
        error: 'Служебный доступ Dovecot не настроен: папки ящика недоступны',
      };
    }
    try {
      return { folders: await ctx.mailbox.listMailFolders(email), available: true, error: null };
    } catch (err) {
      return {
        folders: [],
        available: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  /* ---------------------------------------------------------------- */
  /* Чтение настроек ящика                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Всё разом: общие настройки с подписями, фильтры, папки.
   *
   * Одним запросом, а не тремя, намеренно: это единственная точка входа
   * в чужие настройки, и запись в журнале аудита должна появляться один
   * раз на открытие раздела, а не по разу на каждую вкладку.
   */
  app.get<{ Params: { id: string } }>(
    '/users/:id/settings',
    { preHandler: requireAdmin(app, 'usersettings.read') },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const user = await mailboxOf(id);
      const db = settings().requireDb();

      const { general, filters } = await guard(async () => ({
        general: toWebGeneral(
          await db.getSettings(user.email),
          await db.listSignatures(user.email),
        ),
        filters: await db.listFilters(user.email),
      }));
      const folders = await foldersOf(user.email);

      await audit(ctx, request, {
        action: 'usersettings.view',
        targetType: 'settings',
        targetId: user.id,
        targetLabel: user.email,
        after: { mailbox: user.email },
      });

      return {
        mailbox: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          domain: user.domain,
          active: user.active,
        },
        general,
        filters: filters.map((rule) => toWebRule(rule, folders.folders)),
        folders: folders.folders,
        foldersAvailable: folders.available,
        foldersError: folders.error,
      };
    },
  );

  /** Текст действующего файла правил — доказательство, что правка доехала. */
  app.get<{ Params: { id: string } }>(
    '/users/:id/settings/sieve',
    { preHandler: requireAdmin(app, 'usersettings.read') },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const user = await mailboxOf(id);
      const service = settings();
      return {
        transport: service.store.transport,
        path: service.store.activePath(user.email),
        script: await service.readSieve(user.email),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Общие настройки и подписи                                          */
  /* ---------------------------------------------------------------- */

  app.put<{ Params: { id: string } }>(
    '/users/:id/settings/general',
    { preHandler: requireAdmin(app, 'usersettings.write') },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const user = await mailboxOf(id);
      const dto = generalSchema.parse(request.body) as WebGeneralSettings;
      const db = settings().requireDb();

      const before = await guard(async () =>
        toWebGeneral(await db.getSettings(user.email), await db.listSignatures(user.email)),
      );
      const after = await guard(() => saveGeneralWithSignatures(db, user.email, dto));

      // Автоответчик живёт в том же файле Sieve, что и правила.
      const sieve = await settings().syncSieve(user.email);

      await audit(ctx, request, {
        action: 'usersettings.general',
        targetType: 'settings',
        targetId: user.id,
        targetLabel: user.email,
        before: generalSnapshot(before),
        after: generalSnapshot(after),
      });

      return { ...after, sieve };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Фильтры                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Порядок правил. Объявлен до '/filters/:filterId': маршрутизатор и сам
   * предпочёл бы точное совпадение, но так это видно и человеку.
   */
  app.put<{ Params: { id: string } }>(
    '/users/:id/settings/filters/order',
    { preHandler: requireAdmin(app, 'usersettings.write') },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const user = await mailboxOf(id);
      const { ids } = orderSchema.parse(request.body);
      const db = settings().requireDb();

      const before = await guard(() => db.listFilters(user.email));
      const rules = await guard(() =>
        db.reorderFilters(
          user.email,
          ids.map((raw) => Number(raw)).filter((n) => Number.isInteger(n) && n > 0),
        ),
      );
      await settings().syncSieve(user.email);

      await audit(ctx, request, {
        action: 'usersettings.filter.order',
        targetType: 'settings',
        targetId: user.id,
        targetLabel: user.email,
        before: { order: before.map((r) => r.name) },
        after: { order: rules.map((r) => r.name) },
      });

      const folders = await foldersOf(user.email);
      return rules.map((rule) => toWebRule(rule, folders.folders));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/users/:id/settings/filters',
    { preHandler: requireAdmin(app, 'usersettings.write') },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const user = await mailboxOf(id);
      const dto = ruleSchema.parse(request.body) as WebFilterRule;
      const db = settings().requireDb();
      const folders = await foldersOf(user.email);

      const created = await guard(() =>
        db.createFilter(user.email, fromWebRule(dto, folders.folders)),
      );
      const sieve = await settings().syncSieve(user.email);
      const web = toWebRule(created, folders.folders);

      await audit(ctx, request, {
        action: 'usersettings.filter.create',
        targetType: 'settings',
        targetId: user.id,
        targetLabel: user.email,
        after: { filter: created.name, ...ruleSnapshot(web) },
      });

      return { ...web, sieve };
    },
  );

  app.put<{ Params: { id: string; filterId: string } }>(
    '/users/:id/settings/filters/:filterId',
    { preHandler: requireAdmin(app, 'usersettings.write') },
    async (request) => {
      const { id, filterId } = filterParams.parse(request.params);
      const user = await mailboxOf(id);
      const dto = ruleSchema.parse(request.body) as WebFilterRule;
      const db = settings().requireDb();
      const folders = await foldersOf(user.email);

      const previous = await guard(() => db.getFilter(user.email, filterId));
      if (!previous) throw new NotFoundError('Правило не найдено');
      // previous передаётся не только ради журнала: форма правил в админке
      // не знает про метки и удаление, и без него сохранение отсюда молча
      // снимало бы их с чужого правила. См. fromWebRule.
      const updated = await guard(() =>
        db.updateFilter(user.email, filterId, fromWebRule(dto, folders.folders, previous)),
      );
      if (!updated) throw new NotFoundError('Правило не найдено');
      const sieve = await settings().syncSieve(user.email);
      const web = toWebRule(updated, folders.folders);

      await audit(ctx, request, {
        action: 'usersettings.filter.update',
        targetType: 'settings',
        targetId: user.id,
        targetLabel: user.email,
        before: { filter: previous.name, ...ruleSnapshot(toWebRule(previous, folders.folders)) },
        after: { filter: updated.name, ...ruleSnapshot(web) },
      });

      return { ...web, sieve };
    },
  );

  app.delete<{ Params: { id: string; filterId: string } }>(
    '/users/:id/settings/filters/:filterId',
    { preHandler: requireAdmin(app, 'usersettings.write') },
    async (request) => {
      const { id, filterId } = filterParams.parse(request.params);
      const user = await mailboxOf(id);
      const db = settings().requireDb();

      const previous = await guard(() => db.getFilter(user.email, filterId));
      if (!previous) throw new NotFoundError('Правило не найдено');
      const removed = await guard(() => db.deleteFilter(user.email, filterId));
      if (!removed) throw new NotFoundError('Правило не найдено');
      const sieve = await settings().syncSieve(user.email);

      await audit(ctx, request, {
        action: 'usersettings.filter.delete',
        targetType: 'settings',
        targetId: user.id,
        targetLabel: user.email,
        // Поля повторены пустыми: журнал показывает только изменившееся и
        // выкинул бы из записи само удалённое правило.
        before: { filter: previous.name, enabled: previous.enabled },
        after: { filter: null, enabled: null },
      });

      return { ok: true, sieve };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Групповая установка подписей по шаблону                            */
  /* ---------------------------------------------------------------- */

  /** Справочник подстановок — чтобы интерфейс не хранил свой список. */
  app.get(
    '/signatures/template/variables',
    { preHandler: requireAdmin(app, 'usersettings.read') },
    async () => ({
      items: SIGNATURE_VARIABLES.map((name) => ({
        name,
        hint: SIGNATURE_VARIABLE_HINTS[name],
        /** Значение задаёт администратор, а не карточка ящика. */
        manual: (SIGNATURE_EXTRA_VARIABLES as readonly string[]).includes(name),
      })),
    }),
  );

  /** Ящики, попавшие в выборку. */
  const targetsOf = async (body: BulkBody): Promise<MailUserRow[]> => {
    if (body.ids.length > 0) {
      const rows: MailUserRow[] = [];
      for (const id of body.ids) {
        const row = await ctx.db.findMailUserById(id);
        if (row) rows.push(row);
      }
      return rows;
    }
    if (body.domainId !== undefined) {
      const page = await ctx.db.listMailUsers({
        domainId: body.domainId,
        limit: BULK_MAX,
        offset: 0,
      });
      return page.rows;
    }
    throw new BadRequestError(
      'Не выбрано ни одного ящика: отметьте ящики в списке или выберите домен',
    );
  };

  /** Что произойдёт с одним ящиком — считается один раз и для показа, и для записи. */
  interface Planned {
    user: MailUserRow;
    existing: number;
    outcome: SignatureBulkOutcome;
    missing: string[];
    text: string;
  }

  const planFor = async (body: BulkBody, users: MailUserRow[]): Promise<Planned[]> => {
    const db = settings().requireDb();
    const out: Planned[] = [];
    for (const user of users) {
      const existing = await db.listSignatures(user.email);
      const rendered = renderSignatureFor(
        body.template,
        { email: user.email, displayName: user.display_name },
        body.extras,
      );
      const incomplete = body.skipIncomplete && rendered.empty.length > 0;
      out.push({
        user,
        existing: existing.length,
        outcome: signatureBulkOutcome(
          body.mode as SignatureBulkMode,
          existing.length > 0,
          incomplete,
        ),
        missing: rendered.empty,
        text: rendered.text,
      });
    }
    return out;
  };

  /** Сводка по плану: те самые числа, которые обязан увидеть администратор. */
  const summaryOf = (plan: Planned[]): Record<string, number> => ({
    total: plan.length,
    willAdd: plan.filter((p) => p.outcome === 'add').length,
    willReplace: plan.filter((p) => p.outcome === 'replace').length,
    willSkipExisting: plan.filter((p) => p.outcome === 'skip-existing').length,
    willSkipIncomplete: plan.filter((p) => p.outcome === 'skip-incomplete').length,
    /** Сколько чужих подписей будет затёрто. Молчать об этом нельзя. */
    signaturesReplaced: plan
      .filter((p) => p.outcome === 'replace')
      .reduce((sum, p) => sum + p.existing, 0),
    withExistingSignatures: plan.filter((p) => p.existing > 0).length,
  });

  /**
   * Предпросмотр. Отдельным запросом и ДО применения: групповая правка
   * подписей ничем не откатывается, и единственная защита от опечатки в
   * шаблоне — увидеть готовый текст на живом человеке.
   */
  app.post(
    '/signatures/bulk/preview',
    { preHandler: requireAdmin(app, 'usersettings.bulk') },
    async (request) => {
      const body = bulkSchema.parse(request.body);
      const users = await targetsOf(body);
      const problem = signatureTemplateProblem(body.template);
      const plan = await guard(() => planFor(body, users));

      const sample =
        plan.find((p) => p.user.email === body.previewEmail) ??
        // Показываем на том, кому подпись реально достанется: пример на
        // пропущенном ящике ничего не доказывает.
        plan.find((p) => p.outcome === 'add' || p.outcome === 'replace') ??
        plan[0] ??
        null;

      return {
        ...summaryOf(plan),
        /** Шаблон применять нельзя — здесь сказано, почему. */
        problem,
        mode: body.mode,
        rows: plan.slice(0, PREVIEW_ROWS).map((p) => ({
          id: p.user.id,
          email: p.user.email,
          displayName: p.user.display_name,
          existing: p.existing,
          outcome: p.outcome,
          missing: p.missing,
        })),
        rowsTruncated: Math.max(0, plan.length - PREVIEW_ROWS),
        sample: sample
          ? {
              email: sample.user.email,
              displayName: sample.user.display_name,
              outcome: sample.outcome,
              missing: sample.missing,
              text: sample.text,
            }
          : null,
      };
    },
  );

  /** Применение. Считает тот же план, что показал предпросмотр. */
  app.post(
    '/signatures/bulk/apply',
    { preHandler: requireAdmin(app, 'usersettings.bulk') },
    async (request) => {
      const body = bulkSchema.parse(request.body);
      const problem = signatureTemplateProblem(body.template);
      // Отказ до единой записи в базу: применить шаблон с опечаткой в
      // подстановке — значит разослать `{{долность}}` по живым ящикам.
      if (problem) throw new BadRequestError(problem);

      const users = await targetsOf(body);
      if (users.length === 0) throw new BadRequestError('В выборке нет ни одного ящика');

      const db = settings().requireDb();
      const plan = await guard(() => planFor(body, users));

      let applied = 0;
      const failed: Array<{ email: string; error: string }> = [];
      for (const item of plan) {
        if (item.outcome !== 'add' && item.outcome !== 'replace') continue;
        try {
          const before = await db.listSignatures(item.user.email);
          if (item.outcome === 'replace') {
            /*
             * Замена — ОДНОЙ транзакцией. Раньше здесь удаляли прежние
             * подписи по одной и только потом заводили новую: обрыв между
             * запросами оставлял ящик без единой подписи, а текста
             * стёртых не оставалось нигде — в журнал пишут после успеха.
             */
            await db.replaceSignatures(item.user.email, {
              name: body.name,
              bodyHtml: item.text,
              isDefault: body.makeDefault,
            });
          } else {
            await db.createSignature(item.user.email, {
              name: body.name,
              bodyHtml: item.text,
              isDefault: body.makeDefault,
            });
          }
          applied += 1;

          // Запись на КАЖДЫЙ ящик: «изменено 137 подписей» не отвечает на
          // вопрос владельца ящика «кто и когда трогал мою подпись».
          await audit(ctx, request, {
            action: 'usersettings.signature.bulk',
            targetType: 'settings',
            targetId: item.user.id,
            targetLabel: item.user.email,
            before: {
              signatures: before.map((s) => s.name),
              signature_text: before.find((s) => s.isDefault)?.bodyHtml ?? null,
            },
            after: {
              signatures: [
                ...(item.outcome === 'replace' ? [] : before.map((s) => s.name)),
                body.name,
              ],
              signature_text: item.text,
              mode: item.outcome,
            },
          });
        } catch (err) {
          failed.push({
            email: item.user.email,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const summary = summaryOf(plan);
      await audit(ctx, request, {
        action: 'usersettings.signature.bulk.run',
        targetType: 'settings',
        targetLabel: `${String(applied)} из ${String(plan.length)}`,
        after: {
          template: body.template,
          signature_name: body.name,
          mode: body.mode,
          make_default: body.makeDefault,
          applied,
          skipped_existing: summary['willSkipExisting'] ?? 0,
          skipped_incomplete: summary['willSkipIncomplete'] ?? 0,
          signatures_replaced: summary['signaturesReplaced'] ?? 0,
          failed: failed.length,
        },
      });

      return { ok: true, ...summary, applied, failed };
    },
  );
}
