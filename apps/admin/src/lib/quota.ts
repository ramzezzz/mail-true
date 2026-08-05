/**
 * Квота при вводе: число и единица отдельно.
 *
 * Раньше квота вводилась одной строкой («1 ГБ»), и человек, набравший просто
 * «500», молча получал 500 байт вместо 500 мегабайт. Разделение на число и
 * выбор единицы убирает саму возможность так ошибиться: единица всегда
 * выбрана явно, считать байты в уме не нужно.
 */

export const QUOTA_UNITS = ['КБ', 'МБ', 'ГБ', 'ТБ'] as const;

export type QuotaUnit = (typeof QUOTA_UNITS)[number];

const FACTOR: Readonly<Record<QuotaUnit, number>> = {
  КБ: 1024,
  МБ: 1024 ** 2,
  ГБ: 1024 ** 3,
  ТБ: 1024 ** 4,
};

/** Единица по умолчанию, когда угадывать не из чего (0 — «без ограничения»). */
export const DEFAULT_QUOTA_UNIT: QuotaUnit = 'ГБ';

/** Множитель единицы в байтах. */
export function unitFactor(unit: QuotaUnit): number {
  return FACTOR[unit];
}

/**
 * Байты -> число и единица для полей ввода.
 *
 * Выбирается самая крупная единица, в которой значение остаётся целым:
 * 1073741824 -> «1 ГБ», 102400 -> «100 КБ». Если нацело не делится ни на
 * одну — берём самую крупную, где число не меньше единицы, и округляем
 * до двух знаков (правку всё равно делает человек).
 */
export function splitQuota(bytes: number): { amount: number; unit: QuotaUnit } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { amount: 0, unit: DEFAULT_QUOTA_UNIT };

  const descending = [...QUOTA_UNITS].reverse();
  for (const unit of descending) {
    const factor = FACTOR[unit];
    if (bytes >= factor && bytes % factor === 0) return { amount: bytes / factor, unit };
  }
  for (const unit of descending) {
    const factor = FACTOR[unit];
    if (bytes >= factor) return { amount: Math.round((bytes / factor) * 100) / 100, unit };
  }
  // Меньше килобайта: показываем в килобайтах дробью, лишь бы не в байтах.
  return { amount: Math.round((bytes / FACTOR['КБ']) * 100) / 100, unit: 'КБ' };
}

/**
 * Число и единица -> байты. null — введено не число (интерфейс покажет
 * это рядом с полем, а кнопку сохранения не даст нажать).
 */
export function quotaToBytes(amount: string, unit: QuotaUnit): number | null {
  const text = amount.trim().replace(',', '.');
  if (text === '') return null;
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return null;
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * FACTOR[unit]);
}

/** Единица, в которой значение записано в поле — для подписи «сейчас столько». */
export function isQuotaUnit(value: string): value is QuotaUnit {
  return (QUOTA_UNITS as readonly string[]).includes(value);
}
