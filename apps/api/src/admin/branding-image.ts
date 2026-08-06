/**
 * Проверка файла логотипа перед тем, как он ляжет на диск.
 *
 * Зачем отдельный модуль, а не пара условий в маршруте. Логотип грузит
 * администратор из браузера, а отдаётся он НЕАУТЕНТИФИЦИРОВАННЫМ людям на
 * странице входа — это единственное место продукта, где чужой файл выдаётся
 * всем подряд. Поэтому решение «картинка это или нет» принимается по
 * СОДЕРЖИМОМУ, а не по имени файла и не по заголовку Content-Type: и то,
 * и другое пишет клиент, и `payload.php`, переименованный в `logo.png`,
 * прошёл бы обе проверки.
 *
 * Второе требование — внятный отказ. «Некорректный запрос» на попытку
 * загрузить фотографию с телефона (4000×3000, 6 МБ) не говорит человеку
 * ничего: он не знает ни предела, ни того, что именно не так. Здесь каждый
 * отказ называет и предел, и то, что принесли на самом деле.
 */
import { BadRequestError } from '../errors.js';

/** Что принимаем. Ключ — сам формат, значение — тип содержимого и расширение. */
export const LOGO_FORMATS = {
  png: { mime: 'image/png', ext: 'png', title: 'PNG' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', title: 'JPEG' },
  webp: { mime: 'image/webp', ext: 'webp', title: 'WEBP' },
  gif: { mime: 'image/gif', ext: 'gif', title: 'GIF' },
  svg: { mime: 'image/svg+xml', ext: 'svg', title: 'SVG' },
} as const;

export type LogoFormat = keyof typeof LOGO_FORMATS;

/**
 * Пределы.
 *
 * Размер: 512 КБ. Логотип на странице входа — это строка высотой в пару
 * десятков точек; всё, что больше, — это либо исходник из редактора, либо
 * фотография. Файл лежит в томе и целиком попадает в резервную копию
 * настроек, поэтому мегабайтам там не место.
 *
 * Точки: нижняя граница отсекает favicon 16×16, поставленный вместо
 * логотипа (на странице входа он превратится в мутное пятно), верхняя —
 * фотографию с телефона.
 */
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MIN_WIDTH = 32;
export const LOGO_MIN_HEIGHT = 16;
export const LOGO_MAX_WIDTH = 2000;
export const LOGO_MAX_HEIGHT = 1000;

/**
 * Пределы проверки. Вынесены в параметр, а не зашиты, потому что тем же
 * разбором пользуется ручной логотип домена отправителя
 * (src/logos/admin.ts): там картинка ложится в кружок 32 точки, и 16×16 —
 * это норма, а не «мутное пятно во всю строку входа».
 *
 * Копии модуля под другие пределы быть не должно: разбор SVG здесь защищает
 * от чужого кода, и вторая его копия однажды разойдётся с первой — причём
 * разойдётся в опасную сторону.
 */
export interface LogoLimits {
  maxBytes: number;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}

export const DEFAULT_LOGO_LIMITS: LogoLimits = {
  maxBytes: LOGO_MAX_BYTES,
  minWidth: LOGO_MIN_WIDTH,
  minHeight: LOGO_MIN_HEIGHT,
  maxWidth: LOGO_MAX_WIDTH,
  maxHeight: LOGO_MAX_HEIGHT,
};

export interface LogoInfo {
  format: LogoFormat;
  mime: string;
  /** Расширение файла на диске. Берётся ОТСЮДА, а не из имени, что прислали. */
  ext: string;
  width: number;
  height: number;
  size: number;
}

/** Человекочитаемый размер для текста отказа: «3.4 МБ», «700 КБ». */
export function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${bytes} Б`;
}

/* ------------------------------------------------------------------ */
/* Опознание формата по первым байтам                                   */
/* ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Чем это МОГЛО БЫ быть, если картинкой не является.
 *
 * Нужно ровно для текста отказа: «файл не похож на картинку» человеку
 * не помогает, а «это исполняемый файл Windows» — помогает сразу.
 */
const EXECUTABLE_SIGNATURES: ReadonlyArray<{ head: Buffer; title: string }> = [
  { head: Buffer.from('MZ', 'latin1'), title: 'исполняемый файл Windows' },
  { head: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), title: 'исполняемый файл Linux (ELF)' },
  { head: Buffer.from('#!', 'latin1'), title: 'сценарий оболочки' },
  { head: Buffer.from('<?php', 'latin1'), title: 'сценарий PHP' },
  { head: Buffer.from('PK\u0003\u0004', 'latin1'), title: 'архив ZIP (или документ office)' },
  { head: Buffer.from('%PDF', 'latin1'), title: 'документ PDF' },
  { head: Buffer.from([0xca, 0xfe, 0xba, 0xbe]), title: 'класс Java' },
  { head: Buffer.from([0x1f, 0x8b]), title: 'архив gzip' },
];

function looksLikeExecutable(bytes: Buffer): string | null {
  for (const { head, title } of EXECUTABLE_SIGNATURES) {
    if (bytes.subarray(0, head.length).equals(head)) return title;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Размеры в точках — из самих файлов, без сторонних библиотек           */
/* ------------------------------------------------------------------ */

/** PNG: ширина и высота лежат в блоке IHDR сразу за подписью. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  // 8 байт подписи, 4 длина блока, 4 тип блока ('IHDR'), дальше размеры
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * JPEG: размеры лежат в маркере кадра (SOF), а до него идёт произвольное
 * число служебных секций (EXIF, комментарии, таблицы). Идём по цепочке.
 */
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let pos = 2;
  while (pos + 9 < bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos += 1;
      continue;
    }
    const marker = bytes[pos + 1] ?? 0;
    // Маркеры кадра: C0..CF, кроме C4 (таблицы Хаффмана), C8 и CC
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      return { height: bytes.readUInt16BE(pos + 5), width: bytes.readUInt16BE(pos + 7) };
    }
    // Маркеры без длины: заполнители, начало/конец потока
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      pos += 2;
      continue;
    }
    const length = bytes.readUInt16BE(pos + 2);
    if (length < 2) return null;
    pos += 2 + length;
  }
  return null;
}

/** GIF: логический экран описан сразу за подписью, порядок байтов младший. */
function gifSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

/** WEBP: три разновидности блока, у каждой размеры лежат по-своему. */
function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const packed = bytes.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* SVG                                                                  */
/* ------------------------------------------------------------------ */

/**
 * Что в SVG запрещено.
 *
 * SVG — это XML, а не картинка: внутри него живут скрипты, ссылки на чужие
 * узлы, встроенные HTML-блоки и внешние сущности. В теге <img> браузер
 * скрипты не выполняет, но логотип отдаётся по своему адресу, и открыть его
 * в отдельной вкладке может кто угодно — там это уже полноценный документ
 * НАШЕГО происхождения, то есть с доступом к нашим cookie.
 *
 * Поэтому подозрительный SVG не чистится, а отвергается целиком: чистка
 * молча меняет то, что человек загрузил, и он об этом не узнает.
 */
const SVG_FORBIDDEN: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /<\s*script\b/iu, what: 'тег <script>' },
  { re: /<\s*foreignObject\b/iu, what: 'тег <foreignObject> (внутри него живёт HTML)' },
  { re: /<\s*iframe\b/iu, what: 'тег <iframe>' },
  { re: /<\s*embed\b/iu, what: 'тег <embed>' },
  { re: /<\s*object\b/iu, what: 'тег <object>' },
  { re: /<!ENTITY\b/iu, what: 'объявление внешней сущности <!ENTITY>' },
  { re: /\son[a-z]+\s*=/iu, what: 'обработчик события (onload, onclick и подобные)' },
  { re: /javascript\s*:/iu, what: 'ссылка вида javascript:' },
  {
    re: /<\s*(set|animate)\b[^>]*attributeName\s*=\s*["']?href/iu,
    what: 'подмена ссылки анимацией',
  },
];

/** Ссылки наружу: логотип не должен тянуть чужие файлы со стороннего сервера. */
const SVG_EXTERNAL_REF = /(?:xlink:href|href|src)\s*=\s*["']\s*(?:https?:)?\/\//iu;

function svgSize(text: string): { width: number; height: number } | null {
  const attr = (name: string): number | null => {
    const found = new RegExp(`<svg[^>]*\\s${name}\\s*=\\s*["']([^"']+)["']`, 'iu').exec(text);
    if (!found?.[1]) return null;
    const value = Number.parseFloat(found[1]);
    // Проценты и «em» размера в точках не задают — такой SVG меряем по viewBox
    if (!Number.isFinite(value) || /%|em|rem/iu.test(found[1])) return null;
    return value;
  };

  const width = attr('width');
  const height = attr('height');
  if (width !== null && height !== null)
    return { width: Math.round(width), height: Math.round(height) };

  const viewBox = /<svg[^>]*\sviewBox\s*=\s*["']([^"']+)["']/iu.exec(text);
  if (viewBox?.[1]) {
    const parts = viewBox[1]
      .trim()
      .split(/[\s,]+/u)
      .map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return { width: Math.round(parts[2] as number), height: Math.round(parts[3] as number) };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Собственно проверка                                                  */
/* ------------------------------------------------------------------ */

/**
 * Разбирает файл логотипа и возвращает его свойства.
 * Любое несоответствие — BadRequestError с текстом, из которого понятно,
 * что именно не так и какой предел нарушен.
 */
export function inspectLogo(bytes: Buffer, limits: LogoLimits = DEFAULT_LOGO_LIMITS): LogoInfo {
  if (bytes.length === 0) {
    throw new BadRequestError('Файл пустой: в нём ноль байт. Выберите файл с картинкой.');
  }

  if (bytes.length > limits.maxBytes) {
    throw new BadRequestError(
      `Файл ${humanBytes(bytes.length)}, а логотип должен быть не больше ` +
        `${humanBytes(limits.maxBytes)}. Уменьшите картинку или сохраните её в PNG с прозрачным фоном.`,
    );
  }

  const format = sniffFormat(bytes);
  const size = sizeOf(format, bytes);

  if (size === null) {
    throw new BadRequestError(
      `Файл опознан как ${LOGO_FORMATS[format].title}, но прочитать его размеры не удалось: ` +
        'скорее всего, он повреждён. Откройте его в просмотрщике и пересохраните.',
    );
  }

  if (size.width < limits.minWidth || size.height < limits.minHeight) {
    throw new BadRequestError(
      `Картинка ${size.width}×${size.height} точек — это слишком мало: ` +
        `логотип растянется в пятно. Нужно не меньше ${limits.minWidth}×${limits.minHeight}.`,
    );
  }

  if (size.width > limits.maxWidth || size.height > limits.maxHeight) {
    throw new BadRequestError(
      `Картинка ${size.width}×${size.height} точек — это слишком много: предел ` +
        `${limits.maxWidth}×${limits.maxHeight}. Похоже, это фотография или исходник из редактора, ` +
        'а не логотип.',
    );
  }

  return {
    format,
    mime: LOGO_FORMATS[format].mime,
    ext: LOGO_FORMATS[format].ext,
    width: size.width,
    height: size.height,
    size: bytes.length,
  };
}

/**
 * Формат по содержимому. Имя файла и Content-Type не участвуют намеренно.
 *
 * Экспортируется, потому что тем же опознанием и той же проверкой SVG
 * пользуется логотип домена отправителя (src/logos/image.ts). Пределы там
 * свои — 16×16 у favicon это норма, — а вот решение «картинка это или
 * документ со скриптом» обязано быть ОДНО на весь продукт: второй такой
 * же проверке свойственно разойтись с первой ровно в опасную сторону.
 */
export function sniffFormat(bytes: Buffer): LogoFormat {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (isSvg(bytes)) return 'svg';

  const executable = looksLikeExecutable(bytes);
  if (executable !== null) {
    throw new BadRequestError(
      `Это не картинка, а ${executable}. Логотипом может быть только файл ` +
        'PNG, JPEG, WEBP, GIF или SVG.',
    );
  }
  throw new BadRequestError(
    'Файл не опознан как картинка: его первые байты не совпадают ни с одним из ' +
      'допустимых форматов (PNG, JPEG, WEBP, GIF, SVG). Расширение файла здесь не ' +
      'помогает — важно содержимое.',
  );
}

/** SVG опознаём по тексту: подписи из байтов у него нет. */
function isSvg(bytes: Buffer): boolean {
  // Смотрим только начало: XML-пролог, комментарий и doctype могут быть длинными,
  // но корневой тег в первом килобайте есть всегда.
  const head = bytes.subarray(0, 1024).toString('utf8');
  return (
    /<\s*svg[\s>]/iu.test(head) ||
    (/^\s*<\?xml/iu.test(head) && /<\s*svg[\s>]/iu.test(bytes.toString('utf8')))
  );
}

/** Размеры в точках. Для SVG попутно проверяет его безопасность (см. inspectSvg). */
export function sizeOf(
  format: LogoFormat,
  bytes: Buffer,
): { width: number; height: number } | null {
  switch (format) {
    case 'png':
      return pngSize(bytes);
    case 'jpeg':
      return jpegSize(bytes);
    case 'gif':
      return gifSize(bytes);
    case 'webp':
      return webpSize(bytes);
    case 'svg':
      return inspectSvg(bytes);
  }
}

/** SVG: сначала запреты, потом размеры. Порядок важен для текста отказа. */
function inspectSvg(bytes: Buffer): { width: number; height: number } | null {
  const text = bytes.toString('utf8');
  for (const { re, what } of SVG_FORBIDDEN) {
    if (re.test(text)) {
      throw new BadRequestError(
        `В файле SVG найден ${what}. SVG — это документ, а не картинка: такой файл ` +
          'может выполнять код в браузере того, кто откроет страницу входа. ' +
          'Сохраните логотип в PNG либо уберите из SVG всё, кроме фигур.',
      );
    }
  }
  if (SVG_EXTERNAL_REF.test(text)) {
    throw new BadRequestError(
      'В файле SVG есть ссылка на сторонний сервер. Логотип обязан быть самодостаточным: ' +
        'иначе страница входа перестанет показывать его, как только чужой сервер откажет, ' +
        'а каждый вход будет отмечаться на стороне.',
    );
  }
  return svgSize(text);
}
