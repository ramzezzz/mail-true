/**
 * Поиск логотипа ОДНОГО домена: по порядку убывания правильности.
 *
 * ------------------------------------------------------------------
 * Порядок и почему он именно такой
 * ------------------------------------------------------------------
 * 1. BIMI. Владелец домена сам назвал адрес своего логотипа записью в DNS.
 *    Ответ точный, бесплатный, быстрый и проверяемый — см. bimi.ts.
 * 2. Значок сайта (favicon / apple-touch-icon). Тот же фирменный знак,
 *    есть почти у всех, но его приходится искать в чужом HTML — см. icons.ts.
 * 3. Помощник ИИ — и только если первые два молчат, и только если
 *    администратор его включил. Почему НЕ наоборот, хотя заказчик просил
 *    «чтобы ИИ искал», расписано в шапке ai.ts: коротко — модель способна
 *    выдумать логотип, а DNS не способен.
 *
 * ------------------------------------------------------------------
 * Что считается ответом
 * ------------------------------------------------------------------
 * Различаются ТРИ исхода, а не два, и это важно для кэша:
 *   found — картинка есть;
 *   none  — спросили и узнали, что логотипа нет (помним долго);
 *   error — спросить не удалось: сеть, таймаут, чужой сервер лежит
 *           (помним коротко, потому что завтра он может ответить).
 * Смешать `none` и `error` — значит либо на неделю забыть работающий домен,
 * либо каждые пять минут ломиться в тот, у которого логотипа нет.
 */
import type { Logger } from 'pino';
import { isBimiDeclination, bimiRecordName, pickBimiLocation } from './bimi.js';
import type { LogoConfig } from './config.js';
import { logoDomainCandidates } from './domain.js';
import { lookupTxt } from './dns.js';
import { iconCandidates } from './icons.js';
import { inspectSenderLogo, SENDER_LOGO_MAX_BYTES, type SenderLogoImage } from './image.js';
import { fetchSafe, type FetchLimits } from './net.js';

/** Откуда взялась картинка. Хранится и отдаётся наружу — для объяснимости. */
export type LogoSource = 'bimi' | 'favicon' | 'ai';

export interface FoundLogo {
  source: LogoSource;
  image: SenderLogoImage;
  /** Адрес, с которого картинка приехала. Нужен для журнала и разбора жалоб. */
  origin: string;
}

export type LookupOutcome =
  | { kind: 'found'; logo: FoundLogo; requests: number }
  | { kind: 'none'; requests: number }
  | { kind: 'error'; requests: number };

/** Голова страницы: тегам <link> дальше первых 128 КБ делать нечего. */
const HTML_MAX_BYTES = 128 * 1024;

export interface LogoHintProvider {
  /**
   * Подсказка помощника ИИ: адрес картинки логотипа ВНУТРИ того же домена.
   * null — подсказки нет (ИИ выключен, не знает, ответил мусором).
   */
  hint(domain: string): Promise<string | null>;
}

export interface FindLogoDeps {
  config: LogoConfig;
  logger: Logger;
  /** Помощник ИИ как третий источник. Отсутствует — третьего источника нет. */
  ai?: LogoHintProvider | undefined;
  /*
   * Сеть и DNS подменяются в проверках. Ходить в настоящий интернет из
   * тестов нельзя: они станут зависеть от того, кто сегодня отвечает и
   * какой у него значок, — то есть перестанут что-либо доказывать.
   */
  fetch?: typeof fetchSafe | undefined;
  dns?: typeof lookupTxt | undefined;
}

/**
 * Ищет логотип домена. Наружу уходит от 1 (запись BIMI нашлась сразу) до
 * примерно 7 обращений на ДОМЕН — и ровно один раз на домен, а не на письмо:
 * повторные ответы отдаёт кэш (см. store.ts).
 */
