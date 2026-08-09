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
import { BadRequestError } from '../errors.js';
import { forwardedAttachment, type ForwardedMessage } from '../mail/forwarded.js';
import { htmlToText } from '../mail/text.js';
import { sanitizeEmailHtml } from '../mail/sanitize.js';
import type { UploadStore } from '../uploads.js';

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
  /** Письма, пересылаемые целиком: их исходники читает вызывающий. */
  forwarded: readonly ForwardedMessage[] = [],
): Promise<Buffer> {
  const attachments: Mail.Attachment[] = [];
  for (const item of forwarded) attachments.push(forwardedAttachment(item));
  for (const id of draft.attachmentIds) {
    const found = await uploads.get(id, owner);
    if (!found) throw new BadRequestError(`Вложение не найдено: ${id}`);
    attachments.push({
      filename: found.meta.filename,
      path: found.path,
      contentType: found.meta.mimeType,
    });
  }

  const cleanHtml = sanitizeEmailHtml(draft.bodyHtml, { allowRemote: true }).html;
  const options: Mail.Options = {
    from: { name: from.name ?? '', address: from.address },
    to: toMailAddresses(draft.to),
    cc: toMailAddresses(draft.cc),
    bcc: toMailAddresses(draft.bcc),
    subject: draft.subject,
    html: cleanHtml,
    text: htmlToText(draft.bodyHtml),
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
