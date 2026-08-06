/**
 * Как узнаётся, что на письмо ОТВЕТИЛИ.
 *
 * Здесь только чистые правила — без IMAP, базы и сети. Это сделано ровно
 * потому, что вся возможность «напомнить, если не ответили» держится на
 * одном решении, и решение это невозможно проверить на живом стенде во
 * всех его случаях: чтобы увидеть ответ без In-Reply-To, нужна почтовая
 * программа, которая его не ставит; чтобы увидеть автоответ об отпуске —
 * собеседник в отпуске.
 *
 * ==================================================================
 * ДВЕ ПРОВЕРКИ И ПОЧЕМУ ИХ ИМЕННО ДВЕ
 * ==================================================================
 *
 * 1. ПО ССЫЛКАМ (`In-Reply-To` / `References`) — основная.
 *    Ответ ссылается на Message-ID нашего письма. Это буквально
 *    определение ответа по RFC 5322, и по этим же заголовкам собирает
 *    переписки сам почтовый сервер (алгоритм REFS, см. mail/threads.ts).
 *    Message-ID уникален, поэтому ложное срабатывание здесь возможно
 *    только у отправителя, который нарочно подставил чужой идентификатор.
 *
 * 2. ПО СОБЕСЕДНИКУ И ТЕМЕ — запасная.
 *    Часть почтовых программ (и почти все «ответы» из веб-форм, CRM и
 *    систем заявок) In-Reply-To не ставит вовсе. Для них ответом считается
 *    письмо, пришедшее ПОСЛЕ нашего от кого-то из адресатов поля «Кому»
 *    с той же темой — с точностью до «Re:», «Ответ:», регистра и пробелов.
 *
 * ==================================================================
 * ПОЧЕМУ ЗАПАСНАЯ ПРОВЕРКА НАРОЧНО ШИРОКАЯ
 * ==================================================================
 * Две возможные ошибки здесь стоят по-разному, и это не вопрос вкуса.
 *
 *   НЕ заметить ответ = не напомнить. Человек остаётся ровно там, где был
 *   бы без возможности вовсе: сам вспомнит, сам напишет. Потеряно ничего.
 *
 *   Напомнить ЗРЯ = сказать неправду. Человек открывает поднятое письмо,
 *   видит ответ, пришедший три дня назад, — и больше механизму не верит.
 *   А механизм, которому не верят, хуже отсутствующего: он ещё и мешает.
 *
 * Поэтому вторая проверка ошибается в сторону «ответ был». Ровно про это
 * и предупреждает разбор (docs/gaps.md, п. 4): «Лучше не заметить ответ
 * реже, чем напомнить впустую».
 *
 * ==================================================================
 * ЧТО ОТВЕТОМ НЕ СЧИТАЕТСЯ
 * ==================================================================
 *   - НАШЕ ЖЕ письмо. Написать вдогонку самому себе — обычное дело
 *     («забыл вложение»), и это не ответ собеседника.
 *   - Автоответ об отпуске. У него есть `Auto-Submitted` с чем угодно,
 *     кроме `no` (RFC 3834), и именно он — самый обидный ложный ответ:
 *     собеседник в отпуске, ответа не будет ещё две недели, а напоминание
 *     мы снимем.
 *   - Отчёт о недоставке. Приходит от MAILER-DAEMON/postmaster и означает,
 *     что письма собеседник вообще не получил.
 */

/** Приставки ответа и пересылки, которые срезаются с темы. */
const REPLY_PREFIX =
  /^\s*(?:(?:re|res|rif|aw|antw|sv|vs|ref|fw|fwd|отв|ответ|пересылка|переслано)\s*(?:\[\d+\])?\s*:\s*)+/i;

/**
 * Тема в виде, пригодном для сравнения.
 *
 * Срезаются приставки ответа (в том числе многократные — «Re: Re: Fwd:»),
 * сворачиваются пробелы и регистр. Регистр сворачивается по-русски тоже:
 * `toLowerCase` в JS работает и с кириллицей — в отличие от сравнения
 * в Sieve, где ради этого приходится городить `:regex` (settings/sieve.ts).
 */
