/**
 * Санитизация HTML писем (критично для безопасности).
 *
 * - Вырезаются скрипты, iframe, object/embed, формы и обработчики событий
 *   (DOMPurify сам удаляет on*-атрибуты).
 * - cid:-ссылки на встроенные картинки переписываются на маршрут
 *   /api/messages/:id/parts/:partId.
 * - Внешние картинки по умолчанию блокируются: исходный URL переносится
 *   в data-mt-src, вместо src подставляется прозрачный пиксель. Фронтенд
 *   может показать их по кнопке «Показать картинки».
 */
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

const jsdomInstance = new JSDOM('<!doctype html><html><body></body></html>');
const purifier = createDOMPurify(jsdomInstance.window as unknown as Window & typeof globalThis);

export interface SanitizeOptions {
  /** Разрешить загрузку внешних картинок (http/https). */
  allowRemote: boolean;
  /** Преобразование Content-ID (без угловых скобок) в URL части письма. */
  resolveCid?: ((cid: string) => string | null) | undefined;
}

export interface SanitizeResult {
  html: string;
  /** Сколько внешних ресурсов было заблокировано. */
  blockedRemote: number;
}

/** Прозрачный GIF 1x1 — заглушка вместо заблокированной картинки. */
export const BLOCKED_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const FORBID_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'base',
  'meta',
  'link',
  'noscript',
  'template',
  'audio',
  'video',
  'source',
  'track',
  'svg',
  'math',
];

const FORBID_ATTR = ['srcset', 'ping', 'formaction', 'action', 'xlink:href', 'poster'];

/** Разрешённые схемы URI в атрибутах. */
const ALLOWED_URI = /^(?:(?:https?|mailto|tel|callto):|cid:|data:image\/(?:png|gif|jpe?g|webp|bmp);)/i;

const REMOTE_URL = /^https?:\/\//i;

/** Контекст текущего вызова sanitize (модуль однопоточный). */
let ctx: { allowRemote: boolean; resolveCid: ((cid: string) => string | null) | null; blocked: number } = {
  allowRemote: false,
  resolveCid: null,
  blocked: 0,
};

/**
 * Разбирает url(...) в CSS с учётом кавычек.
 *
 * Наивный вариант `url\(\s*(['"]?)([^)'"]+)\1\s*\)` пропускал адреса со скобкой
 * внутри кавычек: `url("http://tracker/a)b.png")` не совпадал ни с одной ветвью
 * и оставался в CSS нетронутым — то есть внешняя картинка загружалась в обход
 * блокировки, а счётчик заблокированного оставался нулём. Для трекингового
 * пикселя этого достаточно, чтобы отправитель узнал о прочтении письма.
 *
 * Здесь кавычки разбираются явными ветвями, поэтому скобка внутри строки
 * больше не ломает разбор.
 */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;

/** Чистит CSS: убирает @import, expression() и (опционально) внешние url(). */
function scrubCss(css: string, allowRemote: boolean): { css: string; blocked: number } {
  let blocked = 0;
  let out = css.replace(/@import[^;]+;?/gi, () => {
    blocked += 1;
    return '';
  });
  out = out.replace(/expression\s*\(/gi, 'blocked-expression(');
  out = out.replace(CSS_URL, (match, dq?: string, sq?: string, bare?: string) => {
    const trimmed = (dq ?? sq ?? bare ?? '').trim();
    if (!trimmed) return 'none';
    if (/^data:image\//i.test(trimmed)) return match;
    if (trimmed.toLowerCase().startsWith('cid:')) {
      const resolved = ctx.resolveCid?.(trimmed.slice(4).replace(/[<>]/g, ''));
      return resolved ? `url("${resolved}")` : 'none';
    }
    if (REMOTE_URL.test(trimmed) && allowRemote) return match;
    blocked += 1;
    return 'none';
  });

  // Подстраховка: что бы ни осталось после разбора, при запрете внешних
  // ресурсов в CSS не должно быть ни одного http-адреса. Если он там есть —
  // разбор чего-то не понял, и молча пропускать это нельзя.
  if (!allowRemote && /https?:\/\//i.test(out)) {
    out = out.replace(/https?:\/\/[^\s'")]*/gi, () => {
      blocked += 1;
      return 'about:blank';
    });
  }

  return { css: out, blocked };
}

function rewriteImageSource(el: Element, attr: 'src' | 'background'): void {
  const value = el.getAttribute(attr);
  if (!value) return;
  const url = value.trim();

  if (url.toLowerCase().startsWith('cid:')) {
    const cid = url.slice(4).replace(/[<>]/g, '');
    const resolved = ctx.resolveCid ? ctx.resolveCid(cid) : null;
    if (resolved) {
      el.setAttribute(attr, resolved);
    } else {
      el.removeAttribute(attr);
    }
    return;
  }

  if (REMOTE_URL.test(url)) {
    if (!ctx.allowRemote) {
      ctx.blocked += 1;
      el.setAttribute('data-mt-src', url);
      if (attr === 'src') {
        el.setAttribute('src', BLOCKED_PIXEL);
      } else {
        el.removeAttribute(attr);
      }
    }
    return;
  }

  // Прочие схемы, прошедшие ALLOWED_URI (data:image и т. п.), оставляем как есть
}

purifier.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'style') {
    const el = node as Element;
    const { css, blocked } = scrubCss(el.textContent ?? '', ctx.allowRemote);
    ctx.blocked += blocked;
    el.textContent = css;
  }
});

purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  // Ссылки открываем в новой вкладке без утечки opener
  if (tag === 'a') {
    const href = el.getAttribute('href');
    if (href && href.toLowerCase().startsWith('cid:')) el.removeAttribute('href');
    if (el.hasAttribute('href')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }

  if (tag === 'img') rewriteImageSource(el, 'src');
  if (el.hasAttribute('background')) rewriteImageSource(el, 'background');

  const style = el.getAttribute('style');
  if (style) {
    const { css, blocked } = scrubCss(style, ctx.allowRemote);
    ctx.blocked += blocked;
    if (css.trim()) {
      el.setAttribute('style', css);
    } else {
      el.removeAttribute('style');
    }
  }
});

/** Санитизирует HTML письма. Возвращает чистый HTML и счётчик блокировок. */
export function sanitizeEmailHtml(html: string, options: SanitizeOptions): SanitizeResult {
  ctx = {
    allowRemote: options.allowRemote,
    resolveCid: options.resolveCid ?? null,
    blocked: 0,
  };
  const clean = purifier.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ALLOW_DATA_ATTR: false,
    WHOLE_DOCUMENT: false,
    USE_PROFILES: { html: true },
  });
  return { html: clean, blockedRemote: ctx.blocked };
}
