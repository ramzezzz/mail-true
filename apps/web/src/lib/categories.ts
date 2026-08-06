/**
 * Смысловые категории писем (чипы «Учётные записи», «Финансы»…), признак
 * «надёжного отправителя» и отделение их от СВОИХ меток человека.
 *
 * Всё перечисленное в доменной модели передаётся одним и тем же способом —
 * метками письма (MessageSummary.labels), то есть ключевыми словами IMAP.
 * Поэтому здесь же живёт единственный ответ на вопрос «это слово наше
 * служебное или человек завёл его сам»: см. isServiceLabel. Разложить этот
 * ответ по нескольким файлам значило бы, что однажды они разойдутся и
 * служебное слово окажется в списке пользовательских меток.
 *
 * Цвета — только через CSS-переменные токенов.
 */

export interface MailCategory {
  id: string;
  name: string;
  /** Имя CSS-переменной с цветом значка категории. */
  colorVar: string;
}

export const CATEGORIES: readonly MailCategory[] = [
  { id: 'registration', name: 'Учётные записи', colorVar: '--mt-mail-color-icon-registration' },
  { id: 'finance', name: 'Финансы', colorVar: '--mt-mail-color-icon-finance' },
  { id: 'travel', name: 'Путешествия', colorVar: '--mt-mail-color-icon-travel' },
  { id: 'order', name: 'Заказы', colorVar: '--mt-mail-color-icon-order' },
  { id: 'news', name: 'Новости', colorVar: '--mt-mail-color-icon-news' },
  { id: 'social', name: 'Социальные сети', colorVar: '--mt-mail-color-icon-social' },
  { id: 'mailings', name: 'Рассылки', colorVar: '--mt-mail-color-icon-mailings' },
  { id: 'receipts', name: 'Чеки', colorVar: '--mt-mail-color-icon-receipts' },
  { id: 'official', name: 'Госписьма', colorVar: '--mt-mail-color-icon-official' },
];

/** Первая известная категория из меток письма. */
export function messageCategory(labels: readonly string[]): MailCategory | null {
  for (const label of labels) {
    const found = CATEGORIES.find((c) => c.id === label);
    if (found) return found;
  }
  return null;
}

/** Метка «надёжного отправителя» — зеленоватая подложка строки и плашка в письме. */
export const RELIABLE_LABEL = 'reliable';

export function isReliable(labels: readonly string[]): boolean {
  return labels.includes(RELIABLE_LABEL);
}

/* ------------------------------------------------------------------ */
/* Служебное против своего                                             */
/* ------------------------------------------------------------------ */

/**
 * Приставка ключа СВОЕЙ метки. Ту же приставку выдаёт сервер
 * (apps/api/src/mail/labels.ts, LABEL_KEY_PREFIX) — здесь она повторена,
 * чтобы интерфейс мог отличить своё от чужого, не спрашивая сервер на
 * каждую строку списка.
 */
export const LABEL_KEY_PREFIX = 'mt-';

/**
 * Ключевые слова, принадлежащие продукту, а не человеку.
 *
 * Повторяет RESERVED_KEYWORDS сервера. Список нужен и здесь, потому что
 * интерфейс решает, что рисовать пилюлей, ещё до того, как справочник меток
 * доедет: пока он грузится, служебное слово не должно мигнуть в строке
 * списка как «метка без имени».
 */
const SERVICE_LABELS: readonly string[] = [
  '$Forwarded',
  '$MDNSent',
  '$Junk',
  '$NotJunk',
  '$Phishing',
  '$Pinned',
  '$Snoozed',
  '$label1',
  '$label2',
  '$label3',
  '$label4',
  '$label5',
  ...CATEGORIES.map((c) => c.id),
  RELIABLE_LABEL,
];

const SERVICE_LOWER = new Set(SERVICE_LABELS.map((l) => l.toLowerCase()));

/**
 * Слово принадлежит продукту.
 *
 * Сравнение без учёта регистра: Dovecot считает ключевые слова
 * нечувствительными к регистру, и `$snoozed` — то же самое слово, что
 * `$Snoozed`. Иначе одна заглавная буква выдавала бы служебное слово
 * за пользовательскую метку.
 */
export function isServiceLabel(label: string): boolean {
  const trimmed = label.trim();
  if (trimmed === '') return true;
  // Системные флаги IMAP: `\Seen`, `\Flagged`, `\Deleted`…
  if (trimmed.startsWith('\\')) return true;
  return SERVICE_LOWER.has(trimmed.toLowerCase());
}

/** Ключи меток письма, которые завёл человек, — без служебных слов. */
export function userLabelKeys(labels: readonly string[]): string[] {
  return labels.filter((l) => !isServiceLabel(l) && l.startsWith(LABEL_KEY_PREFIX));
}
