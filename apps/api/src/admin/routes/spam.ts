/**
 * Раздел «Антиспам»: что фильтр сделал, по каким спискам и как это изменить.
 *
 * ------------------------------------------------------------------
 * ПРАВА
 * ------------------------------------------------------------------
 * Смотреть — overview.read: это состояние сервера, и дежурному «только
 * чтение» вопрос «почему письмо Иванова ушло в спам» задают чаще всех.
 *
 * Менять списки — domains.write, то есть право владельца. Причина не в
 * осторожности вообще, а в том, ЧТО делает запись в список: она меняет
 * приём почты для ВСЕГО сервера и для всех ящиков разом. Внести домен в
 * запрещённые — то же по последствиям, что выключить приём от целой
 * организации; внести в разрешённые — снять проверку с того, кем легко
 * прикинуться. Это ровно тот же вес, что у настроек домена, поэтому и
 * право то же, а не новое.
 *
 * Обучение — users.write, то есть управление пользователями. Обучение
 * тоже действует на всех, но это ежедневная работа разбора обращений
 * («это не спам, верните»), и требовать ради неё учётную запись владельца
 * значило бы либо раздать полный доступ дежурным, либо не обучать фильтр
 * вовсе. Второе хуже: необученный байесов классификатор — это ложные
 * срабатывания, с которыми потом придут те же люди.
 *
 * ------------------------------------------------------------------
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ
 * ------------------------------------------------------------------
 * Изменения порогов. Управляющий интерфейс rspamd на этой сборке его не
 * даёт (подробно — в rspamd.ts), а если бы давал, писал бы пороги в
 * отдельный скрытый файл поверх infra/rspamd/local.d/actions.conf — и
 * правка actions.conf молча переставала бы действовать. Ложной кнопки
 * «сохранить» в разделе нет намеренно.
 *
 * Но одного «нельзя» мало: раньше пороги отдавались голыми числами, и
 * раздел получался бесполезным — четыре плитки, про которые непонятно ни
 * что они делают, ни куда их двигать. Поэтому появился отдельный ответ
 * GET /spam/thresholds: он объясняет каждый рубеж, показывает пороги ОБОИХ
 * профилей (общий и «свой аутентифицированный отправитель», второй —
 * измерением), ищет противоречия между порогами и печатает точный путь и
 * команду для правки. Подробности — в spam-thresholds.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../../errors.js';
import { audit, requireAdmin } from '../guard.js';
import { withMapLock } from '../map-edit.js';
import {
  addMapEntry,
  parseMapEntries,
  removeMapEntry,
  RspamdClient,
  RspamdUnavailableError,
  senderFromMessage,
  topSymbols,
} from '../rspamd.js';
import { checkEntry, findSpamList, matchMapId, SPAM_LISTS } from '../spam-lists.js';
import { queryFlag } from './logs.js';
import { spamOf, SpamStore } from '../spam-store.js';
import {
  describeThresholds,
  thresholdProbeMessage,
  thresholdWarnings,
} from '../spam-thresholds.js';

const windowSchema = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24),
});

const entrySchema = z.object({
  value: z.string().trim().min(1).max(320),
  /** Зачем — попадает в журнал аудита рядом с самой записью. */
  note: z.string().trim().max(200).optional(),
});

const learnSchema = z.object({
  kind: z.enum(['spam', 'ham']),
  /**
   * Письмо целиком, с заголовками. Предел в мегабайт: обучение смотрит на
   * текст и заголовки, а не на вложения, и мегабайта хватает с запасом.
   */
  message: z
    .string()
    .min(20)
    .max(1024 * 1024),
});

const checkSchema = z.object({
  message: z
    .string()
    .min(20)
    .max(1024 * 1024),
  /**
   * От чьего имени проверять. «Свой» означает аутентифицированного
   * отправителя: у него и пороги, и набор проверок другие
   * (infra/rspamd/local.d/settings.conf), и без этого выбора раздел
   * показывал бы оценку, которой в жизни не бывает.
   */
  as: z.enum(['outside', 'own']).default('outside'),
});

