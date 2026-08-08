/**
 * Маршруты работы с письмами: список, чтение, части/вложения,
 * массовые флаги, перемещение между папками, откладывание до срока.
 */
import type { FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import { z } from 'zod';
import { MAX_ENTITY_ID_LENGTH } from '../mail/folders.js';
import type { Folder, MessageListPage } from '@mail-true/shared';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors.js';
import {
  existingUids,
  groupIdsByFolder,
  listMessages,
  requireFolder,
  requireOrCreateFolder,
  splitMessageId,
} from '../imap/service.js';
import { errorInfo } from '../log.js';
import { parseFullMessage, parseMessageHeaders } from '../mail/parse.js';
import { decidePartDelivery, emlFileName } from '../mail/part-delivery.js';
import { loadAccountsConfig } from '../accounts/config.js';
import { SnoozeDb } from '../mail/snooze-db.js';
import { SNOOZE_PINNED_KEYWORD, SNOOZE_RETURNED_KEYWORD } from '../mail/snooze-mailbox.js';
import { SnoozeService } from '../mail/snooze-service.js';
import { LabelsDb } from '../mail/labels-db.js';
import { labelRoutes, LABELS_MIGRATION_HINT } from '../mail/labels-routes.js';
import { SavedSearchesDb } from '../mail/saved-searches-db.js';
import { savedSearchRoutes, SAVED_SEARCHES_MIGRATION_HINT } from '../mail/saved-searches-routes.js';
import { mailingsRoutes } from '../mail/mailings-routes.js';
import { MuteDb } from '../mail/mute-db.js';
import { MUTE_MIGRATION_HINT, MuteService } from '../mail/mute-service.js';
import { muteRoutes } from '../mail/mute-routes.js';
import { AwaitingDb } from '../mail/await-reply-db.js';
import { AWAIT_MIGRATION_HINT, AwaitReplyService } from '../mail/await-reply-service.js';
import { awaitReplyRoutes } from '../mail/await-reply-routes.js';
import { performUnsubscribe, type UnsubscribeSmtp } from '../mail/unsubscribe-request.js';
import type { MailSession } from '../types.js';

/* Наружу — ради проверок: разбор строки запроса здесь уже один раз соврал
   (см. `threaded` ниже), и ловить это через поднятое приложение дороже. */
export const listQuerySchema = z.object({
  folderId: z.string().min(1).default('inbox'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /*
   * Группировать письма в переписки.
   *
   * Было `z.coerce.boolean()`, и это врало ровно наоборот: `coerce.boolean`
   * — это `Boolean(значение)`, а строка «false» из строки запроса —
   * непустая, то есть ИСТИНА. Пока признак принимался и терялся, ошибка
   * ничего не значила; как только он заработал, `threaded=false` начало
   * означать «группировать». Проверено на живом стенде: список без
   * группировки отдавал 480 строк вместо 483 писем.
   *
   * Поэтому строка разбирается явно: истина — только «1» и «true».
   */
  threaded: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((value) => value === true || value === '1' || value === 'true'),
  filter: z.enum(['all', 'unread', 'flagged', 'with-attachments']).default('all'),
  search: z.string().max(500).optional(),
  /*
   * Отбор по своей метке. Отдельно от `filter`, потому что это не одно из
   * готовых значений, а ключ из справочника ящика; складывается с фильтром
   * и поиском, а не спорит с ними.
   *
   * Схема проверяет только длину — что это ПОЛЬЗОВАТЕЛЬСКАЯ метка, решает
   * сборка запроса к IMAP (buildSearchQuery). Там же и отказ на служебное
   * слово: держать этот замок в разборе строки запроса значило бы, что
   * следующий вызывающий listMessages обойдёт его, ничего не заметив.
   */
  label: z.string().max(64).optional(),
  /** Быстрый режим без сниппетов */
  snippets: z.enum(['0', '1']).default('1'),
});

/*
 * Предел длины идентификатора письма берётся из mail/folders.ts, а не из
 * числа «на глаз». Идентификатор письма — это `<идентификатор папки>:<номер>`,
 * а идентификатор папки несёт в себе путь. Прежние 200 символов резали то же
 * самое, что и предел маршрутизатора: письмо в папке с длинным русским
 * названием нельзя было ни прочитать, ни пометить, ни вынести обратно.
 */
const messageIdSchema = z.string().min(3).max(MAX_ENTITY_ID_LENGTH);

const messageParamsSchema = z.object({ id: messageIdSchema });

const partParamsSchema = z.object({
  id: messageIdSchema,
  partId: z.string().regex(/^(?:[0-9]+(?:\.[0-9]+)*|TEXT)$/, 'Некорректный номер части'),
});

const flagsBodySchema = z.object({
  ids: z.array(messageIdSchema).min(1).max(500),
  /** true — установить флаг, false — снять; отсутствие поля — не менять */
  seen: z.boolean().optional(),
  flagged: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

const moveBodySchema = z.object({
  ids: z.array(messageIdSchema).min(1).max(500),
  targetFolderId: z.string().min(1),
});

/**
 * Отложить письмо до срока.
 *
 * Срок задаётся ЛИБО готовым названием, ЛИБО датой — но считает его в
 * любом случае сервер (см. mail/snooze-schedule.ts, там же объяснено
 * почему). Пояс присылает браузер именем IANA: «завтра утром» — это утро
 * человека, а сервер стоит в UTC.
 */
const snoozeBodySchema = z.object({
  ids: z.array(messageIdSchema).min(1).max(500),
  preset: z.enum(['tomorrow-morning', 'monday', 'next-week', 'custom']).optional(),
  until: z.string().min(1).max(64).optional(),
  timeZone: z.string().max(64).optional(),
});

const unsnoozeBodySchema = z.object({
  ids: z.array(messageIdSchema).min(1).max(500),
});

function requireMailSession(session: MailSession | null): MailSession {
  if (!session) throw new UnauthorizedError();
  return session;
}

/**
 * Разрешает все папки списка ДО первого изменения.
 * Если хоть одной папки нет — бросает 404, и ящик остаётся нетронутым.
 */
async function resolveTargets(
  client: ImapFlow,
  byFolder: Map<string, number[]>,
): Promise<Array<{ folder: Folder; uids: number[] }>> {
  const targets: Array<{ folder: Folder; uids: number[] }> = [];
  for (const [folderId, uids] of byFolder) {
    targets.push({ folder: await requireFolder(client, folderId), uids });
  }
  return targets;
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  const { pool, config, logger } = app.deps;

  /*
   * Настройки исходящей почты для письма отписки. Отписка теперь бывает и
   * поштучной, и пачкой из разбора рассылок, а способ послать письмо у них
   * обязан быть один и тот же — отсюда общая сборка.
   *
   * Именно функция, а не готовый объект: сборка маршрутов не должна
   * трогать настройки вовсе. Половина проверок поднимает этот набор
   * маршрутов с урезанными зависимостями (им нужен только IMAP), и
   * чтение SMTP на этапе сборки роняло бы их все разом — проверено.
   */
  const unsubscribeSmtp = (): UnsubscribeSmtp => ({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED,
  });

  // Список писем в папке
  app.get('/messages', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const q = listQuerySchema.parse(request.query);

    const page: MessageListPage = await pool.withClient(
      session.email,
      session.password,
      async (client) => {
        const folder = await requireFolder(client, q.folderId);
        return listMessages(client, {
          folder,
          offset: q.offset,
          limit: q.limit,
          filter: q.filter,
          search: q.search,
          label: q.label,
          withSnippets: q.snippets === '1',
          /*
           * Группировка по переписке. Раньше признак принимался и молча
           * терялся — список оставался плоским, и это было записано в
           * известных ограничениях API. Теперь он доходит до сборки списка;
           * применить его или нет, решает сама папка (threadingAllowed).
           */
          threaded: q.threaded,
        });
      },
    );
    return page;
  });

  // Полное письмо
  app.get('/messages/:id', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const { id } = messageParamsSchema.parse(request.params);
    const { folderId, uid } = splitMessageId(id);
    const allowRemote = (request.query as Record<string, unknown>)['images'] === '1';

    return pool.withClient(session.email, session.password, async (client) => {
      const folder = await requireFolder(client, folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const msg = await client.fetchOne(
          String(uid),
          {
            uid: true,
            envelope: true,
            flags: true,
            bodyStructure: true,
            size: true,
            internalDate: true,
            source: true,
          },
          { uid: true },
        );
        if (!msg || !msg.source) throw new NotFoundError('Письмо не найдено');
        const { message, blockedRemote } = await parseFullMessage({
          folderId: folder.id,
          msg,
          source: msg.source,
          allowRemote,
        });
        return { ...message, blockedRemote };
      } finally {
        lock.release();
      }
    });
  });

  /**
   * Исходник письма целиком — файл .eml.
   *
   * Нужен там, где разбор не помогает. Письмо с испорченным разделителем
   * частей показывалось пустым, и добраться до его содержимого было нельзя
   * ничем: ни «показать исходник», ни скачиванием. Теперь можно — и заодно
   * такое письмо можно переслать вложением или открыть в другой почтовой
   * программе.
   *
   * Отдаётся строго файлом, а не для показа в браузере: письмо — чужое
   * содержимое, и открывать его как страницу нельзя ни при каких условиях.
   * Отсюда и `nosniff`, и запрет на рамки: браузер не должен решать за нас,
   * что это за файл.
   */
  app.get('/messages/:id/source', { preHandler: app.requireSession }, async (request, reply) => {
    const session = requireMailSession(request.mailSession);
    const { id } = messageParamsSchema.parse(request.params);
    const { folderId, uid } = splitMessageId(id);

    const found = await pool.withClient(session.email, session.password, async (client) => {
      const folder = await requireFolder(client, folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        /*
         * Конверт и дату берём тем же запросом, что и байты письма: они
         * нужны только ради имени файла, а второй заход в ящик за темой
         * стоил бы ещё одной блокировки папки.
         */
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, source: true, envelope: true, internalDate: true },
          { uid: true },
        );
        if (!msg || !msg.source) return null;
        return {
          source: msg.source,
          subject: msg.envelope?.subject ?? '',
          // Дата из заголовка письма, а не время доставки: человек ищет
          // файл по той дате, которую видел в списке писем. Времени
          // доставки хватает как запасного варианта — заголовка Date
          // у письма может не быть вовсе.
          date: msg.envelope?.date ?? msg.internalDate ?? null,
        };
      } finally {
        lock.release();
      }
    });
    if (!found) throw new NotFoundError('Письмо не найдено');

    reply.header('content-type', 'message/rfc822');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
    // Имя файла — тема и дата, вычищенные тем же правилом, что и имена
    // внутри выгрузки ящика (mail/part-delivery.ts → settings/zip.ts).
    // Раньше здесь стоял идентификатор письма, и в «Загрузках» лежал
    // `inbox_209.eml`, о котором назавтра нельзя было сказать ничего.
    const filename = emlFileName(found.subject, found.date);
    reply.header(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(found.source);
  });

  // Вложение или встроенная картинка
  app.get(
    '/messages/:id/parts/:partId',
    { preHandler: app.requireSession },
    async (request, reply) => {
      const session = requireMailSession(request.mailSession);
      const { id, partId } = partParamsSchema.parse(request.params);
      const { folderId, uid } = splitMessageId(id);

      const { meta, content } = await pool.withClient(
        session.email,
        session.password,
        async (client) => {
          const folder = await requireFolder(client, folderId);
          const lock = await client.getMailboxLock(folder.path);
          try {
            const dl = await client.download(String(uid), partId, { uid: true });
            // Скачиваем часть целиком под блокировкой, чтобы не держать ящик
            const chunks: Buffer[] = [];
            for await (const chunk of dl.content) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
            }
            return { meta: dl.meta, content: Buffer.concat(chunks) };
          } finally {
            lock.release();
          }
        },
      );

      if (content.length === 0) throw new NotFoundError('Часть письма не найдена');

      const filename = meta.filename ?? 'attachment';
      // Правило «показывать или скачивать» живёт в одном месте и покрыто
      // тестами — см. mail/part-delivery.ts, там же объяснено почему.
      const { contentType: safeType, inline } = decidePartDelivery(meta.contentType);

      reply.header('content-type', safeType);
      reply.header('x-content-type-options', 'nosniff');
      // Вторая линия обороны: даже если тип когда-нибудь снова окажется
      // исполняемым, эта политика не даст выполнить ни скрипт, ни встроенный
      // объект и запретит открывать содержимое в рамке.
      reply.header(
        'content-security-policy',
        "default-src 'none'; sandbox; frame-ancestors 'none'",
      );
      reply.header(
        'content-disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      reply.header('cache-control', 'private, max-age=3600');
      return reply.send(content);
    },
  );

  /**
   * Отписка от рассылки одним запросом (RFC 8058).
   *
   * Запрос шлёт сервер, а не браузер: адрес отписки не должен узнавать
   * ни адрес читающего, ни его cookie. Если отправитель не разрешил
   * отписку в один запрос, возвращаем ссылку — её откроет интерфейс.
   */
  app.post('/messages/:id/unsubscribe', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const { id } = messageParamsSchema.parse(request.params);
    const { folderId, uid } = splitMessageId(id);

    const headers = await pool.withClient(session.email, session.password, async (client) => {
      const folder = await requireFolder(client, folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const msg = await client.fetchOne(String(uid), { uid: true, headers: true }, { uid: true });
        if (!msg || !msg.headers) throw new NotFoundError('Письмо не найдено');
        return parseMessageHeaders(msg.headers);
      } finally {
        lock.release();
      }
    });

    const outcome = await performUnsubscribe({
      headers,
      session,
      smtp: unsubscribeSmtp(),
      log: request.log,
    });
    // Здесь «отписаться нечем» — это 404: человек нажал на кнопку в
    // конкретном письме и обязан узнать, что в нём адреса отписки нет.
    // В разборе рассылок тот же случай означает другое (см. mailings-routes).
    if (!outcome) throw new NotFoundError('В письме нет адреса отписки');
    return outcome;
  });

  // Массовая простановка/снятие флагов
  app.post('/messages/flags', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = flagsBodySchema.parse(request.body);
    if (body.seen === undefined && body.flagged === undefined && body.deleted === undefined) {
      throw new BadRequestError('Не указано ни одного флага');
    }

    const toAdd: string[] = [];
    const toRemove: string[] = [];
    const collect = (value: boolean | undefined, flag: string): void => {
      if (value === true) toAdd.push(flag);
      if (value === false) toRemove.push(flag);
    };
    collect(body.seen, '\\Seen');
    collect(body.flagged, '\\Flagged');
    collect(body.deleted, '\\Deleted');

    /*
     * Прочитанное письмо перестаёт быть «вернувшимся».
     *
     * Пометка возврата (`$Snoozed` + `$Pinned`) существует ради одного:
     * найти письмо, которое приехало на своё старое место по дате.
     * Как только человек его открыл, задача выполнена — и держать письмо
     * приклеенным к верху списка дальше значит мешать. Снимаем здесь, а не
     * в интерфейсе, потому что ключевые слова живут в ящике: иначе письмо
     * оставалось бы закреплённым в телефоне и во второй вкладке.
     */
    if (body.seen === true) {
      toRemove.push(SNOOZE_RETURNED_KEYWORD, SNOOZE_PINNED_KEYWORD);
    }

    const byFolder = groupIdsByFolder(body.ids);
    let updated = 0;

    await pool.withClient(session.email, session.password, async (client) => {
      // Сначала проверяем ВСЕ папки и только потом меняем хоть что-то.
      // Раньше папки разбирались по ходу дела: письмо из несуществующей
      // папки в середине списка приводило к 404 уже ПОСЛЕ того, как часть
      // флагов проставлена, — список расходился с ящиком.
      const targets = await resolveTargets(client, byFolder);

      for (const { folder, uids } of targets) {
        const lock = await client.getMailboxLock(folder.path);
        try {
          // Считаем результат по ящику, а не по длине присланного списка
          const present = await existingUids(client, uids);
          if (present.length === 0) continue;
          if (toAdd.length > 0) await client.messageFlagsAdd(present, toAdd, { uid: true });
          if (toRemove.length > 0)
            await client.messageFlagsRemove(present, toRemove, { uid: true });
          updated += present.length;
        } finally {
          lock.release();
        }
      }
    });
    return { updated };
  });

  // Перемещение писем между папками
  app.post('/messages/move', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = moveBodySchema.parse(request.body);
    const byFolder = groupIdsByFolder(body.ids);
    let moved = 0;

    await pool.withClient(session.email, session.password, async (client) => {
      // Порядок важен: сперва проверяем все папки-источники (404 без единого
      // перемещения), и только потом трогаем папку-получатель — иначе
      // заведомо неудачный запрос успевал создать «Архив».
      const targets = await resolveTargets(client, byFolder);
      const target = await requireOrCreateFolder(client, body.targetFolderId);

      for (const { folder, uids } of targets) {
        if (folder.id === target.id) continue;
        const lock = await client.getMailboxLock(folder.path);
        try {
          const present = await existingUids(client, uids);
          if (present.length === 0) continue;
          const result = await client.messageMove(present, target.path, { uid: true });
          // UIDPLUS отдаёт соответствие исходных и новых UID — это и есть
          // настоящее число перемещённых писем
          const mapped = result && typeof result === 'object' ? result.uidMap?.size : undefined;
          moved += mapped ?? present.length;
        } finally {
          lock.release();
        }
      }
    });
    return { moved };
  });

  /* ------------------------------------------------------------------ */
  /* Отложить письмо до срока                                            */
  /* ------------------------------------------------------------------ */

  /*
   * Служба живёт при этом наборе маршрутов, а не в server.ts, — по той же
   * причине, по какой очередь отложенной ОТПРАВКИ живёт при маршрутах
   * написания (routes/compose.ts): она целиком принадлежит работе с
   * письмами, и разносить её по двум файлам значило бы, что остановка
   * одного не останавливает второй.
   *
   * Своих переменных окружения модуль не заводит: подключение к базе и
   * служебный пользователь Dovecot берутся оттуда же, откуда их берёт
   * сборщик почты с чужих ящиков (accounts/config.ts). Второй набор
   * переменных для того же самого — прямая дорога к «настроил, а не
   * работает».
   */
  const accountsConfig = loadAccountsConfig();
  const snooze = new SnoozeService({
    config,
    logger,
    master: accountsConfig.masterConfigured
      ? {
          user: accountsConfig.DOVECOT_MASTER_USER,
          password: accountsConfig.DOVECOT_MASTER_PASSWORD,
          separator: accountsConfig.DOVECOT_MASTER_SEPARATOR,
        }
      : null,
  });

  let snoozeDb: SnoozeDb | null = null;
  if (accountsConfig.databaseUrl) {
    snoozeDb = new SnoozeDb({ connectionString: accountsConfig.databaseUrl, logger });
    const db = snoozeDb;
    // Проверка схемы асинхронная и НЕ задерживает сборку маршрутов: почта
    // обязана подняться и с лежащей базой. До ответа возможность выключена.
    db.schemaReady()
      .then((ready) => {
        if (!ready) {
          snooze.disable(
            'Таблицы отложенных писем нет. Примените ' +
              'infra/postgres/migrations/0001_baseline.sql к работающей базе.',
          );
          app.log.error(snooze.unavailableReason);
          return;
        }
        snooze.attachStore(db);
        snooze.start();
      })
      .catch((err: unknown) => {
        snooze.disable('Не удалось проверить схему отложенных писем');
        app.log.error(errorInfo(err), 'Не удалось проверить схему отложенных писем');
      });
  } else {
    snooze.disable(
      'Отложить письмо нельзя: не настроена база данных (DATABASE_URL). ' +
        'Почта при этом работает как обычно.',
    );
    app.log.warn(snooze.unavailableReason);
  }

  /* ------------------------------------------------------------------ */
  /* Свои метки                                                          */
  /* ------------------------------------------------------------------ */

  /*
   * Справочник меток подключается здесь по той же причине, что и служба
   * отложенных писем: метки целиком принадлежат работе с письмами (они и
   * лежат в письмах ключевыми словами IMAP), а своих переменных окружения
   * не заводят — база берётся оттуда же, откуда её берут настройки и
   * сборщик почты.
   *
   * Проба схемы асинхронная и НЕ задерживает сборку маршрутов: почта
   * обязана подняться и с лежащей базой. До ответа возможность выключена,
   * и интерфейс честно её не показывает — см. mail/labels-routes.ts.
   */
  const labelsDeps: { store: LabelsDb | null; unavailableReason: string } = {
    store: null,
    unavailableReason:
      'Свои метки недоступны: не настроена база данных (DATABASE_URL). ' +
      'Почта при этом работает как обычно.',
  };
  let labelsDb: LabelsDb | null = null;
  if (accountsConfig.databaseUrl) {
    labelsDb = new LabelsDb({ connectionString: accountsConfig.databaseUrl, logger });
    const db = labelsDb;
    db.schemaReady()
      .then((ready) => {
        if (!ready) {
          labelsDeps.unavailableReason = LABELS_MIGRATION_HINT;
          app.log.error(LABELS_MIGRATION_HINT);
          return;
        }
        labelsDeps.store = db;
      })
      .catch((err: unknown) => {
        labelsDeps.unavailableReason = 'Не удалось проверить схему меток';
        app.log.error(errorInfo(err), 'Не удалось проверить схему меток');
      });
  } else {
    app.log.warn(labelsDeps.unavailableReason);
  }

  await labelRoutes(app, labelsDeps);

  /* ------------------------------------------------------------------ */
  /* Сохранённые поисковые запросы                                       */
  /* ------------------------------------------------------------------ */

  /*
   * Подключаются здесь по той же причине, что метки и отложенные письма:
   * своих переменных окружения не заводят, база берётся оттуда же, а проба
   * схемы асинхронная и не задерживает сборку маршрутов. До ответа
   * возможность выключена, и интерфейс её честно не показывает — ни кнопки
   * «Сохранить запрос», ни группы в левой колонке.
   */
  const savedSearchesDeps: { store: SavedSearchesDb | null; unavailableReason: string } = {
    store: null,
    unavailableReason:
      'Сохранённые запросы недоступны: не настроена база данных (DATABASE_URL). ' +
      'Поиск при этом работает как обычно.',
  };
  let savedSearchesDb: SavedSearchesDb | null = null;
  if (accountsConfig.databaseUrl) {
    savedSearchesDb = new SavedSearchesDb({
      connectionString: accountsConfig.databaseUrl,
      logger,
    });
    const db = savedSearchesDb;
    db.schemaReady()
      .then((ready) => {
        if (!ready) {
          savedSearchesDeps.unavailableReason = SAVED_SEARCHES_MIGRATION_HINT;
          app.log.error(SAVED_SEARCHES_MIGRATION_HINT);
          return;
        }
        savedSearchesDeps.store = db;
      })
      .catch((err: unknown) => {
        savedSearchesDeps.unavailableReason = 'Не удалось проверить схему сохранённых запросов';
        app.log.error(errorInfo(err), 'Не удалось проверить схему сохранённых запросов');
      });
  } else {
    app.log.warn(savedSearchesDeps.unavailableReason);
  }

  await savedSearchRoutes(app, savedSearchesDeps);

  /* ------------------------------------------------------------------ */
  /* Разбор рассылок и массовая уборка                                   */
  /* ------------------------------------------------------------------ */

  /*
   * Базы у разбора нет, и это не упущение: он целиком считается по
   * содержимому ящика, а снимок осмотра живёт в памяти процесса минуты.
   * Поэтому — в отличие от меток, отложенных писем и сохранённых
   * запросов — у него нет ни миграции, ни состояния «возможности нет»:
   * он работает везде, где работает сама почта.
   *
   * Настройки исходящей почты нужны ровно для одного — письма отписки на
   * `mailto:`; те же самые, что у поштучной отписки выше.
   */
  await mailingsRoutes(app, { smtp: unsubscribeSmtp });

  /* ------------------------------------------------------------------ */
  /* Заглушённые цепочки                                                 */
  /* ------------------------------------------------------------------ */

  /*
   * Подключается здесь по той же причине, что метки и отложенные письма:
   * своих переменных окружения не заводит, база берётся оттуда же, проба
   * схемы асинхронная и не задерживает сборку маршрутов.
   *
   * Файл правил Sieve при этом пишется через раздел настроек
   * (`app.settingsService`): каталог скриптов ящика один, и второе
   * хранилище со своими настройками транспорта разъехалось бы с первым
   * при первой же правке окружения.
   */
  const mute = new MuteService({
    logger,
    includes: () => app.settingsService.includes,
    syncSieve: async (email) => {
      const state = await app.settingsService.syncSieve(email);
      return { written: state.written, error: state.error };
    },
  });

  let muteDb: MuteDb | null = null;
  if (accountsConfig.databaseUrl) {
    muteDb = new MuteDb({ connectionString: accountsConfig.databaseUrl, logger });
    const db = muteDb;
    db.schemaReady()
      .then((ready) => {
        if (!ready) {
          mute.disable(MUTE_MIGRATION_HINT);
          app.log.error(MUTE_MIGRATION_HINT);
          return;
        }
        mute.attachStore(db);
      })
      .catch((err: unknown) => {
        mute.disable('Не удалось проверить схему заглушённых цепочек');
        app.log.error(errorInfo(err), 'Не удалось проверить схему заглушённых цепочек');
      });
  } else {
    mute.disable(
      'Заглушить переписку нельзя: не настроена база данных (DATABASE_URL). ' +
        'Почта при этом работает как обычно.',
    );
    app.log.warn(mute.unavailableReason);
  }

  await muteRoutes(app, mute);

  /* ------------------------------------------------------------------ */
  /* Напомнить, если не ответили                                         */
  /* ------------------------------------------------------------------ */

  /*
   * Служебный вход в Dovecot — тот же, что у возврата отложенных писем:
   * проверять ответ и поднимать письмо надо и тогда, когда человека нет
   * в сети, а пароля владельца для этого не нужно и не хранится.
   */
  const awaitReply = new AwaitReplyService({
    config,
    logger,
    master: accountsConfig.masterConfigured
      ? {
          user: accountsConfig.DOVECOT_MASTER_USER,
          password: accountsConfig.DOVECOT_MASTER_PASSWORD,
          separator: accountsConfig.DOVECOT_MASTER_SEPARATOR,
        }
      : null,
  });

  let awaitingDb: AwaitingDb | null = null;
  if (accountsConfig.databaseUrl) {
    awaitingDb = new AwaitingDb({ connectionString: accountsConfig.databaseUrl, logger });
    const db = awaitingDb;
    db.schemaReady()
      .then((ready) => {
        if (!ready) {
          awaitReply.disable(AWAIT_MIGRATION_HINT);
          app.log.error(AWAIT_MIGRATION_HINT);
          return;
        }
        awaitReply.attachStore(db);
        awaitReply.start();
      })
      .catch((err: unknown) => {
        awaitReply.disable('Не удалось проверить схему ожидаемых ответов');
        app.log.error(errorInfo(err), 'Не удалось проверить схему ожидаемых ответов');
      });
  } else {
    awaitReply.disable(
      'Ждать ответа нельзя: не настроена база данных (DATABASE_URL). ' +
        'Почта при этом работает как обычно.',
    );
    app.log.warn(awaitReply.unavailableReason);
  }

  await awaitReplyRoutes(app, awaitReply);

  app.addHook('onClose', async () => {
    snooze.stop();
    awaitReply.stop();
    if (snoozeDb) await snoozeDb.shutdown().catch(() => undefined);
    if (labelsDb) await labelsDb.shutdown().catch(() => undefined);
    if (savedSearchesDb) await savedSearchesDb.shutdown().catch(() => undefined);
    if (muteDb) await muteDb.shutdown().catch(() => undefined);
    if (awaitingDb) await awaitingDb.shutdown().catch(() => undefined);
  });

  /**
   * Работник виден на этом наборе маршрутов: иначе проверить возврат можно
   * было бы только ожиданием получаса — то есть на деле никак. Декорация
   * живёт в области видимости плагина, ровно как у отложенной отправки.
   */
  app.decorate('snoozeService', snooze);
  /* По той же причине: проверить напоминание иначе можно было бы только
     ожиданием суток. */
  app.decorate('awaitReplyService', awaitReply);

  /**
   * Что лежит в «Отложенных» и работает ли возможность вообще.
   *
   * Один маршрут на оба вопроса намеренно: интерфейс обязан УБРАТЬ кнопку,
   * когда возможности нет, а не показывать её и потом отказывать. Пока
   * `available` ложно, кнопки «Отложить» в почте просто не появляется —
   * то же правило, что у помощника ИИ.
   */
  app.get('/messages/snoozed', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    if (!snooze.available) {
      return {
        available: false,
        scheduledReturn: false,
        reason: snooze.unavailableReason,
        items: [],
      };
    }
    const items = await pool.withClient(session.email, session.password, (client) =>
      snooze.listSnoozed(client, session.email),
    );
    return {
      available: true,
      scheduledReturn: snooze.scheduledReturnAvailable,
      reason: snooze.scheduledReturnAvailable
        ? null
        : 'Служебный доступ Dovecot не настроен: письма придётся возвращать вручную',
      items,
    };
  });

  // Отложить письма до срока
  app.post('/messages/snooze', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = snoozeBodySchema.parse(request.body);
    return pool.withClient(session.email, session.password, (client) =>
      snooze.snooze(client, session.email, body.ids, {
        preset: body.preset,
        until: body.until,
        timeZone: body.timeZone,
      }),
    );
  });

  // Вернуть отложенное письмо прямо сейчас, не дожидаясь срока
  app.delete('/messages/snooze', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = unsnoozeBodySchema.parse(request.body);
    return pool.withClient(session.email, session.password, (client) =>
      snooze.returnNow(client, session.email, body.ids),
    );
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Служба отложенных писем. Обычно работник просыпается сам; наружу
     * выведена, чтобы проверки могли позвать один проход, не дожидаясь
     * таймера.
     */
    snoozeService: SnoozeService;
    /**
     * Служба ожидания ответа. Наружу выведена по той же причине: иначе
     * проверить напоминание можно было бы только ожиданием суток.
     */
    awaitReplyService: AwaitReplyService;
  }
}
