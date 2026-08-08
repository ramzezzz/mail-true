/**
 * Горячие клавиши списка и письма (как в привычных почтовых интерфейсах):
 *   R — ответить, F — переслать, Delete — удалить,
 *   U — пометить непрочитанным, I — флажок, Shift+J — спам,
 *   Shift+L — создать фильтр, Ctrl+P — печать,
 *   стрелки — навигация по списку, Enter — открыть, Esc — закрыть/снять.
 *
 * И три клавиши каркаса, работающие на любой странице почты:
 *   C — написать письмо, / — встать в поиск, ? — показать эту справку.
 * Их в привычных почтовых интерфейсах нет, но нет и ничего, что бы они перебивали, а без них
 * список горячих клавиш нельзя ни узнать, ни вспомнить: подписи стоят
 * только в меню «⋯», и человек, не открывавший это меню, не знает даже,
 * что клавиши есть.
 *
 * Сопоставление по e.code (физическая клавиша), чтобы работало
 * в любой раскладке; для тестов достаточно передать key.
 */

export type HotkeyAction =
  | 'reply'
  | 'forward'
  | 'delete'
  | 'toggle-unread'
  | 'toggle-flag'
  | 'spam'
  | 'create-filter'
  | 'print'
  | 'nav-down'
  | 'nav-up'
  | 'open'
  | 'close';

export interface HotkeyEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** Является ли физическая клавиша указанной латинской буквой (в любой раскладке). */
function isLetter(e: HotkeyEventLike, letter: string): boolean {
  if (e.code) return e.code === `Key${letter.toUpperCase()}`;
  return e.key.toUpperCase() === letter.toUpperCase();
}

export function matchHotkey(e: HotkeyEventLike): HotkeyAction | null {
  const ctrl = Boolean(e.ctrlKey || e.metaKey);
  const shift = Boolean(e.shiftKey);
  const alt = Boolean(e.altKey);

  if (alt) return null;

  // Ctrl+P — печать
  if (ctrl && !shift && isLetter(e, 'p')) return 'print';
  if (ctrl) return null;

  // Клавиши без Ctrl
  switch (e.key) {
    case 'ArrowDown':
      return shift ? null : 'nav-down';
    case 'ArrowUp':
      return shift ? null : 'nav-up';
    case 'Enter':
      return shift ? null : 'open';
    case 'Escape':
      return 'close';
    // Shift+Delete в привычных почтовых интерфейсах — удаление без корзины; такого действия
    // у нас пока нет, поэтому с Shift клавиша молчит.
    case 'Delete':
      return shift ? null : 'delete';
    default:
      break;
  }

  if (shift) {
    if (isLetter(e, 'j')) return 'spam';
    if (isLetter(e, 'l')) return 'create-filter';
    return null;
  }

  if (isLetter(e, 'r')) return 'reply';
  if (isLetter(e, 'f')) return 'forward';
  if (isLetter(e, 'u')) return 'toggle-unread';
  if (isLetter(e, 'i')) return 'toggle-flag';
  return null;
}

/** Не перехватываем клавиши, когда пользователь печатает текст. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(el.isContentEditable);
}

/**
 * Список писем сам живёт на стрелках и Enter, поэтому внутри него глобальные
 * горячие клавиши работать обязаны. Разметка помечается этим атрибутом.
 */
export const HOTKEY_SCOPE_ATTR = 'data-hotkeys';
export const HOTKEY_SCOPE_LIST = 'list';

const INTERACTIVE_SELECTOR =
  'a[href], button, input, textarea, select, summary, [role="button"], [role="menuitem"], [contenteditable="true"], [contenteditable=""]';

/**
 * Фокус стоит на элементе, который сам отвечает на клавиатуру: кнопка,
 * ссылка, поле ввода. Глобальная горячая клавиша при этом срабатывать
 * не должна — иначе Enter на «Написать письмо» открывал бы письмо,
 * выбранное в списке стрелками, а сама кнопка не нажималась бы никогда.
 *
 * Исключение — список писем: стрелки и Enter там и есть его собственное
 * поведение (см. HOTKEY_SCOPE_LIST).
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest(`[${HOTKEY_SCOPE_ATTR}="${HOTKEY_SCOPE_LIST}"]`)) return false;
  return Boolean(el.closest(INTERACTIVE_SELECTOR));
}

/** Общая проверка перед разбором горячей клавиши. */
export function ignoreHotkeysFor(target: EventTarget | null): boolean {
  return isEditableTarget(target) || isInteractiveTarget(target);
}

