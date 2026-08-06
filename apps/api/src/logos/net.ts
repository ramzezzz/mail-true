/**
 * Поход в интернет за картинкой — единственное место продукта, где сервер
 * сам обращается по адресу, пришедшему извне.
 *
 * ------------------------------------------------------------------
 * Чем это опасно и что здесь сделано
 * ------------------------------------------------------------------
 * Адрес логотипа берётся из чужой зоны DNS (запись BIMI) или из чужого HTML.
 * То есть адрес назначает посторонний. Если выполнить такой запрос наивно,
 * получается классическая дыра SSRF: владелец домена публикует
 * `l=https://internal.mail.true/admin/...` или просто `https://127.0.0.1:6379/`
 * — и наш сервер сам сходит во внутреннюю сеть, куда снаружи хода нет.
 * В стеке рядом стоят Postgres, Redis, rspamd и админка.
 *
 * Поэтому:
 *   1. Только HTTPS. По HTTP картинку подменяет любой, кто сидит на пути,
 *      а подменённый логотип — это и есть подделка.
 *   2. Адрес, В КОТОРЫЙ РАЗРЕШИЛОСЬ ИМЯ, проверяется на каждом соединении.
 *      Проверка стоит в обработчике `lookup`, а не «до запроса», и это
 *      принципиально: между отдельной проверкой и соединением остаётся
 *      окно, в которое пролезает подмена ответа DNS (DNS rebinding) —
 *      имя отвечает публичным адресом на проверку и внутренним на запрос.
 *      Здесь проверяется ровно тот адрес, к которому идёт соединение.
 *   3. Перенаправления разбираются вручную и по одному: каждый следующий
 *      адрес проходит все те же проверки. Иначе достаточно было бы отдать
 *      302 на 127.0.0.1.
 *   4. Ограничены и время, и объём: ответ читается кусками и обрывается,
 *      как только превысил предел. Без этого чужой сервер, отдающий
 *      бесконечный поток, съедал бы память нашего.
 *   5. Никаких cookie и никакой аутентификации — запрос анонимный.
 */
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIPv4, isIPv6 } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns';

/** Как мы представляемся чужому серверу. Честно и с обратной связью. */
export const LOGO_USER_AGENT =
  'Mail.True-LogoFetcher/1.0 (+https://mail.true/; fetches brand logos for mail avatars)';

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /**
   * Что делать, когда ответ перерос предел: оборвать чтение и вернуть
   * прочитанное (true) или считать попытку неудачной (false, по умолчанию).
   *
   * Для КАРТИНКИ обрезок бесполезен — половина PNG это не PNG. А вот у
   * СТРАНИЦЫ нам нужна только её голова с тегами <link>, и обрывать
   * мегабайтный интернет-магазин на первых десятках килобайт — правильное
   * поведение, а не отказ.
   */
  truncate?: boolean;
}

export interface FetchedResource {
  /** Итоговый адрес после перенаправлений. */
  url: string;
  status: number;
  contentType: string | null;
  body: Buffer;
}

/**
 * Итог обращения. Три исхода, а не два, и это важно для кэша:
 *
 *   ресурс   — скачали;
 *   'absent' — спросили и узнали, что ничего нет: имя не разрешается, сайт
 *              ответил «нет такой страницы». Это ОТВЕТ, и помнить его надо
 *              долго;
 *   null     — спросить не удалось: связь, таймаут, чужой сервер лежит.
 *              Помнить коротко: завтра он может ответить.
 *
 * Смешать «нет» и «не дозвонились» — значит либо на неделю забыть рабочий
 * домен, либо каждые несколько часов ломиться в тот, которого не существует.
 * Доменов второго рода в почте больше всего: одноразовые имена рассылок.
 */
export type FetchOutcome = FetchedResource | 'absent' | null;

/* ------------------------------------------------------------------ */
/* Что считается «своей» сетью                                          */
/* ------------------------------------------------------------------ */

/** Разбирает IPv4 в число. null — это не IPv4. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

/** Диапазоны, куда наш сервер ходить не должен ни при каких условиях. */
const BLOCKED_V4: ReadonlyArray<{ base: string; bits: number; why: string }> = [
  { base: '0.0.0.0', bits: 8, why: 'этот узел' },
  { base: '10.0.0.0', bits: 8, why: 'частная сеть' },
  { base: '100.64.0.0', bits: 10, why: 'сеть оператора (CGNAT)' },
  { base: '127.0.0.0', bits: 8, why: 'петля' },
  { base: '169.254.0.0', bits: 16, why: 'служебные адреса, в облаках — метаданные' },
  { base: '172.16.0.0', bits: 12, why: 'частная сеть (в ней живёт наш docker)' },
  { base: '192.0.0.0', bits: 24, why: 'служебный диапазон IETF' },
  { base: '192.0.2.0', bits: 24, why: 'диапазон для примеров' },
  { base: '192.88.99.0', bits: 24, why: 'ретрансляция 6to4' },
  { base: '192.168.0.0', bits: 16, why: 'частная сеть' },
  { base: '198.18.0.0', bits: 15, why: 'испытательный диапазон' },
  { base: '198.51.100.0', bits: 24, why: 'диапазон для примеров' },
  { base: '203.0.113.0', bits: 24, why: 'диапазон для примеров' },
  { base: '224.0.0.0', bits: 4, why: 'групповая рассылка' },
  { base: '240.0.0.0', bits: 4, why: 'зарезервировано' },
];

/**
 * Адрес принадлежит нашей или служебной сети — ходить туда нельзя.
 * Неразобранный адрес тоже считается запрещённым: сомнение здесь толкуется
 * не в пользу запроса.
 */
