/**
 * Запасной источник логотипа: значок сайта (favicon / apple-touch-icon).
 *
 * BIMI есть у меньшинства доменов, а значок сайта — почти у всех, и это тот
 * же самый фирменный знак. Поэтому если запись BIMI не нашлась, берём
 * страницу https://<домен>/ и смотрим, какие значки она объявляет.
 *
 * ------------------------------------------------------------------
 * Почему разбор регулярными выражениями, а не разметкой через jsdom
 * ------------------------------------------------------------------
 * jsdom в зависимостях есть (им чистится HTML писем), но здесь он не нужен и
 * вреден: это чужая страница неизвестного размера, а нам от неё требуется
 * несколько атрибутов у тегов <link> в начале документа. Строить из мегабайта
 * чужого HTML полное дерево ради четырёх строк — это и время, и память, и
 * лишняя поверхность разбора на каждое письмо в списке.
 *
 * ------------------------------------------------------------------
 * Порядок предпочтения (он же — качество результата в кружке)
 * ------------------------------------------------------------------
 * 1. apple-touch-icon. Это самый удачный источник: значок для плитки на
 *    телефоне рисуют квадратным, непрозрачным, с полями и обычно 180×180 —
 *    ровно то, что хорошо смотрится в круге 32 точки на экране с двойной
 *    плотностью.
 * 2. <link rel="icon"> размером от 64 точек — крупные ещё не мылят.
 * 3. Значок в SVG — масштабируется без потерь.
 * 4. Всё остальное объявленное, крупные раньше мелких.
 * 5. /favicon.ico по умолчанию — его не объявляют, но он почти всегда есть.
 *
 * `rel="mask-icon"` намеренно пропускается: это одноцветный силуэт для
 * панели Safari, в кружке он выглядит чёрной кляксой.
 */

/** Сколько адресов вообще имеет смысл пробовать для одного домена. */
export const MAX_ICON_CANDIDATES = 4;

interface IconLink {
  href: string;
  /** Наибольшая сторона из объявленных в `sizes`. 0 — не объявлено. */
  size: number;
  isApple: boolean;
  isSvg: boolean;
}

/** Значения атрибута sizes: `32x32 16x16`, `any`. Возвращает наибольшую сторону. */
function largestSize(sizes: string | null): number {
  if (!sizes) return 0;
  // `any` — это SVG: конкретного размера нет, но и мылить нечему.
  if (sizes.trim().toLowerCase() === 'any') return 0;
  let max = 0;
  for (const match of sizes.matchAll(/(\d+)\s*[x×]\s*(\d+)/giu)) {
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (Number.isFinite(w) && Number.isFinite(h)) max = Math.max(max, w, h);
  }
  return max;
}

/** Достаёт значение атрибута из строки тега. Кавычки любые или без них. */
function attr(tag: string, name: string): string | null {
  const quoted = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'iu').exec(tag);
  if (quoted) return quoted[2] ?? quoted[3] ?? null;
  const bare = new RegExp(`\\s${name}\\s*=\\s*([^\\s>]+)`, 'iu').exec(tag);
  return bare?.[1] ?? null;
}

/**
 * Абсолютный адрес значка. null — адрес нерабочий или ведёт не по HTTPS.
 *
 * HTTPS обязателен по той же причине, что и в BIMI: картинку, идущую по
 * открытому каналу, подменяет любой, кто сидит на пути, а подменённый
 * логотип — это и есть подделка. `data:` тоже отвергаем: значок в теле
 * страницы бывает мусорным пикселем, а разбирать его без пользы дорого.
 */
function absoluteHttps(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Собирает адреса значков, объявленных страницей, в порядке предпочтения.
 *
 * @param html начало HTML страницы (достаточно первых десятков килобайт:
 *             теги <link> живут в <head>)
 * @param base адрес самой страницы — относительно него разрешаются ссылки
 */
export function iconCandidates(html: string, base: string): string[] {
  // <base href> меняет точку отсчёта для всех относительных ссылок страницы.
  // Без его учёта значок сайта, живущего на CDN, разрешался бы в никуда.
  const baseTag = /<base\b[^>]*>/iu.exec(html);
  const declaredBase = baseTag ? attr(baseTag[0], 'href') : null;
  let root = base;
  if (declaredBase) {
    try {
      root = new URL(declaredBase, base).toString();
    } catch {
      /* негодный <base> просто игнорируем */
    }
  }

  const found: IconLink[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/u);
    const isApple = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    const isIcon = rel.includes('icon') || rel.includes('shortcut');
    if (!isApple && !isIcon) continue;
    // Одноцветный силуэт для панели Safari — в кружке это клякса.
    if (rel.includes('mask-icon')) continue;

    const href = attr(tag, 'href');
    if (!href) continue;
    const url = absoluteHttps(href, root);
    if (url === null) continue;

    const type = (attr(tag, 'type') ?? '').toLowerCase();
    found.push({
      href: url,
      size: largestSize(attr(tag, 'sizes')),
      isApple,
      isSvg: type.includes('svg') || /\.svg(\?|$)/iu.test(url),
    });
  }

  /** Меньше — предпочтительнее. Порядок описан в шапке файла. */
  const rank = (icon: IconLink): number => {
    if (icon.isApple) return 0;
    if (icon.size >= 64) return 1;
    if (icon.isSvg) return 2;
    return 3;
  };

  found.sort((a, b) => rank(a) - rank(b) || b.size - a.size);

  const urls: string[] = [];
  for (const icon of found) {
    if (!urls.includes(icon.href)) urls.push(icon.href);
  }

  // Последняя надежда: значок по стандартному адресу. Его почти никогда не
  // объявляют тегом, но он есть почти везде — именно его показывает браузер
  // во вкладке, когда страница ничего не объявила.
  const fallback = absoluteHttps('/favicon.ico', root);
  if (fallback !== null && !urls.includes(fallback)) urls.push(fallback);

  return urls.slice(0, MAX_ICON_CANDIDATES);
}
