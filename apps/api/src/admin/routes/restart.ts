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
const idSchema = z.object({ id: z.string().regex(/^\d{1,19}$/) });

/**
 * Сколько минут заявка может висеть «идёт» до того, как её признают
 * брошенной. Дольше самого долгого разумного подъёма (Dovecot с большим
 * индексом) и заметно короче терпения человека перед экраном.
 */
const STALE_MINUTES = 5;

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
    const env: Record<string, string> = {};
    /*
     * И отдельно — ключи, которые надо УБРАТЬ из infra/.env.
     *
     * «Вернуть к умолчанию» убирало значение из базы, а строка в файле
     * оставалась навсегда: панель показывала умолчание продукта, сервер
     * работал с прежним значением. Поймано живьём — сброс потолка памяти
     * вернул в панели 512 МБ, а контейнер поднялся с 768 из файла.
     *
     * Убираем строку, а не пишем в неё умолчание: тогда значение берётся
     * оттуда, откуда и должно, — из умолчания в docker-compose.yml, и в
     * файле не остаётся следов панели там, где человек их не просил.
     */
    const unset: string[] = [];
    if (action === 'recreate' && ctx.serverSettings) {
      for (const spec of settingsAppliedBy(target.id, 'recreate')) {
        const resolved = await ctx.serverSettings.resolve(spec.key);
        if (resolved.source === 'db') env[spec.key] = resolved.raw;
        // Значение пришло из файла, хотя настройкой управляет панель, —
        // значит его туда записала она же, а в базе его больше нет.
        else if (resolved.source === 'env') unset.push(spec.key);
      }
    }
    if (unset.length > 0) env.__unset = unset.join(',');

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
