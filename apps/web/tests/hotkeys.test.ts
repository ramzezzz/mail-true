// @vitest-environment jsdom
/** Тесты сопоставления горячих клавиш (R, F, Delete, U, I, Shift+J…). */

import { describe, expect, it } from 'vitest';
import {
  HOTKEY_SCOPE_ATTR,
  HOTKEY_SCOPE_LIST,
  hotkeyFor,
  ignoreHotkeysFor,
  isInteractiveTarget,
  matchHotkey,
} from '../src/lib/hotkeys';

describe('matchHotkey', () => {
  // Документ (docs/features-mailru.md, «Горячие клавиши») обещает эти три
  // клавиши. Раньше их не было ни в коде, ни в тестах — и расхождение
  // с документом никто не ловил.
  it('R — ответить, F — переслать, Delete — удалить', () => {
    expect(matchHotkey({ key: 'r' })).toBe('reply');
    expect(matchHotkey({ key: 'R' })).toBe('reply');
    expect(matchHotkey({ key: 'f' })).toBe('forward');
    expect(matchHotkey({ key: 'Delete' })).toBe('delete');
  });

  it('R и F работают в русской раскладке', () => {
    expect(matchHotkey({ key: 'к', code: 'KeyR' })).toBe('reply');
    expect(matchHotkey({ key: 'а', code: 'KeyF' })).toBe('forward');
  });

  it('Ctrl+R (перезагрузка) и Shift+Delete почте не принадлежат', () => {
    expect(matchHotkey({ key: 'r', ctrlKey: true })).toBeNull();
    expect(matchHotkey({ key: 'f', ctrlKey: true })).toBeNull();
    expect(matchHotkey({ key: 'Delete', shiftKey: true })).toBeNull();
  });

  it('U — пометить непрочитанным, I — флажок', () => {
    expect(matchHotkey({ key: 'u' })).toBe('toggle-unread');
    expect(matchHotkey({ key: 'i' })).toBe('toggle-flag');
  });

  it('работает в русской раскладке по физической клавише (e.code)', () => {
    expect(matchHotkey({ key: 'г', code: 'KeyU' })).toBe('toggle-unread');
    expect(matchHotkey({ key: 'О', code: 'KeyJ', shiftKey: true })).toBe('spam');
  });

  it('Shift+J — спам, Shift+L — создать фильтр', () => {
    expect(matchHotkey({ key: 'J', shiftKey: true })).toBe('spam');
    expect(matchHotkey({ key: 'L', shiftKey: true })).toBe('create-filter');
    // без Shift эти буквы ничего не значат
    expect(matchHotkey({ key: 'j' })).toBeNull();
    expect(matchHotkey({ key: 'l' })).toBeNull();
  });

  it('Ctrl+P (и Cmd+P) — печать', () => {
    expect(matchHotkey({ key: 'p', ctrlKey: true })).toBe('print');
    expect(matchHotkey({ key: 'p', metaKey: true })).toBe('print');
    expect(matchHotkey({ key: 'p' })).toBeNull();
  });

  it('стрелки, Enter, Escape — навигация', () => {
    expect(matchHotkey({ key: 'ArrowDown' })).toBe('nav-down');
    expect(matchHotkey({ key: 'ArrowUp' })).toBe('nav-up');
    expect(matchHotkey({ key: 'Enter' })).toBe('open');
    expect(matchHotkey({ key: 'Escape' })).toBe('close');
  });

  it('посторонние сочетания не срабатывают', () => {
    expect(matchHotkey({ key: 'u', ctrlKey: true })).toBeNull();
    expect(matchHotkey({ key: 'u', altKey: true })).toBeNull();
    expect(matchHotkey({ key: 'x' })).toBeNull();
  });
});

describe('фокус на управляющем элементе отменяет горячую клавишу', () => {
  it('кнопка, ссылка и поле ввода забирают клавиатуру себе', () => {
    const button = document.createElement('button');
    const link = document.createElement('a');
    link.href = '/inbox/';
    const input = document.createElement('input');

    expect(isInteractiveTarget(button)).toBe(true);
    expect(isInteractiveTarget(link)).toBe(true);
    expect(ignoreHotkeysFor(input)).toBe(true);
  });

  it('значок внутри кнопки — это тоже кнопка', () => {
    const button = document.createElement('button');
    const icon = document.createElement('span');
    button.append(icon);
    expect(isInteractiveTarget(icon)).toBe(true);
  });

  it('обычный текст и document клавиатуру не забирают', () => {
    expect(isInteractiveTarget(document.createElement('div'))).toBe(false);
    expect(isInteractiveTarget(document)).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
  });

  // Иначе после перехода на roving tabindex собственные стрелки списка
  // отключились бы: фокус ведь стоит на строке-ссылке.
  it('строки списка писем — исключение: там клавиши остаются нашими', () => {
    const list = document.createElement('div');
    list.setAttribute(HOTKEY_SCOPE_ATTR, HOTKEY_SCOPE_LIST);
    const row = document.createElement('a');
    row.href = '/inbox/inbox%3A1';
    list.append(row);

    expect(isInteractiveTarget(row)).toBe(false);
    expect(ignoreHotkeysFor(row)).toBe(false);
  });
});

describe('hotkeyFor — разбор с оглядкой на фокус', () => {
  const button = () => document.createElement('button');
  const input = () => document.createElement('input');

  it('на кнопке буквенные клавиши и Enter молчат', () => {
    expect(hotkeyFor({ key: 'Enter' }, button())).toBeNull();
    expect(hotkeyFor({ key: 'r' }, button())).toBeNull();
    expect(hotkeyFor({ key: 'Delete' }, button())).toBeNull();
  });

  it('вне управляющих элементов работают все', () => {
    expect(hotkeyFor({ key: 'Enter' }, document.body)).toBe('open');
    expect(hotkeyFor({ key: 'r' }, document.body)).toBe('reply');
  });

  // Кнопка держит фокус после щелчка мышью: выделили письма кнопкой —
  // и снять выделение с клавиатуры было бы уже нечем.
  it('Esc остаётся нашим даже когда фокус на кнопке', () => {
    expect(hotkeyFor({ key: 'Escape' }, button())).toBe('close');
    // а в поле ввода Esc принадлежит полю
    expect(hotkeyFor({ key: 'Escape' }, input())).toBeNull();
  });
});
