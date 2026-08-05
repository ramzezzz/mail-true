/**
 * Разбор заголовков отписки от рассылки (RFC 2369 и RFC 8058).
 *
 * `List-Unsubscribe` содержит один или несколько адресов в угловых скобках:
 * ссылку `https:` и/или `mailto:`. Если рядом стоит
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, отписка делается
 * одним POST-запросом без подтверждения — так требует RFC 8058, и именно
 * так это должно работать: запрос шлёт сервер, а не браузер пользователя
 * (иначе адрес отписки узнаёт адрес и cookie читающего).
 */

export interface MailtoUnsubscribe {
  address: string;
  subject: string | null;
  body: string | null;
}

export interface UnsubscribeInfo {
  /** Ссылка `https:`/`http:` из заголовка. */
  url: string | null;
  mailto: MailtoUnsubscribe | null;
  /** Отправитель разрешил отписку одним запросом (RFC 8058). */
  oneClick: boolean;
}

/** Достаёт значения в угловых скобках: `<a>, <b>`. */
function bracketed(value: string): string[] {
  const out: string[] = [];
  for (const match of value.matchAll(/<([^>]+)>/g)) {
    const item = match[1]?.trim();
    if (item) out.push(item);
  }
  // Некоторые отправители забывают скобки — тогда берём всё значение
  if (out.length === 0 && value.trim()) out.push(value.trim());
  return out;
}

function parseMailto(raw: string): MailtoUnsubscribe | null {
  const withoutScheme = raw.slice('mailto:'.length);
  const [addressPart, queryPart = ''] = withoutScheme.split('?', 2);
  const address = decodeURIComponent((addressPart ?? '').trim());
  if (!address || !address.includes('@')) return null;

  const params = new URLSearchParams(queryPart);
  return {
    address,
    subject: params.get('subject'),
    body: params.get('body'),
  };
}

/**
 * Разбирает заголовки письма (в нижнем регистре, как их отдаёт API).
 */
export function parseUnsubscribe(headers: Record<string, string>): UnsubscribeInfo {
  const header = headers['list-unsubscribe'];
  const info: UnsubscribeInfo = { url: null, mailto: null, oneClick: false };
  if (!header) return info;

  for (const item of bracketed(header)) {
    const lower = item.toLowerCase();
    if (!info.mailto && lower.startsWith('mailto:')) {
      info.mailto = parseMailto(item);
    } else if (!info.url && (lower.startsWith('https://') || lower.startsWith('http://'))) {
      info.url = item;
    }
  }

  const post = headers['list-unsubscribe-post'] ?? '';
  // RFC 8058: отписка в один запрос возможна только по https-ссылке
  info.oneClick =
    /list-unsubscribe\s*=\s*one-click/i.test(post) &&
    Boolean(info.url && info.url.toLowerCase().startsWith('https://'));

  return info;
}

/** Есть ли у письма хоть какой-то способ отписаться. */
export function canUnsubscribe(headers: Record<string, string>): boolean {
  const info = parseUnsubscribe(headers);
  return Boolean(info.url || info.mailto);
}

/**
 * Пригоден ли адрес для запроса отписки С СЕРВЕРА.
 *
 * Адрес приходит из письма, то есть от кого угодно. Если ходить по нему
 * без разбора, любой отправитель сможет заставить наш сервер стучаться
 * во внутреннюю сеть (SSRF) — а он стоит внутри стека, рядом с Dovecot,
 * Postgres и Redis. Поэтому: только https, без учётных данных в адресе,
 * без нестандартных портов и без адресов, записанных числами.
 * Проверка имени по DNS делается отдельно, уже перед самим запросом.
 */
export function isSafeUnsubscribeUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;

  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.localhost')) return false;
  // Адрес, записанный числами, — обычный способ достучаться до своей сети
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.startsWith('[')) return false;
  return true;
}

/** Частные и служебные диапазоны, куда серверу ходить нельзя. */
export function isPrivateAddress(address: string): boolean {
  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  const v6 = address.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
  // IPv4, завёрнутый в IPv6
  const mapped = v6.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  return false;
}
