/**
 * Перезапуск служб из панели.
 *
 * ------------------------------------------------------------------
 * ДВА СОВЕРШЕННО РАЗНЫХ СЛУЧАЯ ЗА ОДНИМ ЭКРАНОМ
 * ------------------------------------------------------------------
 * 1. СЕБЯ сервер приложения перезапускает сам. Посредник ему не нужен:
 *    у контейнера стоит restart: unless-stopped, значит достаточно
 *    корректно завершиться — тем же SIGTERM, который и так закрывает
 *    запросы, IMAP и базу (см. self-restart.ts).
 *
 * 2. ОСТАЛЬНЫЕ службы — через посредника, у которого есть сокет Docker и
 *    закрытый список того, что ему разрешено (см. service-agent.ts и
 *    infra/service-agent/agent.pl).
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ОТВЕТ ВСЕГДА 202, А НЕ РЕЗУЛЬТАТ
 * ------------------------------------------------------------------
 * Потому что в первом случае ответить результатом физически невозможно:
 * сервер, который перезапускается, не может рассказать, чем это кончилось.
 * Делать два разных протокола — «здесь дождись ответа, а здесь опрашивай» —
 * значит завести в панели две ветки, из которых вторая проверяется редко и
 * ломается незаметно. Поэтому протокол один: заявка принимается, ей
 * выдаётся номер, итог кладётся в журнал перезапусков, панель опрашивает
 * его по номеру.
 *
 * Заявку по перезапуску сервера приложения закрывает НЕ тот процесс,
 * который её завёл: его уже нет. Её закрывает следующий, при старте
 * (markBoot в restart-store.ts). Это же и есть ответ на вопрос «сервер
 * поднялся?» — заявка закрыта, значит поднялся.
 *
 * ------------------------------------------------------------------
 * ОТКАЗ ВМЕСТО ТИШИНЫ
 * ------------------------------------------------------------------
 * Стек можно поднять без посредника — старым compose-файлом или без
 * секрета в infra/.env. Тогда список целей честно говорит про каждую
 * чужую службу «недоступно, вот почему» и печатает команду для консоли.
 * Кнопка, которая молча ничего не делает, хуже отсутствующей кнопки.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequestError } from '../../errors.js';
import { ConflictError } from '../errors.js';
import { audit, currentAdmin, requireAdmin } from '../guard.js';
import {
  actionTitle,
  consoleCommand,
  RESTART_TARGETS,
  resolveTarget,
  type RestartAction,
  type RestartTarget,
} from '../restart-targets.js';
import type { RestartRecord, RestartStore } from '../restart-store.js';
import { describeState, ServiceAgentUnavailableError } from '../service-agent.js';
import { settingsAppliedBy } from '../server-settings-registry.js';

const bodySchema = z.object({ action: z.enum(['restart', 'recreate']) });
/**
 * Что обновляем: свой код (git и пересборка) или базовые образы служб.
 * Третьего не бывает, и «на всякий случай обновить всё» здесь тоже нет —
 * это два разных по риску действия с разными кнопками.
 */
const updateSchema = z.object({ mode: z.enum(['code', 'images']) });
const idSchema = z.object({ id: z.string().regex(/^\d{1,19}$/) });

/**
 * Сколько минут заявка может висеть «идёт» до того, как её признают
 * брошенной. Дольше самого долгого разумного подъёма (Dovecot с большим
 * индексом) и заметно короче терпения человека перед экраном.
 */
const STALE_MINUTES = 5;

/** То, что умеет ServerSettings и нужно здесь. */
interface EnvSource {
  resolve(key: string): Promise<{ raw: string; source: string }>;
  envUnsetDebt(service: string): Promise<string[]>;
}

