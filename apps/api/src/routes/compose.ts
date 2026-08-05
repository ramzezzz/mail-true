/**
 * Отправка писем (POST /api/messages/send) и черновики (POST /api/drafts).
 * Письмо собирается MailComposer'ом в RFC822, отправляется через Postfix
 * submission (nodemailer SMTP) и тем же байтовым представлением
 * сохраняется копия в «Отправленные» (IMAP APPEND).
 */
import type { FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import type { Folder, MailAddress } from '@mail-true/shared';
import {
  BadRequestError,
  MessageTooLargeError,
  SendRejectedError,
  UnauthorizedError,
  UpstreamUnavailableError,
} from '../errors.js';
import { listFolders, markAnswered } from '../imap/service.js';
import { findFolderById } from '../mail/folders.js';
import { DraftSequencer } from '../mail/draft-sequencer.js';
import { classifySmtpError, readSendOutcome, type RejectedRecipient } from '../mail/send-result.js';
import { htmlToText } from '../mail/text.js';
import { sanitizeEmailHtml } from '../mail/sanitize.js';
import type { MailSession } from '../types.js';
import type { UploadStore } from '../uploads.js';
import { errorInfo } from '../log.js';

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
  inReplyTo: z.string().max(1000).optional(),
  references: z.array(z.string().max(1000)).max(100).optional(),
  sendAt: z.string().datetime({ offset: true }).optional(),
});

type DraftBody = z.infer<typeof draftPayloadSchema>;

function formatAddresses(list: MailAddress[]): Mail.Address[] {
  return list.map((a) => ({ name: a.name ?? '', address: a.address }));
}

