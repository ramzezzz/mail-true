/**
 * Разбор ящика: кто шлёт больше всего и что занимает место.
 *
 * Модуль намеренно ЧИСТЫЙ — ни IMAP, ни базы, ни сети: сюда приезжает
 * список осмотренных писем (mailings-scan.ts), отсюда уезжают группы
 * отправителей и выборка на уборку. Благодаря этому и группировка, и —
 * что важнее — правило отбора на массовое удаление проверяются обычными
 * юнит-тестами, а не «посмотрели на живом ящике и вроде похоже».
 *
 * Почему это вообще отдельная от списка писем вещь. Список отвечает на
 * вопрос «что мне пришло», и отвечает страницами. Здесь вопрос другой:
 * «кого у меня больше всего» и «что съело место» — ответ на него нельзя
 * собрать из страницы, он собирается по всему ящику разом. Поэтому и
 * осмотр отдельный, и цена у него другая (см. mailings-scan.ts).
 *
 * ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА. Число, которое человек увидит ДО нажатия,
 * и набор писем, который уедет в корзину ПОСЛЕ нажатия, обязаны считаться
 * одной и той же функцией. Иначе «удалить 412 писем» и «удалено 700»
 * рано или поздно разойдутся — а это тот случай, когда расхождение
 * необратимо. Отсюда `selectForSweep`: и предпросмотр, и выполнение
 * зовут именно её.
 */
import type { FolderRole, MailAddress } from '@mail-true/shared';

/* ------------------------------------------------------------------ */
/* Осмотренное письмо                                                  */
/* ------------------------------------------------------------------ */

/**
 * Письмо глазами разбора: ровно те поля, ради которых стоило платить за
 * осмотр, и ни одного лишнего. Ни тела, ни сниппета, ни структуры частей
 * здесь нет намеренно — на двадцати тысячах писем каждое лишнее поле
 * превращается в мегабайты в памяти.
 */
export interface ScannedMessage {
  /** Составной идентификатор письма `${folderId}:${uid}`. */
  id: string;
  folderId: string;
  folderRole: FolderRole;
  uid: number;
  /** Размер письма в байтах, как его считает сам почтовый сервер. */
  size: number;
  /** Дата письма (ISO). */
  date: string;
  seen: boolean;
  flagged: boolean;
  subject: string;
  from: MailAddress;
  /** Значение `List-Id` без угловых скобок, в нижнем регистре. */
  listId: string | null;
  /** Человеческое имя рассылки из `List-Id`, если отправитель его дал. */
  listName: string | null;
  /** У письма есть заголовок `List-Unsubscribe`. */
  unsubscribe: boolean;
  /** Отписка одним запросом разрешена (RFC 8058). */
  oneClick: boolean;
}

/* ------------------------------------------------------------------ */
/* Группировка                                                         */
/* ------------------------------------------------------------------ */

/**
 * Разбирает `List-Id` (RFC 2919).
 *
 * Значение выглядит как `Погода <weather.example.com>`: в скобках —
 * постоянный идентификатор списка, перед ними — необязательное имя.
 * Идентификатор берётся из скобок и только из них: он не меняется при
 * смене названия рассылки, а имя меняется от письма к письму («Скидки»,
 * «Скидки недели»), и группировать по нему значило бы плодить группы.
 *
 * Скобки иногда забывают — тогда идентификатором считается всё значение.
 */
export function parseListId(raw: string | null | undefined): {
  id: string;
  name: string | null;
} | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  const match = /<([^>]+)>/.exec(value);
  const id = (match?.[1] ?? value).trim().toLowerCase();
  if (!id) return null;
  const namePart = match ? value.slice(0, match.index).trim() : '';
  // Имя приходит в кавычках чаще, чем без них
  const name = namePart.replace(/^"(.*)"$/s, '$1').trim();
  return { id, name: name || null };
}

/** Вид группы: настоящая рассылка со своим `List-Id` либо просто адрес. */
export type MailingKind = 'list' | 'sender';

export interface MailingFolderShare {
  folderId: string;
  count: number;
}

