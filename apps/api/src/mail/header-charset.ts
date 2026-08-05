/**
 * Восстановление заголовков, написанных в восьмибитной кодировке БЕЗ RFC 2047.
 *
 * Правильный способ передать русскую тему письма — закодировать её по
 * RFC 2047: `=?UTF-8?B?...?=`. Но так делают не все. Старые почтовые
 * программы (The Bat!, самописные рассылки, 1С, старые CRM) кладут в
 * заголовок сырые байты в KOI8-R или CP1251, а кодировку называют только в
 * `Content-Type` тела.
 *
 * Такие письма ходят до сих пор, и человек видел вместо темы строку ромбиков:
 * `������ �� ���8`. Тело при этом читалось правильно — то есть кодировка
 * была известна, ею просто не пользовались для заголовка. Хуже того, письмо
 * не находилось поиском по собственной теме.
 *
 * Здесь сырые байты заголовка декодируются той же кодировкой, что объявлена
 * у текстовой части письма. Так поступают mail.ru, Gmail и Thunderbird.
 *
 * Чего этот модуль НЕ делает: не угадывает кодировку по содержимому, если её
 * никто не назвал. Угадывание ошибается, а ошибка здесь — это подмена одного
 * нечитаемого текста другим нечитаемым, только правдоподобным.
 */
import iconv from 'iconv-lite';

/** Заголовок закодирован по RFC 2047 — трогать не нужно, его разберут без нас. */
export function hasEncodedWord(raw: string): boolean {
  return /=\?[^?\s]+\?[bqBQ]\?[^?]*\?=/.test(raw);
}

/**
 * Достаёт сырое значение заголовка из блока заголовков, разворачивая
 * перенесённые строки (продолжение строки начинается с пробела или табуляции).
 *
 * Работаем с байтами, а не со строкой: превращать блок в строку до того, как
 * стала известна кодировка, — значит потерять как раз те байты, ради которых
 * всё затевалось.
 */
export function rawHeaderValue(block: Buffer, name: string): Buffer | null {
  const lowerName = name.toLowerCase();
  // Разбор по строкам вручную: latin1 сохраняет байты один к одному,
  // поэтому по такой строке можно искать границы, не портя содержимое.
  const text = block.toString('latin1');
  const lines = text.split(/\r?\n/);

  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (start === -1) {
      const colon = line.indexOf(':');
      if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === lowerName) {
        start = i;
        end = i;
      }
      continue;
    }
    // Продолжение развёрнутого заголовка
    if (/^[ \t]/.test(line)) {
      end = i;
      continue;
    }
    break;
  }
  if (start === -1) return null;

  const first = lines[start] ?? '';
  const value = first.slice(first.indexOf(':') + 1);
  const parts = [value];
  for (let i = start + 1; i <= end; i += 1) parts.push(lines[i] ?? '');
  /*
   * Разворачивание убирает ТОЛЬКО сам перенос строки. Отступ, с которого
   * начинается продолжение, — уже часть значения и служит разделителем слов;
   * добавлять к нему ещё один пробел нельзя, иначе в теме появляются двойные
   * пробелы. Ошибку поймала собственная проверка на переносе темы.
   */
  return Buffer.from(parts.join('').replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''), 'latin1');
}

/** Есть ли в значении байты вне ASCII — то есть то, что могло испортиться. */
export function hasHighBytes(raw: Buffer): boolean {
  for (const byte of raw) if (byte > 0x7f) return true;
  return false;
}

/** Байты — корректный UTF-8? Тогда кодировку из тела спрашивать незачем. */
function isValidUtf8(raw: Buffer): boolean {
  return !raw.toString('utf8').includes('�');
}

/** Приводит название кодировки к тому, что понимает iconv-lite. */
function normalizeCharset(charset: string | undefined | null): string | null {
  const name = (charset ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!name) return null;
  // us-ascii в заголовке с восьмибитными байтами — заведомая неправда:
  // объявили ASCII, а прислали не ASCII. Кодировка неизвестна.
  if (name === 'us-ascii' || name === 'ascii') return null;
  return iconv.encodingExists(name) ? name : null;
}

/**
 * Восстанавливает значение заголовка.
 *
 * Возвращает null, когда чинить нечего или нечем:
 *   - заголовка нет;
 *   - в нём только ASCII;
 *   - он закодирован по RFC 2047 (разберут и без нас);
 *   - кодировка не названа и байты не похожи на UTF-8.
 */
export function repairHeader(
  block: Buffer | undefined | null,
  name: string,
  bodyCharset: string | undefined | null,
): string | null {
  if (!block || block.length === 0) return null;

  const raw = rawHeaderValue(block, name);
  if (!raw || raw.length === 0) return null;
  if (!hasHighBytes(raw)) return null;
  if (hasEncodedWord(raw.toString('latin1'))) return null;

  // Корректный UTF-8 в заголовке без объявления кодировки — частый случай
  // и единственный, где можно обойтись без подсказки от тела.
  if (isValidUtf8(raw)) return raw.toString('utf8');

  const charset = normalizeCharset(bodyCharset);
  if (!charset) return null;

  const decoded = iconv.decode(raw, charset);
  return decoded.includes('�') ? null : decoded;
}
