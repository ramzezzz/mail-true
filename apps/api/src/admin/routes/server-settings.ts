/**
 * Раздел «Настройки сервера»: посмотреть, изменить, вернуть к умолчанию.
 *
 * ------------------------------------------------------------------
 * ЧТО ОТДАЁТСЯ ПАНЕЛИ И ПОЧЕМУ ИМЕННО СТОЛЬКО
 * ------------------------------------------------------------------
 * Каждая настройка приходит не голым значением, а вместе с тем, что нужно,
 * чтобы человек мог её осмысленно поменять:
 *
 *   value + source   — что действует и ОТКУДА взято: из базы (задано в
 *                      панели), из окружения (infra/.env) или из умолчания
 *                      в коде. Без источника «14» на экране ничего не
 *                      значит: непонятно, это чей-то выбор или так вышло.
 *   default          — к чему вернёт кнопка «по умолчанию».
 *   kind/min/max     — чтобы поле проверяло ввод ДО отправки, а не
 *                      показывало отказ сервера после.
 *   description      — то же описание, что в infra/.env.example. Настройка
 *                      без объяснения последствий — это кнопка «сделать
 *                      что-нибудь».
 *   requiresRestart  — обещание: подействует сразу или после перезапуска.
 *   pendingRestart   — не обещание, а факт: значение уже сохранено, но
 *                      живой процесс работает по старому.
 *
 * ------------------------------------------------------------------
 * СЕКРЕТЫ
 * ------------------------------------------------------------------
 * Пароли базы, секреты сессий, ключи шифрования и общий секрет посредника
 * очереди не отдаются НИ В КАКОМ ВИДЕ: ни значением, ни звёздочками с
 * возможностью подсмотреть, ни длиной. О них известно ровно одно — задан
 * секрет или нет, и это всё, что нужно для ответа на вопрос «настроено ли».
 * Менять их отсюда тоже нельзя (см. группу locked в перечне).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError } from '../../errors.js';
import { audit, currentAdmin, requireAdmin } from '../guard.js';
import type { AdminContext } from '../types.js';
import { SETTING_SECTIONS } from '../server-settings-registry.js';
import { findTarget } from '../restart-targets.js';
import { findRotatable, generateSecret, ROTATABLE_SECRETS } from '../secret-rotation.js';
import {
  parseSettingValue,
  typedValue,
  type ResolvedSetting,
  type ServerSettings,
} from '../server-settings.js';

/** Значение настройки в запросе: строка, число или да/нет. */
const valueSchema = z.union([z.string(), z.number(), z.boolean()]);

const putSchema = z.object({ value: valueSchema });

const bulkSchema = z.object({
  /** null у ключа означает «вернуть к умолчанию». */
  values: z.record(z.string().min(1).max(128), valueSchema.nullable()),
});

/**
 * Ждёт ли настройка применения ПРЯМО СЕЙЧАС.
 *
 * У двух групп это считается по-разному, и свести их к одному правилу
 * нельзя — они про разные процессы.
 *
 *   restart  — значение читает САМ сервер приложения, и при старте
 *              сохранённые значения подмешиваются ему в окружение
 *              (applyStoredEnv). Значит достаточно сравнить действующее
 *              значение с тем, что лежит в окружении живого процесса:
 *              разошлись — настройку меняли уже после старта. Это самый
 *              честный признак из возможных, и он верно молчит, когда
 *              настройку поменяли и вернули обратно.
 *
 *   recreate — значение читает ЧУЖОЙ контейнер, и в окружении сервера
 *              приложения его может не быть вовсе. Сравнивать не с чем,
 *              поэтому единственный честный признак — время: настройку
 *              правили позже, чем эту службу последний раз удачно
 *              применяли. Не применяли ни разу — значит ждёт, и это не
 *              перестраховка: доказательства обратного у нас нет.
 */
function pendingApply(item: ResolvedSetting, lastApplied: ReadonlyMap<string, Date>): boolean {
  const { spec } = item;
  if (spec.group === 'restart') return item.raw !== (item.envRaw ?? spec.def);
  if (spec.group !== 'recreate') return false;
  if (item.source !== 'db' || item.updatedAt === null) return false;
  const updatedAt = item.updatedAt;
  return (spec.applies ?? []).some((apply) => {
    const applied = lastApplied.get(apply.target);
    return applied === undefined || updatedAt > applied;
  });
}