/**
 * Кто и сколько вам пишет — одна строка разбора.
 *
 * Считается по ВСЕМ осмотренным письмам группы, а не по странице: в этом
 * весь смысл разбора. Поэтому `count` и `bytes` — настоящие числа ящика
 * (в пределах осмотра, см. `truncated` в ScanResult), и именно их видит
 * человек перед нажатием.
 */
export interface MailingGroup {
  /** Ключ группы: `list:<list-id>` либо `from:<адрес>`. */
  key: string;
  kind: MailingKind;
  /** Как называть группу человеку. */
  title: string;
  /** Адрес отправителя — по нему группа находится в почте и в поиске. */
  address: string;
  /**
   * Это рассылка, а не переписка.
   *
   * Признаком считается ЛЮБОЙ из двух заголовков — `List-Id` или
   * `List-Unsubscribe`: первый ставят настоящие списки рассылки, второй —
   * магазины и сервисы, которые никакого списка не заводят, но отписку
   * поддерживают. Без этого разделения в списке «рассылок» первым номером
   * оказался бы коллега, с которым вы переписываетесь каждый день.
   */
  mailing: boolean;
  count: number;
  unread: number;
  bytes: number;
  /** Самое старое и самое свежее письмо группы (ISO). */
  firstDate: string;
  lastDate: string;
  /** Отписаться можно (есть адрес отписки хотя бы в одном письме). */
  canUnsubscribe: boolean;
  /** Отписка пройдёт одним запросом с сервера, без открытия страницы. */
  oneClick: boolean;
  /**
   * Письмо, по заголовкам которого будет сделана отписка. Самое СВЕЖЕЕ
   * из тех, где адрес отписки есть: у старого письма он мог протухнуть.
   */
  unsubscribeMessageId: string | null;
  /** Где лежат письма группы — чтобы человек понимал, что он чистит. */
  folders: MailingFolderShare[];
}

/**
 * Как назвать группу.
 *
 * Имя рассылки из `List-Id` сильнее имени отправителя: первое человек и
 * видит в письме («Скидки»), а второе бывает служебным («noreply»).
 * Имени нет вовсе — остаётся адрес: он всегда правда, пусть и некрасив.
 */
function titleOf(message: ScannedMessage): string {
  const name = message.listName ?? message.from.name;
  if (name && name.trim()) return name.trim();
  if (message.from.address) return message.from.address;
  return 'Без отправителя';
}

/**
 * Идёт ли письмо в разбор «кто вам пишет».
 *
 * Три роли выпадают, и каждая по своей причине:
 *
 *   «Отправленные» и «Черновики» — там отправитель вы сами, и группа
 *      «вы» в списке «от кого приходит» не значит ничего.
 *
 *   «Корзина» — письма оттуда УЖЕ убраны. Считать их значило бы, что
 *      после «удалить всё от этого отправителя» строка разбора остаётся
 *      с тем же числом: человек нажал, ящик изменился, а разбор говорит,
 *      что ничего не произошло. Найдено собственной проверкой.
 *
 * Место, занятое корзиной, при этом не теряется: оно видно в разбивке по
 * папкам (`ScanResult.folders`), где ему и место — очистка корзины это
 * отдельное действие, а не «разбор рассылок».
 */
export function countsInReview(message: ScannedMessage): boolean {
  return (
    message.folderRole !== 'sent' &&
    message.folderRole !== 'drafts' &&
    message.folderRole !== 'trash'
  );
}

/**
 * Ключ группы для письма.
 *
 * `List-Id` сильнее адреса намеренно. Крупные рассылки шлют с разных
 * адресов (`news-01@`, `news-02@`, `bounce+хэш@`) и это ОДНА рассылка:
 * отписка от неё одна, и разбирать её человек хочет разом. Если списка
 * нет — остаётся адрес, приведённый к нижнему регистру.
 */
export function groupKeyOf(message: ScannedMessage): string {
  if (message.listId) return `list:${message.listId}`;
  return `from:${message.from.address.toLowerCase()}`;
}

/**
 * Собирает группы отправителей из осмотренных писем.
 *
 * Порядок — по числу писем, потом по занятому месту: человек открывает
 * разбор с вопросом «кто у меня главный источник шума», и ответ должен
 * стоять первой строкой.
 *
 * Что в группы не попадает и почему — см. `countsInReview`. На уборку
 * эти письма при этом идут наравне со всеми: там вопрос другой (сколько
 * занимает место), и отвечать на него надо по всему ящику.
 */
