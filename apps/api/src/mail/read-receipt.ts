/**
 * Уведомления о прочтении (MDN, RFC 8098 и RFC 3798).
 *
 * Две стороны одного дела:
 *
 *   1. Исходящая — заголовок `Disposition-Notification-To` в письме, которое
 *      мы отправляем. Его добавляет маршрут написания.
 *   2. Входящая — письмо ПРОСИТ уведомить. Уведомление отправляется только
 *      по явному согласию человека: MDN сообщает третьей стороне, что письмо
 *      открыто, когда именно и с какого адреса. Отвечать за человека на такой
 *      вопрос нельзя, поэтому здесь нет ни одной ветки «отправить само».
 *
 * Само уведомление — письмо `multipart/report; report-type=
 * disposition-notification` с машиночитаемой частью. Оно собирается здесь
 * вручную, а не MailComposer'ом: тот умеет только `multipart/mixed` и
 * `multipart/alternative`, параметр `report-type` в него не передать,
 * а без него получатель не поймёт, что это уведомление, а не обычное письмо.
 */

import { randomBytes } from 'node:crypto';

/** Кому отправитель просил сообщить о прочтении. */
export interface ReadReceiptRequest {
  /** Адрес из `Disposition-Notification-To`. */
  address: string;
  /** Отображаемое имя, если оно было в заголовке. */
  name: string | null;
}

/**
 * Разбирает `Disposition-Notification-To` из заголовков письма.
 *
 * Заголовки приходят в нижнем регистре — так их отдаёт API (mail/parse.ts).
 * Значение бывает и «Имя <адрес>», и голым адресом, и списком: RFC разрешает
 * несколько адресов, но уведомление шлётся одно, поэтому берём первый.
 * Всё, что не похоже на адрес, отбрасываем целиком: письмо пришло снаружи,
 * и подставлять в конверт что попало нельзя.
 */
export function readReceiptRequest(
  headers: Record<string, string>,
): ReadReceiptRequest | null {
  const raw = headers['disposition-notification-to'];
  if (!raw) return null;

  const first = raw.split(',')[0]?.trim();
  if (!first) return null;

  const angle = first.match(/^(.*)<([^<>]+)>\s*$/);
  const address = (angle ? angle[2] : first)?.trim() ?? '';
  if (!isPlainAddress(address)) return null;

  const name = angle?.[1]?.trim().replace(/^"|"$/g, '') ?? '';
  return { address, name: name ? name : null };
}

/**
 * Годится ли строка как адрес в конверте уведомления.
 *
 * Нарочно строже, чем проверка адресов при отправке письма: этот адрес
 * пришёл из чужого письма и никем не набирался. Перевод строки в нём
 * означал бы возможность подставить в наше письмо любой заголовок.
 */
export function isPlainAddress(value: string): boolean {
  if (value.length > 320) return false;
  if (/[\s<>,;"\\]/.test(value)) return false;
  return /^[^@]+@[^@]+\.[^@]{2,}$/.test(value);
}

export interface ReadReceiptOptions {
  /** Кто прочитал письмо — он же отправитель уведомления. */
  from: string;
  /** Кому уведомление (адрес из Disposition-Notification-To). */
  to: string;
  /** Тема исходного письма — попадает в тему уведомления. */
  originalSubject: string;
  /** Message-ID исходного письма, если он есть. */
  originalMessageId: string | null;
  /** Имя узла для Message-ID и Reporting-UA. */
  hostname: string;
  /** Момент отправки уведомления; параметром — ради воспроизводимых тестов. */
  date?: Date;
}

/** Кодирует заголовок в RFC 2047, если в нём есть не-ASCII. */
export function encodeHeaderWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Убирает из значения всё, что могло бы стать новым заголовком.
 *
 * Тема исходного письма попадает в тему уведомления, а пришла она снаружи.
 * Свёрнутый заголовок с переводом строки — классический способ дописать
 * в чужое письмо свой Bcc.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Message-ID в угловых скобках либо null, если его не было. */
function bracketed(messageId: string | null): string | null {
  const value = oneLine(messageId ?? '');
  if (!value) return null;
  const inner = value.replace(/^<|>$/g, '');
  if (!inner || /[\s<>]/.test(inner)) return null;
  return `<${inner}>`;
}

/**
 * Собирает готовое уведомление о прочтении в байтах RFC 822.
 *
 * `Disposition: manual-action/MDN-sent-manually; displayed` — ровно то, что
 * произошло на самом деле: письмо показано человеку, и уведомление отправлено
 * его руками. Писать `automatic-action` значило бы соврать получателю о том,
 * как именно письмо было прочитано.
 */
export function buildReadReceipt(options: ReadReceiptOptions): Buffer {
  const date = options.date ?? new Date();
  const boundary = `=_mt_mdn_${randomBytes(12).toString('hex')}`;
  const subject = oneLine(options.originalSubject) || '(без темы)';
  const originalId = bracketed(options.originalMessageId);
  const messageId = `<mdn-${randomBytes(12).toString('hex')}@${options.hostname}>`;

  const humanText =
    `Ваше письмо «${subject}» прочитано получателем ${options.from}.\r\n` +
    `Дата прочтения: ${date.toUTCString()}.\r\n\r\n` +
    'Это уведомление отправлено по вашей просьбе и говорит только о том, ' +
    'что письмо было открыто. Прочитано ли оно на самом деле, ' +
    'уведомление не подтверждает.\r\n';

  const head = [
    `From: <${options.from}>`,
    `To: <${options.to}>`,
    `Subject: ${encodeHeaderWord(`Прочитано: ${subject}`)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    // Уведомление — ответ машины, а не переписка. Без этого заголовка
    // автоответчики на той стороне начинают отвечать на уведомление,
    // а мы — на их ответ (RFC 3834).
    'Auto-Submitted: auto-replied',
    ...(originalId ? [`In-Reply-To: ${originalId}`, `References: ${originalId}`] : []),
    `Content-Type: multipart/report; report-type=disposition-notification;\r\n boundary="${boundary}"`,
  ].join('\r\n');

  const notification = [
    `Reporting-UA: ${options.hostname}; Mail.True`,
    `Final-Recipient: rfc822;${options.from}`,
    ...(originalId ? [`Original-Message-ID: ${originalId}`] : []),
    'Disposition: manual-action/MDN-sent-manually; displayed',
  ].join('\r\n');

  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    // Кириллица в теле — только base64: 8-битные байты в письме без
    // объявленной кодировки доезжают до получателя как угодно.
    wrap76(Buffer.from(humanText, 'utf8').toString('base64')),
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    '',
    notification,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return Buffer.from(`${head}\r\n\r\n${body}`, 'utf8');
}

/** Разбивает base64 на строки по 76 символов — предел длины строки в письме. */
function wrap76(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join('\r\n');
}
