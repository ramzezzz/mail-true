/**
 * Сборка письма для отправки «от имени» внешнего адреса.
 *
 * Отдельно от src/routes/compose.ts: там письмо собирается для НАШЕГО
 * ящика и уходит через наш submission, здесь — для чужого адреса и
 * чужого SMTP. Общего у них только формат RFC822, а различий достаточно
 * (вложения из нашего хранилища, но отправитель и транспорт чужие),
 * чтобы не сращивать два пути в один с флагами.
 */
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { ENCODING_OVERHEAD } from '../config.js';
import { BadRequestError, MessageTooLargeError } from '../errors.js';
import { forwardedAttachment, type ForwardedMessage } from '../mail/forwarded.js';
import { inlineQuotedImages, type InlineImageSource } from '../mail/inline-images.js';
import { inlineDataImages } from '../mail/inline-data.js';
import { htmlToText } from '../mail/text.js';
import { sanitizeEmailHtml } from '../mail/sanitize.js';
import type { UploadStore } from '../uploads.js';

/** Размер по-человечески — теми же словами, что и на своём пути отправки. */
function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',');
}

export interface ExternalAddress {
  name: string | null;
  address: string;
}

export interface ExternalDraft {
  to: ExternalAddress[];
  cc: ExternalAddress[];
  bcc: ExternalAddress[];
  subject: string;
  bodyHtml: string;
  attachmentIds: string[];
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  /**
   * Письма, вложенные целиком, — «Переслать как вложение».
   *
   * Раньше этой возможности на внешнем пути не было вовсе: плашки
   * вложенных писем были видны в окне до самого нажатия «Отправить», в
   * запрос они не попадали, а человеку говорили «Письмо отправлено
   * с адреса …». Получатель не получал ни одного из них.
   */
  attachMessageIds?: string[] | undefined;
  /** Просьба уведомить о прочтении — тем же заголовком, что и у своих писем. */
  requestReadReceipt?: boolean | undefined;
}

function toMailAddresses(list: ExternalAddress[]): Mail.Address[] {
  return list.map((a) => ({ name: a.name ?? '', address: a.address }));
}

/** Все получатели письма — конверт SMTP собирается по ним. */
export function externalRecipients(draft: ExternalDraft): string[] {
  return [...draft.to, ...draft.cc, ...draft.bcc].map((a) => a.address);
}

/**
 * Собирает письмо в байты RFC822.
 * Пользовательский HTML прогоняется через санитайзер и здесь: рассылать
 * скрипты по чужому серверу — тем более не наша задача.
 */