export function groupMailings(messages: readonly ScannedMessage[]): MailingGroup[] {
  const byKey = new Map<string, MailingGroup>();
  const foldersByKey = new Map<string, Map<string, number>>();
  /** Дата письма, по которому сейчас назначена отписка группы. */
  const unsubscribeDate = new Map<string, string>();

  for (const message of messages) {
    if (!countsInReview(message)) continue;
    const key = groupKeyOf(message);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        kind: message.listId ? 'list' : 'sender',
        title: titleOf(message),
        address: message.from.address.toLowerCase(),
        mailing: false,
        count: 0,
        unread: 0,
        bytes: 0,
        firstDate: message.date,
        lastDate: message.date,
        canUnsubscribe: false,
        oneClick: false,
        unsubscribeMessageId: null,
        folders: [],
      };
      byKey.set(key, group);
      foldersByKey.set(key, new Map());
    }

    group.count += 1;
    if (!message.seen) group.unread += 1;
    group.bytes += message.size;
    if (message.date < group.firstDate) group.firstDate = message.date;
    if (message.date > group.lastDate) {
      group.lastDate = message.date;
      // Имя группы берём у самого свежего письма: отправитель, сменивший
      // название, должен называться новым, а не тем, что было год назад.
      group.title = titleOf(message);
    }
    if (message.listId || message.unsubscribe) group.mailing = true;
    if (message.unsubscribe) {
      /*
       * Отписка идёт по САМОМУ СВЕЖЕМУ письму с адресом отписки. У ссылки
       * отписки внутри обычно зашит одноразовый признак получателя, и у
       * письма годичной давности он с большой вероятностью уже не
       * действует — сервер отписки ответит ошибкой, а человек решит,
       * что сломались мы.
       *
       * Дата отписочного письма помнится ОТДЕЛЬНО от даты последнего
       * письма группы: у самого свежего письма адреса отписки может и не
       * быть, и сравнивать с ним значило бы никогда не обновить выбор.
       */
      const chosenAt = unsubscribeDate.get(key);
      if (chosenAt === undefined || message.date > chosenAt) {
        unsubscribeDate.set(key, message.date);
        group.unsubscribeMessageId = message.id;
        group.canUnsubscribe = true;
        group.oneClick = message.oneClick;
      }
    }

    const folders = foldersByKey.get(key);
    if (folders) folders.set(message.folderId, (folders.get(message.folderId) ?? 0) + 1);
  }

  for (const [key, group] of byKey) {
    const folders = foldersByKey.get(key);
    group.folders = [...(folders ?? new Map<string, number>())]
      .map(([folderId, count]) => ({ folderId, count }))
      .sort((a, b) => b.count - a.count);
  }

  return [...byKey.values()].sort((a, b) => b.count - a.count || b.bytes - a.bytes);
}

/** Письма выбранной группы — в том же порядке, в каком их осмотрели. */
export function messagesOfGroup(
  messages: readonly ScannedMessage[],
  key: string,
): ScannedMessage[] {
  return messages.filter((m) => countsInReview(m) && groupKeyOf(m) === key);
}

/* ------------------------------------------------------------------ */
/* Уборка                                                              */
/* ------------------------------------------------------------------ */

/**
 * Условия массовой уборки.
 *
 * Всё, кроме `olderThanDays`, — это ЗАЩИТА: каждое поле только сужает
 * выборку. Значения по умолчанию выбраны так, чтобы случайное нажатие
 * уносило как можно меньше: непрочитанное и помеченное остаётся, если
 * человек прямо не сказал обратного.
 */
