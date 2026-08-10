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
import { findFolderById, MAX_ENTITY_ID_LENGTH } from '../mail/folders.js';
import { parseDraftSource, type DraftAttachmentPart } from '../mail/draft-read.js';
import { cidToPartMap } from '../mail/structure.js';
import { DraftSequencer } from '../mail/draft-sequencer.js';
import {
  checkSendAt,
  DeferredSender,
  DeferredSpool,
  normalizeUndoSeconds,
  readFailureFromRaw,
  withBccHeader,
  withFailureHeader,
  type DeferredEntry,
  type DeliveryOutcome,
  type SendFailureReason,
} from '../mail/deferred-send.js';
import {
  forwardedAttachment,
  loadForwardedMessages as readForwardedMessages,
  type ForwardedMessage,
} from '../mail/forwarded.js';
import { parseMessageHeaders } from '../mail/parse.js';
import { buildReadReceipt, readReceiptRequest } from '../mail/read-receipt.js';
import { classifySmtpError, readSendOutcome, type RejectedRecipient } from '../mail/send-result.js';
import {
  imapPartSource,
  inlineQuotedImages,
  type InlineImageSource,
} from '../mail/inline-images.js';
import { htmlToText } from '../mail/text.js';
import { sanitizeEmailHtml } from '../mail/sanitize.js';
import { ENCODING_OVERHEAD } from '../config.js';
import type { ImapPool } from '../imap/pool.js';
import type { AppDeps, MailSession } from '../types.js';
import { UploadQuotaError, type UploadStore } from '../uploads.js';
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
   *
   * Длина — общая для всего продукта (MAX_ENTITY_ID_LENGTH). Здесь стояло
   * своё «200», и это был не запас, а потолок: идентификатор письма —
   * `f-<base64url(путь папки)>:<uid>`, а base64url прибавляет к пути треть.
   * Папка из семи десятков русских букв (кириллица — два байта на букву)
   * уже перебирала двести символов, и письмо из такой папки нельзя было
   * переслать вложением вовсе: сервер отвечал «Некорректные данные
   * запроса», из которого не следует ни что не так, ни что делать.
   */
  attachMessageIds: z.array(z.string().min(1).max(MAX_ENTITY_ID_LENGTH)).max(10).optional(),
  inReplyTo: z.string().max(1000).optional(),
  references: z.array(z.string().max(1000)).max(100).optional(),
  requestReadReceipt: z.boolean().optional(),
  sendAt: z.string().datetime({ offset: true }).optional(),
});

type DraftBody = z.infer<typeof draftPayloadSchema>;

