/**
 * Просьба отправителя уведомить о прочтении (RFC 8098).
 *
 * Заголовок `Disposition-Notification-To` значит: «сообщи мне, когда
 * откроешь письмо». Отвечать на это за человека нельзя — уведомление
 * рассказывает третьей стороне, что письмо открыто и когда именно, а
 * заодно подтверждает, что адрес живой (чем и пользуются рассылки).
 * Поэтому интерфейс только показывает вопрос, а решает человек.
 */

/** Кому уйдёт уведомление, если человек согласится. */
export interface ReadReceiptAsk {
  address: string;
  /** Отображаемое имя из заголовка, если оно там было. */
  name: string | null;
}

/**
 * Достаёт адрес из заголовков письма.
 *
 * Сервер отдаёт имена заголовков в нижнем регистре. Адресов в заголовке
 * может быть несколько — уведомление уходит одно, поэтому берётся первый.
 */
export function readReceiptAsk(headers: Record<string, string>): ReadReceiptAsk | null {
  const raw = headers['disposition-notification-to'];
  if (!raw) return null;

  const first = raw.split(',')[0]?.trim();
  if (!first) return null;

  const angle = first.match(/^(.*)<([^<>]+)>\s*$/);
  const address = (angle ? angle[2] : first)?.trim() ?? '';
  // Та же проверка, что и на сервере: показывать как адрес то, что адресом
  // не является, значит обещать отправку туда, куда ничего не уйдёт
  if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]{2,}$/.test(address)) return null;

  const name = angle?.[1]?.trim().replace(/^"|"$/g, '') ?? '';
  return { address, name: name ? name : null };
}

/** Кого назвать в плашке: имя, если оно есть, иначе адрес. */
export function readReceiptWho(ask: ReadReceiptAsk): string {
  return ask.name ? `${ask.name} (${ask.address})` : ask.address;
}