export interface SweepCriteria {
  /** Папка, которую убираем. Пусто — все осмотренные. */
  folderId?: string | undefined;
  /** Старше скольких дней. 0 — без ограничения по возрасту. */
  olderThanDays?: number | undefined;
  /** Не трогать непрочитанное. */
  keepUnread?: boolean | undefined;
  /** Не трогать помеченное флажком. */
  keepFlagged?: boolean | undefined;
  /** Только письма этой группы отправителей (ключ из `groupMailings`). */
  groupKey?: string | undefined;
  /** Только письма тяжелее скольких байт. */
  largerThanBytes?: number | undefined;
  /**
   * Оставить N самых свежих писем группы.
   *
   * Ровно то, что делает «Sweep — оставить только последнее» в Outlook:
   * рассылку человек чистит целиком, но последнее письмо часто нужно
   * (в нём код, билет, ссылка). Считается по дате письма.
   */
  keepLatest?: number | undefined;
}

/**
 * Роли папок, из которых уборка не выносит НИЧЕГО.
 *
 * Корзина — потому что оттуда уже некуда: перенос в корзину из корзины
 * ничего не освободит, а необратимое удаление здесь не делается вовсе.
 * Черновики — потому что это ненаписанные письма человека, а не почта,
 * которая пришла; потерять их массовой уборкой недопустимо.
 * «Отложенные» — потому что их вернёт служба, и убранное из них письмо
 * не вернётся никогда.
 */
const SWEEP_PROTECTED_ROLES: ReadonlySet<FolderRole> = new Set<FolderRole>([
  'trash',
  'drafts',
  'snoozed',
]);

/**
 * Что именно уедет.
 *
 * Одна функция на предпросмотр и на выполнение — см. шапку файла.
 * `now` передаётся явно, чтобы проверки не зависели от часов машины.
 */
export function selectForSweep(
  messages: readonly ScannedMessage[],
  criteria: SweepCriteria,
  now: Date = new Date(),
): ScannedMessage[] {
  const cutoff =
    criteria.olderThanDays && criteria.olderThanDays > 0
      ? new Date(now.getTime() - criteria.olderThanDays * 86_400_000).toISOString()
      : null;

  let chosen = messages.filter((message) => {
    if (SWEEP_PROTECTED_ROLES.has(message.folderRole)) return false;
    if (criteria.folderId && message.folderId !== criteria.folderId) return false;
    if (criteria.keepUnread && !message.seen) return false;
    if (criteria.keepFlagged && message.flagged) return false;
    if (cutoff && message.date >= cutoff) return false;
    if (criteria.largerThanBytes && message.size < criteria.largerThanBytes) return false;
    if (criteria.groupKey && groupKeyOf(message) !== criteria.groupKey) return false;
    return true;
  });

  const keepLatest = criteria.keepLatest ?? 0;
  if (keepLatest > 0) {
    /*
     * «Оставить последние N» считается ПО ОТБОРУ, а не по всей группе, и
     * это важно: с «оставить последнее» вместе с «старше года» человек
     * ждёт, что последнее из старых останется тоже. Считать по всей группе
     * значило бы, что защита не сработала ни разу, если свежие письма и
     * так не попали в отбор.
     */
    const sorted = [...chosen].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const spared = new Set(sorted.slice(0, keepLatest).map((m) => m.id));
    chosen = chosen.filter((m) => !spared.has(m.id));
  }

  return chosen;
}

/** Итог отбора числами — ровно то, что показывается ДО нажатия. */
export interface SweepPreview {
  count: number;
  bytes: number;
  /** Самое старое и самое свежее письмо отбора (ISO) либо null. */
  oldest: string | null;
  newest: string | null;
  /** Сколько писем из отбора непрочитано и сколько помечено флажком. */
  unread: number;
  flagged: number;
}

export function summarizeSelection(messages: readonly ScannedMessage[]): SweepPreview {
  let bytes = 0;
  let unread = 0;
  let flagged = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  for (const message of messages) {
    bytes += message.size;
    if (!message.seen) unread += 1;
    if (message.flagged) flagged += 1;
    if (oldest === null || message.date < oldest) oldest = message.date;
    if (newest === null || message.date > newest) newest = message.date;
  }
  return { count: messages.length, bytes, oldest, newest, unread, flagged };
}

/** Самые тяжёлые письма ящика — первый ответ на вопрос «куда делось место». */
export function heaviestMessages(
  messages: readonly ScannedMessage[],
  limit: number,
): ScannedMessage[] {
  return [...messages].sort((a, b) => b.size - a.size).slice(0, limit);
}
