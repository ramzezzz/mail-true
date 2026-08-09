/**
 * Отправка писем (POST /api/messages/send) и черновики (POST /api/drafts).
 * Письмо собирается MailComposer'ом в RFC822, отправляется через Postfix
 * submission (nodemailer SMTP) и тем же байтовым представлением
 * сохраняется копия в «Отправленные» (IMAP APPEND).
 *
 * Здесь же живут две соседние возможности, потому что обе — это отправка
 * письма, а не чтение почты: отложенная отправка (очередь на диске,
 * mail/deferred-send.ts) и уведомление о прочтении (mail/read-receipt.ts).
 */
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import type { DraftContent, Folder, MailAddress } from '@mail-true/shared';
import {
  BadRequestError,
  MessageTooLargeError,
  NotFoundError,
  SendRejectedError,
  UnauthorizedError,
  UpstreamUnavailableError,
} from '../errors.js';
import { listFolders, markAnswered, requireFolder, splitMessageId } from '../imap/service.js';
import { findFolderById } from '../mail/folders.js';
import { parseDraftSource } from '../mail/draft-read.js';
import { DraftSequencer } from '../mail/draft-sequencer.js';
import {
  checkSendAt,
  DeferredSender,
  DeferredSpool,
  normalizeUndoSeconds,
  readFailureFromRaw,
  withFailureHeader,
  type DeferredEntry,
  type DeliveryOutcome,
  type SendFailureReason,
} from '../mail/deferred-send.js';
import { parseMessageHeaders } from '../mail/parse.js';
import { buildReadReceipt, readReceiptRequest } from '../mail/read-receipt.js';
import { classifySmtpError, readSendOutcome, type RejectedRecipient } from '../mail/send-result.js';
import { htmlToText } from '../mail/text.js';
import { sanitizeEmailHtml } from '../mail/sanitize.js';
import { ENCODING_OVERHEAD } from '../config.js';
import type { MailSession } from '../types.js';
import type { UploadStore } from '../uploads.js';
import { errorInfo } from '../log.js';

/**
 * Как часто работник очереди смотрит, не пора ли кому-то уходить.
 *
 * Полминуты — это запасной ход для писем, назначенных на завтра, и для
 * тех, что пережили перезапуск сервера. Письмо, ждущее пять секунд отмены,
 * столько не ждёт: на его срок ставится отдельный будильник
 * (DeferredSender.wakeAt), иначе «уйдёт через 5 секунд» на деле означало бы
 * «когда-нибудь в ближайшие полминуты».
 */
const DEFERRED_TICK_MS = 30_000;

/**
 * Адрес в письме, которое ЕЩЁ ПИШУТ.
 *
 * Проверки на правильность адреса здесь намеренно нет. Черновик — это ровно
 * то, что имеет право быть недописанным: человек набирает «ирин», в этот
 * момент срабатывает автосохранение, и сервер отвечал «Некорректные данные
 * запроса». То есть черновик не сохранялся почти всё время, пока письмо
 * пишется, — а окно написания при этом показывало ошибку и отказывалось
 * закрываться.
 *
 * Правильность адреса проверяется при ОТПРАВКЕ, и там об этом говорится
 * человеческим языком, с указанием самого адреса.
 */
const draftAddressSchema = z.object({
  name: z.string().max(200).nullable(),
  address: z.string().trim().max(320),
});

/** Схема DraftPayload из packages/shared. */
const draftPayloadSchema = z.object({
  draftUid: z.number().int().positive().optional(),
  /**
   * Идентификатор окна написания. Нужен автосохранению: пока у черновика
   * ещё нет UID, только по нему и можно понять, что несколько одновременных
   * сохранений относятся к одному письму, а не к разным.
   */
  draftKey: z.string().min(1).max(100).optional(),
  to: z.array(draftAddressSchema).max(100),
  cc: z.array(draftAddressSchema).max(100),
  bcc: z.array(draftAddressSchema).max(100),
  subject: z.string().max(1000),
  bodyHtml: z.string().max(10 * 1024 * 1024),
  attachmentIds: z.array(z.string().min(1).max(100)).max(50),
  /**
   * Письма, вложенные целиком, — «Переслать как вложение». Пересылают
   * обычно одно-два, поэтому предел небольшой: каждое такое вложение
   * тянет за собой весь исходник письма вместе с его вложениями.
   */
  attachMessageIds: z.array(z.string().min(1).max(200)).max(10).optional(),
  inReplyTo: z.string().max(1000).optional(),
  references: z.array(z.string().max(1000)).max(100).optional(),
  requestReadReceipt: z.boolean().optional(),
  sendAt: z.string().datetime({ offset: true }).optional(),
});

type DraftBody = z.infer<typeof draftPayloadSchema>;

function formatAddresses(list: MailAddress[]): Mail.Address[] {
  return list.map((a) => ({ name: a.name ?? '', address: a.address }));
}

/** Письмо, вложенное в другое письмо целиком (message/rfc822). */
export interface ForwardedMessage {
  /** Имя файла вложения — обычно тема исходного письма с «.eml». */
  filename: string;
  /** Исходник письма как он лежит в ящике. */
  raw: Buffer;
}

/**
 * Вложение-письмо для MailComposer.
 *
 * Кодировать пересылаемое письмо в base64 нельзя: RFC 2046 (§5.2.1)
 * разрешает для `message/rfc822` только 7bit, 8bit и binary. А nodemailer
 * по умолчанию ставит любому вложению именно base64 — проверено на
 * собранном письме: часть уезжала как `Content-Transfer-Encoding: base64`,
 * и заголовки пересланного письма внутри неё становились нечитаемыми для
 * всего, что смотрит на письмо не через полный разбор MIME.
 *
 * `contentTransferEncoding: false` снимает этот умолчательный base64 —
 * тогда nodemailer отдаёт содержимое как есть. Если в исходнике есть
 * восьмибитные байты (кириллица в теле без кодирования), объявлять
 * подразумеваемый 7bit было бы неправдой, поэтому заголовок проставляется
 * явно — своим заголовком вложения, до того как nodemailer решит сам.
 */
export function forwardedAttachment(item: ForwardedMessage): Mail.Attachment {
  const eightBit = item.raw.some((byte) => byte > 127);
  return {
    filename: item.filename,
    content: item.raw,
    contentType: 'message/rfc822',
    contentDisposition: 'attachment',
    contentTransferEncoding: false,
    ...(eightBit ? { headers: { 'Content-Transfer-Encoding': '8bit' } } : {}),
  };
}

/**
 * Собирает письмо в RFC822-байты.
 *
 * `keepBcc` — для черновиков, и только для них. По умолчанию MailComposer
 * НЕ пишет заголовок `Bcc` в собранное письмо: скрытые получатели должны
 * попасть в конверт SMTP и остаться невидимыми для всех остальных. Но у
 * черновика конверта нет — он просто лежит в ящике, и без этого заголовка
 * скрытые получатели пропадали бесследно: человек указывал их, сохранял
 * черновик, дописывал его на другой день и отправлял письмо, не заметив,
 * что половина адресатов исчезла.
 */