export function isBlockedAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    const value = ipv4ToInt(ip);
    if (value === null) return true;
    for (const range of BLOCKED_V4) {
      const base = ipv4ToInt(range.base);
      if (base === null) continue;
      const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
      if ((value & mask) >>> 0 === (base & mask) >>> 0) return true;
    }
    return false;
  }

  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // Адрес IPv4, записанный как IPv6 (`::ffff:127.0.0.1`), — это тот же
    // самый IPv4, и запрет должен относиться к нему же. Без этой ветки
    // петля обходилась бы сменой записи адреса.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    // fc00::/7 — уникальные локальные, fe80::/10 — канальные, ff00::/8 —
    // групповые. 2002::/16 и 64:ff9b::/96 — обёртки над IPv4, через которые
    // при желании выходят в те же частные диапазоны.
    if (/^(f[cd]|fe[89ab]|ff)/u.test(lower)) return true;
    if (lower.startsWith('2002:') || lower.startsWith('64:ff9b:')) return true;
    return false;
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* Сам запрос                                                           */
/* ------------------------------------------------------------------ */

export class BlockedAddressError extends Error {}

/**
 * Разрешение имени с проверкой адреса ПЕРЕД соединением.
 * Подставляется в запрос как `lookup`, поэтому проверяется именно тот
 * адрес, к которому пойдёт соединение, — окна для подмены не остаётся.
 */
const guardedLookup: RequestOptions['lookup'] = (hostname, options, callback) => {
  // Сигнатура lookup перегружена (с опциями и без); приводим к одной форме.
  const cb = callback as (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void;
  dnsLookup(hostname, options as never, (err, address, family) => {
    if (err) {
      cb(err, '', 0);
      return;
    }
    const list: LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address: address as string, family: family as number }];
    const allowed = list.filter((entry) => !isBlockedAddress(entry.address));
    if (allowed.length === 0) {
      cb(new BlockedAddressError(`Адрес ${hostname} ведёт во внутреннюю сеть`), '', 0);
      return;
    }
    if (Array.isArray(address)) {
      cb(null, allowed);
      return;
    }
    cb(null, allowed[0]?.address ?? '', allowed[0]?.family ?? 4);
  });
};

/** Один запрос без разбора перенаправлений. */
function requestOnce(
  url: URL,
  limits: FetchLimits,
  accept: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        headers: {
          'User-Agent': LOGO_USER_AGENT,
          Accept: accept,
          // Никаких cookie и никакой аутентификации: запрос анонимный,
          // чужому серверу не за что зацепиться и некого узнать.
          'Accept-Language': '*',
        },
        timeout: limits.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).subarray(0, limits.maxBytes),
          });
        };

        res.on('data', (chunk: Buffer) => {
          if (done) return;
          total += chunk.length;
          chunks.push(chunk);
          if (total <= limits.maxBytes) return;
          // Обрываем СОЕДИНЕНИЕ, а не просто перестаём копить: иначе
          // бесконечный поток продолжал бы занимать сокет и время.
          res.destroy();
          req.destroy();
          if (limits.truncate === true) finish();
          else if (!done) {
            done = true;
            reject(new Error('Ответ больше предела'));
          }
        });
        res.on('end', finish);
        res.on('error', (err) => {
          if (!done) reject(err);
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Чужой сервер не ответил вовремя'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Скачивает ресурс по HTTPS с разбором перенаправлений вручную.
 * null — не получилось по любой причине; причины наружу не разбираются,
 * потому что исход у всех один: логотипа нет.
 */
export async function fetchSafe(
  rawUrl: string,
  limits: FetchLimits,
  accept = 'image/*,text/html;q=0.8,*/*;q=0.1',
): Promise<FetchOutcome> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Негодный адрес — это ответ по существу: по нему ничего нет и не будет.
    return 'absent';
  }

  for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
    // Не HTTPS — тоже ответ по существу: такой адрес мы не возьмём никогда,
    // сколько ни спрашивай.
    if (url.protocol !== 'https:') return 'absent';

    let res;
    try {
      res = await requestOnce(url, limits, accept);
    } catch (err) {
      // Имя не разрешается — сайта нет. Всё прочее (сброс, таймаут,
      // отказ TLS) — «не дозвонились».
      const code = (err as { code?: string } | null)?.code;
      return code === 'ENOTFOUND' || code === 'NXDOMAIN' ? 'absent' : null;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers['location'];
      const next = Array.isArray(location) ? location[0] : location;
      // Перенаправление без адреса и с негодным адресом — ответ по существу:
      // идти дальше некуда.
      if (!next) return 'absent';
      try {
        // Относительное перенаправление разрешается от текущего адреса,
        // а следующий круг цикла заново проверит и схему, и адрес узла.
        url = new URL(next, url);
      } catch {
        return 'absent';
      }
      continue;
    }

    /*
     * 4xx — сервер ответил и сказал «нет»: страницы или значка по этому
     * адресу не существует. Это ответ. А 5xx — «у меня сломалось», и
     * запоминать по нему «логотипа нет» на неделю было бы неправильно.
     */
    if (res.status >= 400 && res.status < 500) return 'absent';
    if (res.status !== 200) return null;

    const type = res.headers['content-type'];
    return {
      url: url.toString(),
      status: res.status,
      contentType: (Array.isArray(type) ? type[0] : type)?.split(';')[0]?.trim().toLowerCase() ?? null,
      body: res.body,
    };
  }

  // Перенаправления кончились, а ответа так и нет: скорее всего, это круг.
  // Ходить по нему повторно через шесть часов незачем — это ответ.
  return 'absent';
}