/** Одна настройка в том виде, в каком её читает панель. */
function toDto(
  item: ResolvedSetting,
  lastApplied: ReadonlyMap<string, Date>,
): Record<string, unknown> {
  const { spec } = item;
  const secret = spec.secret === true;
  const editable = spec.group !== 'locked';
  return {
    key: spec.key,
    section: spec.section,
    group: spec.group,
    kind: spec.kind,
    unit: spec.unit ?? null,
    min: spec.min ?? null,
    max: spec.max ?? null,
    options: spec.options ?? null,
    description: spec.description,
    reason: spec.reason ?? null,
    editable,
    secret,
    requiresRestart: spec.group === 'restart' || spec.group === 'recreate',
    /**
     * Что именно включит эту настройку: службы и действия поимённо, в
     * порядке выполнения. Общего «перезапустить всё» в продукте нет —
     * остановка Postfix и остановка nginx означают для людей разное,
     * и панель обязана показывать, что именно человек остановит.
     *
     * Подробности о каждой службе (последствия, длительность, что НЕ
     * пострадает) панель берёт из GET /api/admin/restart: держать два
     * набора формулировок для одной службы значило бы, что однажды они
     * разойдутся.
     */
    applies: spec.applies ?? [],
    /**
     * Сохранённое значение ещё не дошло до того, кто его читает. Не
     * обещание («когда-нибудь понадобится перезапуск»), а факт —
     * см. pendingApply выше.
     */
    pendingRestart: pendingApply(item, lastApplied),
    // Секрет наружу не выходит ни в каком виде — только «задан или нет».
    value: secret ? null : typedValue(spec, item.raw),
    default: secret ? null : typedValue(spec, spec.def),
    configured: secret ? item.raw !== '' : null,
    source: item.source,
    updatedBy: item.updatedBy,
    updatedAt: item.updatedAt ? item.updatedAt.toISOString() : null,
  };
}

/**
 * Когда каждую службу применяли удачно в последний раз.
 *
 * Спрашивается один раз на весь список, а не на каждую настройку: это
 * один запрос к базе на открытие раздела вместо ста тридцати трёх.
 * Отсутствие журнала (миграция не применена) означает «ничего не
 * применяли», то есть все заданные в панели настройки чужих служб честно
 * покажутся ждущими — а не молча сойдут за применённые.
 */
async function appliedTimes(ctx: AdminContext): Promise<ReadonlyMap<string, Date>> {
  const store = ctx.restarts;
  if (!store) return new Map();
  try {
    return await store.lastApplied();
  } catch {
    return new Map();
  }
}

async function listDto(
  settings: ServerSettings,
  ctx: AdminContext,
): Promise<Record<string, unknown>> {
  const lastApplied = await appliedTimes(ctx);
  const items = (await settings.resolveAll()).map((item) => toDto(item, lastApplied));
  const sections = SETTING_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    note: section.note ?? null,
    settings: items.filter((i) => i.section === section.id),
  })).filter((s) => s.settings.length > 0);

  return {
    sections,
    counts: {
      total: items.length,
      live: items.filter((i) => i.group === 'live').length,
      restart: items.filter((i) => i.group === 'restart').length,
      /** Настройки чужих контейнеров: им мало перезапуска, нужно пересоздание. */
      recreate: items.filter((i) => i.group === 'recreate').length,
      locked: items.filter((i) => i.group === 'locked').length,
      /** Сколько настроек задано в панели, а не взято из файла. */
      overridden: items.filter((i) => i.source === 'db').length,
      /** Сколько уже сохранено, но ещё не дошло до того, кто их читает. */
      pendingRestart: items.filter((i) => i.pendingRestart === true).length,
    },
  };
}

