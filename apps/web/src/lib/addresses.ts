/**
 * Разбор строки получателей «a@b, Имя <c@d>» в MailAddress[].
 * Упрощённый (без полного RFC 5322) — для поля «Кому» окна написания.
 */

import type { MailAddress } from '@mail-true/shared';

export function parseAddresses(value: string): MailAddress[] {
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(part);
      if (match?.[2]) {
        return { name: (match[1] ?? '').trim().replace(/^"|"$/g, '') || null, address: match[2] };
      }
      return { name: null, address: part };
    });
}

/**
 * Обратное действие: адреса в строку для поля окна написания.
 *
 * Нужно при дописывании сохранённого черновика — его получатели приходят
 * с сервера разобранными, а в поле «Кому» лежит текст. Разбор и сборка
 * обязаны быть согласованы: иначе открытие и сохранение черновика подряд
 * меняли бы адреса сами по себе.
 */
export function formatAddresses(list: readonly MailAddress[]): string {
  return list
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
    .join(', ');
}