/**
 * Что уедет в infra/.env перед пересозданием службы.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗАПИСЫВАЕТСЯ
 * ------------------------------------------------------------------
 * Только заданное в панели (source = db). Без этого пересоздание
 * бессмысленно: новый контейнер получил бы прежнее окружение, а человек —
 * сохранённую настройку, которая не работает. Значения из самого файла
 * переписывать самими собой незачем, а умолчания продукта делать в файле
 * явными — не наше дело.
 *
 * ------------------------------------------------------------------
 * ЧТО УБИРАЕТСЯ — И ПОЧЕМУ НЕ ПО ДОГАДКЕ
 * ------------------------------------------------------------------
 * «Вернуть к умолчанию» обязано убрать строку и из файла: иначе панель
 * показывает умолчание, а служба поднимается с прежним значением
 * (поймано живьём на потолке памяти — в панели 512 МБ, в процессе Node
 * 768). Убирает строку посредник, и если в тот момент он недоступен,
 * уборку надо догнать при ближайшем пересоздании.
 *
 * Раньше «что догонять» вычислялось по признаку «значение берётся из
 * файла, а не из базы — значит его записала панель, а в базе его больше
 * нет». Признак неверный: под него попадает ЛЮБАЯ настройка, которую
 * человек прописал в infra/.env своей рукой и панелью никогда не трогал.
 *
 * Живой сценарий: администратор при установке прописал
 * GEOIP_LOGIN_POLICY=allow и список стран, полгода всё работало — и
 * первое же нажатие «Пересоздать» ради совершенно другой настройки молча
 * стирало обе строки, выключая защиту по стране. Ни предупреждения, ни
 * следа: с точки зрения панели ничего не менялось, значение «и так было
 * умолчанием».
 *
 * Отличить свой забытый след от чужой строки по содержимому файла нечем,
 * поэтому и не гадаем: долг ставится в момент неудачной уборки и гасится,
 * когда уборка удалась (см. ServerSettings.oweEnvUnset).
 */
export async function collectRecreateEnv(
  settings: EnvSource | null,
  service: string,
  action: RestartAction,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  if (action !== 'recreate' || settings === null) return env;

  for (const spec of settingsAppliedBy(service, 'recreate')) {
    const resolved = await settings.resolve(spec.key);
    if (resolved.source === 'db') env[spec.key] = resolved.raw;
  }
  const unset = await settings.envUnsetDebt(service);
  if (unset.length > 0) env.__unset = unset.join(',');
  return env;
}

function jobView(record: RestartRecord): Record<string, unknown> {
  return {
    id: record.id,
    service: record.service,
    action: record.action,
    requestedBy: record.requestedBy,
    requestedAt: record.requestedAt.toISOString(),
    finishedAt: record.finishedAt ? record.finishedAt.toISOString() : null,
    status: record.status,
    detail: record.detail,
  };
}