/* ------------------------------------------------------------------ */
/* Клавиши каркаса                                                      */
/*                                                                      */
/* Отдельно от клавиш страницы, потому что и обработчик у них другой:   */
/* страница отвечает за письма, каркас — за то, что доступно всегда.    */
/* Пересечений с таблицей выше нет, так что порядок обработчиков не     */
/* имеет значения, и ни один не отбирает клавишу у другого.             */
/* ------------------------------------------------------------------ */

export type GlobalHotkeyAction = 'compose' | 'search' | 'help';

/**
 * `/` и `?` — одна физическая клавиша, разница в Shift.
 *
 * Смотрим сначала на готовый символ, и только потом на клавишу с Shift.
 * Порядок именно такой, потому что символ надёжнее: раскладок, где `?`
 * набирается не Shift+Slash, много (немецкая, французская), а нажатие,
 * пришедшее из скрипта, вообще может не нести Shift — на этом справка
 * и попалась при живой проверке, открыв поиск вместо себя.
 *
 * Клавиша по коду — запасной путь для русской раскладки: там физическая
 * Slash даёт точку, и одного символа не хватило бы. Вне поля ввода лишнее
 * срабатывание безвредно: точку там всё равно некуда напечатать.
 */
export function matchGlobalHotkey(e: HotkeyEventLike): GlobalHotkeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === '?') return 'help';
  if (e.key === '/') return 'search';
  if (e.code === 'Slash') return e.shiftKey ? 'help' : 'search';
  if (e.shiftKey) return null;
  if (isLetter(e, 'c')) return 'compose';
  return null;
}

/** То же с оглядкой на фокус: в поле ввода клавиатура принадлежит полю. */
export function globalHotkeyFor(
  e: HotkeyEventLike,
  target: EventTarget | null,
): GlobalHotkeyAction | null {
  const action = matchGlobalHotkey(e);
  if (!action) return null;
  return ignoreHotkeysFor(target) ? null : action;
}

/**
 * Справка по клавишам.
 *
 * Живёт рядом с разбором намеренно: справка, лежащая в другом файле,
 * расходится с поведением на первой же новой клавише — и врёт тем убедительнее,
 * чем реже её открывают.
 */
export interface HotkeyHelpItem {
  keys: string[];
  action: string;
  /**
   * Нажимать вместе (Shift+J) или это перечисление разных клавиш (↑ ↓).
   * Без различия справка показывала «↑ + ↓» — сочетание, которого нет.
   * По умолчанию вместе: одиночных перечислений в таблице меньшинство.
   */
  combo?: boolean;
}

export interface HotkeyHelpSection {
  title: string;
  items: HotkeyHelpItem[];
}

export const HOTKEY_HELP: HotkeyHelpSection[] = [
  {
    title: 'Везде',
    items: [
      { keys: ['C'], action: 'Написать письмо' },
      { keys: ['/'], action: 'Поиск по почте' },
      { keys: ['?'], action: 'Эта справка' },
      { keys: ['Esc'], action: 'Закрыть, снять выделение' },
    ],
  },
  {
    title: 'Список писем',
    items: [
      { keys: ['↑', '↓'], action: 'Переход по списку', combo: false },
      { keys: ['Enter'], action: 'Открыть письмо' },
    ],
  },
  {
    title: 'Письмо и выделенные',
    items: [
      { keys: ['R'], action: 'Ответить' },
      { keys: ['F'], action: 'Переслать' },
      { keys: ['Delete'], action: 'Удалить' },
      { keys: ['U'], action: 'Пометить непрочитанным' },
      { keys: ['I'], action: 'Пометить флажком' },
      { keys: ['Shift', 'J'], action: 'Отправить в спам' },
      { keys: ['Shift', 'L'], action: 'Создать правило по отправителю' },
      { keys: ['Ctrl', 'P'], action: 'Распечатать' },
    ],
  },
];

/**
 * Разбор клавиши с оглядкой на то, где стоит фокус, — то, что нужно странице.
 *
 * Esc остаётся нашим даже на кнопке: нажатием кнопки он не бывает, а кнопка
 * держит фокус после щелчка — иначе «выделить все» мышью, а потом снять
 * выделение с клавиатуры стало бы нельзя.
 */
export function hotkeyFor(e: HotkeyEventLike, target: EventTarget | null): HotkeyAction | null {
  const action = matchHotkey(e);
  if (!action) return null;
  if (action === 'close') return isEditableTarget(target) ? null : action;
  return ignoreHotkeysFor(target) ? null : action;
}
