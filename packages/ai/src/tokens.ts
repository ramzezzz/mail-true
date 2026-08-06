/**
 * Оценка числа токенов без внешних библиотек.
 *
 * Точный счёт даёт только сам сервис — его значения мы предпочитаем всегда.
 * Оценка нужна до отправки: чтобы проверить предел расходов и чтобы
 * решить, насколько урезать письмо.
 *
 * Эмпирика для распространённых словарей BPE: латиница ≈ 4 символа
 * на токен, кириллица заметно дороже ≈ 2.2 символа на токен,
 * иероглифы ≈ 1 символ на токен.
 */

const LATIN_CHARS_PER_TOKEN = 4;
const CYRILLIC_CHARS_PER_TOKEN = 2.2;
const CJK_CHARS_PER_TOKEN = 1;

/** Приблизительное число токенов в тексте. Всегда >= 0. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cyrillic = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x0400 && code <= 0x04ff) || (code >= 0x0500 && code <= 0x052f)) {
      cyrillic += 1;
    } else if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  const tokens =
    cyrillic / CYRILLIC_CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN + other / LATIN_CHARS_PER_TOKEN;
  return Math.max(1, Math.ceil(tokens));
}

/** Оценка токенов для набора сообщений запроса (с накладными расходами формата). */
export function estimateMessagesTokens(parts: readonly string[]): number {
  let total = 0;
  for (const part of parts) total += estimateTokens(part) + 4;
  return total + 2;
}