export async function adminRestartRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;
  const selfRestart = ctx.selfRestart;
  const agent = ctx.serviceAgent;
  /*
   * Журнал спрашивается у контекста при КАЖДОМ запросе, а не берётся
   * один раз при регистрации маршрутов. Разница не косметическая:
   * применённость миграции выясняется асинхронно, уже после того как
   * маршруты подключены (см. admin/index.ts), и запомненное здесь
   * значение навсегда осталось бы «журнала нет» — раздел отвечал бы 503
   * на живой базе с применённой миграцией.
   */
  const currentStore = (): RestartStore | null => ctx.restarts ?? null;

  /**
   * Журнал обязателен для протокола «заявка — опрос»: без него панели
   * некуда возвращаться за итогом. Без миграции раздел честно отвечает
   * 503 с командой её применить — ровно как это делают остальные разделы,
   * у которых своя таблица (перенос почты, история доставки).
   */
  function requireStore(): RestartStore {
    const store = currentStore();
    if (store === null) {
      throw new ServiceAgentUnavailableError(
        'Перезапуск из панели недоступен: не применена миграция ' +
          'infra/postgres/migrations/0001_baseline.sql. Без неё некуда записать, ' +
          'чем кончился перезапуск, а перезапускать вслепую нельзя.',
      );
    }
    return store;
  }

  /**
   * Посредник для действий обновления.
   *
   * Просмотр версии без посредника отвечает «недоступно и вот почему» —
   * там это уместно, раздел должен открываться. Действию же отвечать
   * нечем: обновление без посредника не сделать никак, и притворяться,
   * что кнопка нажалась, нельзя.
   */
  function requireAgent(): NonNullable<typeof ctx.serviceAgent> {
    const agent = ctx.serviceAgent;
    if (!agent?.configured) {
      throw new ServiceAgentUnavailableError(
        'Обновление из панели недоступно: не настроен посредник служб. На сервере ' +
          'это делается вручную: git -C /opt/mailtrue pull и пересборка стека.',
      );
    }
    return agent;
  }

  /* ---------------------------------------------------------------- */
  /* Что за версия стоит на сервере                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Обновления в продукте не было как явления.
   *
   * ------------------------------------------------------------------
   * ЧТО БЫЛО
   * ------------------------------------------------------------------
   * Отдельного скрипта обновления нет: обновиться можно только руками
   * по ssh — `git pull` и пересборка. Базовые образы (postgres, redis,
   * nginx, clamav) прибиты тегами, и свежие исправления безопасности
   * приезжают лишь при явном `pull`, которого не делает никто. Версии
   * продукта в панели тоже не видно.
   *
   * То есть сервер, поставленный полгода назад, крутит полугодовалый
   * nginx, а владелец об этом не узнает никак.
   *
   * Это ПЕРВЫЙ шаг: показать, что стоит сейчас и что уже скачано, но не
   * применено. Сами обновление и откат — отдельные действия с
   * подтверждением; смешивать их с просмотром нельзя.
   *
   * Право отдельное (`serversettings.read`): смотреть версию — не то же
   * самое, что перезапускать службы.
   */
  app.get('/version', { preHandler: requireAdmin(app, 'serversettings.read') }, async () => {
    const agent = ctx.serviceAgent;
    if (!agent?.configured) {
      return {
        available: false,
        reason:
          'Посредник служб не настроен, поэтому версию с сервера прочитать нечем. ' +
          'На сервере это показывает git -C /opt/mailtrue log -1.',
        version: null,
      };
    }
    try {
      return { available: true, reason: null, version: await agent.version() };
    } catch (err) {
      /*
       * Отказ посредника не должен ронять раздел: остальная панель
       * работает, и человеку нужно знать причину, а не пустой экран.
       */
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        version: null,
      };
    }
  });

  /**
   * Спросить репозиторий, есть ли что-то новое.
   *
   * Отдельно от просмотра: открытие раздела в сеть не ходит, а нажатие
   * кнопки — как раз просьба сходить. Право на чтение: fetch не меняет
   * ни одного файла продукта, он только скачивает в .git.
   */
  app.post('/version/check', { preHandler: requireAdmin(app, 'serversettings.read') }, async () => {
    const agent = requireAgent();
    return { available: true, reason: null, version: await agent.checkUpdates() };
  });

  /**
   * Запустить обновление.
   *
   * Право то же, что у перезапуска служб, и это не экономия на правах:
   * обновление и есть пересоздание всех служб разом, только с новым
   * кодом. Отдавать его тому, кому не доверили перезапуск одной службы,
   * было бы странно.
   *
   * Ответ приходит сразу: работа идёт в отдельном контейнере, который
   * переживает пересоздание и самого посредника, и сервера приложения.
   * Ход смотрится через GET /version/update.
   */
  app.post(
    '/version/update',
    { preHandler: requireAdmin(app, 'services.restart') },
    async (request, reply) => {
      const agent = requireAgent();
      const { mode } = updateSchema.parse(request.body);

      /*
       * Правки руками — стоп-кран. Обновление кода на таком сервере либо
       * упрётся в конфликт на середине, либо (если правки не мешают
       * слиянию) переедет вместе с ними в неизвестное состояние. Человеку
       * нужно сначала решить, что с ними делать, и это решение не
       * принимается кнопкой «обновить».
       *
       * Базовых образов это не касается: они не трогают рабочее дерево.
       */
      if (mode === 'code') {
        const version = await agent.version();
        if (version.dirty) {
          throw new ConflictError(
            'В каталоге сервера есть правки, сделанные руками. Обновление их затрёт ' +
              'или встанет с конфликтом. Перенесите их в репозиторий или отмените ' +
              '(git -C /opt/mailtrue status), затем повторите.',
          );
        }
      }

      await agent.startUpdate(mode);
      await audit(ctx, request, {
        action: 'server.update',
        targetType: 'server',
        targetLabel: mode === 'code' ? 'код продукта' : 'базовые образы',
        after: { mode },
      });
      return reply.code(202).send({ ok: true, mode });
    },
  );

  /** Ход обновления: состояние отдельного контейнера и его вывод. */
  app.get('/version/update', { preHandler: requireAdmin(app, 'serversettings.read') }, async () => {
    const agent = requireAgent();
    return agent.updateStatus();
  });

  /* ---------------------------------------------------------------- */
  /* Что вообще можно перезапустить                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Доступность считается ОДИН раз на весь список, а не на каждую цель:
   * посредник либо есть, либо его нет, и семь одинаковых запросов к нему
   * ради одного ответа — это семь запусков процесса на той стороне.
   */
  app.get('/restart', { preHandler: requireAdmin(app, 'services.restart') }, async () => {
    let agentOk = false;
    let agentError: string | null = null;
    if (agent?.configured) {
      try {
        const health = await agent.health();
        agentOk = health.ok && health.error === null;
        agentError = health.error;
      } catch (err) {
        agentOk = false;
        agentError = err instanceof Error ? err.message : String(err);
      }
    } else {
      agentError =
        'Посредник перезапуска не настроен: пуст SERVICE_AGENT_TOKEN или служба ' +
        'service-agent не поднята. Перезапуск сервера приложения при этом работает — ' +
        'ему посредник не нужен.';
    }

    // Брошенные заявки разбираем здесь, при открытии раздела: показывать
    // человеку вечное «перезапускаю» нельзя, а отдельный уборщик ради
    // редкого случая — лишняя движущаяся часть.
    const store = currentStore();
    if (store) await store.expireStale(STALE_MINUTES).catch(() => 0);

    const targets = RESTART_TARGETS.map((target) => {
      const selfHandled = target.self && selfRestart !== undefined;
      const available = selfHandled ? selfRestart.supervised : agentOk;
      return {
        id: target.id,
        title: target.title,
        actions: target.actions,
        self: target.self,
        impact: target.impact,
        downtime: target.downtime,
        safe: target.safe,
        available,
        /**
         * Почему нельзя — словами. Разное у сервера приложения (его
         * некому поднять обратно) и у остальных (нет посредника), и
         * сводить это к одному тексту нельзя: лечится оно по-разному.
         */
        unavailableReason: available
          ? null
          : selfHandled
            ? 'Сервер приложения запущен не в контейнере: после остановки поднять его ' +
              'будет некому.'
            : agentError,
        commands: Object.fromEntries(
          target.actions.map((action) => [action, consoleCommand(target, action)]),
        ),
      };
    });

    return {
      /** Метка процесса: по её смене панель узнаёт, что сервер уже новый. */
      bootId: selfRestart?.bootId ?? null,
      startedAt: selfRestart?.startedAt.toISOString() ?? null,
      restartPending: selfRestart?.pending ?? false,
      agent: { configured: agent?.configured ?? false, ok: agentOk, error: agentError },
      journal: store !== null,
      targets,
      jobs: store === null ? [] : (await store.recent(20)).map(jobView),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Заявка на перезапуск                                               */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { target: string } }>(
    '/restart/:target',
    { preHandler: requireAdmin(app, 'services.restart') },
    async (request, reply) => {
      const { action } = bodySchema.parse(request.body);
      /*
       * ЕДИНСТВЕННОЕ место, где имя службы попадает из запроса в код.
       * Дальше работаем с описанием из перечня, а не со строкой клиента:
       * не найденное имя отвергается здесь и до посредника не доезжает.
       */
      let target: RestartTarget & { action: RestartAction };
      try {
        target = resolveTarget(request.params.target, action);
      } catch (err) {
        throw new BadRequestError(err instanceof Error ? err.message : 'Неизвестная служба.');
      }
      const journal = requireStore();
      const admin = currentAdmin(request);

      const selfHandled = target.self && action === 'restart' && selfRestart !== undefined;
      if (selfHandled) {
        return await requestSelfRestart(target, journal, admin.login, request, reply);
      }
      return await requestViaAgent(target, action, journal, admin.login, request, reply);
    },
  );

  /** Перезапуск сервера приложения собой же. */
  async function requestSelfRestart(
    target: RestartTarget,
    journal: RestartStore,
    login: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const self = selfRestart;
    if (!self) throw new ConflictError('Перезапуск сервера приложения сейчас недоступен.');

    // Защита от петли спрашивается ДО записи заявки: отклонённая попытка
    // не должна оставлять в журнале след «перезапускали», которого не было.
    const decision = await self.decide();
    if (!decision.allowed) throw new ConflictError(decision.reason);

    const record = await journal.begin('api', 'restart', login);
    await audit(ctx, request, {
      action: 'service.restart',
      targetType: 'service',
      targetLabel: target.title,
      after: {
        service: 'api',
        action: 'restart',
        restartId: record.id,
        // Последствия пишем в журнал вместе с действием: через полгода
        // «перезапустил api» ничего не скажет, а «панель и веб-почта не
        // отвечали несколько секунд» скажет.
        impact: target.impact,
      },
    });

    self.schedule(`заявка ${record.id}, ${login}`);
    reply.code(202);
    return {
      id: record.id,
      service: 'api',
      action: 'restart',
      self: true,
      /**
       * Метка ЭТОГО процесса. Панель запоминает её и опрашивает сервер,
       * пока не увидит другую: только это доказывает, что перед ней уже
       * новый процесс, а не тот же самый, который задумался.
       */
      bootId: self.bootId,
      status: 'pending',
    };
  }

  /** Всё остальное — через посредника. */
  async function requestViaAgent(
    target: RestartTarget,
    action: RestartAction,
    journal: RestartStore,
    login: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    if (!agent?.configured) {
      throw new ServiceAgentUnavailableError(
        `Действие «${actionTitle(action)}» для службы «${target.title}» из панели ` +
          'недоступно: не настроен посредник. Сделать это в консоли: ' +
          consoleCommand(target, action),
      );
    }

    /*
     * Значения, которые обязаны попасть в infra/.env до пересоздания.
     *
     * Без них пересоздание бессмысленно: новый контейнер получил бы
     * прежнее окружение, а человек — сохранённую настройку, которая не
     * работает. Отправляем ТОЛЬКО то, что задано в панели (source = db):
     * значения из самого файла переписывать самими собой незачем, а
     * умолчания продукта в файле делать явными — не наше дело.
     */
    const env = await collectRecreateEnv(ctx.serverSettings ?? null, target.id, action);

    const record = await journal.begin(target.id, action, login);
    await audit(ctx, request, {
      action: action === 'recreate' ? 'service.recreate' : 'service.restart',
      targetType: 'service',
      targetLabel: target.title,
      after: {
        service: target.id,
        action,
        restartId: record.id,
        impact: target.impact,
        // Что именно уехало в infra/.env. Значения тут не секретны (в
        // списке посредника секретов нет вовсе), а без них запись
        // отвечала бы «пересоздали» и молчала бы о том, ради чего.
        env: Object.keys(env).length === 0 ? null : env,
      },
    });

    /*
     * Работу ведём ПОСЛЕ ответа. Пересоздание с ожиданием готовности
     * занимает десятки секунд, и держать на нём HTTP-запрос значит
     * гарантированно упереться в чей-нибудь таймаут — а хуже всего то,
     * что при пересоздании самого сервера приложения ответ не придёт
     * никогда: этот процесс к тому времени уже остановят.
     */
    void runInBackground(target, action, env, record, request);

    reply.code(202);
    return {
      id: record.id,
      service: target.id,
      action,
      self: false,
      bootId: selfRestart?.bootId ?? null,
      status: 'pending',
    };
  }

  async function runInBackground(
    target: RestartTarget,
    action: RestartAction,
    env: Record<string, string>,
    record: RestartRecord,
    request: FastifyRequest,
  ): Promise<void> {
    const journal = currentStore();
    if (!agent || journal === null) return;
    try {
      const state = await agent.apply(target, action, env);
      const detail = describeState(state);
      /*
       * Долг погашен: посредник строки из infra/.env убрал. Гасим ДО
       * проверки «поднялась ли служба» — файл он правит первым делом, и
       * не поднявшийся контейнер не повод просить убрать то же самое
       * ещё раз при следующем пересоздании.
       */
      const removed = (env.__unset ?? '').split(',').filter((key) => key !== '');
      if (removed.length > 0) {
        await ctx.serverSettings?.clearEnvUnsetDebt(removed, target.id).catch(() => undefined);
      }
      await journal.finish(record.id, state.up ? 'ok' : 'failed', detail);
      if (!state.up) {
        // Отдельная запись аудита: «служба не поднялась» — не то же
        // событие, что «администратор нажал кнопку», и искать его будут
        // первым.
        await audit(ctx, request, {
          action: 'service.failed',
          targetType: 'service',
          targetLabel: target.title,
          after: { service: target.id, action, restartId: record.id, detail },
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await journal.finish(record.id, 'failed', detail).catch(() => undefined);
      app.deps.logger.error({ err, service: target.id, action }, 'Перезапуск службы не удался');
      await audit(ctx, request, {
        action: 'service.failed',
        targetType: 'service',
        targetLabel: target.title,
        after: { service: target.id, action, restartId: record.id, detail },
      }).catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Чем кончилось                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Опрашивается панелью раз в секунду, пока идёт перезапуск. Отдельный
   * лёгкий маршрут, а не общий список: во время перезапуска сервера
   * приложения этот запрос — первый, который до него доходит, и тащить
   * ради него опрос посредника было бы лишним.
   */
  app.get<{ Params: { id: string } }>(
    '/restart/jobs/:id',
    { preHandler: requireAdmin(app, 'services.restart') },
    async (request) => {
      const { id } = idSchema.parse(request.params);
      const journal = requireStore();
      await journal.expireStale(STALE_MINUTES).catch(() => 0);
      const record = await journal.byId(id);
      if (!record) throw new BadRequestError(`Заявки на перезапуск №${id} нет.`);
      return {
        ...jobView(record),
        /** Та же метка, что и в ответе на заявку: сменилась — сервер новый. */
        bootId: selfRestart?.bootId ?? null,
      };
    },
  );
}
