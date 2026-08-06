/**
 * Свои метки: справочник и правила именования ключевых слов IMAP.
 *
 * Метка живёт в письме ключевым словом IMAP (`STORE +FLAGS mt-oplatit`), а
 * её человеческое имя и цвет — в базе. Так сделано потому, что менять
 * хранилище не пришлось вовсе: ключевые слова у нас уже есть, на них держатся
 * чипы категорий и признак надёжного отправителя (mail/summary.ts).
 *
 * Здесь только чистые правила, без базы и без IMAP: их можно проверить
 * поимённо, и именно они отвечают за главную опасность возможности —
 * не дать пользовательской метке ни назваться служебным словом, ни стереть
 * его при правке. См. RESERVED_KEYWORDS ниже.
 */

/* ------------------------------------------------------------------ */
/* Цвета                                                               */
/* ------------------------------------------------------------------ */

/**
 * Цвет метки — это ИДЕНТИФИКАТОР из закрытого набора, а не строка вида
 * `#ff0000`, присланная клиентом. Причина не в красоте: цвет попадает в
 * разметку интерфейса, и произвольная строка из базы означала бы, что
 * значение пользователя доезжает до CSS. Набор закрыт — доехать нечему.
 */
export const LABEL_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
  'gray',
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

export const DEFAULT_LABEL_COLOR: LabelColor = 'blue';

