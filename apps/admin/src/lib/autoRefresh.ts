/**
 * Автообновление живого списка: прилипание к концу, окно записей, память
 * о выборе.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПРИЛИПАНИЕ СЧИТАЕТСЯ ПО ПРОКРУТКЕ, А НЕ ПО ФЛАГУ «ТРОГАЛИ»
 * ------------------------------------------------------------------
 * Человек внизу списка хочет видеть события по мере их появления. Человек,
 * отмотавший вверх и разбирающийся в старой записи, не должен выдёргиваться
 * вниз каждым новым событием — иначе журнал становится бесполезен ровно
 * тогда, когда он нужнее всего.
 *
 * Флаг «пользователь трогал прокрутку» отвечает не на тот вопрос: человек
 * мог отмотать вверх и вернуться вниз сам, и тогда следить снова надо.
 * Единственный честный признак — где список стоит СЕЙЧАС.
 *
 * ------------------------------------------------------------------
 * ЗАПАС НА ДРОЖАНИЕ
 * ------------------------------------------------------------------
 * «В самом конце» — не строго ноль. Инерционная прокрутка на телефоне
 * останавливается в паре точек от края, а дробные высоты строк дают
 * остаток в доли точки. Без запаса прилипание слетало бы само собой,
 * и человек считал бы, что автообновление сломано.
 */

/** Запас, в пределах которого список считается стоящим в самом конце. */
export const STICK_SLACK_PX = 48;

/** Положение прокрутки — ровно то, что нужно для решения о прилипании. */
export interface ScrollPosition {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Стоит ли список в самом конце (с запасом).
 *
 * Список короче окна тоже считается «в конце»: прокручивать там нечего,
 * и новые записи обязаны появляться сами.
 */
export function isPinnedToBottom(
  position: ScrollPosition,
  slack: number = STICK_SLACK_PX,
): boolean {
  const distance = position.scrollHeight - position.scrollTop - position.clientHeight;
  return distance <= slack;
}

/**
 * Стоит ли лента в самом верху (с тем же запасом).
 *
 * Нужно там, где новое приписывается СВЕРХУ, а не снизу: история обработанных
 * писем идёт от свежих к старым, и «следить за новым» там означает стоять в
 * начале списка, а не в конце.
 */
export function isPinnedToTop(
  position: Pick<ScrollPosition, 'scrollTop'>,
  slack = STICK_SLACK_PX,
): boolean {
  return position.scrollTop <= slack;
}

/**
 * Кто на самом деле прокручивается вокруг этого узла.
 *
 * Поймано на живом стенде, и юнит-тест этого не показал: в панели
 * управления прокручивается не окно, а `<main>` с собственным overflow.
 * Прилипание, считанное по `window.scrollY`, было ВСЕГДА истинным — то
 * есть лента дёргалась бы и у человека, отмотавшего к старым записям, а
 * счётчик непрочитанного не появился бы никогда.
 *
 * Ищем ближайшего предка, который действительно прокручивается. `null`
 * означает «прокручивается сама страница» — так тоже бывает, и завязываться
 * на разметку макета здесь нельзя: она меняется.
 */
export function scrollParent(node: Element | null): Element | null {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const overflow = globalThis.getComputedStyle?.(el).overflowY ?? '';
    if (/(auto|scroll|overlay)/.test(overflow) && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

/** Насколько прокручен тот, кто прокручивается вокруг узла. */
export function scrollTopNear(node: Element | null): number {
  return scrollParent(node)?.scrollTop ?? globalThis.scrollY ?? 0;
}

/** Вернуть к началу того, кто прокручивается вокруг узла. */
export function scrollToTopNear(node: Element | null): void {
  const parent = scrollParent(node);
  if (parent) parent.scrollTo({ top: 0, behavior: 'smooth' });
  else globalThis.scrollTo?.({ top: 0, behavior: 'smooth' });
}

/**
 * Окно записей в памяти.
 *
 * Копить без предела нельзя: сутки на открытой вкладке — это сотни тысяч
 * узлов в разметке и растущая куча браузера. Лишнее срезается СВЕРХУ, то
 * есть самое старое, — вниз приходит новое, и оно важнее.
 *
 * Возвращается тот же массив, если резать нечего: лишняя копия на каждом
 * обновлении — это лишняя перерисовка всего списка.
 */
export function keepWindow<T>(items: readonly T[], max: number): readonly T[] {
  if (max <= 0 || items.length <= max) return items;
  return items.slice(items.length - max);
}

/**
 * Сколько записей пришло, пока человек смотрел вверх.
 *
 * Считается от той записи, которая была последней на момент отрыва от
 * конца, а не «сколько всего»: человеку нужно число НЕПРОЧИТАННЫХ.
 */
export function unreadCount(total: number, seen: number): number {
  return Math.max(0, total - seen);
}

/** Склонение для подписи кнопки возврата вниз. */
export function unreadLabel(count: number): string {
  const tail = count % 10;
  const hundred = count % 100;
  let word = 'новых записей';
  if (tail === 1 && hundred !== 11) word = 'новая запись';
  else if (tail >= 2 && tail <= 4 && (hundred < 12 || hundred > 14)) word = 'новые записи';
  return `${count} ${word}`;
}

/* ------------------------------------------------------------------ */
/* Память о выборе                                                      */
/* ------------------------------------------------------------------ */

const STORAGE_PREFIX = 'mt-admin-autorefresh:';

/**
 * Ключ памяти — СВОЙ у каждого журнала.
 *
 * За очередью следят постоянно, а в журнал аудита заходят разбираться:
 * один общий выключатель означал бы, что включённое в одном месте
 * дёргает список в другом.
 */
export function autoRefreshKey(journal: string): string {
  return `${STORAGE_PREFIX}${journal}`;
}

/**
 * Включено ли автообновление у этого журнала.
 *
 * По умолчанию ВЫКЛЮЧЕНО: список, который шевелится сам, — это решение
 * человека, а не наше за него. Недоступное хранилище (частный режим,
 * запрет на сайт) не должно ронять страницу.
 */
export function loadAutoRefresh(journal: string): boolean {
  try {
    return globalThis.localStorage?.getItem(autoRefreshKey(journal)) === '1';
  } catch {
    return false;
  }
}

export function saveAutoRefresh(journal: string, enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(autoRefreshKey(journal), enabled ? '1' : '0');
  } catch {
    // Хранилище недоступно — выбор просто не переживёт перезагрузку
  }
}

/**
 * Стоит ли сейчас опрашивать сервер.
 *
 * Невидимая вкладка не опрашивается вовсе: забытая на сутки панель иначе
 * молотила бы сервер запросами впустую — и сервер тот же самый, что возит
 * почту.
 */
export function shouldPoll(enabled: boolean, visibility: string | undefined): boolean {
  return enabled && visibility !== 'hidden';
}
