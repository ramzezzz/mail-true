/**
 * Из каких идентификаторов складывается заглушённая переписка.
 *
 * Чистые функции без IMAP и базы: именно здесь решается, что считать
 * «той же перепиской», и ошибка тут стоит дороже всего остального в
 * возможности — заглушить лишнее значит потерять почту молча.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ В СПИСОК ИДУТ И ССЫЛКИ ТОЖЕ, А НЕ ТОЛЬКО СВОИ MESSAGE-ID
 * ------------------------------------------------------------------
 * Заглушая переписку, мы видим ровно те её письма, что лежат в папке.
 * Начала переписки среди них может не быть вовсе: человека добавили
 * в обсуждение на сороковом письме, а первые тридцать девять ему не
 * приходили. Между тем следующий ответ сошлётся именно на них — в
 * References стоит вся цепочка предков.
 *
 * Поэтому в список идут и собственные Message-ID видимых писем, и все
 * идентификаторы из их References/In-Reply-To. Лишнего это не заглушает:
 * References — это буквально «письма, ответом на которые я являюсь»,
 * то есть та же самая переписка по определению RFC 5322.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ КЛЮЧ — КОРЕНЬ, А НЕ ПЕРВОЕ ПОПАВШЕЕСЯ
 * ------------------------------------------------------------------
 * Ключ записи должен быть одним и тем же, когда человек заглушает
 * переписку сегодня, снимает заглушку завтра и заглушает снова через
 * неделю, — иначе в подборке «Заглушённые» появятся три строки об одном
 * и том же разговоре, и снятие одной из них ничего не изменит.
 *
 * Устойчив здесь только корень: первый идентификатор в References самого
 * старого письма (а если ссылок нет — его собственный Message-ID). Он не
 * зависит ни от того, сколько писем сейчас в папке, ни от того, какие из
 * них человек выделил мышью.
 */

/** Письмо в том виде, в каком его читает служба заглушек. */
export interface ThreadHeaderSource {
  /** Собственный Message-ID (в любом виде — с угловыми скобками или без). */
  messageId: string | null | undefined;
  /** Значение заголовка References целиком, как пришло. */
  references: string | null | undefined;
  /** Значение заголовка In-Reply-To целиком, как пришло. */
  inReplyTo: string | null | undefined;
  /** Дата письма — по ней ищется самое старое. Пусто — считаем самым новым. */
  date?: Date | null | undefined;
}

/**
 * Сколько идентификаторов сохраняется на одну переписку.
 *
 * Не про место в базе, а про время доставки: список превращается в условие
 * Sieve, которое перебирается для каждого входящего письма ящика. Полсотни
 * покрывают переписку, которую человек в состоянии прочитать, а очень
 * длинные обсуждения всё равно опознаются по ранним письмам — на них
 * ссылается вся цепочка.
 */
export const MUTE_IDS_PER_THREAD = 50;

/** Разбирает список идентификаторов из References/In-Reply-To. */
export function parseMessageIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  // Только то, что стоит в угловых скобках. Всё остальное в этих
  // заголовках — мусор отправителя («On Mon, ... wrote:» в In-Reply-To
  // встречается чаще, чем хотелось бы), и в правило доставки ему нельзя.
  const re = /<([^<>\s]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const id = match[1]?.trim();
    if (id) out.push(id);
  }
  return out;
}

/** Message-ID без угловых скобок и пробелов. */
export function bareMessageId(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().replace(/^<|>$/g, '').trim();
  return value === '' ? null : value;
}

/** Что вышло из разбора выделенных писем. */
export interface ThreadIdentity {
  /** Устойчивое имя переписки. Пусто — опознать переписку нечем. */
  threadKey: string;
  /** Идентификаторы, по которым узнаётся её продолжение. */
  messageIds: string[];
}

/**
 * Собирает опознавательные признаки переписки по её письмам.
 *
 * Пустой threadKey означает ровно одно: ни у одного письма нет ни
 * Message-ID, ни ссылок. Заглушать такую переписку нечем, и служба
 * обязана сказать об этом прямо, а не завести запись, которая никогда
 * ни на что не сработает.
 */
export function threadIdentity(messages: readonly ThreadHeaderSource[]): ThreadIdentity {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined): void => {
    const id = bareMessageId(raw);
    if (!id) return;
    const key = id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ids.push(id);
  };

  // Самое старое письмо — по дате; письма без даты считаются самыми новыми,
  // чтобы отсутствие даты не назначало корнем случайное письмо.
  const ordered = [...messages].sort((a, b) => {
    const at = a.date ? a.date.getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.date ? b.date.getTime() : Number.MAX_SAFE_INTEGER;
    return at - bt;
  });

  let threadKey = '';
  for (const msg of ordered) {
    const refs = [...parseMessageIdList(msg.references), ...parseMessageIdList(msg.inReplyTo)];
    if (threadKey === '') {
      threadKey = bareMessageId(refs[0]) ?? bareMessageId(msg.messageId) ?? '';
    }
    push(msg.messageId);
    for (const ref of refs) push(ref);
  }

  return { threadKey, messageIds: ids.slice(0, MUTE_IDS_PER_THREAD) };
}

/**
 * Разбивает выделенные письма на переписки.
 *
 * Нужна потому, что человек имеет полное право выделить в списке пять
 * строк из разных разговоров и нажать «Заглушить». Слепить их в одну
 * запись значило бы показать в подборке «Заглушённые» одну строку с чужой
 * темой, а снятие этой строки расглушило бы все пять разом — то есть
 * человек вернул бы себе переписки, которых не просил.
 *
 * Связь — общий идентификатор: два письма в одной переписке, если у них
 * совпадает хоть один Message-ID из набора «свой + все ссылки». Это то же
 * правило, по которому цепочки собирает почтовый сервер (алгоритм REFS,
 * см. mail/threads.ts), и здесь оно применяется к горстке выделенных
 * писем, а не ко всей папке.
 */
export function groupThreads<T extends ThreadHeaderSource>(messages: readonly T[]): T[][] {
  interface Group {
    keys: Set<string>;
    items: T[];
  }
  const groups: Group[] = [];

  for (const msg of messages) {
    const keys = new Set<string>();
    const own = bareMessageId(msg.messageId);
    if (own) keys.add(own.toLowerCase());
    for (const ref of parseMessageIdList(msg.references)) keys.add(ref.toLowerCase());
    for (const ref of parseMessageIdList(msg.inReplyTo)) keys.add(ref.toLowerCase());

    const touched = groups.filter((g) => [...keys].some((k) => g.keys.has(k)));
    if (touched.length === 0) {
      groups.push({ keys, items: [msg] });
      continue;
    }
    // Письмо может связать между собой группы, которые до него казались
    // разными: оно ссылается и на одну, и на другую. Тогда они и есть
    // одна переписка, и склеиваются здесь же.
    const first = touched[0] as Group;
    first.items.push(msg);
    for (const key of keys) first.keys.add(key);
    for (const other of touched.slice(1)) {
      for (const item of other.items) first.items.push(item);
      for (const key of other.keys) first.keys.add(key);
      groups.splice(groups.indexOf(other), 1);
    }
  }

  return groups.map((g) => g.items);
}