export function isLabelColor(value: unknown): value is LabelColor {
  return typeof value === 'string' && (LABEL_COLORS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Служебные ключевые слова                                            */
/* ------------------------------------------------------------------ */

/**
 * Ключевые слова, которые принадлежат ПРОДУКТУ, а не человеку.
 *
 * Список собран из трёх мест, и это единственное место, где он собран
 * целиком:
 *
 *   - системные флаги IMAP (`\Seen`, `\Flagged`, …) — они начинаются с
 *     обратной косой и отсеиваются отдельной проверкой ниже;
 *   - служебные ключевые слова почтовых программ (`$Forwarded`, `$MDNSent`,
 *     `$Junk`, `$NotJunk`) — их ставим не мы, но снимать их мы не вправе:
 *     `$MDNSent` значит «уведомление о прочтении уже отправлено», и его
 *     потеря заставит спросить человека второй раз (RFC 3503);
 *   - наши собственные (`$Snoozed`, `$Pinned` из mail/snooze-mailbox.ts,
 *     чипы категорий и `reliable` из веб-интерфейса) — на них держится
 *     видимая часть продукта.
 *
 * Ни одно слово отсюда не может стать пользовательской меткой, не попадает
 * в справочник и не снимается правкой меток. Это и есть главное место,
 * где новая возможность могла бы навредить.
 */
export const RESERVED_KEYWORDS: readonly string[] = [
  // Служебные слова почтовых программ и наши пометки состояния
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
  // Смысловые категории писем (apps/web/src/lib/categories.ts)
  'registration',
  'finance',
  'travel',
  'order',
  'news',
  'social',
  'mailings',
  'receipts',
  'official',
  // Признак надёжного отправителя (apps/web/src/lib/categories.ts)
  'reliable',
];

/**
 * Сравнение ключевых слов идёт БЕЗ учёта регистра.
 *
 * IMAP разрешает серверу считать ключевые слова нечувствительными к
 * регистру, и Dovecot так и делает. Значит, метка `Reliable` — это то же
 * самое слово, что и `reliable`, и проверка «занято ли» обязана это видеть.
 * Иначе запрет служебных слов обходился бы одной заглавной буквой.
 */
const RESERVED_LOWER = new Set(RESERVED_KEYWORDS.map((k) => k.toLowerCase()));

/** Слово принадлежит продукту, а не человеку. */
export function isServiceKeyword(keyword: string): boolean {
  const trimmed = keyword.trim();
  if (trimmed === '') return true;
  // Системные флаги IMAP: `\Seen`, `\Flagged`, `\Deleted`, `\Draft`, `\Answered`
  if (trimmed.startsWith('\\')) return true;
  return RESERVED_LOWER.has(trimmed.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Ключ метки                                                          */
/* ------------------------------------------------------------------ */

/**
 * Приставка ключа пользовательской метки.
 *
 * Нужна ровно для одного: чтобы метка, названная человеком, никогда не
 * совпала со словом, которое продукт заведёт ЗАВТРА. Без приставки метка
 * «Финансы», превращённая в `finansy`, живёт спокойно, а метка с именем
 * «finance» столкнулась бы с чипом категории — и мы бы это заметили, только
 * когда чип пропал бы у человека с такой меткой.
 */
export const LABEL_KEY_PREFIX = 'mt-';

/** Предел длины ключа: ключевые слова у Dovecot не бесконечны. */
export const MAX_LABEL_KEY_LENGTH = 64;
export const MAX_LABEL_NAME_LENGTH = 64;

/**
 * Кириллица в латиницу.
 *
 * Ключевое слово IMAP — это атом: пробелы, скобки, кавычки и обратная косая
 * в нём запрещены, а восьмибитные байты хоть Dovecot и переживает, но
 * дальше по дороге (перенос ящика, сторонний клиент) они превращаются в
 * мусор. Поэтому имя «Оплатить» едет в базе как есть, а в письме лежит
 * `mt-oplatit`.
 */
const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** Часть ключа без приставки: только строчная латиница, цифры и дефис. */
export function slugifyLabelName(name: string): string {
  const lower = name.trim().toLowerCase();
  let out = '';
  for (const char of lower) {
    const mapped = TRANSLIT[char];
    if (mapped !== undefined) out += mapped;
    else if (/[a-z0-9]/.test(char)) out += char;
    else out += '-';
  }
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '');
  // Имя из одних смайликов или знаков препинания оставило бы пустой ключ.
  // Пустого ключевого слова не бывает, поэтому есть запасное имя.
  if (out === '') out = 'label';
  return out.slice(0, MAX_LABEL_KEY_LENGTH - LABEL_KEY_PREFIX.length - 4);
}

/**
 * Ключ новой метки, не совпадающий ни с одним занятым.
 *
 * Совпадения разрешаются числом на конце (`mt-schet`, `mt-schet-2`), а не
 * отказом: человек вправе назвать две метки «Счета» и «Счёта», и объяснять
 * ему разницу транслитерации мы не будем.
 */
export function buildLabelKey(name: string, taken: readonly string[]): string {
  const base = `${LABEL_KEY_PREFIX}${slugifyLabelName(name)}`;
  const busy = new Set(taken.map((k) => k.toLowerCase()));
  const occupied = (candidate: string): boolean =>
    busy.has(candidate.toLowerCase()) || isServiceKeyword(candidate);
  if (!occupied(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!occupied(candidate)) return candidate;
  }
  throw new Error('Не удалось подобрать ключ метки');
}

/**
 * Ключ похож на пользовательскую метку.
 *
 * Проверяется и приставка, и набор символов, и отсутствие в служебном
 * списке. Именно этой проверкой закрыт маршрут простановки меток: прислать
 * `$Snoozed` или `\Deleted` в списке «поставить» нельзя — их сюда просто
 * не пропустят.
 */
export function isUserLabelKey(key: string): boolean {
  if (!key.startsWith(LABEL_KEY_PREFIX)) return false;
  if (key.length > MAX_LABEL_KEY_LENGTH) return false;
  if (!/^[a-z0-9-]+$/.test(key)) return false;
  return !isServiceKeyword(key);
}

/** Имя метки, приведённое к виду, в котором его можно хранить и показать. */
export function normalizeLabelName(raw: string): string {
  // Схлопываем пробелы: «Оплатить    срочно» и «Оплатить срочно» — одно имя,
  // а разница между ними в списке настроек не видна вовсе.
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_NAME_LENGTH);
}

/* ------------------------------------------------------------------ */
/* Метка                                                               */
/* ------------------------------------------------------------------ */

export interface UserLabel {
  /** Ключевое слово IMAP, лежащее в письме. */
  key: string;
  /** Как метка называется для человека. */
  name: string;
  color: LabelColor;
  position: number;
}

/**
 * Отбор пользовательских меток из ключевых слов письма.
 *
 * Знает ДВА условия сразу: слово не служебное И есть в справочнике. Второе
 * важно не меньше первого — ключевое слово, которое поставила чужая почтовая
 * программа, показывать пилюлей без имени и цвета мы не можем, а придумывать
 * ему имя не вправе.
 */
export function userLabelsOf(
  keywords: readonly string[],
  dictionary: readonly UserLabel[],
): UserLabel[] {
  const byKey = new Map(dictionary.map((label) => [label.key.toLowerCase(), label]));
  const out: UserLabel[] = [];
  for (const keyword of keywords) {
    if (isServiceKeyword(keyword)) continue;
    const found = byKey.get(keyword.toLowerCase());
    if (found && !out.includes(found)) out.push(found);
  }
  return out.sort((a, b) => a.position - b.position);
}
