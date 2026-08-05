/**
 * Блокировка внешних картинок в теле письма.
 *
 * Блокирует СЕРВЕР, а не интерфейс: `apps/api/src/mail/sanitize.ts` переносит
 * исходный адрес в `data-mt-src`, вместо `src` подставляет прозрачный пиксель
 * и возвращает счётчик `blockedRemote` в ответе `GET /api/messages/:id`.
 * Показать картинки можно единственным способом — перезапросить письмо с
 * `?images=1`: тогда сервер отдаст тело с настоящими адресами.
 *
 * Раньше здесь жила собственная блокировка, искавшая `src="http…"`. Против
 * настоящего API она не находила ничего (такого `src` в ответе уже нет),
 * поэтому плашка «Показать картинки» не появлялась никогда, а появись она —
 * показывать было бы нечего: параметр `?images=1` никто не отправлял.
 * Теперь интерфейс только читает счётчик сервера, а «своя» блокировка
 * осталась ровно для одного дела — заглушки, которая изображает сервер.
 */

/** Прозрачный GIF 1×1 — то же значение, что подставляет сервер. */
export const BLOCKED_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Атрибут, куда сервер убирает исходный адрес заблокированной картинки. */
export const BLOCKED_SRC_ATTR = 'data-mt-src';

/** Что интерфейсу нужно знать о письме, чтобы решить судьбу плашки. */
export interface BlockableMessage {
  bodyHtml?: string | null;
  /** Счётчик сервера. Необязателен: ответ мог прийти и без него. */
  blockedRemote?: number | undefined;
}

const BLOCKED_ATTR_RE = new RegExp(`\\s${BLOCKED_SRC_ATTR}\\s*=`, 'gi');

/**
 * Сколько заблокированных картинок в готовом HTML.
 * Запасной путь на случай, если счётчика в ответе нет.
 */
export function countBlockedImages(html: string | null | undefined): number {
  if (!html) return 0;
  return html.match(BLOCKED_ATTR_RE)?.length ?? 0;
}

/**
 * Сколько внешних картинок заблокировано в письме.
 * Верим счётчику сервера, а без него считаем по разметке.
 */
export function blockedImageCount(message: BlockableMessage | null | undefined): number {
  if (!message) return 0;
  if (typeof message.blockedRemote === 'number') return message.blockedRemote;
  return countBlockedImages(message.bodyHtml);
}

/** Показывать ли плашку «Внешние картинки заблокированы». */
export function shouldOfferImages(
  message: BlockableMessage | null | undefined,
  imagesRequested: boolean,
): boolean {
  return !imagesRequested && blockedImageCount(message) > 0;
}

export interface BlockedHtml {
  html: string;
  /** Сколько картинок заблокировано — имя поля как в ответе API. */
  blockedRemote: number;
}

const IMG_SRC_RE =
  /(<img\b[^>]*?)\ssrc\s*=\s*(?:"((?:https?:)?\/\/[^"]*)"|'((?:https?:)?\/\/[^']*)')/gi;

const CSS_URL_RE = /url\(\s*(['"]?)(?:https?:)?\/\/[^)'"]*\1\s*\)/gi;

/**
 * Повторяет поведение серверного санитайзера — нужна только заглушкам,
 * чтобы автономный режим отдавал ровно тот же HTML, что настоящий API.
 * В боевом пути не используется: там всё уже сделано на сервере.
 */
export function blockRemoteImages(html: string): BlockedHtml {
  let blockedRemote = 0;
  let result = html.replace(
    IMG_SRC_RE,
    (_m, before: string, double: string | undefined, single: string | undefined) => {
      blockedRemote += 1;
      return `${before} src="${BLOCKED_PIXEL}" ${BLOCKED_SRC_ATTR}="${double ?? single ?? ''}"`;
    },
  );
  result = result.replace(CSS_URL_RE, () => {
    blockedRemote += 1;
    return 'none';
  });
  return { html: result, blockedRemote };
}