async function composeRaw(
  payload: DraftBody,
  from: string,
  uploads: UploadStore,
  /** Предел письма целиком: проверяется ДО сборки, по размерам вложений. */
  messageMaxBytes: number,
  forwarded: readonly ForwardedMessage[] = [],
  settings?: { keepBcc?: boolean },
): Promise<Buffer> {
  const attachments: Mail.Attachment[] = [];
  /*
   * СУММУ СЧИТАЕМ ДО СБОРКИ, А НЕ ПОСЛЕ.
   *
   * Единственная проверка размера стояла ниже по течению — над готовым
   * буфером письма. К тому времени память уже съедена: nodemailer копит
   * все части в массив и делает Buffer.concat, то есть держит письмо
   * дважды.
   *
   * Обойти это было просто и не требовало ничего, кроме обычной работы
   * интерфейса. Пределы, которые есть, — на ОДНО вложение (17,8 МБ) и на
   * число файлов В ОДНОМ запросе (20). Суммы не проверял никто: пятьдесят
   * загруженных файлов по 17,8 МБ давали пик около двух с половиной
   * гигабайт на один запрос. Дальше «Reached heap limit», процесс
   * перезапускается, и у ВСЕХ остальных обрываются сессии, соединения и
   * отправка — ровно тот отказ, который уже разбирали в infra/docker-
   * compose.yml и закрывали ограничением тела запроса. Вложения приходят
   * не в теле, а по идентификаторам, поэтому то ограничение их не ловит,
   * а Buffer живёт вне кучи V8 — не ловит и --max-old-space-size.
   *
   * Черновик при этом не проверялся вовсе: гигабайтный буфер уходил прямо
   * в IMAP APPEND.
   *
   * Размер известен заранее — uploads.get отдаёт его в meta. Считаем с
   * той же надбавкой на кодирование, что и предел одного вложения:
   * base64 растит вложение примерно на 40%.
   */
  let attachedBytes = 0;
  for (const id of payload.attachmentIds) {
    // Владелец — тот же ящик, от чьего имени письмо: чужая загрузка для
    // него не существует, и в письмо попасть не может.
    const found = await uploads.get(id, from);
    if (!found) throw new BadRequestError(`Вложение не найдено: ${id}`);
    attachedBytes += found.meta.size;
    attachments.push({
      filename: found.meta.filename,
      path: found.path,
      contentType: found.meta.mimeType,
    });
  }
  for (const item of forwarded) {
    attachedBytes += item.raw.length;
    attachments.push(forwardedAttachment(item));
  }
  const projected = Math.round(attachedBytes * ENCODING_OVERHEAD);
  if (projected > messageMaxBytes) {
    throw new MessageTooLargeError(
      `Вложения не помещаются: вместе они дадут около ${megabytes(projected)} МБ, ` +
        `а предел письма — ${megabytes(messageMaxBytes)} МБ. ` +
        'Уберите часть файлов или отправьте их отдельными письмами.',
      { limitBytes: messageMaxBytes, projectedBytes: projected },
    );
  }

  // Пользовательский HTML тоже прогоняем через санитайзер:
  // composer не должен рассылать скрипты даже по ошибке фронтенда
  const cleanHtml = sanitizeEmailHtml(payload.bodyHtml, { allowRemote: true }).html;

  const options: Mail.Options = {
    from,
    to: formatAddresses(payload.to),
    cc: formatAddresses(payload.cc),
    bcc: formatAddresses(payload.bcc),
    subject: payload.subject,
    html: cleanHtml,
    text: htmlToText(payload.bodyHtml),
    attachments,
    date: new Date(),
  };
  if (payload.inReplyTo) options.inReplyTo = payload.inReplyTo;
  if (payload.references && payload.references.length > 0) {
    options.references = payload.references;
  }
  /**
   * Просьба уведомить о прочтении (RFC 8098). Адрес — свой же: просить
   * сообщать кому-то третьему интерфейс не предлагает и не должен, иначе
   * почта превращается в средство подтверждения чужих адресов.
   */
  if (payload.requestReadReceipt) {
    options.headers = { 'Disposition-Notification-To': `<${from}>` };
  }

  const composer = new MailComposer(options);
  const node = composer.compile();
  /**
   * `keepBcc` живёт на узле MIME, а не в настройках письма: MailComposer
   * заголовок `Bcc` в узел кладёт, а вот саму настройку «не выбрасывать его
   * при сборке» дальше не передаёт (nodemailer/lib/mail-composer/index.js —
   * список опций MimeNode её не содержит). Поэтому ставим прямо на узле;
   * иначе черновик собирался бы вообще без скрытых получателей.
   */
  if (settings?.keepBcc) (node as unknown as { keepBcc: boolean }).keepBcc = true;
  return node.build();
}

/** Имя файла для вложенного письма: тема + «.eml». */
export function forwardedFilename(subject: string): string {
  const clean = subject
    .replace(/[\r\n]+/g, ' ')
    // В имени файла эти символы означают путь или запрещены в файловых
    // системах — а тема письма приходит снаружи и содержит что угодно
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim()
    .slice(0, 100);
  return `${clean || 'Письмо'}.eml`;
}

function allRecipients(payload: DraftBody): string[] {
  return [...payload.to, ...payload.cc, ...payload.bcc].map((a) => a.address);
}

/**
 * Простая проверка адреса: есть ли собака, что-то до неё, точка после неё.
 *
 * Нарочно не строгая по RFC — задача не отсеять экзотику, а поймать
 * недописанное («ирин», «ivan@») и явную опечатку. Всё остальное отвергнет
 * почтовый сервер получателя, и об этом мы сообщим отдельно.
 */
function looksLikeAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/**
 * Отправлять можно только на адреса, похожие на адреса.
 *
 * Раньше это делала схема запроса, и человек получал «Некорректные данные
 * запроса» — из чего непонятно ни что не так, ни в каком поле. Теперь в
 * сообщении назван сам адрес, а поля перечислены по-русски.
 */
function checkSendableAddresses(payload: DraftBody): void {
  const fields: Array<[string, MailAddress[]]> = [
    ['«Кому»', payload.to],
    ['«Копия»', payload.cc],
    ['«Скрытая копия»', payload.bcc],
  ];
  for (const [label, list] of fields) {
    for (const item of list) {
      if (looksLikeAddress(item.address)) continue;
      const shown = item.address.trim() === '' ? '(пусто)' : item.address;
      throw new BadRequestError(
        `В поле ${label} это не похоже на адрес почты: «${shown}». ` +
          'Адрес выглядит так: имя@домен.ру',
      );
    }
  }
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',');
}

/** Находит папку черновиков или объясняет, почему не вышло. */
async function requireDraftsFolder(client: ImapFlow): Promise<Folder> {
  const folders = await listFolders(client);
  const drafts = findFolderById(folders, 'drafts');
  if (!drafts) throw new BadRequestError('Папка черновиков не найдена');
  return drafts;
}

