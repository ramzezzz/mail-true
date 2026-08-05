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
): Promise<Buffer> {
  const attachments: Mail.Attachment[] = [];
  for (const id of draft.attachmentIds) {
    const found = await uploads.get(id);
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
  if (draft.inReplyTo) options.inReplyTo = draft.inReplyTo;
  if (draft.references && draft.references.length > 0) options.references = draft.references;

  return new MailComposer(options).compile().build();
}
