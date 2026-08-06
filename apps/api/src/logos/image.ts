/**
 * Проверка картинки, скачанной с чужого сервера.
 *
 * ------------------------------------------------------------------
 * Чем это отличается от проверки логотипа входа
 * ------------------------------------------------------------------
 * Опознание формата по первым байтам и — что важнее — разбор безопасности
 * SVG здесь НЕ переписаны, а взяты из admin/branding-image.ts. Причина
 * простая: вторая копия проверки, которой доверена защита от чужого кода
 * в SVG, однажды разойдётся с первой, и разойдётся она в опасную сторону.
 * Пусть решение «картинка это или документ со скриптом» будет одно на весь
 * продукт.
 *
 * Отличаются только ПРЕДЕЛЫ, и отличаются осмысленно:
 *   * 16×16 — обычный размер favicon, и для логотипа входа он был бы мутным
 *     пятном во всю строку, а в кружке 32 точки он всего лишь не идеален;
 *   * 256 КБ вместо 512 — картинка едет по сети на каждое незнакомое
 *     доменное имя, и место в кэше она занимает у нас;
 *   * добавлен формат ICO: именно им отвечает /favicon.ico у большинства
 *     сайтов, а логотипом входа его никто не грузит.
 *
 * Ошибки здесь не рассказываются человеку: это не его файл и не его выбор.
 * Негодная картинка означает «логотипа у домена нет» — в кружке остаётся
 * буква, и это правильный исход.
 */
import { LOGO_FORMATS, sizeOf, sniffFormat, type LogoFormat } from '../admin/branding-image.js';

/** Больше этого не скачиваем и не храним. */
export const SENDER_LOGO_MAX_BYTES = 256 * 1024;
/** Меньше этого картинку в кружок ставить незачем — будет каша. */
export const SENDER_LOGO_MIN_SIDE = 16;
/** Больше этого — это уже не значок, а иллюстрация со страницы. */
export const SENDER_LOGO_MAX_SIDE = 2048;

/** Формат логотипа отправителя: форматы логотипа входа плюс ICO. */
export type SenderLogoFormat = LogoFormat | 'ico';

export interface SenderLogoImage {
  format: SenderLogoFormat;
  mime: string;
  width: number;
  height: number;
  bytes: Buffer;
}

/** ICO: подпись `00 00 01 00`. `00 00 02 00` — это курсор, он нам не нужен. */
const ICO_SIGNATURE = Buffer.from([0x00, 0x00, 0x01, 0x00]);

/**
 * Размеры ICO. В файле лежит НЕСКОЛЬКО картинок разного размера; берём
 * наибольшую — её и покажет браузер, когда мы отдадим файл целиком.
 */
function icoSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 22) return null;
  if (!bytes.subarray(0, 4).equals(ICO_SIGNATURE)) return null;
  const count = bytes.readUInt16LE(4);
  if (count === 0) return null;

  let best: { width: number; height: number } | null = null;
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    if (entry + 16 > bytes.length) break;
    // Ноль в поле размера означает 256 — иначе байт бы не хватило.
    const width = bytes[entry] === 0 ? 256 : (bytes[entry] as number);
    const height = bytes[entry + 1] === 0 ? 256 : (bytes[entry + 1] as number);
    if (best === null || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

/**
 * Разбирает скачанные байты. null — это не годная картинка (любая причина:
 * не картинка, опасный SVG, размеры вне пределов, файл повреждён).
 */
export function inspectSenderLogo(bytes: Buffer): SenderLogoImage | null {
  if (bytes.length === 0 || bytes.length > SENDER_LOGO_MAX_BYTES) return null;

  const ico = icoSize(bytes);
  if (ico !== null) {
    return withinLimits({
      format: 'ico',
      // Исторически ICO отдают под этим типом; `image/vnd.microsoft.icon`
      // формально правильнее, но браузеры единодушно понимают оба, а этот
      // ещё и не спорит со старыми.
      mime: 'image/x-icon',
      width: ico.width,
      height: ico.height,
      bytes,
    });
  }

  let format: LogoFormat;
  let size: { width: number; height: number } | null;
  try {
    // Обе функции бросают BadRequestError с текстом для администратора:
    // «это исполняемый файл», «в SVG найден тег <script>». Здесь адресата
    // у этих слов нет — любой отказ означает «логотипа нет».
    format = sniffFormat(bytes);
    size = sizeOf(format, bytes);
  } catch {
    return null;
  }
  if (size === null) return null;

  return withinLimits({
    format,
    mime: LOGO_FORMATS[format].mime,
    width: size.width,
    height: size.height,
    bytes,
  });
}

function withinLimits(image: SenderLogoImage): SenderLogoImage | null {
  if (image.width < SENDER_LOGO_MIN_SIDE || image.height < SENDER_LOGO_MIN_SIDE) return null;
  if (image.width > SENDER_LOGO_MAX_SIDE || image.height > SENDER_LOGO_MAX_SIDE) return null;
  /*
   * Отсекаем полосы. Логотип вписывается в круг, и картинка с отношением
   * сторон больше 4:1 после вписывания превращается в ниточку поперёк
   * кружка — хуже, чем честная буква. Такое приходит, когда вместо значка
   * сайта объявлен «логотип в шапке» целиком.
   */
  const ratio = image.width / image.height;
  if (ratio > 4 || ratio < 0.25) return null;
  return image;
}
