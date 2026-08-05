/**
 * Постраничная подгрузка списка писем.
 *
 * Сервер отдаёт не больше сотни писем за запрос и вместе с ними — `total`
 * (в живом ящике это 187 писем при limit=100). Раньше интерфейс запрашивал
 * ровно одну страницу с `offset: 0`, `total` не использовал и подгрузки не
 * имел: всё, что дальше первой сотни, было недостижимо — ни прокруткой, ни
 * кнопкой. Здесь — арифметика страниц, чтобы её можно было проверить
 * отдельно от компонентов.
 */

/** Минимум, который нужен от страницы ответа `GET /api/messages`. */
export interface PageLike {
  items: readonly unknown[];
  total: number;
  offset: number;
  limit: number;
}

/** Сколько писем уже загружено во всех полученных страницах. */
export function loadedCount(pages: readonly PageLike[]): number {
  return pages.reduce((sum, page) => sum + page.items.length, 0);
}

/** Сколько всего писем подходит под запрос (по последней странице). */
export function totalCount(pages: readonly PageLike[]): number {
  const last = pages[pages.length - 1];
  return last ? last.total : 0;
}

/**
 * Смещение следующей страницы или undefined, если загружено всё.
 * Считаем по фактически полученным письмам, а не по номеру страницы:
 * сервер вправе вернуть меньше, чем просили.
 */
export function nextPageOffset(pages: readonly PageLike[]): number | undefined {
  if (pages.length === 0) return 0;
  const loaded = loadedCount(pages);
  const last = pages[pages.length - 1];
  // Пустая страница — дальше идти некуда, иначе крутились бы вечно
  if (!last || last.items.length === 0) return undefined;
  if (loaded >= last.total) return undefined;
  return loaded;
}

/** Есть ли что подгружать. */
export function hasMore(pages: readonly PageLike[]): boolean {
  return nextPageOffset(pages) !== undefined;
}

/** Подпись под списком: «Показано 100 из 187». */
export function loadedLabel(loaded: number, total: number): string {
  return `Показано ${loaded} из ${total}`;
}

/**
 * Подпись кнопки «Выделить все».
 *
 * Выделить можно только загруженные письма: у невыгруженных нет
 * идентификаторов. Пока загружено не всё, честно говорим, сколько
 * именно выделяем, — раньше кнопка обещала «все», а выделяла сотню.
 */
export function selectAllLabel(loaded: number, total: number): string {
  if (total <= loaded) return 'Выделить все';
  return `Выделить загруженные (${loaded} из ${total})`;
}
