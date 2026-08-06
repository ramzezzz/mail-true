/**
 * Кому МОЖНО нарисовать логотип: разбор Authentication-Results.
 *
 * ------------------------------------------------------------------
 * Зачем это здесь вообще
 * ------------------------------------------------------------------
 * Логотип рядом с письмом читается человеком как знак подлинности: «это
 * действительно тот самый банк». Значит показывать его можно только тому,
 * чью подлинность действительно проверили. Письмо от «sberbank-security.xyz»
 * с настоящим гербом Сбербанка ОПАСНЕЕ такого же письма без герба: без
 * картинки человек хотя бы посмотрит на адрес.
 *
 * Поэтому здесь ровно один вопрос: подтверждено ли, что письмо отправлено
 * от имени домена, написанного в поле «От кого»? Ответ «да» даёт только
 * согласованность (alignment) — DMARC=pass либо DKIM=pass с подписью того же
 * домена. Одного SPF=pass мало: он проверяет конверт (MAIL FROM), а человек
 * читает заголовок From, и эти два адреса совпадать не обязаны — на этом
 * расхождении и построена половина подделок.
 *
 * ------------------------------------------------------------------
 * Почему берётся ТОЛЬКО ПЕРВЫЙ заголовок и только со своим именем
 * ------------------------------------------------------------------
 * Authentication-Results — обычный заголовок письма. Его может написать кто
 * угодно, в том числе сам отправитель: строка «dkim=pass» внутри присланного
 * письма не значит ничего. Доверять можно ровно одному экземпляру — тому,
 * который вписал НАШ сервер при приёме (rspamd через milter, заголовок
 * добавляется сверху). Отсюда две проверки, и обе обязательны:
 *
 *   1. Берётся ПЕРВЫЙ (самый верхний) заголовок. Подделка отправителя
 *      физически не может оказаться выше того, что приписан при приёме.
 *   2. Его authserv-id обязан совпасть с именем нашего почтового узла
 *      (MAIL_HOSTNAME). Иначе достаточно было бы прислать письмо, у которого
 *      первым заголовком идёт собственноручное «dkim=pass», — и чужой
 *      логотип встал бы в кружок по заказу отправителя.
 *
 * Только вторая проверка без первой тоже не спасает: отправитель напишет
 * `Authentication-Results: mail.local; dkim=pass` и попадёт в наше имя.
 * Работают они лишь вместе.
 */
import { rawHeaderValue } from './header-charset.js';

/** Разобранная запись одного метода: `dkim=pass header.d=example.com`. */
export interface AuthMethodResult {
  /** dkim | spf | dmarc | auth | … — в нижнем регистре. */
  method: string;
  /** pass | fail | none | … — в нижнем регистре. */
  result: string;
  /** Свойства метода: `header.d` -> `example.com`. Ключи в нижнем регистре. */
  props: Record<string, string>;
}

export interface AuthResults {
  /** Имя сервера, который проводил проверку (RFC 8601, authserv-id). */
  authservId: string;
  methods: AuthMethodResult[];
}

/**
 * Делит строку по `;`, не разрывая значений в кавычках.
 *
 * Кавычки в Authentication-Results законны (`reason="..."`), и наивный
 * `split(';')` разрезал бы такое значение пополам, а обломок его второй
 * половины разобрался бы как ещё один метод.
 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (ch === ';' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** Снимает кавычки со значения свойства, если они есть. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Разбирает значение одного заголовка Authentication-Results.
 * null — строка не похожа на этот заголовок вовсе.
 */
export function parseAuthenticationResults(value: string): AuthResults | null {
  const chunks = splitTopLevel(value.replace(/\s+/gu, ' '));
  const head = chunks[0];
  if (head === undefined) return null;

  /*
   * authserv-id может нести номер версии: `mail.local 1; ...`. Берём первое
   * слово. Заодно отсекается случай, когда сервер вписал только имя и на
   * этом закончил, — тогда методов просто нет.
   */
  const authservId = (head.split(/\s+/u)[0] ?? '').toLowerCase();
  if (authservId === '') return null;

  const methods: AuthMethodResult[] = [];
  for (const chunk of chunks.slice(1)) {
    const tokens = chunk.split(/\s+/u);
    const first = tokens[0] ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const method = first.slice(0, eq).toLowerCase();
    const result = first.slice(eq + 1).toLowerCase();
    if (method === '' || result === '') continue;

    const props: Record<string, string> = {};
    for (const token of tokens.slice(1)) {
      const at = token.indexOf('=');
      if (at <= 0) continue;
      props[token.slice(0, at).toLowerCase()] = unquote(token.slice(at + 1)).toLowerCase();
    }
    methods.push({ method, result, props });
  }

  return { authservId, methods };
}