function formatAddresses(list: MailAddress[]): Mail.Address[] {
  return list.map((a) => ({ name: a.name ?? '', address: a.address }));
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
  settings?: {
    keepBcc?: boolean;
    /**
     * Имя отправителя из настроек ящика — то, что получатель видит в поле
     * «От кого» вместо голого адреса.
     *
     * Настройка была объявлена (settings/types.ts), показывалась в форме и
     * прямо обещала «имя видит получатель», но не читалась НИКЕМ: письмо
     * собиралось с `from` = адрес. Причём окно написания показывало
     * человеку имя — вычисленное из адреса (routes/account.ts), а не то,
     * что он вписал, — так что расхождение было незаметно до тех пор, пока
     * получатель не спросит, почему письма приходят «от ivan.petrov@».
     */
    fromName?: string;
    /**
     * Откуда брать встроенные картинки цитируемого письма.
     *
     * В теле, которое цитирует окно написания, они стоят ссылками на наш
     * же маршрут (`/api/messages/…/parts/…`) — так письмо готовится для
     * ЧТЕНИЯ. Отправить такую ссылку нельзя: санитайзер снимает адрес
     * целиком, и у получателя остаётся `<img>` без картинки. Здесь части
     * скачиваются из ящика и прикладываются встроенными вложениями —
     * см. mail/inline-images.ts.
     */
    inlineSource?: InlineImageSource;
    /**
     * Переносить картинки «сколько поместится», а не отказывать целиком.
     *
     * Нужно ровно одному вызову — спасению текста в «Черновики» после
     * отказа отправки. Там письмо УЖЕ признано неотправляемым (чаще всего
     * именно по размеру), и отказ из-за не поместившейся картинки означал
     * бы, что черновик не запишется вовсе: человек потерял бы весь текст
     * вместо одной картинки. Не поместившаяся остаётся ссылкой на наш же
     * маршрут — в черновике она открывается и показывается, в отличие от
     * уходящего письма, где такая ссылка бесполезна получателю.
     */
    inlineBestEffort?: boolean;
  },
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

  /*
   * Встроенные картинки цитаты — во вложения письма.
   *
   * ДО САНИТАЙЗЕРА, и это не мелочь порядка. Санитайзер знает про схемы
   * `cid:` и `https:`, а наш собственный путь `/api/messages/…/parts/…`
   * для него чужой: атрибут снимается целиком, и после него переносить
   * уже нечего — именно так пересылка и теряла все встроенные картинки.
   * Здесь ссылка превращается в `cid:`, которую санитайзер пропускает.
   *
   * Заодно ДО подсчёта размера ниже: картинки из чужого письма весят
   * ровно столько же, сколько весили там, и упереться в предел письма
   * человек должен здесь, а не получить отказ от SMTP.
   */
  let bodyHtml = payload.bodyHtml;
  if (settings?.inlineSource) {
    const inlined = await inlineQuotedImages(
      bodyHtml,
      settings.inlineSource,
      // Остаток предела в ИСХОДНЫХ байтах: письмо кодируется base64, и
      // тот же запас, что у обычных вложений, нужен и здесь.
      Math.max(0, Math.floor(messageMaxBytes / ENCODING_OVERHEAD) - attachedBytes),
    );
    bodyHtml = inlined.html;
    for (const item of inlined.attachments) {
      attachedBytes += Buffer.isBuffer(item.content) ? item.content.length : 0;
      attachments.push(item);
    }
    /*
     * Картинки, не поместившиеся в предел, — это отказ, а не мелочь.
     *
     * Молча оставить ссылку значит вернуться ровно к тому, что чинилось:
     * получатель видит письмо без картинок и не знает почему. Отказываем
     * до отправки и теми же словами, что и при тяжёлых вложениях.
     */
    if (inlined.skipped > 0 && settings.inlineBestEffort !== true) {
      throw new MessageTooLargeError(
        `Письмо не помещается в предел ${megabytes(messageMaxBytes)} МБ: ` +
          `картинок из цитаты не поместилось — ${String(inlined.skipped)}. ` +
          'Уберите часть цитируемого письма или перешлите его вложением.',
        {
          limitBytes: messageMaxBytes,
          projectedBytes: Math.round(attachedBytes * ENCODING_OVERHEAD),
        },
      );
    }
  }

  /*
   * Сумма считается ПОСЛЕ переноса картинок: они тоже вложения, и не
   * учитывать их значило бы пропустить письмо, которое всё равно не
   * пройдёт по размеру, — но узнал бы об этом уже SMTP.
   */
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
  const cleanHtml = sanitizeEmailHtml(bodyHtml, {
    allowRemote: true,
    /*
     * Ссылки `cid:` остаются: письмо уходит наружу, и это правильный вид
     * ссылки на встроенную картинку. При показе письма такую ссылку
     * снимают — открыть её браузером нечем, — и снятие здесь означало бы
     * `<img>` без картинки у получателя.
     */
    keepCid: true,
  }).html;

  const options: Mail.Options = {
    // Имя ставится объектом, а не строкой: экранирование кавычек и
    // кодирование кириллицы в заголовке делает сам сборщик письма.
    from: settings?.fromName ? { name: settings.fromName, address: from } : from,
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

/**
 * Очередь сохранений черновика — ОДНА на приложение, а не на набор маршрутов.
 *
 * Сохранения одного окна написания обязаны идти строго по одному: иначе
 * автосохранение вместе с явным «сохранить» плодит копии письма. Но окно
 * написания ходит не только сюда: письмо с подключённого чужого адреса
 * уходит совсем другим маршрутом (accounts/routes.ts), а черновик у него
 * тот же самый и лежит в НАШЕЙ папке «Черновики». Со своей очередью на
 * каждый набор маршрутов уборка черновика после отправки «от имени»
 * разошлась бы с автосохранением: таймер успел бы положить новую копию
 * уже отправленного письма.
 *
 * Привязка к `deps`, а не просто к модулю: `deps` — один объект на
 * приложение (см. app.ts), и в проверках каждый поднятый экземпляр
 * получает свой. Иначе состояние окон текло бы из одной проверки в
 * другую, а по-настоящему это значит — из одного приложения в другое.
 */
const draftSequencers = new WeakMap<AppDeps, DraftSequencer>();

export function draftSequencerFor(deps: AppDeps): DraftSequencer {
  const existing = draftSequencers.get(deps);
  if (existing) return existing;
  const created = new DraftSequencer();
  draftSequencers.set(deps, created);
  return created;
}

/** Черновик, из которого письмо отправляют: UID в ящике и/или ключ окна. */
export interface DraftRef {
  draftUid?: number | undefined;
  draftKey?: string | undefined;
}

/**
 * Убирает черновик письма, которое уже принято к отправке.
 *
 * Через ту же очередь, что и автосохранение: иначе таймер успеет положить
 * новую копию уже отправленного письма. Неудача сюда не поднимается —
 * письмо-то ушло.
 *
 * Отдельной функцией, а не замыканием маршрута: ровно то же самое обязана
 * делать отправка с подключённого чужого адреса. Она этого не делала, и
 * черновик оставался лежать: человек открывал сохранённое письмо,
 * переключал отправителя на внешний адрес, отправлял — а через неделю
 * находил черновик в папке и отправлял его второй раз. У получателя дубль.
 */
export async function dropDraftAfterSend(
  drafts: DraftSequencer,
  pool: ImapPool,
  session: MailSession,
  ref: DraftRef,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<void> {
  if (!ref.draftUid && !ref.draftKey) return;
  const key = ref.draftKey ? `${session.email}:${ref.draftKey}` : session.email;
  await drafts
    .save(key, ref.draftUid, Boolean(ref.draftKey), async (previousUid) => {
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

export async function composeRoutes(app: FastifyInstance): Promise<void> {
  const { config, pool, secretBox, uploads } = app.deps;
  const drafts = draftSequencerFor(app.deps);

  /**
   * Вложения черновиков, уже выложенные во временное хранилище.
   *
   * Ключ — ящик и UID черновика, значение — что именно для него выложено.
   *
   * Зачем это нужно. Открытие черновика (GET /drafts/:uid) кладёт его
   * вложения в хранилище ЗАНОВО: окну написания нужны идентификаторы
   * загрузок, а в ящике лежат части MIME. Но открытий у одного черновика
   * сколько угодно — открыл, посмотрел, закрыл, вернулся, — и каждое
   * оставляло в хранилище ещё одну копию всех файлов. Копии считаются в
   * занятое ящиком место (uploads.usedBy), поэтому черновик с парой
   * тяжёлых вложений за несколько открытий съедал предел на ящик, и
   * человек упирался в «предел на ящик — 250,0 МБ», пытаясь прикрепить
   * обычный файл к СОВСЕМ ДРУГОМУ письму. Связи между причиной и отказом
   * не видно никакой.
   *
   * Поэтому повторное открытие того же черновика отдаёт те же загрузки,
   * если они ещё на месте и черновик с тех пор не менялся (сверяется
   * отпечаток: имена, типы и размеры частей). Изменился или загрузки
   * унесло уборщиком — выкладываем заново, теперь уже с проверкой места.
   */
  const materializedDrafts = new Map<string, { fingerprint: string; ids: string[] }>();
  /** Сколько черновиков помним. Забытый — просто выложится заново. */
  const MATERIALIZED_MAX = 500;

  /** Чем один набор вложений черновика отличается от другого. */
  function attachmentsFingerprint(parts: readonly DraftAttachmentPart[]): string {
    return parts.map((p) => `${p.filename}|${p.mimeType}|${String(p.content.length)}`).join('\n');
  }

  /**
   * Те же загрузки, что и в прошлое открытие, — если они ещё на месте.
   * Пропала хоть одна (уборщик, отправка соседнего письма) — набор считаем
   * негодным целиком: половина вложений хуже, чем выложить их заново.
   */
  async function reuseUploads(
    owner: string,
    ids: readonly string[],
  ): Promise<DraftContent['attachments'] | null> {
    const found: DraftContent['attachments'] = [];
    for (const id of ids) {
      const upload = await uploads.get(id, owner);
      if (!upload) return null;
      found.push({ id: upload.meta.id, filename: upload.meta.filename, size: upload.meta.size });
    }
    return found;
  }

  /**
   * Вложения черновика во временном хранилище — по одному набору на
   * черновик, а не по набору на каждое открытие (см. materializedDrafts).
   *
   * Место проверяется ТЕМ ЖЕ пределом, что и обычная загрузка файла
   * (routes/uploads.ts): этот путь клал файлы мимо всякой проверки, но в
   * занятое место они засчитывались — то есть переполнить хранилище через
   * него было можно, а узнать об этом человек мог только по отказу в
   * другом окне.
   */
  async function draftAttachments(
    session: MailSession,
    uid: number,
    parts: readonly DraftAttachmentPart[],
  ): Promise<DraftContent['attachments']> {
    if (parts.length === 0) return [];
    const key = `${session.email}:${String(uid)}`;
    const fingerprint = attachmentsFingerprint(parts);
    const remembered = materializedDrafts.get(key);
    if (remembered && remembered.fingerprint === fingerprint) {
      const reused = await reuseUploads(session.email, remembered.ids);
      if (reused) return reused;
    }

    const incoming = parts.reduce((sum, part) => sum + part.content.length, 0);
    const used = await uploads.usedBy(session.email);
    if (used + incoming > config.UPLOAD_MAILBOX_MAX_BYTES) {
      throw new UploadQuotaError(
        'Вложения черновика не помещаются во временное хранилище: предел на ящик — ' +
          `${megabytes(config.UPLOAD_MAILBOX_MAX_BYTES)} МБ. ` +
          'Отправьте или удалите начатые письма и откройте черновик снова.',
      );
    }

    const saved: DraftContent['attachments'] = [];
    for (const part of parts) {
      const meta = await uploads.save(
        session.email,
        part.filename,
        part.mimeType,
        Readable.from(part.content),
      );
      saved.push({ id: meta.id, filename: meta.filename, size: meta.size });
    }
    materializedDrafts.set(key, { fingerprint, ids: saved.map((a) => a.id) });
    if (materializedDrafts.size > MATERIALIZED_MAX) {
      // Map помнит порядок вставки — уходит самый старый черновик
      const oldest = materializedDrafts.keys().next().value;
      if (oldest !== undefined) materializedDrafts.delete(oldest);
    }
    return saved;
  }

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

  /**
   * Отправка вдобавок ограничена ПО ЯЩИКУ, а не по адресу клиента.
   *
   * Общий предел частоты считает запросы с одного адреса, и для отправки
   * это неверно с обеих сторон: захваченный ящик получал три сотни писем
   * в минуту (столько же, сколько весь остальной API), а контора за одним
   * внешним адресом делила предел между всеми сотрудниками сразу.
   *
   * Ключ — адрес ящика из сессии; без сессии до сюда не доходят
   * (preHandler выше), но на всякий случай остаётся адрес клиента.
   */
  const sendRoute = {
    ...composeRoute,
    config: {
      rateLimit: {
        max: config.SEND_RATE_PER_MINUTE,
        timeWindow: 60_000,
        /*
         * hook: 'preHandler' — обязателен, а не украшение.
         *
         * По умолчанию ограничитель частоты вешается на onRequest, то есть
         * ДО проверки сессии: `request.mailSession` там ещё пуст, ключом
         * молча становился адрес клиента, и предел «по ящику» на деле
         * оставался прежним пределом по адресу — ровно тем, от которого
         * этот маршрут и уводили. На preHandler наш requireSession стоит
         * первым (плагин дописывает свой обработчик в конец), поэтому
         * адрес ящика к этому моменту уже известен.
         */
        hook: 'preHandler' as const,
        keyGenerator: (request: { mailSession?: MailSession | null; ip: string }): string =>
          request.mailSession?.email ?? request.ip,
      },
    },
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
    /*
     * КАРТИНКИ ПЕРЕНОСЯТСЯ И СЮДА.
     *
     * Собиралось это письмо без `inlineSource`, и оттого спасённый
     * черновик ложился в ящик с пустыми `<img>`: ссылки на наш маршрут
     * частей санитайзер снимает при сборке, а переносить их во вложения
     * было некому. То есть после отказа почтового сервера человек
     * получал в «Черновиках» письмо, из которого пропали все картинки
     * пересылаемого — и узнавал об этом, только отправив его повторно.
     *
     * Соседний путь (обычное сохранение черновика) переносит их с самого
     * начала; здесь дефект был воспроизведён заново.
     */
    /*
     * ПИСЬМО СОХРАНЯЕТСЯ ВСЕГДА — В ТОМ ЧИСЛЕ ПОВЕРХ ОТКРЫТОГО ЧЕРНОВИКА.
     *
     * Раньше здесь первой же строкой стоял выход: «черновик прислан, значит
     * он на месте». На месте он и правда был — только СТАРЫЙ. Человек
     * открывал сохранённое письмо, дописывал две страницы, получал отказ
     * 550 — и читал в ответе «Письмо сохранено в черновиках», хотя в
     * черновиках лежала версия недельной давности. Написанное за эту
     * сессию пропадало целиком, а сообщение утверждало обратное.
     *
     * Теперь новая версия кладётся поверх прежней (saveDraftVersion сам
     * удалит заменённую), поэтому копий не прибавляется — а текст цел.
     */
    try {
      const raw = await pool.withClient(session.email, session.password, (client) =>
        composeRaw(payload, session.email, uploads, config.MESSAGE_MAX_BYTES, forwarded, {
          keepBcc: true,
          inlineSource: imapPartSource(client, requireFolder, splitMessageId),
          /*
           * «Сколько поместится» — потому что сюда приходят и письма,
           * которые не проходят по размеру. Отказ на этом месте оставил
           * бы человека вовсе без черновика (см. inlineBestEffort).
           */
          inlineBestEffort: true,
        }),
      );
      const uid = await saveDraftVersion(session, raw, payload.draftUid, payload.draftKey);
      return { draftUid: uid, draftId: uid ? `drafts:${uid}` : null };
    } catch (err) {
      log.warn(errorInfo(err), 'Не удалось сохранить черновик после отказа отправки');
      /*
       * Сохранить не вышло. Про открытый черновик здесь НЕ говорим, хотя
       * он и остался лежать: он несёт прежний текст, а человеку нужен
       * нынешний. Ответ на этом пути так и написан — «сохранить не
       * удалось, не закрывайте окно», и это единственный честный совет:
       * текст сейчас есть только в самом окне.
       */
      return { draftUid: null, draftId: null };
    }
  }

  /** Убирает черновик письма, которое уже принято к отправке. */
  const dropSentDraft = (
    session: MailSession,
    payload: DraftBody,
    log: { warn: (obj: unknown, msg: string) => void },
  ): Promise<void> => dropDraftAfterSend(drafts, pool, session, payload, log);

  /** Соединение с Postfix submission от имени ящика. */
  function openTransport(email: string, password: string) {
    return nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: { user: email, pass: password },
      // В dev-стеке сертификаты самоподписанные (см. TLS_REJECT_UNAUTHORIZED)
      tls: { rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED },
      /*
       * СВОИ СРОКИ ОЖИДАНИЯ — ВМЕСТО БИБЛИОТЕЧНЫХ.
       *
       * У nodemailer умолчания рассчитаны на чужой сервер в интернете:
       * две минуты на соединение, полминуты на приветствие и ДЕСЯТЬ МИНУТ
       * молчания сокета. Наш submission стоит в соседнем контейнере, и
       * такие сроки означают вот что: одно зависшее соединение держит
       * очередь целиком — она обходится строго по одному письму
       * (deferred-send.ts), — то есть пятисекундная «отмена отправки» у
       * всех остальных ящиков превращается в десятиминутную. Письма при
       * этом не теряются, повтор отработает; ломается обещание «уйдёт
       * через пять секунд», причём сразу у всех.
       *
       * Числа с запасом на настоящую работу: приветствие и соединение —
       * секунды даже на нагруженном сервере, а молчание сокета должно
       * пережить передачу тяжёлого вложения на медленном канале.
       */
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 120_000,
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
    return pool.withClient(session.email, session.password, (client) =>
      readForwardedMessages(client, ids),
    );
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
      let partial: RejectedRecipient[] = [];

      /*
       * SMTP уже принимал это письмо — второй раз не отдаём.
       *
       * Так бывает, когда процесс умер между ответом «250» и удалением
       * конверта: там остаются копия в «Отправленные», уборка вложений
       * и пометка исходного письма, то есть секунды сетевой работы.
       * Перезапуск в этот момент — обычное дело (кнопка в панели,
       * обновление образа), а письмо у получателя задваивалось.
       *
       * Хвост доделываем: копия в «Отправленных» могла не лечь, а
       * вложения — остаться. Отправку пропускаем.
       */
      if (entry.sentAt) {
        app.log.warn(
          { deferredId: entry.id, sentAt: entry.sentAt },
          'Письмо уже принято SMTP ранее: повторно не отправляем, доделываем хвост',
        );
        await appendToSent(entry.owner, password, raw).catch((err: unknown) => {
          app.log.warn(errorInfo(err), 'Копия письма в «Отправленные» не легла и на этот раз');
        });
        await dropHeldUploads(entry);
        return 'sent';
      }

      const transport = openTransport(entry.owner, password);
      try {
        const info = await transport.sendMail({
          envelope: { from: entry.owner, to: entry.envelopeTo },
          raw,
        });
        /*
         * Отметка «SMTP принял» — ПЕРВЫМ делом, до всего хвоста.
         * Разбор — в комментарии к DeferredEntry.sentAt.
         */
        await spool.markSent(entry.id).catch((err: unknown) => {
          app.log.error(
            errorInfo(err, { deferredId: entry.id }),
            'Не удалось отметить письмо принятым: при перезапуске оно может уйти повторно',
          );
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
       * Флаг «отвечено» на исходном письме — ЗДЕСЬ, а не только на
       * синхронном пути.
       *
       * Отмена отправки включена по умолчанию, то есть каждое обычное
       * письмо уходит через эту очередь: пометку ставил код, до которого
       * при настройках по умолчанию не доходило никогда. Стрелка у
       * отвеченного письма не появлялась ни в вебе, ни в почтовой
       * программе — и человек отвечал во второй раз.
       *
       * Неудача пометки отправку не отменяет: письмо уже у получателя, а
       * флаг — украшение поверх.
       */
      if (entry.inReplyTo) {
        const original = entry.inReplyTo;
        await pool
          .withClient(entry.owner, password, (client) => markAnswered(client, original))
          .catch((err: unknown) => {
            app.log.warn(errorInfo(err), 'Исходное письмо не помечено отвеченным');
          });
      }

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
      /*
       * Письмо своё отжило — причину последней неудачи держать больше не
       * за чем. Раньше запись удалялась только в onGiveUp, то есть у
       * письма, которое сорвалось однажды и потом ушло, она оставалась в
       * памяти процесса навсегда. Не авария, но растёт бесконечно.
       */
      lastFailure.delete(entry.id);
      noticed.delete(entry.id);
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
        /*
         * РАСШИФРОВКА ПАРОЛЯ — ВНУТРИ try, И ЭТО НЕ КОСМЕТИКА.
         *
         * Она стояла первой строкой обработчика, ВНЕ его. После смены
         * SESSION_SECRET (плановая ротация, перенос установки,
         * восстановление тома) расшифровка бросает — и бросала ДО того,
         * как человеку выпишут извещение. Работник очереди понимал
         * исключение правильно (письмо остаётся в очереди, чтобы не
         * пропасть), но человек не узнавал ни-че-го: ни черновика, ни
         * записи, ни строки в почте. Письмо молча крутилось в очереди,
         * а он ждал ответа от адресата.
         *
         * Извещение ниже пишется в любом случае — оно пароля не требует.
         */
        const password = secretBox.decrypt(entry.passwordEnc);
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

  /**
   * Имя отправителя этого ящика — то, что увидит получатель в «От кого».
   *
   * Спрашивается при запросе по той же причине, что и срок отмены
   * отправки: раздел настроек подключается позже маршрутов письма.
   * Настроек нет или база молчит — письмо уходит с голым адресом, как
   * уходило раньше: имя это удобство, а не условие доставки.
   */
  async function senderDisplayName(email: string): Promise<string> {
    const settings = app.settingsService as typeof app.settingsService | undefined;
    if (!settings?.available) return '';
    try {
      const name = (await settings.requireDb().getSettings(email)).senderName ?? '';
      return name.trim().slice(0, 255);
    } catch (err) {
      app.log.warn(errorInfo(err), 'Не удалось прочитать имя отправителя — письмо уйдёт без него');
      return '';
    }
  }

  // Отправка письма
  app.post('/messages/send', sendRoute, async (request) => {
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
    const fromName = await senderDisplayName(session.email);
    const raw = await pool.withClient(session.email, session.password, (client) =>
      composeRaw(payload, session.email, uploads, config.MESSAGE_MAX_BYTES, forwarded, {
        ...(fromName ? { fromName } : {}),
        /*
         * Соединение с ящиком нужно только ради встроенных картинок
         * цитаты: их части лежат в том письме, которое человек пересылает.
         * Без таких картинок в теле сюда никто не ходит —
         * inlineQuotedImages выходит сразу, не открывая ни одной папки.
         */
        inlineSource: imapPartSource(client, requireFolder, splitMessageId),
      }),
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
          // На какое письмо отвечаем: работник очереди поставит исходному
          // флаг «отвечено» после успешной отправки.
          ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
          // Скрытых получателей в собранных байтах нет и быть не должно —
          // они едут отдельно, чтобы вернуться в письмо, если оно уедет
          // в «Черновики» (см. DeferredEntry.bcc).
          bcc: payload.bcc.map((a) => a.address),
          // Отложено человеком: при отмене письмо возвращается в
          // «Черновики», а не стирается (см. DeferredEntry.scheduled).
          scheduled: true,
        },
        raw,
      );
      await dropSentDraft(session, payload, request.log);
      await Promise.all(payload.attachmentIds.map((id) => uploads.delete(id)));
      request.log.info(
        { deferredId: entry.id, sendAt: entry.sendAt },
        'Письмо принято к отложенной отправке',
      );
      return {
        ok: true,
        scheduled: true,
        sendAt: entry.sendAt,
        /**
         * Номер письма в очереди — им же его и отменяют.
         *
         * Раньше здесь стоял только `sendAt`, и отменить отложенное
         * письмо было нечем: номер знал лишь сервер, а список очереди
         * интерфейс не спрашивал. Письмо исчезало из виду до самого срока.
         */
        pendingId: entry.id,
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
          // Та же причина, что и у отложенной отправки: пометку
          // «отвечено» ставит работник очереди, а не этот запрос.
          ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
          attachmentIds: payload.attachmentIds,
          bcc: payload.bcc.map((a) => a.address),
        },
        raw,
      );
      await dropSentDraft(session, payload, request.log);
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

    await dropSentDraft(session, payload, request.log);

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
    const { pendingId, heldByWindow } = z
      .object({
        pendingId: z.string().min(1).max(100),
        /**
         * ОКНО НАПИСАНИЯ ДЕРЖИТ ЭТО ПИСЬМО И ВЕРНЁТ ЕГО СЕБЕ САМО.
         *
         * Единственный случай, когда возвращать письмо в «Черновики» не
         * надо: пятисекундная отмена, нажатая в том же окне, откуда письмо
         * ушло. Там оно живёт целиком — с телом, получателями и теми же
         * вложениями, — и черновик стал бы лишней копией.
         *
         * Во всех остальных случаях окна нет. Раньше выбор делался по
         * признаку `scheduled` — «отложено человеком», — и это было
         * неверно: обычное письмо, которому почтовый сервер отказал
         * временно, работник переносит на новый срок, и оно попадает в
         * панель «Уйдут позже» уже БЕЗ всякого окна (оно закрылось через
         * пять секунд). Кнопка «Отменить» на такой строке стирала письмо
         * с диска целиком: ни в «Черновиках», ни в окне, ни в очереди —
         * при том что панель прямо обещает возврат в «Черновики».
         *
         * Поэтому умолчание безопасное: не сказали — значит возвращаем.
         * Старый клиент из кэша браузера в худшем случае получит лишний
         * черновик рядом с вернувшимся окном, а не потерянное письмо.
         */
        heldByWindow: z.boolean().optional(),
      })
      .parse(request.body ?? {});

    const gone = { ok: true, cancelled: false as const, reason: 'gone' as const };
    /*
     * Замок занят — письмо прямо сейчас в работе у очереди. Это НЕ то же
     * самое, что «письмо ушло»: работник держит замок и на неудачной
     * попытке, и на всей укладке в черновики, а интерфейс на прежний
     * ответ говорил «письмо уже ушло» и закрывал окно вместе с текстом.
     * Отдаём отдельную причину, чтобы можно было сказать правду и
     * предложить повторить.
     */
    if (!deferred.claim(pendingId)) {
      return { ok: true, cancelled: false as const, reason: 'sending' as const };
    }
    try {
      const entry = await spool.get(pendingId);
      // Чужое письмо для нас неотличимо от несуществующего — и отвечаем
      // одинаково: сказать «это письмо не ваше» значило бы подтвердить,
      // что такое письмо есть.
      if (!entry || entry.owner !== session.email) return gone;

      /*
       * SMTP УЖЕ ПРИНЯЛ ЭТО ПИСЬМО — ОТМЕНЯТЬ НЕЧЕГО.
       *
       * Конверт с отметкой `sentAt` лежит в очереди не потому, что письмо
       * не ушло, а потому, что не доделан хвост: копия в «Отправленные»,
       * уборка вложений, пометка исходного письма. Процесс мог умереть
       * ровно в этом окне (перезапуск из панели, обновление образа), и
       * тогда конверт дожидается следующего обхода — работник увидит
       * отметку, отправлять второй раз не станет и доделает остальное.
       *
       * Прежний код этой отметки не смотрел: он снимал конверт с очереди
       * и отвечал «отменено» о письме, которое уже у получателя. Хуже
       * того, вместе с конвертом пропадал и хвост — копия в
       * «Отправленных» не появлялась уже никогда, и у человека не
       * оставалось ни следа отправленного письма.
       */
      if (entry.sentAt) {
        request.log.info(
          { pendingId, sentAt: entry.sentAt },
          'Отмена опоздала: письмо уже принято почтовым сервером',
        );
        return { ok: true, cancelled: false as const, reason: 'gone' as const };
      }

      /*
       * ПИСЬМО ВОЗВРАЩАЕТСЯ В «ЧЕРНОВИКИ» — ВЕЗДЕ, КРОМЕ ОДНОГО СЛУЧАЯ.
       *
       * Случай этот — пятисекундная отмена из того же окна написания:
       * письмо там целиком, окно его и вернёт, а черновик был бы лишней
       * копией. Про то, что окно живо, говорит сам клиент (heldByWindow);
       * гадать об этом на сервере не по чему.
       *
       * Раньше здесь стояло `if (entry.scheduled)`, то есть возврат
       * полагался только письмам, отложенным человеком. Разбор — в
       * комментарии к heldByWindow выше: обычное письмо после временного
       * отказа SMTP живёт в очереди без окна, и «Отменить» его уничтожало.
       *
       * Скрытая копия возвращается заголовком: в отправляемых байтах её
       * нет, а в черновике она нужна — иначе дописанное письмо уйдёт без
       * части получателей.
       */
      let draftUid: number | null = null;
      if (!heldByWindow) {
        try {
          const raw = await spool.raw(pendingId);
          if (raw) {
            draftUid = await pool.withClient(session.email, session.password, async (client) => {
              const folder = await requireDraftsFolder(client);
              const appended = await client.append(
                folder.path,
                withBccHeader(raw, entry.bcc ?? []),
                ['\\Draft'],
              );
              return appended && appended.uid ? appended.uid : null;
            });
          }
        } catch (err) {
          /*
           * Не легло — письмо НЕ снимаем с очереди и честно говорим об
           * этом. Стереть его сейчас значило бы потерять текст: другого
           * места, где он есть, не осталось.
           */
          request.log.error(
            errorInfo(err, { pendingId }),
            'Отложенное письмо не удалось вернуть в черновики — оставляем в очереди',
          );
          return {
            ok: false as const,
            cancelled: false as const,
            reason: 'draft-failed' as const,
            message:
              'Письмо не удалось вернуть в «Черновики», поэтому оно осталось в очереди. ' +
              'Проверьте, есть ли место в ящике, и попробуйте ещё раз.',
          };
        }
      }

      await spool.remove(pendingId);
      request.log.info({ pendingId, draftUid }, 'Отправка отменена, письмо снято с очереди');
      /**
       * Копии в «Отправленных» не остаётся: она кладётся только после
       * успешной отправки (см. deliver). Всё остальное зависит от того,
       * кто держал письмо: окно написания или очередь на сутки.
       */
      return {
        ok: true,
        cancelled: true as const,
        draftUid,
        draftId: draftUid ? `drafts:${String(draftUid)}` : null,
      };
    } finally {
      deferred.release(pendingId);
    }
  });

  /**
   * Письма, ожидающие своего часа: «Отправить позже».
   *
   * ------------------------------------------------------------------
   * ЗАЧЕМ ЭТОТ СПИСОК
   * ------------------------------------------------------------------
   * Нажав «Отправить позже», человек терял письмо из виду целиком: оно
   * уходит из «Черновиков» (иначе одно письмо лежало бы в двух местах и
   * ушло бы дважды), в «Отправленные» ещё не попало, а списка очереди в
   * продукте не было. Ни посмотреть, ни исправить, ни отменить — при
   * том что отмена по номеру работает давно, только сам номер жил в
   * памяти окна написания и пропадал вместе с ним.
   *
   * Отдаётся ровно то, что нужно строке списка: кому, о чём и когда
   * уйдёт. Самих писем здесь нет — за телом человек идёт в отмену,
   * которая возвращает письмо в окно.
   */
  app.get('/messages/scheduled', { preHandler: app.requireSession }, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    const items = await spool.scheduledFor(session.email);
    return {
      items: items.map((entry) => ({
        id: entry.id,
        sendAt: entry.sendAt,
        subject: entry.subject,
        to: entry.envelopeTo,
        /**
         * Сколько раз отправка срывалась. Ноль — обычное ожидание;
         * больше — сервер получателя пока не принимает, и человеку
         * лучше знать об этом до срока, а не после.
         */
        attempts: entry.attempts ?? 0,
      })),
    };
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
    /*
     * Картинки цитаты переносим и в ЧЕРНОВИК.
     *
     * Иначе выходило так: человек нажал «Переслать», сохранил черновик,
     * вернулся к нему завтра — а картинок в теле уже нет. Ссылки на наш
     * маршрут санитайзер снимает при сборке письма, и в черновике
     * оставался `<img>` без адреса; дальше письмо уходило без картинок,
     * хотя по прямому пути «переслать и сразу отправить» они доезжали.
     */
    const raw = await pool.withClient(session.email, session.password, (client) =>
      composeRaw(payload, session.email, uploads, config.MESSAGE_MAX_BYTES, forwarded, {
        keepBcc: true,
        inlineSource: imapPartSource(client, requireFolder, splitMessageId),
      }),
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

    /*
     * Строение письма берётся вместе с исходником, одним заходом.
     *
     * Оно нужно ради встроенных картинок: в теле черновика они стоят
     * ссылками `cid:`, а показать их можно только по номеру части
     * (`/api/messages/drafts:<uid>/parts/<часть>`). Соответствие «cid ->
     * номер части» живёт в BODYSTRUCTURE и больше нигде: разбор самих
     * байтов номеров частей не знает. Разбор — в DraftReadOptions.
     */
    const found = await pool.withClient(session.email, session.password, async (client) => {
      const folder = await requireDraftsFolder(client);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, source: true, bodyStructure: true },
          { uid: true },
        );
        return msg && msg.source ? { source: msg.source, structure: msg.bodyStructure } : null;
      } finally {
        lock.release();
      }
    });
    if (!found) throw new NotFoundError('Черновик не найден');
    const source = found.source;

    /**
     * Черновик, вернувшийся из очереди отправки, несёт причину заголовком
     * (см. SEND_FAILURE_HEADER). Читаем её здесь и отдаём отдельным полем:
     * человек, открывший такой черновик, не должен гадать, откуда взялось
     * письмо, которого он не сохранял, и почему оно не ушло.
     */
    const cidMap = cidToPartMap(found.structure);
    const parsed = await parseDraftSource(source, {
      resolveCid: (cid) => {
        const part = cidMap.get(cid);
        return part
          ? `/api/messages/${encodeURIComponent(`drafts:${String(uid)}`)}/parts/` +
              encodeURIComponent(part)
          : null;
      },
    });
    const sendFailure = readFailureFromRaw(source);
    const attachments = await draftAttachments(session, uid, parsed.attachments);

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
    // Предел длины — общий для всего продукта: письмо из папки с длинным
    // русским названием тоже просит уведомления о прочтении, а со своим
    // «200» этот маршрут отвечал ему «Некорректные данные запроса», и
    // вопрос «уведомить отправителя?» возвращался при каждом открытии.
    const { id } = z
      .object({ id: z.string().min(1).max(MAX_ENTITY_ID_LENGTH) })
      .parse(request.params);
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

    /*
     * Ставится и после отправки, и после отказа — см. комментарий выше.
     *
     * НЕУДАЧА ЭТОЙ ОТМЕТКИ НЕ ОТМЕНЯЕТ УЖЕ ОТПРАВЛЕННОГО УВЕДОМЛЕНИЯ.
     * Раньше отказ IMAP здесь ронял маршрут пятисоткой, хотя уведомление
     * к этому моменту было у отправителя. Человек читал «Не удалось
     * отправить уведомление», нажимал ещё раз — и отправителю уходило
     * второе. Причины отказа житейские: ящик упёрся в квоту, соединение
     * оборвалось, сервер не даёт ставить ключевые слова.
     *
     * Поэтому: уведомление ушло — говорим правду об обоих действиях
     * отдельно. Уведомления не было (человек отказался) — отметка и есть
     * всё содержание запроса, и промолчать о её неудаче нельзя: вопрос
     * «уведомить отправителя?» вернётся при следующем открытии письма.
     */
    let flagged = true;
    try {
      await pool.withClient(session.email, session.password, async (client) => {
        const lock = await client.getMailboxLock(found.path);
        try {
          await client.messageFlagsAdd([uid], ['$MDNSent'], { uid: true });
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      flagged = false;
      request.log.warn(errorInfo(err), 'Не удалось пометить письмо как отвеченное ($MDNSent)');
      if (!sent) {
        throw new UpstreamUnavailableError(
          'Не удалось запомнить отказ — вопрос об уведомлении появится снова.',
        );
      }
    }

    return {
      ok: true,
      sent,
      alreadyAnswered: false,
      /** Отметка $MDNSent на месте: без неё вопрос вернётся при открытии. */
      flagged,
      warning: flagged
        ? null
        : 'Уведомление отправлено, но пометить письмо не удалось — ' +
          'вопрос может появиться снова. Второй раз подтверждать не нужно.',
    };
  });
}

/** Экспорт для юнит-тестов. */
export { draftPayloadSchema };
