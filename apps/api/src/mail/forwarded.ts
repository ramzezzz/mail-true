/**
 * Письма, вложенные в другое письмо целиком, — «Переслать как вложение».
 *
 * Живёт отдельным модулем, потому что путей отправки у нас два: своё
 * письмо (routes/compose.ts) и письмо с подключённого чужого адреса через
 * его SMTP (accounts/routes.ts). Второй путь эту возможность просто
 * терял: плашки вложенных писем были видны в окне до самого нажатия
 * «Отправить», в запрос они не попадали, а человеку говорили «Письмо
 * отправлено с адреса …». Получатель не получал ни одного из них.
 *
 * Собирать их двумя способами нельзя по той же причине, по какой у ответа
 * одна сборка на список и на страницу письма: два способа однажды
 * разъезжаются, и разъезжаются молча.
 */

import type { ImapFlow } from 'imapflow';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { NotFoundError } from '../errors.js';
import { requireFolder, splitMessageId } from '../imap/service.js';

/** Письмо, вложенное в другое письмо целиком (message/rfc822). */
export interface ForwardedMessage {
  /** Имя файла вложения — обычно тема исходного письма с «.eml». */
  filename: string;
  /** Исходник письма как он лежит в ящике. */
  raw: Buffer;
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

/**
 * Читает исходники пересылаемых писем ИЗ СВОЕГО ящика.
 *
 * Именно с сервера, а не из браузера: письмо уже лежит в ящике целиком,
 * и гонять его вниз и обратно — лишний трафик и лишний способ испортить
 * байты.
 *
 * Ящик здесь всегда свой, даже когда письмо уходит с чужого адреса:
 * пересылают то, что человек получил у нас.
 */
export async function loadForwardedMessages(
  client: ImapFlow,
  ids: readonly string[],
): Promise<ForwardedMessage[]> {
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
