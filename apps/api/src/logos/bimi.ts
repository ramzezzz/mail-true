/**
 * BIMI — официальный способ узнать логотип домена (RFC-проект BIMI, draft-brand-indicators).
 *
 * ------------------------------------------------------------------
 * Почему это ПЕРВЫЙ источник, а не ИИ
 * ------------------------------------------------------------------
 * Заказчик просил «чтобы ИИ искал логотипы». Начинать с ИИ было бы и дорого,
 * и неверно по существу: BIMI — механизм, придуманный ровно под эту задачу
 * и ровно для почты. Владелец домена САМ публикует в DNS адрес своего
 * логотипа:
 *
 *     default._bimi.example.com.  IN TXT  "v=BIMI1; l=https://example.com/logo.svg"
 *
 * Это значит три вещи, которых ИИ не даст ни за какие деньги:
 *   * ответ точный — логотип назвал сам владелец домена, а не угадала модель;
 *   * ответ бесплатный и быстрый — один запрос DNS, десятки миллисекунд;
 *   * ответ проверяемый — при споре видно, откуда взялась картинка.
 *
 * Модель же принципиально способна выдумать «логотип Сбербанка» для домена
 * sberbank-security.xyz, и проверить её будет нечем. Поэтому порядок такой:
 * BIMI -> favicon домена -> и только потом ИИ, если администратор его включил.
 *
 * ------------------------------------------------------------------
 * Что здесь НЕ делается
 * ------------------------------------------------------------------
 * Не проверяется сертификат VMC (поле `a=`). VMC подтверждает, что логотип
 * принадлежит владельцу товарного знака, и стоит денег — в 2026 году его
 * имеют единицы. Требовать его значило бы не показывать логотип почти
 * никому. Подмену это не открывает: право показать логотип у нас даёт не
 * BIMI, а проверка подлинности письма (см. mail/sender-auth.ts), а запись
 * BIMI читается ИЗ ЗОНЫ САМОГО ДОМЕНА — положить её туда может только тот,
 * кто этой зоной управляет.
 */

/** Имя записи BIMI для домена. Селектор по умолчанию — `default`. */
export function bimiRecordName(domain: string): string {
  return `default._bimi.${domain}`;
}

export interface BimiRecord {
  /** Адрес картинки логотипа (`l=`). Пустая строка в записи означает отказ. */
  location: string | null;
  /** Адрес сертификата VMC (`a=`). Сохраняется только для диагностики. */
  authority: string | null;
}

/**
 * Разбирает значение TXT-записи BIMI.
 * null — это не запись BIMI (нет обязательного `v=BIMI1`).
 */
export function parseBimiRecord(value: string): BimiRecord | null {
  const parts = value
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p !== '');

  let version = false;
  let location: string | null = null;
  let authority: string | null = null;

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const tag = part.slice(0, eq).trim().toLowerCase();
    const val = part.slice(eq + 1).trim();
    if (tag === 'v') {
      // Версия сравнивается без учёта регистра: в зонах встречается и `BIMI1`,
      // и `bimi1`, а из-за буквоедства логотип бы просто не нашёлся.
      version = val.toLowerCase() === 'bimi1';
    } else if (tag === 'l') {
      // Пустое `l=` — это явный отказ владельца («логотипа нет»), а не
      // отсутствие записи. Отличать их важно: отказ надо запомнить надолго.
      location = val === '' ? null : val;
    } else if (tag === 'a') {
      authority = val === '' ? null : val;
    }
  }

  if (!version) return null;
  return { location, authority };
}

/**
 * Выбирает пригодный адрес логотипа из набора TXT-записей имени.
 *
 * Записей на имени может оказаться несколько (например, осталась старая):
 * берём первую, которая действительно является записью BIMI и называет
 * адрес. Адрес обязан быть HTTPS: по HTTP логотип может подменить любой,
 * кто сидит на пути, а подменённый логотип — это и есть подделка.
 */
export function pickBimiLocation(records: readonly string[]): string | null {
  for (const raw of records) {
    const parsed = parseBimiRecord(raw);
    if (!parsed?.location) continue;
    if (!/^https:\/\//iu.test(parsed.location)) continue;
    return parsed.location;
  }
  return null;
}

/**
 * Есть ли в наборе записей ЯВНЫЙ отказ: запись BIMI без адреса.
 *
 * Нужен отдельно от «ничего не нашли»: владелец, который сказал «логотипа
 * нет», сказал это надолго, и переспрашивать его каждые сутки незачем.
 */
export function isBimiDeclination(records: readonly string[]): boolean {
  return records.some((raw) => {
    const parsed = parseBimiRecord(raw);
    return parsed !== null && parsed.location === null;
  });
}
