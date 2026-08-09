/**
 * Куда серверу можно стучаться с уведомлением.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Адрес службы доставки принимался любой, лишь бы начинался с https.
 * А дальше сервер сам ходит по нему POST-запросом — на каждое новое
 * письмо, — и отдаёт первые триста символов ответа обратно в панель
 * уведомлений («проверочное уведомление»).
 *
 * Значит любой, кто вошёл в свою почту, мог подписаться на
 * `https://внутренний-хост/что-угодно`, нажать «проверить» и прочитать
 * кусок ответа. Ключи подписки при этом генерируются за секунду — они
 * ничего не подтверждают. Это запрос от имени сервера внутрь сети, где
 * снаружи никого нет, с чтением результата: ровно то, ради чего такие
 * дыры и ищут.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ
 * ------------------------------------------------------------------
 * Три вещи, каждая отсекает свой класс адресов:
 *
 *   1. Схема и порт. Только https и только обычный порт: служба доставки
 *      браузера не живёт на 8080 и тем более на 6379.
 *   2. Имя, а не адрес. У настоящих служб (Google, Mozilla, Apple,
 *      Microsoft) всегда доменное имя. IP-литерал в подписке означает,
 *      что её собрали руками, — а собирают руками ровно для этого.
 *   3. Куда это имя ведёт. Резолвим и требуем, чтобы ВСЕ адреса были
 *      публичными: имя «внутренний.local» или домен, который заведён на
 *      192.168.1.10, отсеиваются здесь.
 *
 * Белого списка служб доставки намеренно нет: браузеры их меняют и
 * добавляют, и список превратился бы в «уведомления не работают в новом
 * браузере, разбирайтесь почему».
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Отказ с человеческим текстом: он доезжает до панели уведомлений. */
export class PushEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushEndpointError';
  }
}

/** Локальные и служебные имена, которых в подписке быть не может. */
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.intranet'];

/**
 * Адрес из непубличного диапазона.
 *
 * Перечислены те, что действительно встречаются внутри установки:
 * петля, частные сети, link-local (включая метаданные облаков —
 * 169.254.169.254), CGNAT, а для IPv6 — петля, уникальные локальные и
 * link-local. Плюс адреса, отображённые из IPv4 (::ffff:10.0.0.1):
 * без них проверка обходится одной записью в DNS.
 */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPrivateV4(address);
  if (kind !== 6) return true; // не адрес вовсе — не пропускаем

  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  // fc00::/7 — уникальные локальные, fe80::/10 — link-local.
  return /^f[cd]/u.test(lower) || /^fe[89ab]/u.test(lower);
}

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map((piece) => Number(piece));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  const [a = 0, b = 0] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local и метаданные облаков
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // многоадресные и зарезервированные
  return false;
}

/**
 * Проверка формы адреса — без сети.
 *
 * Отдельно от резолва, чтобы её можно было прогнать в тестах и вызвать
 * там, где ходить в DNS незачем.
 */
export function checkEndpointShape(endpoint: string): { host: string } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushEndpointError('Адрес службы доставки неразборчив');
  }
  if (url.protocol !== 'https:') {
    throw new PushEndpointError('Адрес службы доставки должен быть https');
  }
  if (url.port !== '' && url.port !== '443') {
    throw new PushEndpointError('Служба доставки уведомлений не работает на нестандартном порту');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === '') throw new PushEndpointError('В адресе службы доставки нет имени узла');
  if (isIP(host) !== 0) {
    throw new PushEndpointError(
      'В адресе службы доставки стоит числовой адрес вместо имени — так подписки не выдаёт ни один браузер',
    );
  }
  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new PushEndpointError('Адрес службы доставки указывает внутрь этой сети');
  }
  return { host };
}

/**
 * Полная проверка: форма плюс то, куда имя ведёт на самом деле.
 *
 * Резолв делается ОДИН РАЗ, при подписке. Полностью от подмены DNS это
 * не спасает (имя может смениться потом), но отсекает главное: подписку,
 * собранную руками на внутренний узел. Отправка при этом ничего не
 * читает из ответа наружу — см. sender.ts.
 */
export async function assertDeliverableEndpoint(endpoint: string): Promise<void> {
  const { host } = checkEndpointShape(endpoint);

  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new PushEndpointError(
      `Имя «${host}» из адреса службы доставки не разрешается — проверьте подписку в браузере`,
    );
  }
  if (records.length === 0) {
    throw new PushEndpointError(`Имя «${host}» из адреса службы доставки никуда не ведёт`);
  }
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw new PushEndpointError('Адрес службы доставки указывает внутрь этой сети');
  }
}
