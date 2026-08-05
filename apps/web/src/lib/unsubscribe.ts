/**
 * Отписка от рассылки по заголовку List-Unsubscribe (RFC 2369/8058).
 *
 * Проверка `'List-Unsubscribe' in message.headers` не срабатывала никогда,
 * и по двум причинам сразу:
 *
 *   1) сервер отдаёт имена заголовков в НИЖНЕМ регистре
 *      (`apps/api/src/mail/parse.ts`, HEADER_WHITELIST) — точного совпадения
 *      с `List-Unsubscribe` в объекте не бывает;
 *   2) mailparser сводит все заголовки `list-*` в один ключ `list`, поэтому
 *      `parsed.headers.get('list-unsubscribe')` возвращает undefined и до
 *      интерфейса заголовок не доходит вовсе (проверено живым письмом:
 *      `headers` приходит пустым объектом).
 *
 * Первую причину чиним здесь: имена приводим к нижнему регистру и понимаем
 * оба варианта — и отдельный `list-unsubscribe`, и сводный `list`. Вторая
 * лечится только на стороне API (см. отчёт): пока сервер не начнёт класть
 * заголовок в ответ, показывать кнопку не по чему.
 */

export interface UnsubscribeLinks {
  /** Адрес письма-отписки (mailto:), если он предложен. */
  mailto: string | null;
  /** Веб-адрес отписки (http/https), если он предложен. */
  http: string | null;
  /** Отписка в одно нажатие: есть List-Unsubscribe-Post (RFC 8058). */
  oneClick: boolean;
}

/** Регистронезависимый поиск заголовка. */
function header(headers: Record<string, string>, name: string): string | null {
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === needle && typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * Значение List-Unsubscribe. Кроме собственного заголовка понимаем сводный
 * `list` — в него mailparser складывает всю группу `list-*`.
 */
function rawValue(headers: Record<string, string>): string | null {
  return header(headers, 'list-unsubscribe') ?? header(headers, 'list');
}

const ANGLE_RE = /<([^>]+)>/g;

/** Разбирает `<mailto:…>, <https://…>` в набор ссылок. */
export function unsubscribeLinks(
  headers: Record<string, string> | null | undefined,
): UnsubscribeLinks | null {
  if (!headers) return null;
  const raw = rawValue(headers);
  if (!raw) return null;

  let mailto: string | null = null;
  let http: string | null = null;
  for (const match of raw.matchAll(ANGLE_RE)) {
    const url = (match[1] ?? '').trim();
    if (/^mailto:/i.test(url)) mailto ??= url;
    else if (/^https?:/i.test(url)) http ??= url;
  }
  // Некоторые отправители пишут адрес без угловых скобок
  if (!mailto && !http) {
    const bare = raw.trim();
    if (/^mailto:/i.test(bare)) mailto = bare;
    else if (/^https?:/i.test(bare)) http = bare;
  }
  if (!mailto && !http) return null;

  const post = header(headers, 'list-unsubscribe-post');
  return { mailto, http, oneClick: Boolean(post) };
}

/** Есть ли у письма отписка — по ней показывается кнопка «Отписаться». */
export function canUnsubscribe(headers: Record<string, string> | null | undefined): boolean {
  return unsubscribeLinks(headers) !== null;
}
