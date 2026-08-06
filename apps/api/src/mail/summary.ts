/**
 * Формирование MessageSummary — строки списка писем — из данных IMAP FETCH.
 */
import type {
  FetchMessageObject,
  MessageAddressObject,
  MessageEnvelopeObject,
  MessageStructureObject,
} from 'imapflow';
import { repairHeader } from './header-charset.js';
import type { MailAddress, MessageFlags, MessageSummary } from '@mail-true/shared';
import { collectAttachments } from './structure.js';
import { senderLogoDomain } from './sender-auth.js';

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
    // Уведомление о прочтении уже отправлено или от него отказались
    // (RFC 3503). В пользовательские метки это слово не попадает — оно
    // в SYSTEM_KEYWORDS, — поэтому без отдельного поля интерфейс не смог бы
    // отличить «ещё не спрашивали» от «уже ответили» и спрашивал бы снова.
    mdnSent: has('$MDNSent'),
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

/**
 * Кодировка текстовой части письма — подсказка для восстановления заголовка.
 *
 * Берётся с первой попавшейся текстовой части: отправитель, который написал
 * тему в KOI8-R, тело почти наверняка написал в ней же.
 */
function textCharsetOf(node: MessageStructureObject | undefined): string | null {
  if (!node) return null;
  const type = (node.type ?? '').toLowerCase();
  if (type.startsWith('text/')) {
    const charset = node.parameters?.['charset'];
    if (typeof charset === 'string' && charset) return charset;
  }
  for (const child of node.childNodes ?? []) {
    const found = textCharsetOf(child);
    if (found) return found;
  }
  return null;
}

/**
 * Тема письма, восстановленная по кодировке тела, если её испортили.
 *
 * Заголовок, присланный сырыми байтами в KOI8-R или CP1251 без кодирования
 * по RFC 2047, разбирался как строка ромбиков — и такой в списке и видел
 * человек, хотя тело письма читалось правильно. Письмо к тому же не
 * находилось поиском по собственной теме.
 */
function repairSubject(
  fallback: string,
  rawHeaders: Buffer | undefined,
  structure: MessageStructureObject | undefined,
): string {
  return repairHeader(rawHeaders, 'Subject', textCharsetOf(structure)) ?? fallback;
}

export interface BuildSummaryArgs {
  folderId: string;
  msg: FetchMessageObject;
  snippet?: string | undefined;
  /**
   * Сырые байты заголовков письма. Нужны, чтобы восстановить тему, если
   * отправитель прислал её в восьмибитной кодировке без положенного
   * кодирования по RFC 2047 — см. header-charset.ts.
   *
   * Необязательны: без них тема берётся как раньше.
   */
  rawHeaders?: Buffer | undefined;
}

/** Собирает MessageSummary из ответа IMAP FETCH. */
export function buildSummary({
  folderId,
  msg,
  snippet,
  rawHeaders,
}: BuildSummaryArgs): MessageSummary {
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
    subject: repairSubject(envelope?.subject ?? '', rawHeaders, msg.bodyStructure),
    snippet: snippet ?? '',
    date: (Number.isNaN(date.getTime()) ? new Date() : date).toISOString(),
    flags: flagsFromSet(msg.flags),
    hasAttachments: realAttachments.length > 0,
    attachmentNames: realAttachments.map((a) => a.filename),
    labels: labelsFromSet(msg.flags),
    pinned: msg.flags?.has('$Pinned') ?? false,
    sizeBytes: msg.size ?? 0,
    /*
     * Домен, которому в ЭТОМ письме разрешено показать логотип в кружке.
     * null — подлинность отправителя не подтверждена, значит рисуется
     * буква. Решение принимается ЗДЕСЬ, на сервере, а не в интерфейсе:
     * логотип читается человеком как знак подлинности, и право на него
     * не должно зависеть от того, что подставит клиент. Подробности и
     * защита от подделанного заголовка — в mail/sender-auth.ts.
     */
    senderLogoDomain: senderLogoDomain(envelope?.from?.[0]?.address, rawHeaders),
  };
}