/** Домен из почтового адреса: `Иван <a@Example.COM.>` -> `example.com`. */
export function domainOfAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .replace(/[>\s]+$/u, '')
    .replace(/\.+$/u, '')
    .toLowerCase();
  // Домен должен выглядеть доменом: хотя бы одна точка и только допустимые
  // знаки. Заодно отсекаются адреса вида `user@[192.0.2.1]` — у литерала
  // адреса логотипа быть не может по определению.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u.test(domain)) {
    return null;
  }
  return domain;
}

/**
 * Согласованность домена подписи с доменом отправителя.
 *
 * Совпадение либо отношение «поддомен» в любую сторону: письмо от
 * `news.example.com`, подписанное `example.com`, — это то самое письмо от
 * example.com (мягкая согласованность DMARC, relaxed). А вот `example.com`
 * и `example.com.evil.net` в это отношение не попадают: у второго первый
 * не является суффиксом ПО ГРАНИЦЕ ТОЧКИ.
 */
export function domainsAligned(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Подтверждена ли подлинность отправителя настолько, чтобы рисовать логотип.
 *
 * @param fromDomain домен из заголовка From (уже нормализованный)
 * @param results    разобранный заголовок, вписанный НАШИМ сервером
 */
export function senderVerified(fromDomain: string, results: AuthResults): boolean {
  for (const entry of results.methods) {
    if (entry.result !== 'pass') continue;

    if (entry.method === 'dmarc') {
      /*
       * DMARC=pass по определению означает, что хотя бы одна из проверок
       * (SPF или DKIM) сошлась И согласована с доменом заголовка From.
       * Это ровно то, что нам нужно, и потому самый желанный ответ.
       *
       * `header.from` при этом всё равно сверяется, если он назван: письмо
       * могло быть переупаковано по дороге (список рассылки), и тогда
       * проверка относилась к другому адресу, чем тот, который видит человек.
       */
      const claimed = entry.props['header.from'];
      if (claimed === undefined || domainsAligned(fromDomain, claimed)) return true;
    }

    if (entry.method === 'dkim') {
      /*
       * DKIM=pass сам по себе не значит ничего: подписать письмо своим
       * ключом может кто угодно, и `d=` тогда указывает на домен подделки.
       * Значение имеет только СОГЛАСОВАННАЯ подпись — та, чей домен `d=`
       * совпадает с доменом отправителя.
       */
      const signer = entry.props['header.d'] ?? entry.props['header.i']?.replace(/^.*@/u, '');
      if (signer !== undefined && signer !== '' && domainsAligned(fromDomain, signer)) return true;
    }

    /*
     * SPF=pass намеренно НЕ засчитывается: он проверяет адрес конверта
     * (MAIL FROM), а логотип ставится к тому, что человек видит в поле
     * «От кого». Домены конверта и заголовка совпадать не обязаны.
     */
  }
  return false;
}

/**
 * Имя нашего почтового узла — то, чьё авторство заголовка мы признаём.
 *
 * Читается из окружения тем же именем, что и во всём стеке
 * (infra/.env, MAIL_HOSTNAME). Значение по умолчанию совпадает с dev-стендом.
 */
export function trustedAuthservId(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MAIL_HOSTNAME'] ?? 'mail.local').trim().toLowerCase();
}

/**
 * Домен, которому в этом письме разрешено показать логотип.
 * null — не разрешено никакому: рисуется прежняя буква.
 *
 * @param fromAddress  адрес из заголовка From
 * @param headerBlock  сырой блок заголовков письма (как его отдал IMAP)
 * @param authservId   имя нашего узла; по умолчанию из окружения
 */
export function senderLogoDomain(
  fromAddress: string | null | undefined,
  headerBlock: Buffer | undefined | null,
  authservId: string = trustedAuthservId(),
): string | null {
  const domain = domainOfAddress(fromAddress);
  if (domain === null) return null;
  if (!headerBlock || headerBlock.length === 0) return null;

  // Только первое вхождение — см. шапку файла. rawHeaderValue возвращает
  // именно его и заодно разворачивает перенесённые строки.
  const raw = rawHeaderValue(headerBlock, 'authentication-results');
  if (!raw || raw.length === 0) return null;

  const results = parseAuthenticationResults(raw.toString('utf8'));
  if (results === null) return null;
  if (results.authservId !== authservId.toLowerCase()) return null;

  return senderVerified(domain, results) ? domain : null;
}
