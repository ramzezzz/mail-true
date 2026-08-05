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