export async function findLogo(domain: string, deps: FindLogoDeps): Promise<LookupOutcome> {
  const { config } = deps;
  const http = deps.fetch ?? fetchSafe;
  const txtOf = deps.dns ?? lookupTxt;
  const names = logoDomainCandidates(domain);
  if (names.length === 0) return { kind: 'none', requests: 0 };

  const imageLimits: FetchLimits = {
    timeoutMs: config.SENDER_LOGO_HTTP_TIMEOUT_MS,
    maxBytes: SENDER_LOGO_MAX_BYTES,
    maxRedirects: 3,
  };
  const htmlLimits: FetchLimits = {
    timeoutMs: config.SENDER_LOGO_HTTP_TIMEOUT_MS,
    maxBytes: HTML_MAX_BYTES,
    maxRedirects: 3,
    truncate: true,
  };

  let requests = 0;
  /** Хоть раз наткнулись на «спросить не удалось» — исход не «логотипа нет». */
  let sawFailure = false;
  /** Владелец домена ЯВНО отказался от логотипа: `l=` пустое. */
  let declined = false;

  /** Скачивает картинку и проверяет её. null — не годится. */
  const tryImage = async (url: string, source: LogoSource): Promise<FoundLogo | null> => {
    requests += 1;
    const res = await http(url, imageLimits, 'image/*');
    // 'absent' — «по этому адресу ничего нет», это ответ, а не сбой связи.
    if (res === null) {
      sawFailure = true;
      return null;
    }
    if (res === 'absent') return null;
    const image = inspectSenderLogo(res.body);
    if (image === null) return null;
    return { source, image, origin: res.url };
  };

  /* --- 1. BIMI ------------------------------------------------------ */

  for (const name of names) {
    requests += 1;
    const txt = await txtOf(bimiRecordName(name), config.SENDER_LOGO_DNS_TIMEOUT_MS);
    if (!txt.answered) {
      sawFailure = true;
      continue;
    }
    if (isBimiDeclination(txt.records)) declined = true;

    const location = pickBimiLocation(txt.records);
    if (location === null) continue;

    const found = await tryImage(location, 'bimi');
    if (found !== null) {
      deps.logger.debug({ domain, name, origin: found.origin }, 'Логотип найден по BIMI');
      return { kind: 'found', logo: found, requests };
    }
  }

  // Владелец сказал «логотипа нет» — это ответ, и лазить по его сайту после
  // такого невежливо и бессмысленно.
  if (declined) return { kind: 'none', requests };

  /* --- 2. Значок сайта ---------------------------------------------- */

  for (const name of names) {
    requests += 1;
    const page = await http(`https://${name}/`, htmlLimits, 'text/html,*/*;q=0.5');
    if (page === null) {
      sawFailure = true;
      continue;
    }

    /*
     * Сайта по этому имени нет вовсе ('absent'), но значок по стандартному
     * адресу спросить всё равно стоит: домены рассылок часто не отдают
     * страницы, а /favicon.ico на них лежит. Пустой HTML даст ровно один
     * запасной адрес.
     */
    const html =
      page === 'absent' || page.contentType?.startsWith('text/html') === false
        ? ''
        : page.body.toString('utf8');
    const base = page === 'absent' ? `https://${name}/` : page.url;
    for (const url of iconCandidates(html, base)) {
      const found = await tryImage(url, 'favicon');
      if (found !== null) {
        deps.logger.debug({ domain, name, origin: found.origin }, 'Логотип найден по значку сайта');
        return { kind: 'found', logo: found, requests };
      }
    }
  }

  /* --- 3. Помощник ИИ ----------------------------------------------- */

  if (deps.ai) {
    const hinted = await deps.ai.hint(domain);
    if (hinted !== null) {
      const found = await tryImage(hinted, 'ai');
      if (found !== null) {
        deps.logger.debug({ domain, origin: found.origin }, 'Логотип найден по подсказке ИИ');
        return { kind: 'found', logo: found, requests };
      }
    }
  }

  return { kind: sawFailure ? 'error' : 'none', requests };
}