export async function composeRoutes(app: FastifyInstance): Promise<void> {
  const { config, pool, secretBox, uploads } = app.deps;
  // Сохранения черновика одного окна написания идут строго по очереди —
  // иначе автосохранение вместе с явным «сохранить» плодит копии письма
  const drafts = new DraftSequencer();

  /**
   * Очередь отложенной отправки лежит рядом с загруженными вложениями —
   * на том же постоянном томе (см. infra: `api-uploads:/srv/data`). Своей
   * настройки для неё нет намеренно: заводить переменную окружения ради
   * соседнего каталога значило бы менять развёртывание там, где ничего
   * менять не нужно.
   */
  const spool = new DeferredSpool(join(dirname(config.UPLOAD_DIR), 'deferred'));

  /**
   * Тело письма с картинками законно бывает в разы больше обычного запроса,
   * поэтому у маршрутов написания свой предел. Раньше схема разрешала
   * `bodyHtml` до 10 МБ, а общий предел тела запроса был 2 МБ: письмо со
   * вставленными картинками упиралось в невидимый потолок и получало
   * английскую ошибку не из контракта.
   */
  const composeRoute = {
    preHandler: app.requireSession,
    bodyLimit: config.COMPOSE_BODY_MAX_BYTES,
  };

  /** Кладёт новую версию черновика и убирает предыдущую. */
  async function saveDraftVersion(
    session: MailSession,
    raw: Buffer,
    requestedUid: number | undefined,
    draftKey: string | undefined,
  ): Promise<number | null> {
    const key = draftKey ? `${session.email}:${draftKey}` : session.email;
    return drafts.save(key, requestedUid, Boolean(draftKey), async (previousUid) =>
      pool.withClient(session.email, session.password, async (client) => {
        const folder = await requireDraftsFolder(client);
        const appended = await client.append(folder.path, raw, ['\\Draft', '\\Seen']);
        const uid = appended && appended.uid ? appended.uid : null;
        if (previousUid !== undefined) {
          const lock = await client.getMailboxLock(folder.path);
          try {
            await client.messageDelete([previousUid], { uid: true });
          } finally {
            lock.release();
          }
        }
        return { uid, result: uid };
      }),
    );
  }

  /**
   * Письмо не ушло и не уйдёт — сохраняем текст, чтобы он не пропал.
   * Раньше при постоянном отказе SMTP письмо терялось целиком.
   *
   * Письмо для черновика собирается ЗАНОВО, а не берётся готовым от отправки:
   * у черновика должен остаться заголовок `Bcc` (см. composeRaw), иначе
   * скрытые получатели пропадают, и человек отправляет спасённое письмо уже
   * без них — молча и не заметив.
   */
  async function keepDraftAfterFailure(
    session: MailSession,
    payload: DraftBody,
    forwarded: readonly ForwardedMessage[],
    log: { warn: (obj: unknown, msg: string) => void },
  ): Promise<{ draftUid: number | null; draftId: string | null }> {
    if (payload.draftUid) {
      // Исходный черновик не трогали — он на месте
      return { draftUid: payload.draftUid, draftId: `drafts:${payload.draftUid}` };
    }
    try {
      const raw = await composeRaw(
        payload,
        session.email,
        uploads,
        config.MESSAGE_MAX_BYTES,
        forwarded,
        {
          keepBcc: true,
        },
      );
      const uid = await saveDraftVersion(session, raw, undefined, payload.draftKey);
      return { draftUid: uid, draftId: uid ? `drafts:${uid}` : null };
    } catch (err) {
      log.warn(errorInfo(err), 'Не удалось сохранить черновик после отказа отправки');
      return { draftUid: null, draftId: null };
    }
  }

  /**
   * Убирает черновик письма, которое уже принято к отправке.
   *
   * Через ту же очередь, что и автосохранение: иначе таймер успеет положить
   * новую копию уже отправленного письма. Неудача сюда не поднимается —
   * письмо-то ушло.
   */
  async function dropDraftAfterSend(
    session: MailSession,
    payload: DraftBody,
    log: { warn: (obj: unknown, msg: string) => void },
  ): Promise<void> {
    if (!payload.draftUid && !payload.draftKey) return;
    const key = payload.draftKey ? `${session.email}:${payload.draftKey}` : session.email;
    await drafts
      .save(key, payload.draftUid, Boolean(payload.draftKey), async (previousUid) => {
        if (previousUid === undefined) return { uid: null, result: null };
        await pool.withClient(session.email, session.password, async (client) => {
          const folders = await listFolders(client);
          const draftsFolder = findFolderById(folders, 'drafts');
          if (!draftsFolder) return;
          const lock = await client.getMailboxLock(draftsFolder.path);
          try {
            await client.messageDelete([previousUid], { uid: true });
          } finally {
            lock.release();
          }
        });
        return { uid: null, result: null };
      })
      .catch((err: unknown) => {
        log.warn(errorInfo(err), 'Не удалось удалить черновик отправленного письма');
      });
  }

  /** Соединение с Postfix submission от имени ящика. */
  function openTransport(email: string, password: string) {
    return nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: { user: email, pass: password },
      // В dev-стеке сертификаты самоподписанные (см. TLS_REJECT_UNAUTHORIZED)
      tls: { rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED },
    });
  }

  /**
   * Достаёт из ящика исходники писем, которые пересылают вложением.
   *
   * Именно с сервера, а не из браузера: письмо уже лежит в ящике целиком,
   * и гонять его вниз и обратно — лишний трафик и лишний способ испортить
   * байты. Имя файла берётся из темы (см. forwardedFilename).
   */
  async function loadForwardedMessages(
    session: MailSession,
    ids: readonly string[],
  ): Promise<ForwardedMessage[]> {
    if (ids.length === 0) return [];
    return pool.withClient(session.email, session.password, async (client) => {
      const found: ForwardedMessage[] = [];
      for (const id of ids) {
        const { folderId, uid } = splitMessageId(id);
        const folder = await requireFolder(client, folderId);
        const lock = await client.getMailboxLock(folder.path);
        try {
          const msg = await client.fetchOne(
            String(uid),
            { uid: true, source: true, envelope: true },
            { uid: true },
          );
          if (!msg || !msg.source) {
            throw new NotFoundError(`Письмо для пересылки не найдено: ${id}`);
          }
          found.push({
            filename: forwardedFilename(msg.envelope?.subject ?? ''),
            raw: msg.source,
          });
        } finally {
          lock.release();
        }
      }
      return found;
    });
  }

  /**
   * Копия отправленного письма в «Отправленных».
   *
   * Неудача здесь — не неудача отправки: письмо уже у получателя. Поэтому
   * функция не бросает, а отвечает признаком.
   */
  async function appendToSent(
    email: string,
    password: string,
    raw: Buffer,
  ): Promise<{ uid?: number } | false> {
    return pool.withClient(email, password, async (client) => {
      const folders = await listFolders(client);
      const sent = findFolderById(folders, 'sent');
      if (!sent) return false;
      return client.append(sent.path, raw, ['\\Seen']);
    });
  }

  /* --- Отложенная отправка ------------------------------------------
   * Работник очереди живёт при этом наборе маршрутов, а не в server.ts:
   * очередь целиком принадлежит написанию письма, и разносить её по двум
   * файлам значило бы, что остановка одного не останавливает второй. */

  /**
   * Убирает загрузки, которые письмо держало ради возможной отмены.
   *
   * Их не удалили при постановке в очередь нарочно: пока отмена возможна,
   * письмо может вернуться в окно написания с теми же идентификаторами
   * вложений (см. DeferredEntry.attachmentIds). Здесь письмо своё отжило —
   * либо ушло, либо не уйдёт никогда, — и держать файлы больше незачем.
   */
  async function dropHeldUploads(entry: DeferredEntry): Promise<void> {
    await Promise.all((entry.attachmentIds ?? []).map((id) => uploads.delete(id)));
  }

  /**
   * Чем кончилась последняя попытка отправки каждого письма в очереди.
   *
   * Работник очереди знает только «получилось / не получилось / повторить»,
   * а человеку нужно ЧТО ИМЕННО ответил почтовый сервер и КОМУ отказали.
   * Единственное место, где это известно, — сама попытка, поэтому причина
   * запоминается там и достаётся, когда попытки исчерпаны.
   *
   * В памяти, а не в конверте на диске: перезапуск сервера обнуляет
   * счётчик попыток не полностью (он в конверте), но потерянная причина —
   * не потеря письма. Пустая причина заменяется общей формулировкой,
   * и молчания всё равно не выходит.
   */
  const lastFailure = new Map<string, SendFailureReason>();
  /**
   * Конверты, о которых человеку уже сказали.
   *
   * Нужно потому, что письмо, не попавшее в «Черновики», остаётся в
   * очереди и работник вернётся к нему на следующем обходе. Извещение
   * при этом одно на письмо: «письмо не отправлено» раз в полминуты —
   * это не забота, а шум, в котором тонет всё остальное.
   *
   * Память переживает не всё: после перезапуска сервера извещение может
   * выписаться второй раз. Это сознательный размен — лучше повтор раз в
   * перезапуск, чем запись на диске ради того, чтобы не повториться.
   */
  const noticed = new Set<string>();

  /**
   * Извещает человека, что письмо не отправлено.
   *
   * Два пути, и они не взаимозаменяемы.
   *
   * ЗАПИСЬ на постоянном томе — основной. Она дожидается человека:
   * вкладка закрыта, браузер выключен, сервер перезапускался — извещение
   * никуда не делось, и почта покажет его при следующем открытии. Ровно
   * этого не хватало: письмо тихо ложилось в черновики, и человек узнавал
   * о нём от адресата.
   *
   * СОБЫТИЕ по сокету — добавка для того случая, когда вкладка открыта
   * прямо сейчас. Оно приходит в ту же секунду и показывается заметно,
   * а не строкой внизу. Само по себе оно ничего не гарантирует (некому
   * доставить — и не доставится), поэтому пишется всегда после записи,
   * а не вместо неё.
   *
   * Уведомлений при закрытой вкладке (src/push) здесь СОЗНАТЕЛЬНО нет.
   * Они выключены по умолчанию и требуют разрешения браузера, то есть
   * у большинства ящиков молчали бы; строить на них извещение об отказе
   * значило бы сделать заметность отказа необязательной. Запись работает
   * у всех и без разрешений.
   */
  async function noticeSendFailure(
    entry: DeferredEntry,
    reason: SendFailureReason,
    draftUid: number | null,
    /** Письмо ушло, но не всем: заголовок извещения от этого меняется. */
    partial = false,
  ): Promise<void> {
    let notice;
    try {
      notice = await spool.addFailure({
        owner: entry.owner,
        subject: entry.subject,
        envelopeTo: entry.envelopeTo,
        reason: reason.reason,
        rejected: reason.rejected,
        attempts: reason.attempts,
        lastAttemptAt: reason.lastAttemptAt,
        partial,
        draftUid,
      });
    } catch (err) {
      app.log.error(
        errorInfo(err, { deferredId: entry.id }),
        'Письмо не отправлено, и записать извещение об этом не удалось',
      );
      return;
    }
    const told = app.mailNotifier?.notify(entry.owner, {
      type: 'send-failed',
      id: notice.id,
      subject: notice.subject,
      reason: notice.reason,
      draftUid: notice.draftUid,
    });
    app.log.warn(
      {
        deferredId: entry.id,
        owner: entry.owner,
        noticeId: notice.id,
        draftUid,
        told: Boolean(told),
      },
      'Письмо не отправлено — сохранено в черновиках, человеку выписано извещение',
    );
  }

  const deferred = new DeferredSender({
    spool,
    deliver: async (entry: DeferredEntry, raw: Buffer): Promise<DeliveryOutcome> => {
      const password = secretBox.decrypt(entry.passwordEnc);
      const transport = openTransport(entry.owner, password);
      let partial: RejectedRecipient[] = [];
      try {
        const info = await transport.sendMail({
          envelope: { from: entry.owner, to: entry.envelopeTo },
          raw,
        });
        /*
         * ЧАСТИЧНЫЙ ОТКАЗ. Нижняя библиотека бросает ошибку, только когда
         * отвергнуты ВСЕ получатели. Если одному ответили 250, а другому
         * 550 «нет такого ящика», обещание разрешается успешно, а отказ
         * лежит внутри ответа.
         *
         * Раньше результат здесь просто выбрасывался, и путь через очередь
         * (а это путь ПО УМОЛЧАНИЮ — отмена отправки включена) терял отказ
         * целиком: человеку сказано «письмо принято», письмо ушло из
         * очереди, извещения нет, черновика нет. Узнать правду он мог
         * только из отчёта о недоставке, если тот вообще настроен. В
         * синхронном пути это давно разобрано (см. send-result.ts) — здесь
         * дефект был воспроизведён заново.
         */
        partial = readSendOutcome(info).rejected;
      } catch (err) {
        const failure = classifySmtpError(err);
        app.log.warn(
          errorInfo(err, { deferredId: entry.id }),
          'Отложенное письмо не ушло с этой попытки',
        );
        // Причину запоминаем на каждой попытке: если попытки кончатся,
        // человеку надо сказать не «не отправилось», а что именно ответил
        // сервер и кому он отказал
        lastFailure.set(entry.id, {
          reason: failure.message,
          rejected: failure.rejected.map((r) => ({ address: r.address, message: r.message })),
          attempts: entry.attempts + 1,
          lastAttemptAt: new Date().toISOString(),
          envelopeTo: entry.envelopeTo,
        });
        return failure.permanent ? 'failed' : 'retry';
      } finally {
        transport.close();
      }
      // Письмо ушло. Копию в «Отправленные» кладём отдельно и не считаем
      // её неудачу неудачей отправки — по той же причине, что и при
      // обычной отправке: письмо уже у получателя.
      await appendToSent(entry.owner, password, raw).catch((err: unknown) => {
        app.log.warn(errorInfo(err), 'Отложенное письмо ушло, копия в «Отправленные» не легла');
      });
      // Теперь письмо у получателя, и возвращать его в окно написания
      // больше не придётся — вложения можно убирать (см. attachmentIds)
      await dropHeldUploads(entry);

      /*
       * Часть адресатов письмо не получила — и это надо СКАЗАТЬ.
       *
       * Отправка считается состоявшейся: остальным письмо доставлено,
       * копия в «Отправленных» лежит, повторять нечего. Но извещение
       * выписывается тем же способом, что и при полном отказе, потому что
       * вопрос у человека ровно один: «дошло ли». Молчание здесь означает
       * «дошло всем», а это неправда.
       */
      if (partial.length > 0) {
        app.log.warn(
          { deferredId: entry.id, rejected: partial.map((r) => r.address) },
          'Отложенное письмо ушло не всем получателям',
        );
        // Черновика здесь нет и не нужно: письмо ушло, переписывать и
        // отправлять заново нечего — правится список получателей, а не
        // само письмо. Поэтому draftUid = null.
        await noticeSendFailure(
          entry,
          {
            reason: 'Письмо доставлено не всем получателям',
            rejected: partial.map((r) => ({ address: r.address, message: r.message })),
            attempts: entry.attempts + 1,
            lastAttemptAt: new Date().toISOString(),
            envelopeTo: entry.envelopeTo,
          },
          null,
          true,
        );
      }
      return 'sent';
    },
    onGiveUp: async (entry, raw) => {
      /**
       * Письмо не ушло и не уйдёт.
       *
       * Три вещи, и все три обязательны. Первая — сохранить написанное
       * в черновики: молча потерять его нельзя, человек уже отдал письмо
       * почте и ушёл. Вторая — сохранить его С ПРИЧИНОЙ: черновик,
       * о происхождении которого приходится догадываться, немногим лучше
       * потери. Третья — СКАЗАТЬ: до появления отмены отправки отказ
       * прилетал человеку прямо в ответ на «Отправить», и обменять это
       * на молчание было бы плохой сделкой.
       */
      const password = secretBox.decrypt(entry.passwordEnc);
      const reason: SendFailureReason = lastFailure.get(entry.id) ?? {
        // Причины нет только если сервер перезапустился между попытками.
        // Общая формулировка честнее молчания: письмо действительно
        // не ушло, а подробности человек увидит в журнале сервера.
        reason: 'Почтовый сервер не принял письмо',
        rejected: [],
        attempts: entry.attempts,
        lastAttemptAt: new Date().toISOString(),
        envelopeTo: entry.envelopeTo,
      };
      let draftUid: number | null = null;
      /*
       * Отказ укладки в черновики — типа Error, потому что его придётся
       * бросить дальше (см. ниже), а бросать не-Error значит потерять и
       * стек, и внятную запись в журнале работника очереди.
       */
      let keepFailure: Error | null = null;
      try {
        draftUid = await pool.withClient(entry.owner, password, async (client) => {
          const folder = await requireDraftsFolder(client);
          // Черновик несёт причину заголовком — окно написания покажет её
          // полосой, как только человек этот черновик откроет. Скрытая
          // копия возвращается туда же: в отправляемых байтах её нет.
          const appended = await client.append(
            folder.path,
            withFailureHeader(raw, reason, entry.bcc ?? []),
            ['\\Draft'],
          );
          return appended && appended.uid ? appended.uid : null;
        });
      } catch (err) {
        // Черновик не лёг — тем более надо сказать. Извещение ниже
        // пишется в любом случае: без него человек не узнает вообще ничего.
        keepFailure = err instanceof Error ? err : new Error(String(err));
        app.log.error(
          errorInfo(err, { deferredId: entry.id }),
          'Письмо не отправлено и не сохранилось в черновиках',
        );
      }

      /*
       * Извещение выписывается ОДИН раз на конверт. Письмо, которое не
       * удалось убрать в черновики, остаётся в очереди (см. ниже), и без
       * этой отметки работник выписывал бы человеку одно и то же
       * извещение каждые полминуты.
       */
      if (!noticed.has(entry.id)) {
        await noticeSendFailure(entry, reason, draftUid);
        noticed.add(entry.id);
      }

      /*
       * ЗДЕСЬ ЗАКАНЧИВАЕТСЯ ЖИЗНЬ ПИСЬМА — И ТОЛЬКО ЕСЛИ ОНО СПАСЕНО.
       *
       * Раньше неудача укладки в черновики гасилась в этом же catch, и
       * onGiveUp завершался успешно. Работник очереди понимал это как
       * «убрано» и стирал с диска и конверт, и тело письма, и
       * удерживаемые вложения — то есть письмо исчезало навсегда.
       * Человек получал извещение «письмо не отправлено» без кнопки
       * «открыть»: знать знал, а восстановить было нечего. Достижимо это
       * не в теории — сменившийся пароль ящика, переполненный ящик,
       * недоступный IMAP: любая из этих причин роняет APPEND.
       *
       * Защита от этого в работнике очереди написана (deferred-send.ts,
       * «письмо стирается ТОЛЬКО после успешной уборки»), но она ждёт
       * ИСКЛЮЧЕНИЯ, а его гасили здесь. Пробрасываем — и письмо остаётся
       * лежать в очереди, пока причина не уйдёт. Лежащий конверт мозолит
       * глаза и разбирается руками; это несравнимо лучше исчезнувшего
       * письма, которое человек считал отправленным.
       */
      if (keepFailure !== null) throw keepFailure;

      lastFailure.delete(entry.id);
      noticed.delete(entry.id);
      // Вложения уже внутри черновика — держать их копии незачем
      await dropHeldUploads(entry);
    },
    log: {
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg),
      error: (obj, msg) => app.log.error(obj, msg),
    },
  });
  deferred.start(DEFERRED_TICK_MS);
  /**
   * Работник виден на этом наборе маршрутов: иначе проверить отправку из
   * очереди можно было бы только ожиданием полуминуты — то есть на деле
   * никак. Декорация живёт в области видимости плагина (наружу, в корневой
   * экземпляр, Fastify её не поднимает) — ровно там, где ей и место.
   */
  app.decorate('deferredSender', deferred);
  // Остановка сервера не должна оставлять за собой работающий таймер:
  // в тестах он держал бы процесс и путал бы соседние проверки.
  app.addHook('onClose', () => {
    deferred.stop();
  });

  /**
   * Сколько секунд у этого ящика на отмену отправки.
   *
   * Настройка спрашивается у сервиса настроек ПРИ ЗАПРОСЕ, а не при
   * подключении маршрутов: раздел настроек регистрируется в app.ts позже
   * написания писем, и на момент сборки этого набора маршрутов декорации
   * ещё нет.
   *
   * Нет настроек (не задана база, отвалился Postgres, старая схема) — ноль,
   * то есть письмо уходит сразу, ровно как до появления возможности.
   * Задерживать чужую почту, не зная, просил ли об этом человек, нельзя:
   * «письмо ушло позже, чем я думал» — это отказ, а «отмены не было» —
   * всего лишь отсутствие удобства.
   */
  async function undoSendSeconds(email: string): Promise<number> {
    const settings = app.settingsService as typeof app.settingsService | undefined;
    if (!settings?.available) return 0;
    try {
      return normalizeUndoSeconds((await settings.requireDb().getSettings(email)).undoSendSeconds);
    } catch (err) {
      app.log.warn(
        errorInfo(err),
        'Не удалось прочитать срок отмены отправки — письмо уйдёт сразу',
      );
      return 0;
    }
  }

  // Отправка письма
  app.post('/messages/send', composeRoute, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    const payload = draftPayloadSchema.parse(request.body);

    const schedule = checkSendAt(payload.sendAt, new Date());
    if (schedule.kind === 'invalid') throw new BadRequestError(schedule.reason);
    if (payload.to.length === 0 && payload.cc.length === 0 && payload.bcc.length === 0) {
      throw new BadRequestError('Не указан ни один получатель');
    }
    // Правильность адресов проверяется здесь, а не схемой запроса: схема
    // отвечает общим «Некорректные данные запроса», из которого человеку
    // непонятно ни что не так, ни где. Здесь можно назвать сам адрес.
    checkSendableAddresses(payload);

    const forwarded = await loadForwardedMessages(session, payload.attachMessageIds ?? []);
    const raw = await composeRaw(
      payload,
      session.email,
      uploads,
      config.MESSAGE_MAX_BYTES,
      forwarded,
    );

    // Предел письма известен заранее — незачем узнавать его от SMTP отказом
    if (raw.length > config.MESSAGE_MAX_BYTES) {
      const kept = await keepDraftAfterFailure(session, payload, forwarded, request.log);
      /*
       * Про черновик говорим ТОЛЬКО когда он есть.
       *
       * Здесь стояло безусловное «Письмо сохранено в черновиках», хотя
       * keepDraftAfterFailure глотает свою неудачу и возвращает draftId:
       * null — например, когда ящик упёрся в квоту и Dovecot отбил APPEND.
       * Человек читал обещание, закрывал окно написания — и текста не
       * оставалось нигде: ни у получателя, ни в «Черновиках».
       *
       * В этой ветке вероятность отказа как раз наибольшая: сохраняется
       * то самое письмо, которое только что признано слишком большим.
       *
       * Соседняя ветка (временный отказ SMTP) написана правильно и
       * проверяет kept.draftId — теперь так делают все три.
       */
      throw new MessageTooLargeError(
        `Письмо ${megabytes(raw.length)} МБ, а почтовый сервер принимает не больше ` +
          `${megabytes(config.MESSAGE_MAX_BYTES)} МБ.` +
          (kept.draftId
            ? ' Письмо сохранено в черновиках.'
            : ' Сохранить его в черновиках тоже не удалось — не закрывайте окно, ' +
              'уберите лишние вложения и попробуйте снова.'),
        kept,
      );
    }

    /**
     * Отложенная отправка. Письмо уже собрано целиком — вместе с вложениями,
     * подписью и заголовками, — поэтому в очередь кладутся готовые байты:
     * позже пересобирать нечего и не из чего. Черновик убирается сразу,
     * иначе одно письмо оказалось бы и в очереди, и в «Черновиках», и
     * человек отправил бы его второй раз руками.
     */
    if (schedule.kind === 'later') {
      const entry = await spool.add(
        {
          owner: session.email,
          passwordEnc: secretBox.encrypt(session.password),
          sendAt: schedule.at.toISOString(),
          envelopeTo: allRecipients(payload),
          subject: payload.subject,
          // Скрытых получателей в собранных байтах нет и быть не должно —
          // они едут отдельно, чтобы вернуться в письмо, если оно уедет
          // в «Черновики» (см. DeferredEntry.bcc).
          bcc: payload.bcc.map((a) => a.address),
        },
        raw,
      );
      await dropDraftAfterSend(session, payload, request.log);
      await Promise.all(payload.attachmentIds.map((id) => uploads.delete(id)));
      request.log.info(
        { deferredId: entry.id, sendAt: entry.sendAt },
        'Письмо принято к отложенной отправке',
      );
      return {
        ok: true,
        scheduled: true,
        sendAt: entry.sendAt,
        sentMessageId: null,
        accepted: [],
        rejected: [],
        savedToSent: false,
        warning: null,
      };
    }

    /**
     * Отмена отправки: письмо уходит в ту же очередь, только на секунды.
     *
     * Держим его НА СЕРВЕРЕ, а не таймером в браузере, и это главное
     * отличие: закрытая вкладка (случайно закрытая, упавшая, уснувший
     * телефон) отменяет только возможность передумать, а письмо всё равно
     * уходит. Таймер в браузере в этом месте молча терял бы письма.
     *
     * Загрузки вложений здесь НЕ удаляются — в отличие от отправки
     * «завтра в девять» ниже. Пока отмена возможна, письмо может вернуться
     * в окно написания с теми же идентификаторами вложений, а удалённые
     * файлы превратили бы возвращённое письмо в письмо без вложений.
     * Их уберёт работник очереди, когда письмо действительно уйдёт.
     */
    const undoSeconds = schedule.kind === 'now' ? await undoSendSeconds(session.email) : 0;
    if (undoSeconds > 0) {
      const sendAt = new Date(Date.now() + undoSeconds * 1000);
      const entry = await spool.add(
        {
          owner: session.email,
          passwordEnc: secretBox.encrypt(session.password),
          sendAt: sendAt.toISOString(),
          envelopeTo: allRecipients(payload),
          subject: payload.subject,
          attachmentIds: payload.attachmentIds,
          bcc: payload.bcc.map((a) => a.address),
        },
        raw,
      );
      await dropDraftAfterSend(session, payload, request.log);
      // Будильник ровно на срок: постоянный обход очереди ходит раз
      // в полминуты и «через пять секунд» превратил бы в «когда-нибудь»
      deferred.wakeAt(sendAt);
      request.log.info(
        { pendingId: entry.id, undoUntil: entry.sendAt },
        'Письмо принято к отправке с возможностью отмены',
      );
      return {
        ok: true,
        /** По нему письмо и отзывают — POST /api/messages/send/undo. */
        pendingId: entry.id,
        /** До какого момента отмена ещё сработает (ISO). */
        undoUntil: entry.sendAt,
        sentMessageId: null,
        accepted: [],
        rejected: [],
        savedToSent: false,
        warning: null,
      };
    }

    const transport = openTransport(session.email, session.password);

    let rejected: RejectedRecipient[] = [];
    let accepted: string[] = [];
    try {
      const info = await transport.sendMail({
        envelope: { from: session.email, to: allRecipients(payload) },
        raw,
      });
      // Postfix отвечает на каждого получателя отдельно: часть адресов могла
      // быть отвергнута (`550 User unknown`) при успешном ответе в целом.
      // Раньше это поле не читалось вовсе и пользователю сообщалось,
      // что письмо ушло всем.
      const outcome = readSendOutcome(info);
      rejected = outcome.rejected;
      accepted = outcome.accepted;
    } catch (err) {
      const failure = classifySmtpError(err);
      if (failure.permanent) {
        // Сервер доступен и ответил отказом: повторять бессмысленно,
        // 503 «почтовый сервер недоступен» здесь был неправдой дважды
        request.log.warn(
          errorInfo(err, { smtpCode: failure.code }),
          'Почтовый сервер отклонил письмо',
        );
        const kept = await keepDraftAfterFailure(session, payload, forwarded, request.log);
        const details = {
          ...kept,
          smtpCode: failure.code,
          rejected: failure.rejected,
        };
        // Тот же случай: обещать черновик можно, только если он записался.
        const message =
          failure.message +
          (kept.draftId
            ? '. Письмо сохранено в черновиках.'
            : '. Сохранить письмо в черновиках тоже не удалось — не закрывайте окно.');
        throw failure.tooLarge
          ? new MessageTooLargeError(message, details)
          : new SendRejectedError(message, details);
      }
      /**
       * Временный отказ: сервер недоступен, временная ошибка
       * аутентификации, перезапуск служб (в том числе штатное обновление
       * продукта). Раньше здесь просто отдавалась 503 — и письмо пропадало
       * целиком: черновик сохранялся ТОЛЬКО при постоянном отказе и при
       * превышении размера, а в «Черновиках» после такого отказа было
       * пусто. Человек терял набранный текст на ровном месте, причём
       * ровно в тот момент, когда повтор через минуту сработал бы.
       *
       * Загруженные вложения намеренно НЕ удаляем: отказ временный, и
       * повторная отправка из того же окна написания ссылается на те же
       * идентификаторы загрузок. Их подчистит уборщик (см. uploads.sweep).
       */
      request.log.warn(errorInfo(err), 'Ошибка отправки через SMTP submission');
      const kept = await keepDraftAfterFailure(session, payload, forwarded, request.log);
      throw new UpstreamUnavailableError(
        kept.draftId
          ? 'Почтовый сервер сейчас недоступен, письмо не отправлено. ' +
              'Текст сохранён в черновиках — попробуйте отправить ещё раз.'
          : 'Почтовый сервер сейчас недоступен, письмо не отправлено.',
        kept,
      );
    } finally {
      transport.close();
    }

    /**
     * Дальше письмо УЖЕ ушло получателю. Всё, что не получилось после
     * этого, — не повод объявлять отправку неудачной.
     *
     * Как это выглядело: ящик на 81% квоты, письмо с вложением. Получатель
     * письмо получил, но APPEND копии в «Отправленные» отбит по квоте —
     * и API отвечал 500 «Внутренняя ошибка». Человек видел ошибку, не
     * находил письма в «Отправленных» и отправлял заново: у получателя
     * оказывались два одинаковых письма. Неудача сохранения копии не
     * должна выглядеть как неудача отправки.
     */
    let appended: { uid?: number } | false = false;
    let savedToSent = true;
    try {
      appended = await appendToSent(session.email, session.password, raw);
      if (!appended) savedToSent = false;
    } catch (err) {
      savedToSent = false;
      request.log.warn(
        errorInfo(err),
        'Письмо отправлено, но копию в «Отправленные» сохранить не удалось',
      );
    }

    /**
     * Флаг «отвечено» на исходном письме: в привычных почтовых интерфейсах у отвеченного письма
     * в списке появляется стрелка. Флаг живёт в ящике, поэтому его видят
     * и другие клиенты, и он переживает перезагрузку страницы.
     * Неудача — не повод отменять успешную отправку.
     */
    if (payload.inReplyTo) {
      try {
        await pool.withClient(session.email, session.password, (client) =>
          markAnswered(client, payload.inReplyTo as string),
        );
      } catch (err) {
        request.log.warn(errorInfo(err), 'Не удалось пометить исходное письмо отвеченным');
      }
    }

    await dropDraftAfterSend(session, payload, request.log);

    // Загруженные вложения больше не нужны
    await Promise.all(payload.attachmentIds.map((id) => uploads.delete(id)));

    return {
      // false, если хотя бы один получатель отклонён: письмо ушло не всем
      ok: rejected.length === 0,
      sentMessageId: appended && appended.uid ? `sent:${appended.uid}` : null,
      accepted,
      rejected,
      /**
       * Письмо отправлено, но копии в «Отправленных» нет (например, ящик
       * переполнен). Отдельное поле, а не ошибка: иначе человек решит,
       * что письмо не ушло, и отправит его второй раз.
       */
      savedToSent,
      warning: savedToSent
        ? null
        : 'Письмо отправлено, но копия не сохранена в «Отправленных» — ' +
          'возможно, закончилось место в ящике.',
    };
  });

  /**
   * Отзыв письма, ещё лежащего в очереди отмены.
   *
   * Отвечает 200 и в том случае, когда отменить не вышло: опоздание — это
   * не поломка сервера, а обычный исход гонки, и человеку про него надо
   * сказать отдельными словами («письмо уже ушло»), а не общим текстом
   * ошибки. Молчание же или ложное «отменено» здесь хуже всего: человек
   * уверен, что письма нет, а оно у получателя.
   *
   * Замок берётся ДО чтения записи и держится до её удаления. Без него
   * работник очереди успевал бы отдать письмо SMTP между нашей проверкой
   * и удалением файлов — и мы отвечали бы «отменено» об ушедшем письме.
   * Захват синхронный, поэтому в одном процессе Node это настоящее
   * взаимное исключение (см. DeferredSender.claim).
   */
  app.post('/messages/send/undo', { preHandler: app.requireSession }, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    const { pendingId } = z
      .object({ pendingId: z.string().min(1).max(100) })
      .parse(request.body ?? {});

    const gone = { ok: true, cancelled: false as const };
    if (!deferred.claim(pendingId)) return gone;
    try {
      const entry = await spool.get(pendingId);
      // Чужое письмо для нас неотличимо от несуществующего — и отвечаем
      // одинаково: сказать «это письмо не ваше» значило бы подтвердить,
      // что такое письмо есть.
      if (!entry || entry.owner !== session.email) return gone;
      await spool.remove(pendingId);
      request.log.info({ pendingId }, 'Отправка отменена, письмо снято с очереди');
      /**
       * Следов не остаётся никаких: копия в «Отправленные» кладётся только
       * после успешной отправки (см. deliver), черновик человеку возвращает
       * не ящик, а само окно написания — оно его и не теряло.
       */
      return { ok: true, cancelled: true as const };
    } finally {
      deferred.release(pendingId);
    }
  });

  /**
   * Письма, которые отправить не удалось, — те, о которых человеку ещё
   * не сказали.
   *
   * Почта спрашивает этот список при каждом открытии, а не только по
   * событию сокета: событие увидит лишь та вкладка, что была открыта
   * в момент отказа. Человек, закрывший вкладку и вернувшийся наутро,
   * обязан узнать то же самое.
   */
  app.get('/messages/send/failures', { preHandler: app.requireSession }, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    return { items: await spool.failures(session.email) };
  });

  /**
   * «Понятно» — человек прочитал извещение.
   *
   * Убирается только по явному действию человека, а не по показу: плашку
   * легко не заметить (переключил вкладку, отвлёкся), и извещение,
   * пропавшее само, вернуло бы нас ровно к молчаливой потере.
   */
  app.post('/messages/send/failures/ack', { preHandler: app.requireSession }, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.body ?? {});
    return { ok: true, removed: await spool.removeFailure(session.email, id) };
  });

  // Сохранение черновика
  app.post('/drafts', composeRoute, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    const payload = draftPayloadSchema.parse(request.body);

    // Пересылаемые вложением письма попадают и в черновик: иначе сохранение
    // черновика молча выбрасывало бы их, а отправить потом было бы нечего.
    const forwarded = await loadForwardedMessages(session, payload.attachMessageIds ?? []);
    // keepBcc — чтобы «Скрытая копия» дожила до дописывания черновика,
    // см. composeRaw. У отправляемого письма этого заголовка быть не должно.
    const raw = await composeRaw(
      payload,
      session.email,
      uploads,
      config.MESSAGE_MAX_BYTES,
      forwarded,
      {
        keepBcc: true,
      },
    );
    const uid = await saveDraftVersion(session, raw, payload.draftUid, payload.draftKey);

    return {
      ok: true,
      draftId: uid ? `drafts:${uid}` : null,
      draftUid: uid,
    };
  });

  /**
   * Чтение черновика обратно в окно написания.
   *
   * Этого маршрута не было, и из-за этого сохранённый черновик нельзя было
   * дописать вообще ничем: он сохранялся, показывался в папке — и на этом
   * всё. Щелчок по нему открывал просмотр письма, а окно написания не
   * открывалось никак.
   *
   * Вложения. В ящике они лежат частями MIME, а окну написания нужны
   * идентификаторы загрузок — только с ними письмо потом соберётся заново.
   * Поэтому вложения черновика кладутся во временное хранилище ЗАНОВО, и
   * наружу уходят новые идентификаторы. Обратная сторона — открытый и
   * брошенный черновик оставляет копии файлов в хранилище; их убирает тот же
   * уборщик, что и брошенные загрузки окна написания (uploads.sweep), и это
   * дешевле, чем потерять вложение при первом же дописывании.
   */
  app.get('/drafts/:uid', { preHandler: app.requireSession }, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    const { uid } = z.object({ uid: z.coerce.number().int().positive() }).parse(request.params);

    const source = await pool.withClient(session.email, session.password, async (client) => {
      const folder = await requireDraftsFolder(client);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        return msg && msg.source ? msg.source : null;
      } finally {
        lock.release();
      }
    });
    if (!source) throw new NotFoundError('Черновик не найден');

    /**
     * Черновик, вернувшийся из очереди отправки, несёт причину заголовком
     * (см. SEND_FAILURE_HEADER). Читаем её здесь и отдаём отдельным полем:
     * человек, открывший такой черновик, не должен гадать, откуда взялось
     * письмо, которого он не сохранял, и почему оно не ушло.
     */
    const parsed = await parseDraftSource(source);
    const sendFailure = readFailureFromRaw(source);
    const attachments: DraftContent['attachments'] = [];
    for (const part of parsed.attachments) {
      const meta = await uploads.save(
        session.email,
        part.filename,
        part.mimeType,
        Readable.from(part.content),
      );
      attachments.push({ id: meta.id, filename: meta.filename, size: meta.size });
    }

    const content: DraftContent = {
      draftUid: uid,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      bodyHtml: parsed.bodyHtml,
      attachments,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      requestReadReceipt: parsed.requestReadReceipt,
      // Пусто у обычного черновика; заполнено — значит письмо уже пробовали
      // отправить и не смогли, и окно написания скажет об этом полосой
      sendFailure,
    };
    return content;
  });

  /**
   * Ответ на просьбу уведомить о прочтении.
   *
   * Маршрут живёт здесь, а не среди маршрутов чтения писем: его работа —
   * отправить письмо, и он делает это тем же способом и тем же соединением,
   * что и обычная отправка.
   *
   * `send: false` — человек отказался. Уведомление не уходит, но ключевое
   * слово `$MDNSent` ставится всё равно (RFC 3503 предписывает именно так):
   * иначе отказ ничего не значил бы и вопрос возвращался бы при каждом
   * открытии письма — на любом устройстве и в любой почтовой программе.
   */
  app.post('/messages/:id/read-receipt', { preHandler: app.requireSession }, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const { send } = z.object({ send: z.boolean() }).parse(request.body ?? {});
    const { folderId, uid } = splitMessageId(id);

    const found = await pool.withClient(session.email, session.password, async (client) => {
      const folder = await requireFolder(client, folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, headers: true, envelope: true, flags: true },
          { uid: true },
        );
        if (!msg) return null;
        return {
          path: folder.path,
          headerBlock: msg.headers ?? Buffer.alloc(0),
          subject: msg.envelope?.subject ?? '',
          messageId: msg.envelope?.messageId ?? null,
          already: msg.flags?.has('$MDNSent') ?? false,
        };
      } finally {
        lock.release();
      }
    });
    if (!found) throw new NotFoundError('Письмо не найдено');
    // Второй раз уведомлять не о чем: письмо прочитано один раз, и повтор
    // означал бы, что кнопка «не отправлять» ничего не значит.
    if (found.already) return { ok: true, sent: false, alreadyAnswered: true };

    const headers = await parseMessageHeaders(found.headerBlock);
    const asked = readReceiptRequest(headers);
    if (!asked) throw new BadRequestError('Это письмо не просит уведомления о прочтении');

    let sent = false;
    if (send) {
      const raw = buildReadReceipt({
        from: session.email,
        to: asked.address,
        originalSubject: found.subject,
        originalMessageId: found.messageId,
        hostname: session.email.split('@')[1] ?? 'localhost',
      });
      const transport = openTransport(session.email, session.password);
      try {
        await transport.sendMail({
          envelope: { from: session.email, to: [asked.address] },
          raw,
        });
        sent = true;
      } catch (err) {
        const failure = classifySmtpError(err);
        request.log.warn(errorInfo(err), 'Не удалось отправить уведомление о прочтении');
        // Отказ виден человеку: молчаливое «ничего не произошло» здесь —
        // ровно та беда, из-за которой эта кнопка и переделывалась.
        throw failure.permanent
          ? new SendRejectedError(`${failure.message}. Уведомление не отправлено.`)
          : new UpstreamUnavailableError(
              'Почтовый сервер сейчас недоступен, уведомление не отправлено.',
            );
      } finally {
        transport.close();
      }
    }

    // Ставится и после отправки, и после отказа — см. комментарий выше
    await pool.withClient(session.email, session.password, async (client) => {
      const lock = await client.getMailboxLock(found.path);
      try {
        await client.messageFlagsAdd([uid], ['$MDNSent'], { uid: true });
      } finally {
        lock.release();
      }
    });

    return { ok: true, sent, alreadyAnswered: false };
  });
}

/** Экспорт для юнит-тестов. */
export { draftPayloadSchema };