export function normalizeSubject(subject: string): string {
  let value = (subject ?? '').replace(/\s+/g, ' ').trim();
  // Многократно: «Re: Fwd: Re: тема» встречается сплошь и рядом.
  for (let i = 0; i < 8; i += 1) {
    const stripped = value.replace(REPLY_PREFIX, '');
    if (stripped === value) break;
    value = stripped.trim();
  }
  return value.toLowerCase();
}

/** Адрес в виде, пригодном для сравнения. */
export function normalizeAddress(address: string): string {
  return (address ?? '').trim().toLowerCase();
}

/** Отправитель отчёта о недоставке, а не собеседник. */
const DAEMON_LOCAL_PARTS = new Set([
  'mailer-daemon',
  'postmaster',
  'mail-daemon',
  'noreply-daemon',
]);

export function isSystemSender(address: string): boolean {
  const value = normalizeAddress(address);
  if (value === '') return true;
  const local = value.split('@')[0] ?? '';
  return DAEMON_LOCAL_PARTS.has(local);
}

/** Письмо, ответа на которое ждут. */
export interface AwaitedLetter {
  /** Message-ID нашего письма без угловых скобок. */
  messageId: string;
  /** Тема нашего письма. */
  subject: string;
  /** Адреса из поля «Кому» — от них и ждём ответа. */
  recipients: readonly string[];
  /** Когда письмо было отправлено. */
  sentAt: Date;
  /** Свой адрес: своё же письмо ответом не считается. */
  selfAddress: string;
}

/** Письмо-кандидат в ответы. */
export interface ReplyCandidate {
  fromAddress: string;
  subject: string;
  date: Date | null;
  /** Разобранные идентификаторы из References. */
  references: readonly string[];
  /** Разобранные идентификаторы из In-Reply-To. */
  inReplyTo: readonly string[];
  /** Значение заголовка Auto-Submitted, если он был. */
  autoSubmitted?: string | null | undefined;
}

/** Чем именно опознан ответ. */
export type ReplyMatch = 'references' | 'subject' | null;

/** Автоответ (RFC 3834): всё, кроме явного `no`, — не ответ человека. */
export function isAutoSubmitted(value: string | null | undefined): boolean {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === '') return false;
  return raw !== 'no';
}

/**
 * Ответ ли это на наше письмо.
 *
 * Возвращает, КАКАЯ проверка сработала, а не просто «да»: это значение
 * пишется в базу и потом отвечает на вопрос «почему оно решило, что мне
 * ответили». Без него разбор жалобы упирался бы в догадки.
 */
export function matchReply(letter: AwaitedLetter, candidate: ReplyCandidate): ReplyMatch {
  if (isAutoSubmitted(candidate.autoSubmitted)) return null;
  if (isSystemSender(candidate.fromAddress)) return null;

  const from = normalizeAddress(candidate.fromAddress);
  // Своё же письмо ответом не считается — иначе достаточно было бы
  // написать вдогонку самому себе, и напоминание тихо исчезло бы.
  if (from === normalizeAddress(letter.selfAddress)) return null;

  const needle = letter.messageId.toLowerCase();
  const links = [...candidate.references, ...candidate.inReplyTo].map((id) =>
    id.replace(/^<|>$/g, '').trim().toLowerCase(),
  );
  if (links.includes(needle)) return 'references';

  /*
   * Запасная проверка. Три условия сразу, и убрать нельзя ни одно:
   * без адреса ответом считалась бы любая рассылка с похожей темой,
   * без темы — любое письмо собеседника, без даты — письмо, на которое
   * мы сами и отвечали.
   */
  const recipients = letter.recipients.map(normalizeAddress).filter((a) => a !== '');
  if (!recipients.includes(from)) return null;
  if (candidate.date && candidate.date.getTime() <= letter.sentAt.getTime()) return null;
  const subject = normalizeSubject(letter.subject);
  if (subject === '') return null;
  if (normalizeSubject(candidate.subject) !== subject) return null;
  return 'subject';
}