export async function composeExternalRaw(
  draft: ExternalDraft,
  from: { name: string | null; address: string },
  uploads: UploadStore,
  /**
   * Ящик веб-почты, который эти вложения загрузил. НЕ адрес отправителя:
   * письмо уходит с внешнего адреса, а файлы лежат под учёткой того, кто
   * вошёл, — по ней хранилище и проверяет владельца.
   */
  owner: string,
  /**
   * Предел письма целиком — тот же, что и у своего пути отправки.
   *
   * Раньше на этом пути не было ни предела, ни суммы вложений: письмо
   * собиралось целиком в память (nodemailer держит его дважды), уезжало
   * чужому серверу и получало отказ уже от него — а до отказа успевало
   * съесть память процесса, то есть уронить почту всем остальным. На
   * своём пути это давно закрыто; здесь дефект жил отдельной жизнью.
   */
  messageMaxBytes: number,
  /** Письма, пересылаемые целиком: их исходники читает вызывающий. */
  forwarded: readonly ForwardedMessage[] = [],
  settings: {
    /**
     * Откуда брать встроенные картинки цитаты — см. mail/inline-images.ts.
     *
     * Без этого письмо с чужого адреса уходило БЕЗ ЕДИНОЙ картинки:
     * в теле они стоят ссылками на наш маршрут частей, и санитайзер
     * снимает такой адрес целиком. Свой путь отправки переносит их во
     * встроенные вложения с самого начала, а этот — не переносил, и
     * пересылка с подключённого адреса молча теряла всю графику.
     */
    inlineSource?: InlineImageSource;
  } = {},
): Promise<Buffer> {
  const attachments: Mail.Attachment[] = [];
  let attachedBytes = 0;
  for (const item of forwarded) {
    attachedBytes += item.raw.length;
    attachments.push(forwardedAttachment(item));
  }
  for (const id of draft.attachmentIds) {
    const found = await uploads.get(id, owner);
    if (!found) throw new BadRequestError(`Вложение не найдено: ${id}`);
    attachedBytes += found.meta.size;
    attachments.push({
      filename: found.meta.filename,
      path: found.path,
      contentType: found.meta.mimeType,
    });
  }

  // Картинки цитаты — ДО санитайзера: после него переносить уже нечего,
  // адрес снят целиком. Разбор порядка — в routes/compose.ts.
  let bodyHtml = draft.bodyHtml;
  if (settings.inlineSource) {
    const inlined = await inlineQuotedImages(
      bodyHtml,
      settings.inlineSource,
      Math.max(0, Math.floor(messageMaxBytes / ENCODING_OVERHEAD) - attachedBytes),
    );
    bodyHtml = inlined.html;
    for (const item of inlined.attachments) {
      attachedBytes += Buffer.isBuffer(item.content) ? item.content.length : 0;
      attachments.push(item);
    }
    if (inlined.skipped > 0) {
      throw new MessageTooLargeError(
        `Письмо не помещается в предел ${megabytes(messageMaxBytes)} МБ: ` +
          `картинок из цитаты не поместилось — ${String(inlined.skipped)}. ` +
          'Уберите часть цитируемого письма или перешлите его вложением.',
        { limitBytes: messageMaxBytes },
      );
    }
  }

  /*
   * Вшитые в тело картинки (`data:`) — во вложения, как и на своём пути
   * отправки: снимок экрана из буфера и картинка дописываемого черновика
   * приходят именно так, а получателю `data:` в письме не показывают ни
   * Outlook, ни Gmail.
   */
  const dataImages = inlineDataImages(
    bodyHtml,
    Math.max(0, Math.floor(messageMaxBytes / ENCODING_OVERHEAD) - attachedBytes),
  );
  bodyHtml = dataImages.html;
  attachedBytes += dataImages.bytes;
  for (const item of dataImages.attachments) attachments.push(item);
  if (dataImages.skipped > 0) {
    throw new MessageTooLargeError(
      `Письмо не помещается в предел ${megabytes(messageMaxBytes)} МБ: ` +
        `вставленных картинок не поместилось — ${String(dataImages.skipped)}. ` +
        'Уберите часть картинок или отправьте их вложениями.',
      { limitBytes: messageMaxBytes },
    );
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

  // `keepCid: true` — по той же причине, что и на своём пути: письмо
  // уходит наружу, и `cid:` там единственный работающий вид ссылки на
  // встроенную картинку. Без него перенос выше был бы бессмыслен.
  const cleanHtml = sanitizeEmailHtml(bodyHtml, { allowRemote: true, keepCid: true }).html;
  const options: Mail.Options = {
    from: { name: from.name ?? '', address: from.address },
    to: toMailAddresses(draft.to),
    cc: toMailAddresses(draft.cc),
    bcc: toMailAddresses(draft.bcc),
    subject: draft.subject,
    html: cleanHtml,
    text: htmlToText(bodyHtml),
    attachments,
    date: new Date(),
  };
  /*
   * Просьба уведомить о прочтении — на адрес ПОДКЛЮЧЕНИЯ, а не свой:
   * письмо уходит с чужого адреса, и уведомление должно вернуться туда
   * же. Раньше кнопка в окне оставалась зажжённой, а заголовок не
   * ставился вовсе — обещание без исполнения.
   */
  if (draft.requestReadReceipt) {
    options.headers = { 'Disposition-Notification-To': `<${from.address}>` };
  }
  if (draft.inReplyTo) options.inReplyTo = draft.inReplyTo;
  if (draft.references && draft.references.length > 0) options.references = draft.references;

  return new MailComposer(options).compile().build();
}
