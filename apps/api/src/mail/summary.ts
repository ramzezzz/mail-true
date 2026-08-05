/**
 * Формирование MessageSummary — строки списка писем — из данных IMAP FETCH.
 */
import type { FetchMessageObject, MessageAddressObject, MessageEnvelopeObject } from 'imapflow';
import type { MailAddress, MessageFlags, MessageSummary } from '@mail-true/shared';
import { collectAttachments } from './structure.js';

/** Системные IMAP-флаги, которые не считаются пользовательскими метками. */
const SYSTEM_KEYWORDS = new Set(['$Forwarded', '$MDNSent', '$Junk', '$NotJunk', '$Pinned']);

export function mapAddress(addr: MessageAddressObject | undefined): MailAddress {
  // По контракту (packages/shared) отсутствующее имя — это null, а не пустая
  // строка. IMAP отдаёт для писем без отображаемого имени именно пустую строку,
  // и если её пропустить, потребитель, проверяющий на null, покажет пустоту.
  const name = addr?.name?.trim();
  return {
    name: name ? name : null,
    address: addr?.address ?? '',
  };
}

export function mapAddressList(list: MessageAddressObject[] | undefined): MailAddress[] {
  return (list ?? []).filter((a) => a.address).map(mapAddress);
}

/** Преобразует IMAP-флаги в MessageFlags. */
export function flagsFromSet(set: Set<string> | undefined): MessageFlags {
  const has = (flag: string): boolean => set?.has(flag) ?? false;
  return {
    seen: has('\\Seen'),
    flagged: has('\\Flagged'),
    answered: has('\\Answered'),
    forwarded: has('$Forwarded'),
    draft: has('\\Draft'),
    deleted: has('\\Deleted'),
  };
}

/** Пользовательские метки: keywords без системных флагов. */
export function labelsFromSet(set: Set<string> | undefined): string[] {
  if (!set) return [];
  return [...set].filter((f) => !f.startsWith('\\') && !SYSTEM_KEYWORDS.has(f));
}

/**
 * Идентификатор цепочки: письма одной переписки связываются
 * через In-Reply-To/Message-ID. Приближение без полного алгоритма JWZ.
 */
export function threadIdOf(envelope: MessageEnvelopeObject | undefined, fallback: string): string {
  const root = envelope?.inReplyTo || envelope?.messageId;
  if (!root) return fallback;
  return 't-' + Buffer.from(root.replace(/[<>]/g, ''), 'utf8').toString('base64url');
}

export interface BuildSummaryArgs {
  folderId: string;
  msg: FetchMessageObject;
  snippet?: string | undefined;
}

/** Собирает MessageSummary из ответа IMAP FETCH. */
export function buildSummary({ folderId, msg, snippet }: BuildSummaryArgs): MessageSummary {
  const attachments = collectAttachments(msg.bodyStructure);
  const realAttachments = attachments.filter((a) => !a.inline);
  const envelope = msg.envelope;
  const id = `${folderId}:${msg.uid}`;

  const dateSource = envelope?.date ?? msg.internalDate ?? new Date();
  const date = dateSource instanceof Date ? dateSource : new Date(dateSource);

  return {
    id,
    folderId,
    uid: msg.uid,
    threadId: threadIdOf(envelope, id),
    from: mapAddress(envelope?.from?.[0]),
    to: mapAddressList(envelope?.to),
    cc: mapAddressList(envelope?.cc),
    subject: envelope?.subject ?? '',
    snippet: snippet ?? '',
    date: (Number.isNaN(date.getTime()) ? new Date() : date).toISOString(),
    flags: flagsFromSet(msg.flags),
    hasAttachments: realAttachments.length > 0,
    attachmentNames: realAttachments.map((a) => a.filename),
    labels: labelsFromSet(msg.flags),
    pinned: msg.flags?.has('$Pinned') ?? false,
    sizeBytes: msg.size ?? 0,
  };
}
