/**
 * Горячие клавиши списка и письма (как в mail.ru):
 *   R — ответить, F — переслать, Delete — удалить,
 *   U — пометить непрочитанным, I — флажок, Shift+J — спам,
 *   Shift+L — создать фильтр, Ctrl+P — печать,
 *   стрелки — навигация по списку, Enter — открыть, Esc — закрыть/снять.
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
    // Shift+Delete у mail.ru — удаление без корзины; такого действия
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