export async function adminServerSettingsRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;
  const settings = ctx.serverSettings;
  if (!settings) return;

  app.get('/server-settings', { preHandler: requireAdmin(app, 'serversettings.read') }, async () =>
    listDto(settings, ctx),
  );

  app.put<{ Params: { key: string } }>(
    '/server-settings/:key',
    { preHandler: requireAdmin(app, 'serversettings.write') },
    async (request) => {
      const { value } = putSchema.parse(request.body);
      const admin = currentAdmin(request);
      const { before, after } = await settings.set(request.params.key, value, admin.login);
      await audit(ctx, request, {
        action: 'serversettings.update',
        targetType: 'serversettings',
        targetLabel: after.spec.key,
        before: { value: before.raw, source: before.source },
        after: { value: after.raw, source: after.source },
      });
      return toDto(after, await appliedTimes(ctx));
    },
  );

  app.delete<{ Params: { key: string } }>(
    '/server-settings/:key',
    { preHandler: requireAdmin(app, 'serversettings.write') },
    async (request) => {
      const admin = currentAdmin(request);
      void admin;
      const { before, after } = await settings.reset(request.params.key);

      /*
       * СБРОС УБИРАЕТ СТРОКУ И ИЗ infra/.env.
       *
       * Без этого «вернуть к умолчанию» возвращало только показания
       * панели: значение уходило из базы, а строка в файле оставалась
       * навсегда, и служба продолжала подниматься с прежним. Поймано
       * живьём на потолке памяти: в панели 512 МБ, в процессе Node 768.
       *
       * Убираем строку, а не пишем в неё умолчание: значение тогда
       * берётся из умолчания в docker-compose.yml, и следов панели в
       * файле не остаётся.
       *
       * Отказ посредника здесь НЕ отменяет сброс: значение из базы уже
       * убрано, и это главное. Но и молчать нельзя — пишем в журнал, а
       * панель покажет «ждёт применения», как и для любой другой
       * настройки чужой службы.
       */
      const recreates = (after.spec.applies ?? []).filter((a) => a.action === 'recreate');
      if (recreates.length > 0 && ctx.serviceAgent?.configured === true) {
        for (const apply of recreates) {
          const target = findTarget(apply.target);
          if (!target) continue;
          try {
            await ctx.serviceAgent.unsetEnv(target, [after.spec.key]);
            await settings.clearEnvUnsetDebt([after.spec.key], apply.target);
          } catch (err) {
            /*
             * Долг записываем, а не надеемся вычислить потом.
             *
             * Догнать неубранную строку надо при ближайшем пересоздании
             * службы, и раньше «что убрать» вычислялось по признаку
             * «значение сейчас берётся из файла, а не из базы». Под него
             * попадает не только наш след, но и любая настройка,
             * прописанная в infra/.env руками: пересоздание ради одной
             * настройки молча стирало соседние (см. oweEnvUnset).
             */
            await settings.oweEnvUnset(after.spec.key, apply.target).catch(() => undefined);
            request.log.warn(
              { err, key: after.spec.key, service: apply.target },
              'Настройка сброшена в базе, но строку из infra/.env убрать не удалось',
            );
          }
        }
      }
      await audit(ctx, request, {
        action: 'serversettings.reset',
        targetType: 'serversettings',
        targetLabel: after.spec.key,
        before: { value: before.raw, source: before.source },
        after: { value: after.raw, source: after.source },
      });
      return toDto(after, await appliedTimes(ctx));
    },
  );

  /**
   * Сохранить несколько настроек разом — так их и правят: открыл раздел,
   * поменял три поля, нажал «Сохранить».
   *
   * Записи в журнал аудита — по одной на КАЖДУЮ изменившуюся настройку,
   * а не одна на нажатие кнопки. Иначе через полгода на вопрос «кто убрал
   * предел размера письма» журнал ответил бы «кто-то менял настройки»,
   * и пришлось бы разворачивать вложенный список внутри одной записи.
   *
   * Настройки, чьё значение не изменилось, не пишутся ни в базу, ни в
   * журнал: панель присылает форму целиком, и без этого каждое нажатие
   * «Сохранить» оставляло бы в журнале полсотни записей ни о чём.
   */
  app.post(
    '/server-settings/bulk',
    { preHandler: requireAdmin(app, 'serversettings.write') },
    async (request) => {
      const { values } = bulkSchema.parse(request.body);
      const keys = Object.keys(values);
      if (keys.length === 0) throw new BadRequestError('Не передано ни одной настройки.');
      if (keys.length > 200) throw new BadRequestError('За один раз — не больше 200 настроек.');
      const admin = currentAdmin(request);

      let changed = 0;
      for (const key of keys) {
        const incoming = values[key];
        if (incoming === null) {
          const current = await settings.resolve(key);
          if (current.source !== 'db') continue;
          const { before, after } = await settings.reset(key);
          changed += 1;
          await audit(ctx, request, {
            action: 'serversettings.reset',
            targetType: 'serversettings',
            targetLabel: key,
            before: { value: before.raw, source: before.source },
            after: { value: after.raw, source: after.source },
          });
          continue;
        }
        // Отказ по неизменяемому ключу — ДО сравнения значений: иначе
        // присланный в общей форме MAIL_DOMAIN с тем же значением молча
        // проглотился бы, и панель решила бы, что менять его можно.
        const spec = settings.specForWrite(key);
        const before = await settings.resolve(key);
        /*
         * Значение и так уже такое — не пишем ничего.
         *
         * Панель присылает форму целиком, и без этой проверки первое же
         * нажатие «Сохранить» закрепило бы в базе ВСЕ настройки разом.
         * Закрепление — не пустяк: закреплённая настройка перестаёт
         * следовать за infra/.env, то есть обновление продукта с новым
         * умолчанием прошло бы мимо неё. Закрепляться должно только то,
         * что человек действительно поменял.
         */
        if (parseSettingValue(spec, incoming) === before.raw) continue;
        const { after } = await settings.set(key, incoming, admin.login);
        changed += 1;
        await audit(ctx, request, {
          action: 'serversettings.update',
          targetType: 'serversettings',
          targetLabel: key,
          before: { value: before.raw, source: before.source },
          after: { value: after.raw, source: after.source },
        });
      }

      return { changed, ...(await listDto(settings, ctx)) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Перевыпуск секретов                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Что можно перевыпустить и чем это обернётся.
   *
   * Список отдаётся отдельно от настроек, потому что это не настройки:
   * значения у них нет и не будет — ни текущего, ни нового. Есть только
   * действие и его цена.
   */
  app.get(
    '/server-settings/secrets',
    { preHandler: requireAdmin(app, 'serversettings.write') },
    () => ({
      available: ctx.serviceAgent?.configured === true,
      secrets: ROTATABLE_SECRETS.map((item) => ({
        key: item.key,
        title: item.title,
        impact: item.impact,
        services: item.applies.map((apply) => apply.target),
      })),
    }),
  );

  app.post<{ Params: { key: string } }>(
    '/server-settings/secrets/:key/rotate',
    {
      preHandler: requireAdmin(app, 'serversettings.write'),
      // Перевыпуск пересоздаёт службы. Три за пять минут — это уже не
      // «поправил не тот», а что-то не то происходит.
      config: { rateLimit: { max: 3, timeWindow: 300_000 } },
    },
    async (request) => {
      const secret = findRotatable(request.params.key);
      if (!secret) {
        // Именно 400, а не 404: ключ мог существовать как настройка, но
        // не входить в закрытый список перевыпускаемых, и ответ должен
        // отличать «нет такого» от «этот — нельзя».
        throw new BadRequestError(
          `Секрет «${request.params.key}» не перевыпускается из панели. ` +
            'Перевыпускаются только те, разрыв которых стоит повторного входа, ' +
            'а не потери данных.',
        );
      }
      /*
       * Проверка, зависящая от настройки сервера, а не от самого секрета.
       *
       * Идёт ДО посредника и до генерации: отказ должен объяснять
       * причину, а не оставлять после себя новый секрет в файле.
       */
      const blocked = secret.guard?.(process.env);
      if (blocked !== undefined && blocked !== null) {
        throw new BadRequestError(blocked);
      }

      const agent = ctx.serviceAgent;
      if (!agent || !agent.configured) {
        throw new BadRequestError(
          'Перевыпуск требует посредника служб: новое значение пишется в infra/.env, ' +
            'а затем службы пересоздаются. Задайте SERVICE_AGENT_TOKEN и поднимите стек заново.',
        );
      }

      const value = generateSecret(secret.bytes);
      const admin = currentAdmin(request);

      /*
       * Сначала запись и пересоздание ПЕРВОЙ службы из списка, затем
       * остальные — без окружения (оно уже в файле).
       *
       * Порядок в списке не случайный: у общего секрета двух служб
       * первой идёт та, которая его ПРОВЕРЯЕТ (посредник очереди,
       * контроллер антиспама). Наоборот — гарантированный отказ на
       * несколько секунд: сервер приложения уже ходил бы с новым
       * секретом к службе, которая ещё живёт со старым.
       */
      const applied: string[] = [];
      let first = true;
      for (const step of secret.applies) {
        const target = findTarget(step.target);
        if (!target) continue;
        await agent.apply(target, step.action, first ? { [secret.key]: value } : {});
        applied.push(target.id);
        first = false;
      }

      /*
       * В журнал аудита — сам факт и затронутые службы. Значения нет
       * нигде: ни в ответе, ни в аудите, ни в журнале сервера. Аудит
       * читают из панели, а панель показывают на совещаниях.
       */
      await audit(ctx, request, {
        action: 'serversettings.secret.rotate',
        targetType: 'serversettings',
        targetLabel: secret.key,
        after: { services: applied, by: admin.login },
      });

      return { key: secret.key, services: applied };
    },
  );
}