/** Собирает письмо в RFC822-байты. */
async function composeRaw(
  payload: DraftBody,
  from: string,
  uploads: UploadStore
): Promise<Buffer> {
  const attachments: Mail.Attachment[] = [];
  for (const id of payload.attachmentIds) {
    const found = await uploads.get(id);
    if (!found) throw new BadRequestError(`Вложение не найдено: ${id}`);
    attachments.push({
      filename: found.meta.filename,
      path: found.path,
      contentType: found.meta.mimeType,
    });
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

  const composer = new MailComposer(options);
  return composer.compile().build();
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
  const { config, pool, uploads } = app.deps;
  // Сохранения черновика одного окна написания идут строго по очереди —
  // иначе автосохранение вместе с явным «сохранить» плодит копии письма
  const drafts = new DraftSequencer();

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
    draftKey: string | undefined
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
      })
    );
  }

  /**
   * Письмо не ушло и не уйдёт — сохраняем текст, чтобы он не пропал.
   * Раньше при постоянном отказе SMTP письмо терялось целиком.
   */
  async function keepDraftAfterFailure(
    session: MailSession,
    raw: Buffer,
    payload: DraftBody,
    log: { warn: (obj: unknown, msg: string) => void }
  ): Promise<{ draftUid: number | null; draftId: string | null }> {
    if (payload.draftUid) {
      // Исходный черновик не трогали — он на месте
      return { draftUid: payload.draftUid, draftId: `drafts:${payload.draftUid}` };
    }
    try {
      const uid = await saveDraftVersion(session, raw, undefined, payload.draftKey);
      return { draftUid: uid, draftId: uid ? `drafts:${uid}` : null };
    } catch (err) {
      log.warn(errorInfo(err), 'Не удалось сохранить черновик после отказа отправки');
      return { draftUid: null, draftId: null };
    }
  }

  // Отправка письма
  app.post('/messages/send', composeRoute, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    const payload = draftPayloadSchema.parse(request.body);

    if (payload.sendAt && new Date(payload.sendAt).getTime() > Date.now() + 60_000) {
      // Планировщик отложенной отправки пока не реализован
      throw new BadRequestError('Отложенная отправка пока не поддерживается');
    }
    if (payload.to.length === 0 && payload.cc.length === 0 && payload.bcc.length === 0) {
      throw new BadRequestError('Не указан ни один получатель');
    }
    // Правильность адресов проверяется здесь, а не схемой запроса: схема
    // отвечает общим «Некорректные данные запроса», из которого человеку
    // непонятно ни что не так, ни где. Здесь можно назвать сам адрес.
    checkSendableAddresses(payload);

    const raw = await composeRaw(payload, session.email, uploads);

    // Предел письма известен заранее — незачем узнавать его от SMTP отказом
    if (raw.length > config.MESSAGE_MAX_BYTES) {
      const kept = await keepDraftAfterFailure(session, raw, payload, request.log);
      throw new MessageTooLargeError(
        `Письмо ${megabytes(raw.length)} МБ, а почтовый сервер принимает не больше ` +
          `${megabytes(config.MESSAGE_MAX_BYTES)} МБ. Письмо сохранено в черновиках.`,
        kept
      );
    }

    const transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: { user: session.email, pass: session.password },
      // В dev-стеке сертификаты самоподписанные (см. TLS_REJECT_UNAUTHORIZED)
      tls: { rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED },
    });

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
        request.log.warn(errorInfo(err, { smtpCode: failure.code }), 'Почтовый сервер отклонил письмо');
        const kept = await keepDraftAfterFailure(session, raw, payload, request.log);
        const details = {
          ...kept,
          smtpCode: failure.code,
          rejected: failure.rejected,
        };
        const message = `${failure.message}. Письмо сохранено в черновиках.`;
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
      const kept = await keepDraftAfterFailure(session, raw, payload, request.log);
      throw new UpstreamUnavailableError(
        kept.draftId
          ? 'Почтовый сервер сейчас недоступен, письмо не отправлено. ' +
            'Текст сохранён в черновиках — попробуйте отправить ещё раз.'
          : 'Почтовый сервер сейчас недоступен, письмо не отправлено.',
        kept
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
      appended = await pool.withClient(session.email, session.password, async (client) => {
        const folders = await listFolders(client);
        const sent = findFolderById(folders, 'sent');
        let result: { uid?: number } | false = false;
        if (sent) {
          result = await client.append(sent.path, raw, ['\\Seen']);
        }
        return result;
      });
      if (!appended) savedToSent = false;
    } catch (err) {
      savedToSent = false;
      request.log.warn(
        errorInfo(err),
        'Письмо отправлено, но копию в «Отправленные» сохранить не удалось'
      );
    }

    /**
     * Флаг «отвечено» на исходном письме: в mail.ru у отвеченного письма
     * в списке появляется стрелка. Флаг живёт в ящике, поэтому его видят
     * и другие клиенты, и он переживает перезагрузку страницы.
     * Неудача — не повод отменять успешную отправку.
     */
    if (payload.inReplyTo) {
      try {
        await pool.withClient(session.email, session.password, (client) =>
          markAnswered(client, payload.inReplyTo as string)
        );
      } catch (err) {
        request.log.warn(errorInfo(err), 'Не удалось пометить исходное письмо отвеченным');
      }
    }

    if (payload.draftUid || payload.draftKey) {
      // Через ту же очередь, что и автосохранение: иначе таймер успеет
      // положить новую копию уже отправленного письма
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
          request.log.warn(errorInfo(err), 'Не удалось удалить черновик отправленного письма');
        });
    }

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

  // Сохранение черновика
  app.post('/drafts', composeRoute, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    const payload = draftPayloadSchema.parse(request.body);

    const raw = await composeRaw(payload, session.email, uploads);
    const uid = await saveDraftVersion(session, raw, payload.draftUid, payload.draftKey);

    return {
      ok: true,
      draftId: uid ? `drafts:${uid}` : null,
      draftUid: uid,
    };
  });
}

/** Экспорт для юнит-тестов. */
export { draftPayloadSchema };
