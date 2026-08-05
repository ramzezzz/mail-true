/**
 * Пределы длины почтового адреса и отображаемого имени.
 *
 * Числа взяты не с потолка:
 *   * локальная часть (до «@») по RFC 5321 — не длиннее 64 ОКТЕТОВ;
 *   * адрес целиком по той же спецификации — не длиннее 320 октетов;
 *   * колонка virtual_users.email в базе — VARCHAR(255), а Postgres
 *     считает в СИМВОЛАХ, поэтому это отдельное, третье ограничение.
 *
 * Байты и символы — разные вещи: кириллическая буква в UTF-8 занимает два
 * байта. Поэтому в сообщении человеку всегда сказано, в чём именно предел,
 * и сколько уже набрано, — иначе «255» ничего не объясняет.
 *
 * Те же пределы продублированы на сервере (apps/api/src/admin/address-limits.ts):
 * здесь они нужны, чтобы объяснить ошибку до отправки запроса, а не вместо
 * серверной проверки. Совпадение чисел закреплено проверкой.
 */

/** Локальная часть адреса — до «@». RFC 5321, октеты. */
export const LOCAL_PART_MAX_BYTES = 64;

/** Адрес целиком. RFC 5321, октеты. */
export const ADDRESS_MAX_BYTES = 320;

/** Адрес целиком: virtual_users.email — VARCHAR(255), символы. */
export const ADDRESS_MAX_CHARS = 255;

/** Отображаемое имя: virtual_users.display_name — VARCHAR(255), символы. */
export const DISPLAY_NAME_MAX_CHARS = 255;

/** Длина в байтах кодировки UTF-8 — именно её считает почтовый протокол. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Длина в символах так, как её считает Postgres (кодовые точки, не суррогаты). */
export function charLength(text: string): number {
  return [...text].length;
}

/** Пояснение про кириллицу — добавляем только когда байт больше, чем символов. */
function bytesHint(text: string): string {
  return byteLength(text) > charLength(text)
    ? ' Кириллическая буква занимает два байта, поэтому символов помещается меньше.'
    : '';
}

/**
 * Проверяет длину адреса. null — всё в порядке, иначе готовая фраза для
 * человека: что именно длинно, каков предел и сколько набрано сейчас.
 */
export function checkMailboxAddress(email: string): string | null {
  const address = email.trim();
  if (address === '') return null;

  const at = address.lastIndexOf('@');
  const local = at === -1 ? address : address.slice(0, at);

  const localBytes = byteLength(local);
  if (localBytes > LOCAL_PART_MAX_BYTES) {
    return (
      `Имя ящика (часть до «@») не может быть длиннее ${LOCAL_PART_MAX_BYTES} байт — ` +
      `сейчас ${localBytes}.${bytesHint(local)}`
    );
  }

  const addressBytes = byteLength(address);
  if (addressBytes > ADDRESS_MAX_BYTES) {
    return `Адрес целиком не может быть длиннее ${ADDRESS_MAX_BYTES} байт — сейчас ${addressBytes}.${bytesHint(address)}`;
  }

  const addressChars = charLength(address);
  if (addressChars > ADDRESS_MAX_CHARS) {
    return `Адрес не поместится в хранилище: не длиннее ${ADDRESS_MAX_CHARS} символов — сейчас ${addressChars}.`;
  }

  return null;
}

/** То же для отображаемого имени: предел в символах, и так и сказано. */
export function checkDisplayName(name: string): string | null {
  const value = name.trim();
  const chars = charLength(value);
  if (chars > DISPLAY_NAME_MAX_CHARS) {
    return `Отображаемое имя не может быть длиннее ${DISPLAY_NAME_MAX_CHARS} символов — сейчас ${chars}.`;
  }
  return null;
}
