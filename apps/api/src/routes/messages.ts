/**
 * Маршруты работы с письмами: список, чтение, части/вложения,
 * массовые флаги, перемещение между папками.
 */
import { lookup } from 'node:dns/promises';
import type { FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { MAX_ENTITY_ID_LENGTH } from '../mail/folders.js';
import type { Folder, MessageListPage } from '@mail-true/shared';
import {
  ApiError,
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
  UpstreamUnavailableError,
} from '../errors.js';
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
import { decidePartDelivery } from '../mail/part-delivery.js';
import {
  isPrivateAddress,
  isSafeUnsubscribeUrl,
  parseUnsubscribe,
  type MailtoUnsubscribe,
} from '../mail/unsubscribe.js';
import type { MailSession } from '../types.js';

const listQuerySchema = z.object({
  folderId: z.string().min(1).default('inbox'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  threaded: z.coerce.boolean().default(false),
  filter: z.enum(['all', 'unread', 'flagged', 'with-attachments']).default('all'),
  search: z.string().max(500).optional(),
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

function requireMailSession(session: MailSession | null): MailSession {
  if (!session) throw new UnauthorizedError();
  return session;
}

/** Сколько ждём ответа от адреса отписки. */
const UNSUBSCRIBE_TIMEOUT_MS = 8000;

/**
 * Шлёт POST по адресу отписки (RFC 8058).
 *
 * Адрес пришёл из письма, то есть от кого угодно, а сервер стоит внутри
 * стека рядом с Dovecot, Postgres и Redis. Поэтому перед запросом адрес
 * проверяется дважды: по виду (только https, без учётных данных и
 * нестандартных портов) и по тому, куда разрешается имя, — во внутреннюю
 * сеть не ходим. Перенаправления не выполняются: они увели бы куда угодно.
 */
async function requestOneClickUnsubscribe(
  url: string,
  log: { warn: (obj: unknown, msg: string) => void }
): Promise<void> {
  if (!isSafeUnsubscribeUrl(url)) {
    throw new BadRequestError('Адрес отписки выглядит небезопасно');
  }
  const hostname = new URL(url).hostname;
  let addresses: Array<{ address: string }> = [];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new UpstreamUnavailableError('Не удалось найти адрес отписки');
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new BadRequestError('Адрес отписки ведёт во внутреннюю сеть');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UNSUBSCRIBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
      signal: controller.signal,
    });
    // 3xx тоже считается принятым: многие рассылки отвечают перенаправлением
    if (response.status >= 400) {
      log.warn({ status: response.status, url }, 'Адрес отписки ответил ошибкой');
      throw new UpstreamUnavailableError('Служба отписки ответила ошибкой');
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    log.warn(errorInfo(err, { url }), 'Не удалось выполнить отписку');
    throw new UpstreamUnavailableError('Не удалось связаться со службой отписки');
  } finally {
    clearTimeout(timer);
  }
}

/** Отправляет письмо отписки на адрес из `mailto:`. */
async function sendUnsubscribeMail(
  app: FastifyInstance,
  session: MailSession,
  mailto: MailtoUnsubscribe
): Promise<void> {
  const { config } = app.deps;
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: { user: session.email, pass: session.password },
    tls: { rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED },
  });
  try {
    await transport.sendMail({
      from: session.email,
      to: mailto.address,
      subject: mailto.subject ?? 'unsubscribe',
      text: mailto.body ?? 'unsubscribe',
    });
  } finally {
    transport.close();
  }
}

/**
 * Разрешает все папки списка ДО первого изменения.
 * Если хоть одной папки нет — бросает 404, и ящик остаётся нетронутым.
 */
async function resolveTargets(
  client: ImapFlow,
  byFolder: Map<string, number[]>
): Promise<Array<{ folder: Folder; uids: number[] }>> {
  const targets: Array<{ folder: Folder; uids: number[] }> = [];
  for (const [folderId, uids] of byFolder) {
    targets.push({ folder: await requireFolder(client, folderId), uids });
  }
  return targets;
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;

  // Список писем в папке
  app.get('/messages', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const q = listQuerySchema.parse(request.query);

    const page: MessageListPage = await pool.withClient(session.email, session.password, async (client) => {
      const folder = await requireFolder(client, q.folderId);
      return listMessages(client, {
        folder,
        offset: q.offset,
        limit: q.limit,
        filter: q.filter,
        search: q.search,
        withSnippets: q.snippets === '1',
      });
    });
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
          { uid: true }
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

  // Вложение или встроенная картинка
  app.get('/messages/:id/parts/:partId', { preHandler: app.requireSession }, async (request, reply) => {
    const session = requireMailSession(request.mailSession);
    const { id, partId } = partParamsSchema.parse(request.params);
    const { folderId, uid } = splitMessageId(id);

    const { meta, content } = await pool.withClient(session.email, session.password, async (client) => {
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
    });

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
    reply.header('content-security-policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
    reply.header(
      'content-disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(content);
  });

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

    const info = parseUnsubscribe(headers);
    if (!info.url && !info.mailto) {
      throw new NotFoundError('В письме нет адреса отписки');
    }

    if (info.oneClick && info.url) {
      await requestOneClickUnsubscribe(info.url, request.log);
      return { ok: true, method: 'one-click' as const, url: info.url };
    }

    if (info.mailto) {
      await sendUnsubscribeMail(app, session, info.mailto);
      return { ok: true, method: 'mailto' as const, address: info.mailto.address };
    }

    // Остаётся только открыть страницу отписки — это делает интерфейс
    return { ok: false, method: 'link' as const, url: info.url };
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
          if (toRemove.length > 0) await client.messageFlagsRemove(present, toRemove, { uid: true });
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
}
