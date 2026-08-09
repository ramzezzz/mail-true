/**
 * Разбор строки получателей «a@b, Имя <c@d>» в MailAddress[].
 * Упрощённый (без полного RFC 5322) — для поля «Кому» окна написания.
 */

import type { MailAddress } from '@mail-true/shared';

/**
 * Режет строку на получателей, не трогая запятые ВНУТРИ имени.
 *
 * Раньше строка просто делилась по «,» и «;», и на именах вида
 * «Иванов, Иван <ivan@example.com>» это давало ДВУХ получателей:
 * несуществующий «Иванов» и настоящий адрес. Имена такой формы
 * («Фамилия, Имя», «Doe, John») массово ставят корпоративные почтовые
 * системы, и приходят они к нам сами — из заголовков писем в подсказку
 * поля «Кому».
 *
 * Итог был двойной: письмо уходило с адресом, которого нет (и отбивалось
 * у отправителя), а при обороте «черновик → открыть → сохранить» мусорный
 * адрес закреплялся в черновике насовсем.
 *
 * Поэтому разделитель считается разделителем только вне кавычек и вне
 * угловых скобок — там запятая часть значения, а не граница.
 */
export function splitRecipientParts(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      escaped = false;
      current += char;
      continue;
    }
    if (inQuotes && char === '\\') {
      escaped = true;
      current += char;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && char === '<') inAngle = true;
    if (!inQuotes && char === '>') inAngle = false;
    if ((char === ',' || char === ';') && !inQuotes && !inAngle) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Имя из части «Имя <адрес>» в человеческий вид.
 *
 * Кавычки снимаются вместе с экранированием: собранное нами
 * «"Пётр \"Петя\" Петров"» обязано разобраться обратно в исходное имя,
 * иначе слэши копились бы с каждым открытием черновика.
 */
function decodeName(raw: string): string | null {
  const name = raw.trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length > 1) {
    return name.slice(1, -1).replace(/\\(.)/g, '$1') || null;
  }
  return name || null;
}

export function parseAddresses(value: string): MailAddress[] {
  return splitRecipientParts(value)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(part);
      if (match?.[2]) {
        return { name: decodeName(match[1] ?? ''), address: match[2] };
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
 *
 * Имя с запятой берётся в кавычки — иначе согласованность и ломалась:
 * собранное «Иванов, Иван <ivan@…>» при следующем разборе превращалось в
 * двух получателей. Кавычки внутри имени экранируются, как требует
 * RFC 5322 для quoted-string.
 */
export function formatAddresses(list: readonly MailAddress[]): string {
  return list
    .map((a) => {
      if (!a.name) return a.address;
      const needsQuotes = /[,;<>"]/.test(a.name);
      const escaped = a.name.replace(/["\\]/g, (char) => `\\${char}`);
      const name = needsQuotes ? `"${escaped}"` : a.name;
      return `${name} <${a.address}>`;
    })
    .join(', ');
}
