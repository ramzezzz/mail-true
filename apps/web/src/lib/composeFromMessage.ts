/**
 * Наполнение окна написания из письма: ответ и пересылка.
 *
 * Живёт отдельно от страницы письма, потому что то же самое нужно списку:
 * `R` и `F` работают и там, и там, и собирать ответ двумя разными способами
 * значило бы получить два разных ответа.
 */

import type { DraftContent, Message } from '@mail-true/shared';
import type { ComposeInit } from '../app/store';
import { formatAddresses } from './addresses';

/** Цитата исходного письма для ответа/пересылки. */
export function quoteHtml(message: Message): string {
  const date = new Date(message.date).toLocaleString('ru-RU');
  const from = message.from.name ?? message.from.address;
  return `<br><br><p>${date}, ${from} &lt;${message.from.address}&gt;:</p><blockquote>${
    message.bodyHtml ?? message.bodyText ?? ''
  }</blockquote>`;
}

/**
 * Ответ отправителю. Настройка «Включать содержимое исходного письма
 * в ответ» — только про ответ; пересылка ей не подчиняется и в привычных почтовых интерфейсах.
 */
export function replyInit(message: Message, quoteOriginal: boolean): ComposeInit {
  return {
    to: message.from.address,
    subject: message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`,
    bodyHtml: quoteOriginal ? quoteHtml(message) : undefined,
    inReplyTo: message.messageId ?? undefined,
    references: message.messageId ? [...message.references, message.messageId] : undefined,
    sourceMessageId: message.id,
  };
}

/**
 * Дописывание сохранённого черновика.
 *
 * Ключевое здесь — `draftUid`. По нему окно написания понимает, что письмо
 * продолжают, а не начинают: тело берётся как есть (подпись в нём уже есть),
 * а сохранение перезаписывает ТОТ ЖЕ черновик, а не кладёт в папку ещё одну
 * копию. Без этого дописывание превращало один черновик в три.
 */
export function draftInit(draft: DraftContent): ComposeInit {
  return {
    draftUid: draft.draftUid,
    to: formatAddresses(draft.to),
    cc: formatAddresses(draft.cc),
    bcc: formatAddresses(draft.bcc),
    subject: draft.subject,
    bodyHtml: draft.bodyHtml,
    attachments: draft.attachments,
    requestReadReceipt: draft.requestReadReceipt,
    // Черновик ответа остаётся ответом: без этих двух полей дописанное
    // письмо ушло бы новой перепиской, и у получателя оно встало бы
    // отдельной веткой вместо продолжения разговора.
    inReplyTo: draft.inReplyTo ?? undefined,
    references: draft.references.length > 0 ? draft.references : undefined,
    // Черновик, который человек не создавал: письмо вернулось из очереди
    // отправки, потому что почтовый сервер его не принял. Окно написания
    // скажет об этом полосой — иначе открывший гадал бы, откуда это письмо.
    sendFailure: draft.sendFailure ?? undefined,
  };
}

/** Пересылка: получателя нет, тело — исходное письмо целиком. */
export function forwardInit(message: Message): ComposeInit {
  return {
    subject: message.subject.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
    bodyHtml: quoteHtml(message),
    sourceMessageId: message.id,
  };
}