/** Понятные названия решений rspamd. */
const ACTION_TITLES: Readonly<Record<string, string>> = {
  reject: 'Отклонено при приёме',
  'add header': 'Помечено как спам',
  'rewrite subject': 'Изменена тема',
  greylist: 'Отложено (серый список)',
  'soft reject': 'Временный отказ',
  'no action': 'Пропущено',
};

export function actionTitle(action: string): string {
  return ACTION_TITLES[action] ?? action;
}

export async function adminSpamRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;
  const { config: apiConfig } = app.deps;
  const store = new SpamStore(ctx.db);
  const rspamd =
    ctx.rspamd ??
    new RspamdClient({
      host: ctx.config.RSPAMD_HOST,
      port: ctx.config.RSPAMD_CONTROLLER_PORT,
      password: ctx.config.RSPAMD_PASSWORD,
    });

  /** Карта по имени файла или понятный отказ. */
  const mapIdOf = async (file: string): Promise<number> => {
    const maps = await rspamd.maps();
    const id = matchMapId(maps, file);
    if (id === null) {
      throw new NotFoundError(
        `Антиспам не знает карты ${file}. Проверьте infra/rspamd/local.d/multimap.conf ` +
          'и что каталог maps.d примонтирован в контейнер rspamd',
      );
    }
    return id;
  };

  /**
   * Запись карты с объяснением самого вероятного отказа.
   *
   * Пишет файл сам rspamd (см. rspamd.ts), а работает он от пользователя
   * _rspamd — тогда как файлы карт приезжают из репозитория с владельцем
   * root. Если владельца не поправили при запуске контейнера
   * (infra/rspamd/entrypoint.sh), запись упирается в права, и rspamd
   * отвечает пятисоткой без внятного текста. Администратор при этом видел
   * бы «ответил 500» и не имел ни малейшего представления, что чинить.
   */
  const writeMap = async (mapId: number, text: string, file: string): Promise<void> => {
    try {
      await rspamd.saveMap(mapId, text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (/permission|denied|read.?only|EACCES/iu.test(reason)) {
        throw new RspamdUnavailableError(
          `Антиспам не смог записать файл ${file}: не хватает прав. Каталог ` +
            'infra/rspamd/maps.d должен принадлежать пользователю _rspamd внутри контейнера ' +
            `(это делает infra/rspamd/entrypoint.sh при запуске). Ответ rspamd: ${reason}`,
        );
      }
      throw err;
    }
  };

  /* ---------------------------------------------------------------- */
  /* Сводка                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Всё, что нужно для верхней части экрана, одним ответом.
   *
   * Одним, а не пятью, в отличие от дашборда: здесь все источники дешёвые
   * (три запроса к rspamd по локальной сети и два лёгких к базе), и делить
   * их значило бы городить пять состояний загрузки ради десятка
   * миллисекунд.
   */
  app.get('/spam/overview', { preHandler: requireAdmin(app, 'overview.read') }, async (request) => {
    const q = windowSchema.parse(request.query);
    const to = new Date();
    const from = new Date(to.getTime() - q.hours * 3600_000);

    const schemaReady = await store.schemaReady();
    const [period, manual, collectingSince] = await Promise.all([
      schemaReady ? store.totals(from, to) : null,
      /*
       * Отказ считается ОТСУТСТВИЕМ ЧИСЛА, а не нулём.
       *
       * Здесь стоял `catch(() => ({ spam: 0, ham: 0 }))`: недоступная база
       * превращалась в честный на вид ноль, и плитка «обучений вручную»
       * показывала «0» — то есть отвечала «фильтр никто не обучал» там,
       * где ответа не знает никто. Соседние числа при отказе базы честно
       * пропадают (schemaReady), это единственное выбивалось.
       */
      store.manualLearns(from, to).catch(() => null),
      schemaReady ? store.collectingSince() : null,
    ]);

    let live: {
      version: string;
      uptimeSeconds: number;
      scanned: number;
      learned: number;
      actions: Record<string, number>;
      bayes: Array<{ symbol: string; type: string; revision: number }>;
    } | null = null;
    let symbols: Array<{ symbol: string; weight: number; hits: number }> = [];
    let unavailable: string | null = null;

    try {
      // Порогов здесь больше нет: они целиком переехали в /spam/thresholds
      // вместе с объяснением каждого. Держать их в двух ответах значило бы
      // однажды разойтись формулировками про одно и то же число.
      const [stat, counters] = await Promise.all([rspamd.stat(), rspamd.counters()]);
      live = {
        version: stat.version,
        uptimeSeconds: stat.uptimeSeconds,
        scanned: stat.scanned,
        learned: stat.learned,
        actions: stat.actions,
        bayes: stat.statfiles.map((f) => ({
          symbol: f.symbol,
          type: f.type,
          revision: f.revision,
        })),
      };
      symbols = topSymbols(counters, 20).map((c) => ({
        symbol: c.symbol,
        weight: c.weight,
        hits: c.hits,
      }));
    } catch (err) {
      unavailable = err instanceof RspamdUnavailableError ? err.message : (err as Error).message;
    }

    return {
      hours: q.hours,
      /** Отвечает ли антиспам прямо сейчас. */
      available: live !== null,
      unavailable,
      live,
      /** Разность счётчиков за окно; null — таблицы снимков в базе нет. */
      period: period
        ? {
            ...period,
            spam: spamOf(period),
            /** Доля спама от проверенного, проценты с одним знаком. */
            spamPercent:
              period.scanned > 0 ? Math.round((spamOf(period) / period.scanned) * 1000) / 10 : null,
          }
        : null,
      periodNote: schemaReady
        ? 'Числа «за период» считаются по снимкам счётчиков rspamd: сам он хранит только ' +
          'значения с момента запуска, и после перезапуска они обнуляются'
        : /*
           * Имя файла здесь называть НЕЛЬЗЯ: 0022_rspamd_stats.sql лежит
           * в legacy/ и в применяемый набор не входит — таблица снимков
           * давно живёт в 0001_baseline.sql. Администратор шёл искать
           * файл, которого в каталоге миграций нет, и делал вывод, что
           * установка сломана. Называем действие, а не файл.
           */
          'История за период недоступна: в базе нет таблицы снимков счётчиков. ' +
          'Примените миграции (install/apply-migrations.sh) и обновите страницу. ' +
          'Состояние «прямо сейчас» показывается и без неё',
      collectingSince,
      /**
       * Обучение из панели — по журналу аудита, а не по счётчику rspamd.
       * `null` — прочитать не удалось; ноль и «неизвестно» на экране
       * должны выглядеть по-разному.
       */
      manualLearns: manual,
      symbols,
      symbolsNote:
        'Срабатывания правил считает сам rspamd — с момента запуска процесса, а не за ' +
        'выбранный период. Правила с нулём срабатываний скрыты: их около полутора тысяч',
      /**
       * Честная оговорка про самозагрязнение: панель сама проверяет письмами
       * подпись DKIM (см. services.ts), и эти проверки тоже попадают в
       * счётчики. На тихом сервере это заметная доля.
       */
      selfProbeNote:
        'В счётчики попадают и служебные проверки самой панели: раздел «Дашборд» на каждом ' +
        'открытии проверяет подпись исходящих пробным письмом',
    };
  });

  /* ---------------------------------------------------------------- */
  /* Последние проверенные письма                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Право то же, что у журналов почты и письма из очереди
   * (mailbox.impersonate): здесь видны отправитель, получатели и ТЕМА
   * письма — то есть чужая переписка, а не сводка о ней.
   */
  app.get(
    '/spam/history',
    { preHandler: requireAdmin(app, 'mailbox.impersonate') },
    async (request) => {
      const q = z
        .object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          /*
           * Показывать только то, что фильтр счёл спамом.
           *
           * Через общий queryFlag, а не z.coerce.boolean: тот превращает
           * строку «false» из запроса в ИСТИНУ (непустая строка), и
           * флажок стоял включённым при любом положении — в истории
           * показывался только спам, а искали в ней обычно потерявшееся
           * ЧИСТОЕ письмо. Тот же дефект уже дважды ловили в списке
           * писем и в журналах служб.
           */
          spamOnly: queryFlag,
        })
        .parse(request.query);
      /*
       * ЗАПИСЬ В ЖУРНАЛ — ДО ПОКАЗА, А НЕ ПОСЛЕ И НЕ «КОГДА-НИБУДЬ».
       *
       * Здесь видно отправителя, получателей и ТЕМУ письма, то есть чужую
       * переписку. Право поднято до mailbox.impersonate именно поэтому —
       * а следа не оставалось никакого: администратор мог читать, о чём
       * переписывается любой сотрудник, и по журналу это было не отличить
       * от бездействия. Соседний маршрут (письмо из очереди) пишет запись
       * с самого начала, и она закреплена проверкой; здесь её просто
       * забыли.
       *
       * Пишем ДО обращения к rspamd: отказ сервиса не повод потерять
       * запись о самом обращении.
       */
      await audit(ctx, request, {
        action: 'spam.history',
        targetType: 'antispam',
        targetLabel: 'Последние письма',
        after: { limit: q.limit, spamOnly: q.spamOnly },
      });
      try {
        const rows = await rspamd.history();
        const filtered = q.spamOnly
          ? rows.filter((r) => r.action === 'reject' || r.action === 'add header')
          : rows;
        return {
          available: true,
          note:
            'История живёт в памяти процесса rspamd: она короткая и обнуляется при ' +
            'перезапуске. Долгую историю доставки ведёт раздел «Почтовый поток»',
          total: rows.length,
          items: filtered.slice(0, q.limit).map((row) => ({
            at: row.at,
            action: row.action,
            actionTitle: actionTitle(row.action),
            score: row.score,
            requiredScore: row.requiredScore,
            subject: row.subject,
            sender: row.sender,
            /*
             * Получателей и адрес отправителя экран не показывает — и
             * отдавать их незачем: это чужая переписка, а лишнее поле в
             * ответе однажды окажется в чьём-то журнале доступа или в
             * снимке экрана. Понадобятся — вернутся вместе с колонкой,
             * которая их показывает.
             */
            user: row.user,
            sizeBytes: row.sizeBytes,
            // Пять самых весомых: полный список у иного письма — сорок
            // строк, и ответ «почему спам» в них теряется.
            symbols: row.symbols.slice(0, 5),
          })),
        };
      } catch (err) {
        return {
          available: false,
          note: err instanceof Error ? err.message : String(err),
          total: 0,
          items: [],
        };
      }
    },
  );

  /* ---------------------------------------------------------------- */
  /* Пороги                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Пороги с объяснением: что происходит на каждом рубеже и чем грозит сдвиг.
   *
   * Отдельным запросом, а не частью сводки, ровно по одной причине: здесь
   * есть ИЗМЕРЕНИЕ. Чтобы узнать пороги профиля «свой отправитель», надо
   * прогнать через rspamd пробное письмо, а это лишняя проверка в его
   * счётчиках. В сводке она делалась бы при каждом открытии раздела и на
   * каждое переключение периода; здесь — только когда человек открыл
   * вкладку «Пороги», то есть когда за неё есть чем платить.
   *
   * Право — overview.read: числа ничего не раскрывают о переписке, а
   * вопрос «почему письмо ушло в спам» задают в первую очередь дежурному.
   */
  app.get('/spam/thresholds', { preHandler: requireAdmin(app, 'overview.read') }, async () => {
    let common: Record<string, number | null> = {};
    let unavailable: string | null = null;
    try {
      common = await rspamd.actions();
    } catch (err) {
      unavailable = err instanceof RspamdUnavailableError ? err.message : (err as Error).message;
    }

    /*
     * Пороги своих отправителей — измерением, потому что иначе никак:
     * профили настроек (infra/rspamd/local.d/settings.conf) контроллер не
     * показывает. Отказ измерения не должен ронять весь ответ: общие
     * пороги — главное, ради чего сюда пришли, и терять их из-за неудачной
     * пробы нельзя.
     */
    let own: Record<string, number | null> = {};
    let ownProblem: string | null = unavailable;
    if (unavailable === null) {
      const probeSender = `postmaster@${ctx.config.MAIL_DOMAIN}`;
      try {
        const verdict = await rspamd.check(thresholdProbeMessage(ctx.config.MAIL_DOMAIN), {
          ip: '127.0.0.1',
          from: probeSender,
          rcpt: probeSender,
          // Аутентифицированного отправителя rspamd узнаёт по заголовку
          // User — именно по нему срабатывает профиль own_users.
          user: probeSender,
        });
        own = verdict.thresholds;
      } catch (err) {
        ownProblem = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      available: unavailable === null,
      unavailable,
      /**
       * Два профиля, а не один набор чисел. Раньше раздел показывал только
       * общие пороги, и на вопрос «почему письмо нашего сотрудника не
       * ушло в спам, хотя набрало восемь баллов» ответить по экрану было
       * нельзя: у своих отправителей порог другой, и об этом нигде не
       * говорилось.
       */
      profiles: [
        {
          id: 'common',
          title: 'Письма извне',
          note:
            'Общие пороги: действуют на всю почту, приходящую из интернета. Заданы в ' +
            'infra/rspamd/local.d/actions.conf.',
          items: describeThresholds(common),
          warnings: thresholdWarnings(common),
          measured: false,
          problem: unavailable,
        },
        {
          id: 'own',
          title: 'Письма своих аутентифицированных отправителей',
          note:
            'Для писем, отправленных через submission с логином и паролем, пороги свои — ' +
            'заметно мягче, и часть внешних проверок для них не выполняется вовсе ' +
            '(infra/rspamd/local.d/settings.conf). Чтобы письмо сотрудника не уехало в спам ' +
            'из-за форматирования.',
          items: describeThresholds(own),
          warnings: thresholdWarnings(own),
          /** Измерено пробным письмом, а не прочитано у контроллера. */
          measured: ownProblem === null,
          problem: ownProblem,
        },
      ],
      /**
       * Прямой ответ на «почему нельзя нажать и сохранить». Не отговорка:
       * ниже стоит ровно то, что надо сделать вместо кнопки.
       */
      editable: false,
      whyReadonly:
        'Пороги из панели не записываются, и это не осторожность, а отсутствие места для ' +
        'записи. Контроллер rspamd сохраняет пороги только при настроенном dynamic_conf, ' +
        'которого в сборке нет; а если бы он был, пороги легли бы в отдельный файл ПОВЕРХ ' +
        'actions.conf — и правка самого actions.conf молча перестала бы действовать. Сам ' +
        'файл серверу приложения недоступен: каталог local.d примонтирован в контейнер ' +
        'rspamd только на чтение. Списки ниже правятся именно потому, что их пишет сам ' +
        'rspamd по своему запросу; у порогов такого механизма нет.',
      howTo: {
        file: 'infra/rspamd/local.d/actions.conf',
        format: 'reject = 15;   add_header = 6;   greylist = null;',
        command: 'docker compose -f infra/docker-compose.yml kill -s HUP rspamd',
        note:
          'Формат строгий: «имя = значение;», по одному порогу на строку. null означает ' +
          '«действие выключено». Перезапуск не нужен — сигнал HUP применяет правку без ' +
          'простоя, почта в этот момент не теряется.',
      },
      probeNote:
        'Пороги своих отправителей измеряются пробным письмом при каждом открытии этой ' +
        'вкладки: другого способа их узнать у панели нет. Письмо никуда не доставляется и ' +
        'ничему не обучает, но в счётчик проверенных писем попадает.',
      scaleNote:
        'Баллы складываются из всех сработавших правил: проверок подписи и репутации, ' +
        'внешних списков, ваших списков ниже и обученного классификатора. Обычное деловое ' +
        'письмо со ссылками и картинками набирает 2–4 балла — поэтому порог пометки ниже ' +
        'четырёх опасен даже на самом спокойном сервере.',
    };
  });

  /* ---------------------------------------------------------------- */
  /* Списки                                                             */
  /* ---------------------------------------------------------------- */

  app.get('/spam/lists', { preHandler: requireAdmin(app, 'overview.read') }, async () => {
    let maps: Array<{ id: number; uri: string }> = [];
    let unavailable: string | null = null;
    try {
      maps = await rspamd.maps();
    } catch (err) {
      unavailable = err instanceof Error ? err.message : String(err);
    }

    const items = await Promise.all(
      SPAM_LISTS.map(async (spec) => {
        const id = unavailable === null ? matchMapId(maps, spec.file) : null;
        let entries: string[] = [];
        let problem: string | null = unavailable;
        if (id !== null) {
          try {
            entries = parseMapEntries(await rspamd.getMap(id));
          } catch (err) {
            problem = err instanceof Error ? err.message : String(err);
          }
        } else if (problem === null) {
          problem = `Карта ${spec.file} не подключена в multimap.conf`;
        }
        return {
          id: spec.id,
          title: spec.title,
          tone: spec.tone,
          value: spec.value,
          symbol: spec.symbol,
          score: spec.score,
          editable: spec.editable,
          hint: spec.hint,
          // Зачем список нужен и пример записи: без них пустая таблица
          // говорит человеку только «здесь ничего нет».
          purpose: spec.purpose,
          example: spec.example,
          file: spec.file,
          entries,
          problem,
        };
      }),
    );

    return {
      available: unavailable === null,
      unavailable,
      items,
      note:
        'Списки лежат в файлах infra/rspamd/maps.d и переписываются самим rspamd по запросу ' +
        'панели — копии в базе нет намеренно. Изменение действует в течение десяти секунд ' +
        '(map_watch_interval), перезапуск не нужен',
    };
  });

  /** Добавить запись. */
  app.post(
    '/spam/lists/:id/entries',
    { preHandler: requireAdmin(app, 'domains.write') },
    async (request) => {
      const { id } = z.object({ id: z.string().trim().max(64) }).parse(request.params);
      const body = entrySchema.parse(request.body);
      const spec = findSpamList(id);
      if (!spec) throw new NotFoundError(`Списка «${id}» нет`);
      if (!spec.editable) {
        throw new BadRequestError(`Список «${spec.title}» правится не из панели: ${spec.hint}`);
      }
      const check = checkEntry(spec.value, body.value);
      if (!check.ok) throw new BadRequestError(check.problem);

      /*
       * Чтение, изменение и запись — под очередью по этой карте.
       *
       * Копии в базе нет намеренно: источник истины — файл, который
       * переписывает сам rspamd, и правка означает «прочитать целиком,
       * дописать строку, записать целиком». Две такие правки внахлёст
       * (а раздел используют вдвоём — см. ниже про четыре руки) молча
       * теряют одну из записей: панель отвечает «готово», в журнале
       * аудита стоит добавление, а письма от адреса продолжают идти.
       */
      const outcome = await withMapLock(spec.file, async () => {
        const mapId = await mapIdOf(spec.file);
        const before = await rspamd.getMap(mapId);
        const beforeEntries = parseMapEntries(before);
        if (beforeEntries.some((line) => line.toLowerCase() === check.value)) {
          // Не ошибка: повторное добавление того же адреса — обычное дело
          // при разборе обращения в четыре руки. Ответ честно говорит, что
          // ничего не изменилось, и запись в аудит не делается.
          return { changed: false, entries: beforeEntries };
        }
        await writeMap(mapId, addMapEntry(before, check.value), spec.file);
        /*
         * Список в ответе — ПЕРЕЧИТАННЫЙ, а не своя версия текста.
         * Своя версия говорит лишь «что мы намеревались записать», и на
         * ней ответ выглядел бы одинаково и при удавшейся записи, и при
         * записи, которую rspamd принял и отбросил.
         */
        return { changed: true, entries: parseMapEntries(await rspamd.getMap(mapId)) };
      });

      if (!outcome.changed) return { ok: true, changed: false, entries: outcome.entries };

      await audit(ctx, request, {
        action: 'antispam.list.add',
        targetType: 'antispam',
        targetLabel: `${spec.title}: ${check.value}`,
        after: {
          list: spec.id,
          value: check.value,
          symbol: spec.symbol,
          score: spec.score,
          ...(body.note ? { note: body.note } : {}),
        },
      });
      return { ok: true, changed: true, entries: outcome.entries };
    },
  );

  /**
   * Убрать запись.
   *
   * Значение приходит строкой запроса, а не частью пути: в записях бывают
   * косые черты (подсеть 203.0.113.0/24), а закодированная косая черта в
   * пути — источник расхождений между прокси и сервером приложения.
   */
  app.delete(
    '/spam/lists/:id/entries',
    { preHandler: requireAdmin(app, 'domains.write') },
    async (request) => {
      const { id } = z.object({ id: z.string().trim().max(64) }).parse(request.params);
      const { value } = z.object({ value: z.string().trim().min(1).max(320) }).parse(request.query);
      const spec = findSpamList(id);
      if (!spec) throw new NotFoundError(`Списка «${id}» нет`);
      if (!spec.editable) {
        throw new BadRequestError(`Список «${spec.title}» правится не из панели: ${spec.hint}`);
      }

      const target = value.toLowerCase();
      // Под той же очередью, что и добавление: удаление внахлёст с
      // добавлением воскресило бы убранный адрес или потеряло новый.
      const outcome = await withMapLock(spec.file, async () => {
        const mapId = await mapIdOf(spec.file);
        const before = await rspamd.getMap(mapId);
        const beforeEntries = parseMapEntries(before);
        if (!beforeEntries.some((line) => line.toLowerCase() === target)) {
          return { changed: false, entries: beforeEntries };
        }
        await writeMap(mapId, removeMapEntry(before, target), spec.file);
        return { changed: true, entries: parseMapEntries(await rspamd.getMap(mapId)) };
      });

      if (!outcome.changed) return { ok: true, changed: false, entries: outcome.entries };

      await audit(ctx, request, {
        action: 'antispam.list.remove',
        targetType: 'antispam',
        targetLabel: `${spec.title}: ${target}`,
        before: { list: spec.id, value: target, symbol: spec.symbol },
        after: null,
      });
      return { ok: true, changed: true, entries: outcome.entries };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Проверка письма и обучение                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Прогнать письмо через фильтр, ничего с ним не делая.
   *
   * Отвечает на единственный вопрос, с которым в этот раздел приходят:
   * «почему это письмо ушло в спам». Заодно показывает пороги, применённые
   * ИМЕННО К ЭТОМУ письму, — другого способа увидеть пороги профилей
   * настроек у панели нет.
   *
   * Право — users.write: проверка ничего не меняет, но письмо в теле
   * запроса чужое, и делать её доступной «только чтению» незачем.
   */
  app.post('/spam/check', { preHandler: requireAdmin(app, 'users.write') }, async (request) => {
    const body = checkSchema.parse(request.body);
    const own = body.as === 'own';
    const domain = ctx.config.MAIL_DOMAIN;
    /*
     * Отправитель конверта берётся ИЗ ПИСЬМА, а не подставляется служебным
     * адресом. Rspamd судит об отправителе по конверту, и с постоянной
     * подстановкой правила по отправителю — то есть ровно те списки,
     * которые правят на этом же экране, — не срабатывали бы никогда.
     * Проверено на стенде: письмо с домена из чёрного списка набирало
     * 11,8 балла БЕЗ символа BLACKLIST_SENDER_DOMAIN.
     */
    const sender = senderFromMessage(body.message) ?? `probe@example.org`;
    const verdict = await rspamd.check(body.message, {
      // «Свой» отправитель — это тот, кто прошёл аутентификацию на
      // submission; его rspamd узнаёт по заголовку User, а не по адресу.
      ip: own ? '127.0.0.1' : '203.0.113.10',
      from: sender,
      rcpt: `postmaster@${domain}`,
      ...(own ? { user: sender } : {}),
    });
    return {
      as: body.as,
      sender,
      score: verdict.score,
      action: verdict.action,
      actionTitle: actionTitle(verdict.action),
      thresholds: verdict.thresholds,
      symbols: verdict.symbols,
      note:
        `Проверено как письмо от ${sender} — адрес взят из заголовка From, потому что ` +
        'именно по отправителю конверта работают списки. Письмо никуда не доставляется и ' +
        'ничему не обучает, но в счётчик проверенных попадает',
    };
  });

  /**
   * Обучить фильтр на письме.
   *
   * Пишется в аудит обязательно, и не для порядка: обучение действует на
   * ВСЕХ пользователей сервера и откатывается только обратным обучением.
   * Ошибочно скормленное как спам письмо от партнёра будет годами
   * подталкивать в спам всю похожую переписку, и единственный способ
   * найти виновника — журнал.
   */
  app.post('/spam/learn', { preHandler: requireAdmin(app, 'users.write') }, async (request) => {
    const body = learnSchema.parse(request.body);
    try {
      await rspamd.learn(body.kind, body.message);
    } catch (err) {
      // Самая частая осечка обучения — слишком короткое письмо: байесову
      // классификатору нужно не меньше одиннадцати различных слов. Ответ
      // rspamd про «tokens» человеку ничего не говорит.
      const text = err instanceof Error ? err.message : String(err);
      if (text.includes('tokens')) {
        throw new BadRequestError(
          'Письмо слишком короткое для обучения: классификатору нужно хотя бы десяток ' +
            'разных слов. Возьмите письмо целиком, вместе с заголовками',
        );
      }
      if (text.includes('already learned')) {
        throw new BadRequestError('Это письмо уже использовалось для обучения');
      }
      throw err;
    }

    // В журнал попадают тема и отправитель, но НЕ тело письма: чужая
    // переписка не должна оседать в базе целиком ради следа о действии.
    const headers = body.message.slice(0, 4000);
    const headerOf = (name: string): string | null => {
      const found = new RegExp(`^${name}:\\s*(.+)$`, 'imu').exec(headers);
      return found?.[1]?.trim().slice(0, 200) ?? null;
    };
    const subject = headerOf('Subject');
    const sender = headerOf('From');
    await audit(ctx, request, {
      action: body.kind === 'spam' ? 'antispam.learn.spam' : 'antispam.learn.ham',
      targetType: 'antispam',
      targetLabel: subject ? `Обучение: ${subject}` : 'Обучение по письму без темы',
      after: {
        kind: body.kind,
        subject,
        sender,
        sizeBytes: body.message.length,
      },
    });
    return {
      ok: true,
      kind: body.kind,
      note:
        body.kind === 'spam'
          ? 'Фильтр запомнил письмо как спам. Действует на всех пользователей сервера'
          : 'Фильтр запомнил письмо как обычное. Действует на всех пользователей сервера',
    };
  });

  /* ---------------------------------------------------------------- */
  /* Состояние самого антиспама                                         */
  /* ---------------------------------------------------------------- */

  /** Последние ошибки rspamd — сюда смотрят, когда «фильтр странно себя ведёт». */
  app.get('/spam/errors', { preHandler: requireAdmin(app, 'audit.read') }, async () => {
    try {
      return { available: true, items: await rspamd.errors(30), note: '' };
    } catch (err) {
      return {
        available: false,
        items: [],
        note: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Адрес контроллера показывается в разделе: без него сообщение
  // «не отвечает» не подсказывает, куда идти смотреть.
  app.get('/spam/settings', { preHandler: requireAdmin(app, 'overview.read') }, async () => ({
    controller: rspamd.address,
    configured: rspamd.configured,
    mailDomain: ctx.config.MAIL_DOMAIN,
    resolver: ctx.config.RESOLVER_IP,
    smtpHost: apiConfig.SMTP_HOST,
  }));
}
