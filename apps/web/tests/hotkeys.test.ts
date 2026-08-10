// @vitest-environment jsdom
/** Тесты сопоставления горячих клавиш (R, F, Delete, U, I, Shift+J…). */

import { describe, expect, it } from 'vitest';
import {
  HOTKEY_HELP,
  HOTKEY_SCOPE_ATTR,
  HOTKEY_SCOPE_LIST,
  hotkeyFor,
  ignoreHotkeysFor,
  anyModalOpen,
  globalHotkeyFor,
  noteModalClosed,
  noteModalOpened,
  isInteractiveTarget,
  matchGlobalHotkey,
  matchHotkey,
} from '../src/lib/hotkeys';

describe('matchHotkey', () => {
  // Документ (docs/features-reference.md, «Горячие клавиши») обещает эти три
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

describe('клавиши каркаса — C, /, ?', () => {
  it('C — написать, / — поиск, Shift+/ — справка', () => {
    expect(matchGlobalHotkey({ key: 'c' })).toBe('compose');
    expect(matchGlobalHotkey({ key: '/' })).toBe('search');
    expect(matchGlobalHotkey({ key: '?', shiftKey: true })).toBe('help');
    // Без Shift в событии: так приходит нажатие из скрипта и с раскладок,
    // где «?» набирается не Shift+Slash. Живая проверка поймала здесь
    // открытие поиска вместо справки.
    expect(matchGlobalHotkey({ key: '?' })).toBe('help');
  });

  it('работают в русской раскладке', () => {
    // Slash в русской раскладке даёт точку, KeyC — букву «с».
    expect(matchGlobalHotkey({ key: 'с', code: 'KeyC' })).toBe('compose');
    expect(matchGlobalHotkey({ key: '.', code: 'Slash' })).toBe('search');
    expect(matchGlobalHotkey({ key: ',', code: 'Slash', shiftKey: true })).toBe('help');
  });

  it('с Ctrl и Alt молчат: это чужие сочетания', () => {
    expect(matchGlobalHotkey({ key: 'c', ctrlKey: true })).toBeNull();
    expect(matchGlobalHotkey({ key: 'c', metaKey: true })).toBeNull();
    expect(matchGlobalHotkey({ key: '/', altKey: true })).toBeNull();
  });

  it('не отбирают клавиши у клавиш страницы', () => {
    // Пересечение означало бы, что порядок двух обработчиков решает исход.
    for (const key of ['r', 'f', 'u', 'i', 'Delete', 'Enter', 'Escape', 'ArrowDown']) {
      expect(matchGlobalHotkey({ key })).toBeNull();
    }
    expect(matchHotkey({ key: 'c' })).toBeNull();
    expect(matchHotkey({ key: '/' })).toBeNull();
  });

  it('в поле ввода принадлежат полю', () => {
    const input = document.createElement('input');
    expect(globalHotkeyFor({ key: 'c' }, input)).toBeNull();
    expect(globalHotkeyFor({ key: '/' }, input)).toBeNull();
    expect(globalHotkeyFor({ key: 'c' }, document.body)).toBe('compose');
  });
});

describe('справка по клавишам', () => {
  // Справка врёт незаметно: её открывают редко, а расходится она на первой
  // же новой клавише. Поэтому сверяем её с самим разбором.
  it('каждая клавиша из справки действительно что-то делает', () => {
    const named: Record<string, () => unknown> = {
      C: () => matchGlobalHotkey({ key: 'c' }),
      '/': () => matchGlobalHotkey({ key: '/' }),
      '?': () => matchGlobalHotkey({ key: '?', shiftKey: true }),
      Esc: () => matchHotkey({ key: 'Escape' }),
      Enter: () => matchHotkey({ key: 'Enter' }),
      R: () => matchHotkey({ key: 'r' }),
      F: () => matchHotkey({ key: 'f' }),
      U: () => matchHotkey({ key: 'u' }),
      I: () => matchHotkey({ key: 'i' }),
      Delete: () => matchHotkey({ key: 'Delete' }),
      '↑': () => matchHotkey({ key: 'ArrowUp' }),
      '↓': () => matchHotkey({ key: 'ArrowDown' }),
      Пробел: () => matchHotkey({ key: ' ' }),
    };
    // Сочетания — отдельно от одиночных клавиш: «↑ ↓» в одной строке справки
    // это две клавиши, а «Shift+J» — одна пара, и путать их нельзя.
    const combos: Record<string, () => unknown> = {
      'Shift+J': () => matchHotkey({ key: 'j', shiftKey: true }),
      'Shift+L': () => matchHotkey({ key: 'l', shiftKey: true }),
      'Ctrl+P': () => matchHotkey({ key: 'p', ctrlKey: true }),
    };
    for (const section of HOTKEY_HELP) {
      for (const item of section.items) {
        // Сочетание проверяем как сочетание, перечисление — поклавишно:
        // ровно так их и показывает справка.
        const asCombo = item.combo !== false && item.keys.length > 1;
        const combo = item.keys.join('+');
        const probes = asCombo ? [combos[combo]] : item.keys.map((k) => named[k]);
        for (const [index, probe] of probes.entries()) {
          const shown = asCombo ? combo : item.keys[index];
          expect(probe, `в справке есть «${shown}», а в разборе — нет`).toBeDefined();
          expect(probe?.(), `«${shown}» в справке ничего не делает`).not.toBeNull();
        }
      }
    }
  });
});

describe('отметить письмо с клавиатуры', () => {
  it('пробел отмечает письмо под курсором', () => {
    // Раньше отметить одно письмо можно было ТОЛЬКО мышью: галочка на
    // рабочем столе показывается по наведению, значит её нет ни в обходе
    // по Tab, ни в дереве доступности. Вместе с ней для работающего
    // клавиатурой пропадала вся панель выделения.
    expect(matchHotkey({ key: ' ' })).toBe('toggle-select');
  });

  it('с Shift пробел молчит: это уже другое действие, и его у нас нет', () => {
    expect(matchHotkey({ key: ' ', shiftKey: true })).toBeNull();
  });

  it('в поле ввода пробел остаётся пробелом', () => {
    const field = { tagName: 'INPUT' } as unknown as EventTarget;
    expect(hotkeyFor({ key: ' ' }, field)).toBeNull();
  });

  it('на кнопке внутри списка пробел не перехватывается: он её нажимает', () => {
    // Пробел — родная клавиша кнопки и галочки, а внутри строки списка
    // они есть: выделение и звёздочка. Обычные горячие клавиши внутри
    // списка работают всегда, но с пробелом это правило не годится.
    const button = document.createElement('button');
    const list = document.createElement('div');
    list.setAttribute('data-hotkeys', 'list');
    list.appendChild(button);
    expect(hotkeyFor({ key: ' ' }, button)).toBeNull();
  });

  it('на самой строке письма пробел отмечает письмо', () => {
    const row = document.createElement('div');
    const list = document.createElement('div');
    list.setAttribute('data-hotkeys', 'list');
    list.appendChild(row);
    expect(hotkeyFor({ key: ' ' }, row)).toBe('toggle-select');
  });
});

describe('открытое модальное окно забирает клавиши себе', () => {
  it('пока окно открыто, клавиши страницы и каркаса молчат', () => {
    /*
     * ЧТО БЫЛО. Окно перехватывает только Escape и Tab, всё остальное
     * проходит сквозь затемнение к списку писем ПОЗАДИ. Пока фокус стоит
     * на поле или кнопке окна, клавиши и так игнорируются — но стоит
     * щёлкнуть по тексту внутри (по картинке в предпросмотре вложения,
     * по строке в «Исходном тексте письма»), и фокус уходит на
     * неинтерактивный узел. С этого момента «E» отправляет в архив
     * письмо, которого человек не видит, «#» — в корзину, а «C»
     * открывает окно написания ПОД затемнением.
     */
    expect(globalHotkeyFor({ key: 'c' }, document.body)).toBe('compose');

    noteModalOpened();
    try {
      expect(anyModalOpen()).toBe(true);
      expect(globalHotkeyFor({ key: 'c' }, document.body)).toBeNull();
      expect(hotkeyFor({ key: 'e' }, document.body)).toBeNull();
      expect(hotkeyFor({ key: '#' }, document.body)).toBeNull();
    } finally {
      noteModalClosed();
    }

    expect(anyModalOpen()).toBe(false);
    expect(globalHotkeyFor({ key: 'c' }, document.body)).toBe('compose');
  });

  it('окно поверх окна: клавиши возвращаются только после последнего', () => {
    // Подтверждение над формой — обычное дело, и закрытие внутреннего
    // окна не должно возвращать клавиши, пока внешнее ещё висит.
    noteModalOpened();
    noteModalOpened();
    noteModalClosed();
    expect(anyModalOpen()).toBe(true);
    noteModalClosed();
    expect(anyModalOpen()).toBe(false);
  });
});
