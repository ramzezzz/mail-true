/**
 * Настоящие байты для заглушечных вложений.
 *
 * Зачем. Режим заглушек существует для того, чтобы интерфейс можно было
 * смотреть и проверять без сервера, — и предпросмотр вложения в нём обязан
 * работать так же, как с сервером. На нулях (а именно нули заглушка отдавала
 * раньше) он показывал бы пустой квадрат, то есть ровно то, чего мы в
 * предпросмотре и стараемся избежать.
 *
 * Поэтому здесь лежат три маленьких, но настоящих файла: картинка PNG,
 * PDF в одну страницу и текст. Каждый из них — один разрешённый род
 * предпросмотра (см. mail/attachments.ts), так что все три ветви показа
 * достижимы и без бэкенда.
 *
 * Файлы записаны base64 намеренно: собирать PNG со сжатием и PDF с
 * таблицей смещений прямо в браузере — это сотня строк кода ради данных,
 * которые не меняются никогда.
 */

/** Шахматная клетка 160×100, оттенки серого — 587 байт. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAAAAAAk3WRTAAACEklEQVR42sXWa0/IcRyG8fvlYMKcpphkDi3VcphkThNGTDTKnJbDkDkNWWi8p15Rz6/7BVyfh//r/m3fh/9sgQ2we7YCB3bPNuDA7tkOHNg9A8CB3bMDOLB7dgIHds8u4MDu2Q0c2D17gAO7Zy9wYPfsAw7snv3Agd1zADiwewaBA7tnCDiwe/jhINi9DjwEdq8DD4Pd68BhsHsdeATsXgeOgN3rwKNg9zrwGNi9DjwOdq8DT4Dd68CTYPc6cBTsXgeOgd3rwFNg9zpwHOxeB06A3TMJfGD3TAEHds9p4MDuOQMc2D1ngQO75xxwYPecBw7snmngwO65ABzYPTPAgd1zETiwey4BB3bPZeDA7rkCHNg9V4EDu+cacGD3+mG9DnavA2fB7nXgDbB7HXgT7F4H3gK714G3we514B2wex04B3avA++C3evAe2D3OvA+2L0OnAe714EPwO514EOwex24AHavAx+B3fMY+MDuWQQO7J4l4MDueQIc2D1PgQO75xlwYPc8Bw7snhfAgd3zEjiwe5aBA7vnFXBg97wGDuyeN8CB3fMWOLB73gEHds974MDu9cP6AexeB66A3evAj2D3OvAT2L0O/Ax2rwO/gN3rwK9g9zrwG9i9DvwOdq8Df4Dd68CfYPc6cBXsXgf+ArvXgWtg9zrwN9i9DvwDds9f4AO7Zx04sHv+AQd2z3/gwO6b2mHG7LlFGq8AAAAASUVORK5CYII=';

/** PDF в одну страницу с таблицей xref — 560 байт. */
const PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMDAgMTIwXS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDUzPj4Kc3RyZWFtCkJUIC9GMSAyMCBUZiAyMCA2MCBUZCAoTWFpbC5UcnVlIC0gcHJpbWVyIFBERikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYT4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1NCAwMDAwMCBuIAowMDAwMDAwMTA1IDAwMDAwIG4gCjAwMDAwMDAyMTcgMDAwMDAgbiAKMDAwMDAwMDMxNyAwMDAwMCBuIAp0cmFpbGVyCjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjM4MAolJUVPRgo=';

const SAMPLE_TEXT = [
  'Примечания к отчёту за июль',
  '===========================',
  '',
  '1. Цифры по кварталу — на вкладке «Сводка».',
  '2. Строки с пометкой «предварительно» ещё уточняются.',
  '3. Вопросы — Анне, она собирала.',
  '',
  'Файл в UTF-8. <script>alert(1)</script> — и это должно остаться',
  'буквами на экране, а не выполниться.',
].join('\n');

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Байты для заглушечного вложения либо null, если для такого рода файлов
 * настоящего образца нет (таблица, архив) — тогда вызывающий отдаёт нули,
 * как и раньше.
 */
export function mockPartBytes(filename: string, mimeType: string): Uint8Array<ArrayBuffer> | null {
  const type = mimeType.toLowerCase();
  const name = filename.toLowerCase();
  if (type === 'application/pdf' || name.endsWith('.pdf')) return fromBase64(PDF_BASE64);
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/u.test(name)) {
    return fromBase64(PNG_BASE64);
  }
  if (type.startsWith('text/') || name.endsWith('.txt')) {
    return new TextEncoder().encode(SAMPLE_TEXT);
  }
  return null;
}
