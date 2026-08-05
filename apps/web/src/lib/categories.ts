/**
 * Смысловые категории писем (чипы «Учётные записи», «Финансы»…) и признак
 * «надёжного отправителя». В доменной модели они передаются метками
 * (MessageSummary.labels); цвета — только через CSS-переменные токенов.
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
