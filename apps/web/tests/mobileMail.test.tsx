// @vitest-environment jsdom
/**
 * Телефон: строка списка в три строки, жесты, нижняя навигация.
 *
 * Раскладка под узкий экран уже была — колонка папок уезжала в ящик, панели
 * переносили кнопки, окно написания разворачивалось на весь экран
 * (см. tests/responsiveLayout.test.tsx). Не было того, без чего почтой
 * с телефона не пользуются каждый день:
 *
 *   — строка списка на 390 точках оставалась однострочной, как на большом
 *     экране: отправитель, тема и превью делили одну линию и все три
 *     обрезались многоточием, а превью пряталось совсем;
 *   — действий по смахиванию не существовало вовсе, обновить список можно
 *     было только перезагрузкой страницы;
 *   — до папок вела единственная дорога — гамбургер в верхнем левом углу,
 *     то есть два касания и оба в недосягаемом углу;
 *   — во всём интерфейсе не было ни одного `@media (hover: hover)`:
 *     наведение на сенсорном экране залипает после касания.
 *
 * Здесь проверяется каждое из этих мест. Порядок проверок нарочный: сперва
 * требуется, чтобы возможность вообще существовала, и только потом — чтобы
 * она вела себя правильно. Иначе «жест отменяем» проходило бы на коде,
 * в котором жестов нет.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { Folder, MessageSummary } from '@mail-true/shared';
import { api } from '../src/api';
import { useUiStore } from '../src/app/store';
import { SessionProvider } from '../src/app/session';
import { AppLayout } from '../src/layout/AppLayout';
import { NAV_DRAWER_ID } from '../src/layout/Header';
import { pinnedFolders } from '../src/layout/BottomNav';
import { MessageList, ROW_HEIGHT, rowHeightFor } from '../src/mail/MessageList';
import { ListToolbar } from '../src/mail/ListToolbar';
import {
  PULL_TRIGGER,
  SWIPE_TRIGGER,
  isHorizontalSwipe,
  pullArmed,
  pullDistance,
  swipeAction,
  swipeOffset,
} from '../src/lib/gestures';
import { EDGE_WIDTH, swipeBackDone } from '../src/lib/useSwipeBack';

/* --- Вспомогательное ---------------------------------------------------- */

const SRC = resolve(process.cwd(), 'src');
const read = (relativePath: string): string => readFileSync(join(SRC, relativePath), 'utf8');

/** Все CSS-модули приложения. */
function cssModules(dir = SRC): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...cssModules(full));
    else if (name.endsWith('.module.css')) found.push(full);
  }
  return found;
}

/** Содержимое всех блоков `@media (max-width: N)` с N не больше предела. */
function narrowRules(css: string, upTo: number): string {
  let out = '';
  const media = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let found = media.exec(css);
  while (found) {
    const limit = Number(found[1]);
    let depth = 1;
    let i = media.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    if (limit <= upTo) out += css.slice(media.lastIndex, i);
    found = media.exec(css);
  }
  return out;
}

/** Тело правила по селектору внутри куска CSS. */
function block(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `в CSS нет правила ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

/**
 * Событие касания для React. jsdom своего TouchEvent не имеет, а React
 * читает у события только `touches`/`changedTouches` — их и подкладываем.
 */
function touch(type: string, points: Array<{ clientX: number; clientY: number }>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const field of ['touches', 'changedTouches', 'targetTouches']) {
    Object.defineProperty(event, field, { value: points });
  }
  return event;
}

/** Провести пальцем по узлу: касание, движение, отпускание. */
function swipe(node: Element, from: [number, number], to: [number, number]) {
  act(() => {
    node.dispatchEvent(touch('touchstart', [{ clientX: from[0], clientY: from[1] }]));
  });
  act(() => {
    node.dispatchEvent(touch('touchmove', [{ clientX: to[0], clientY: to[1] }]));
  });
}

function release(node: Element) {
  act(() => node.dispatchEvent(touch('touchend', [])));
}

/**
 * jsdom не считает размеров, а виртуализация меряет контейнер именно ими:
 * при нулевой высоте она не рисует ни одной строки.
 */
function stubLayout(width = 390, height = 800) {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => width,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => height,
  });
}

/** Подменяем matchMedia: без неё jsdom не умеет отвечать про ширину экрана. */
function stubViewport(phone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('max-width: 600px') ? phone : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

function summary(uid: number, over: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id: `inbox:${uid}`,
    folderId: 'inbox',
    uid,
    threadId: `t-${uid}`,
    from: { name: 'Пётр Смирнов', address: 'p@example.com' },
    to: [],
    cc: [],
    subject: `Тема письма ${uid}`,
    snippet: 'начало текста письма, которое должно быть видно третьей строкой',
    date: new Date(2026, 7, 5, 12, uid).toISOString(),
    flags: {
      seen: true,
      flagged: false,
      answered: false,
      forwarded: false,
      draft: false,
      deleted: false,
    },
    hasAttachments: false,
    attachmentNames: [],
    labels: [],
    pinned: false,
    sizeBytes: 1024,
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubLayout();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ selectedIds: new Set<string>(), compactList: false });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/* ====================================================================== */
/* 1. Строка списка на телефоне — в три строки                             */
/* ====================================================================== */

describe('строка списка на телефоне', () => {
  it('высота строки на телефоне больше, чем на рабочем столе, и вмещает три строки', () => {
    // Сперва — что разная высота вообще бывает. Раньше её задавала
    // единственная константа `compact ? 40 : 48`, одна на все ширины.
    expect(rowHeightFor(false, false)).toBe(ROW_HEIGHT.desktop.normal);
    expect(
      rowHeightFor(false, true),
      'на телефоне строка той же высоты, что на большом экране',
    ).toBeGreaterThan(rowHeightFor(false, false));

    // Три строки текста (отправитель 20 + тема 20 + превью 18) плюс поля
    expect(rowHeightFor(false, true)).toBeGreaterThanOrEqual(76);
    // И компактный режим на телефоне тоже трёхстрочный, только теснее
    expect(rowHeightFor(true, true)).toBeGreaterThan(rowHeightFor(true, false));
    expect(rowHeightFor(true, true)).toBeLessThan(rowHeightFor(false, true));
  });

  it('виртуализация раздаёт строкам телефонную высоту, а не настольную', () => {
    stubViewport(true);
    act(() => {
      root.render(
        <MemoryRouter>
          <MessageList messages={[summary(1), summary(2)]} />
        </MemoryRouter>,
      );
    });

    // У виртуализированной строки высота стоит во встроенном стиле: именно
    // её и надо было научить зависеть от ширины экрана
    const rows = [...host.querySelectorAll<HTMLElement>('[class*="virtualRow"]')].filter((el) =>
      el.querySelector('[class*="correspondent"]'),
    );
    expect(rows.length, 'строки не отрисовались').toBeGreaterThan(0);
    expect(rows[0]!.style.height).toBe(`${ROW_HEIGHT.phone.normal}px`);
  });

  it('на широком экране высота строки прежняя — 48px', () => {
    stubViewport(false);
    act(() => {
      root.render(
        <MemoryRouter>
          <MessageList messages={[summary(1)]} />
        </MemoryRouter>,
      );
    });
    const row = [...host.querySelectorAll<HTMLElement>('[class*="virtualRow"]')].find((el) =>
      el.querySelector('[class*="correspondent"]'),
    );
    expect(row!.style.height).toBe(`${ROW_HEIGHT.desktop.normal}px`);
  });

  it('на телефоне строка разложена сеткой в три ряда: отправитель, тема, превью', () => {
    const css = narrowRules(read('mail/MessageList.module.css'), 600);
    const row = block(css, '.row');
    expect(row, 'строка на телефоне осталась однострочным flex-ом').toMatch(
      /display:\s*grid/u,
    );
    // Три ряда: отправитель, тема, превью
    const rows = /grid-template-rows:\s*([^;]+);/u.exec(row);
    expect(rows, 'у сетки строки не задано трёх рядов').not.toBeNull();
    expect(rows![1]!.trim().split(/\s+/u)).toHaveLength(3);

    // Отправитель и дата — в первом ряду, вместе
    expect(block(css, '.correspondent')).toMatch(/grid-row:\s*1/u);
    expect(block(css, '.date')).toMatch(/grid-row:\s*1/u);
    // Тема с превью — со второго ряда
    expect(block(css, '.title')).toMatch(/grid-row:\s*2/u);
  });

  it('превью письма на телефоне видно — оно и есть третья строка', () => {
    const css = narrowRules(read('mail/MessageList.module.css'), 600);
    const snippet = block(css, '.snippet');
    // Раньше здесь стояло ровно `display: none`
    expect(snippet, 'превью на телефоне по-прежнему спрятано').not.toMatch(
      /display:\s*none/u,
    );
    // И оно занимает отдельную строку, а не встаёт рядом с темой
    expect(snippet).toMatch(/flex:\s*1\s+0\s+100%/u);
  });

  it('превью письма и вправду отрисовано в строке списка', () => {
    stubViewport(true);
    act(() => {
      root.render(
        <MemoryRouter>
          <MessageList messages={[summary(1)]} />
        </MemoryRouter>,
      );
    });
    const snippet = host.querySelector('[class*="snippet"]');
    expect(snippet?.textContent).toContain('начало текста письма');
  });
});

/* ====================================================================== */
/* 2. Жесты                                                                */
/* ====================================================================== */

describe('арифметика жестов', () => {
  it('смахивание доводится только за порогом, а до него отменяется', () => {
    expect(swipeAction(SWIPE_TRIGGER)).toBe('archive');
    expect(swipeAction(-SWIPE_TRIGGER)).toBe('delete');
    // Недоведённое — ничего: строка обязана вернуться на место
    expect(swipeAction(SWIPE_TRIGGER - 1)).toBeNull();
    expect(swipeAction(-(SWIPE_TRIGGER - 1))).toBeNull();
    expect(swipeAction(0)).toBeNull();
  });

  it('до порога строка идёт за пальцем, за порогом упирается', () => {
    expect(swipeOffset(40)).toBe(40);
    expect(swipeOffset(-40)).toBe(-40);
    // Дальше порога ход тормозится, но знак сохраняется
    expect(Math.abs(swipeOffset(400))).toBeGreaterThan(SWIPE_TRIGGER);
    expect(Math.abs(swipeOffset(400))).toBeLessThan(400);
    expect(swipeOffset(-400)).toBeLessThan(0);
  });

  it('косое движение пальца не считается смахиванием', () => {
    expect(isHorizontalSwipe(60, 4)).toBe(true);
    // Палец пошёл вниз — это прокрутка списка, а не жест по строке
    expect(isHorizontalSwipe(20, 40)).toBe(false);
    // Слишком короткое движение — ещё не жест
    expect(isHorizontalSwipe(4, 0)).toBe(false);
  });

  it('оттягивание вниз идёт с сопротивлением и срабатывает только за порогом', () => {
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(-100)).toBe(0);
    expect(pullDistance(100)).toBeLessThan(100);
    expect(pullArmed(pullDistance(PULL_TRIGGER * 2))).toBe(true);
    expect(pullArmed(pullDistance(10))).toBe(false);
  });
});

describe('смахивание строки списка', () => {
  const messages = [summary(1), summary(2)];

  function renderList(onSwipe: (m: MessageSummary, a: 'archive' | 'delete') => void) {
    stubViewport(true);
    act(() => {
      root.render(
        <MemoryRouter>
          <MessageList messages={messages} onSwipe={onSwipe} />
        </MemoryRouter>,
      );
    });
    const row = host.querySelector<HTMLAnchorElement>('a[class*="row"]');
    expect(row, 'строки списка не отрисовались').not.toBeNull();
    return row!;
  }

  it('жест вообще существует: от движения пальца строка едет за ним', () => {
    // Это требование первое не случайно. Без него проверка «жест отменяем»
    // проходила бы на коде, где жестов нет вовсе: строка никуда не уехала —
    // значит, и возвращать нечего.
    const row = renderList(() => {});
    expect(row.style.transform, 'строка сдвинута ещё до всякого жеста').toBe('');

    swipe(row, [200, 100], [140, 104]);
    expect(row.style.transform, 'строка не поехала за пальцем — жеста нет').toMatch(
      /translateX\(-\d/u,
    );
  });

  it('недоведённое смахивание отменяется: строка возвращается, действия нет', () => {
    const done = vi.fn();
    const row = renderList(done);

    // Тянем меньше порога и отпускаем
    swipe(row, [200, 100], [200 - (SWIPE_TRIGGER - 20), 102]);
    expect(row.style.transform, 'строка не сдвинулась вовсе').not.toBe('');

    release(row);
    expect(row.style.transform, 'строка осталась сдвинутой').toBe('');
    expect(done, 'недоведённый жест всё равно удалил письмо').not.toHaveBeenCalled();
  });

  it('доведённое смахивание влево удаляет, вправо — в архив', () => {
    const done = vi.fn();
    const row = renderList(done);

    swipe(row, [300, 100], [300 - SWIPE_TRIGGER - 10, 104]);
    release(row);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ id: 'inbox:1' }), 'delete');

    done.mockClear();
    swipe(row, [40, 100], [40 + SWIPE_TRIGGER + 10, 104]);
    release(row);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ id: 'inbox:1' }), 'archive');
  });

  it('вертикальное движение отдаётся прокрутке, а не жесту', () => {
    const done = vi.fn();
    const row = renderList(done);

    swipe(row, [200, 300], [206, 120]);
    expect(row.style.transform, 'прокрутка списка сорвалась в смахивание').toBe('');
    release(row);
    expect(done).not.toHaveBeenCalled();
  });

  it('под сдвинутой строкой видно, что произойдёт, и доведён ли жест', () => {
    const row = renderList(() => {});
    const shell = row.closest('[data-swipe]');
    expect(shell, 'под строкой нет подложки с подсказкой действия').not.toBeNull();

    swipe(row, [300, 100], [300 - (SWIPE_TRIGGER - 20), 102]);
    expect(shell!.getAttribute('data-swipe')).toBe('delete');
    expect(
      shell!.getAttribute('data-swipe-armed'),
      'недоведённый жест выглядит как доведённый',
    ).toBe('false');

    swipe(row, [300, 100], [300 - SWIPE_TRIGGER - 10, 102]);
    expect(shell!.getAttribute('data-swipe-armed')).toBe('true');
  });

  it('после смахивания письмо не открывается заодно', () => {
    // Проверка идёт по адресу страницы, а не по defaultPrevented: строка
    // отменяет событие в любом случае (она сама решает, куда переходить),
    // и по одному этому признаку «не открылось» от «открылось» не отличить.
    stubViewport(true);
    let path = '';
    function Where() {
      path = useLocation().pathname;
      return null;
    }
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/inbox/']}>
          <Where />
          <MessageList messages={messages} onSwipe={() => {}} />
        </MemoryRouter>,
      );
    });
    const row = host.querySelector<HTMLAnchorElement>('a[class*="row"]')!;
    const click = () =>
      act(() =>
        void row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
      );

    // Смахнули — и следом браузер шлёт клик по той же строке
    swipe(row, [300, 100], [300 - SWIPE_TRIGGER - 10, 104]);
    release(row);
    click();
    expect(path, 'жест заодно открыл письмо').toBe('/inbox/');

    // А обычное нажатие письмо по-прежнему открывает: без этого предыдущая
    // проверка проходила бы и на строке, которая не открывается вовсе
    click();
    expect(path, 'строка перестала открывать письмо нажатием').toBe('/inbox/inbox%3A1');
  });
});

describe('потянуть список вниз — обновить', () => {
  const messages = [summary(1), summary(2)];

  function renderList(onRefresh: () => Promise<unknown>) {
    stubViewport(true);
    act(() => {
      root.render(
        <MemoryRouter>
          <MessageList messages={messages} onRefresh={onRefresh} />
        </MemoryRouter>,
      );
    });
    const scroll = host.querySelector<HTMLElement>('[class*="scroll"]');
    expect(scroll, 'область прокрутки списка не найдена').not.toBeNull();
    return scroll!;
  }

  it('жест существует: оттягивание показывает крутилку обновления', () => {
    const refresh = vi.fn(() => Promise.resolve());
    const scroll = renderList(refresh);
    expect(host.querySelector('[role="status"]'), 'крутилка есть до всякого жеста').toBeNull();

    swipe(scroll, [200, 100], [200, 100 + PULL_TRIGGER * 2]);
    const indicator = host.querySelector('[role="status"]');
    expect(indicator, 'список не отзывается на оттягивание — жеста нет').not.toBeNull();
    expect(indicator!.getAttribute('data-armed')).toBe('true');
  });

  it('недотянутый жест отменяется: обновления не происходит', () => {
    const refresh = vi.fn(() => Promise.resolve());
    const scroll = renderList(refresh);

    swipe(scroll, [200, 100], [200, 110]);
    const indicator = host.querySelector('[role="status"]');
    expect(indicator, 'список не отозвался на движение вовсе').not.toBeNull();
    expect(indicator!.getAttribute('data-armed'), 'недотянутый жест показан доведённым').toBe(
      'false',
    );

    release(scroll);
    expect(refresh, 'недотянутый жест всё равно обновил список').not.toHaveBeenCalled();
    expect(host.querySelector('[role="status"]'), 'крутилка осталась висеть').toBeNull();
  });

  it('дотянутый жест обновляет список', () => {
    const refresh = vi.fn(() => Promise.resolve());
    const scroll = renderList(refresh);
    swipe(scroll, [200, 100], [200, 100 + PULL_TRIGGER * 3]);
    release(scroll);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('у каждого жеста есть кнопка', () => {
  it('обновить список можно кнопкой, а не только пальцем', () => {
    const refresh = vi.fn();
    act(() => {
      root.render(
        <MemoryRouter>
          <ListToolbar
            selectedCount={0}
            filter="all"
            onFilterChange={() => {}}
            folders={[]}
            onSelectAll={() => {}}
            onClearSelection={() => {}}
            onMarkAllRead={() => {}}
            onRefresh={refresh}
            onDelete={() => {}}
            onArchive={() => {}}
            onMoveTo={() => {}}
            onUnsubscribe={() => {}}
            onMarkUnread={() => {}}
            onToggleFlag={() => {}}
            onSpam={() => {}}
            onPrint={() => {}}
            onCreateFilter={() => {}}
            onForwardAsAttachment={() => {}}
          />
        </MemoryRouter>,
      );
    });

    const button = [...host.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Обновить'),
    );
    expect(button, 'кнопки «Обновить» нет — жест остался единственным способом').not.toBeUndefined();

    act(() => void button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(refresh).toHaveBeenCalled();
  });

  it('удалить и в архив есть кнопками при выделенном письме', () => {
    const remove = vi.fn();
    const archive = vi.fn();
    act(() => {
      root.render(
        <MemoryRouter>
          <ListToolbar
            selectedCount={1}
            filter="all"
            onFilterChange={() => {}}
            folders={[]}
            onSelectAll={() => {}}
            onClearSelection={() => {}}
            onMarkAllRead={() => {}}
            onDelete={remove}
            onArchive={archive}
            onMoveTo={() => {}}
            onUnsubscribe={() => {}}
            onMarkUnread={() => {}}
            onToggleFlag={() => {}}
            onSpam={() => {}}
            onPrint={() => {}}
            onCreateFilter={() => {}}
            onForwardAsAttachment={() => {}}
          />
        </MemoryRouter>,
      );
    });
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels.some((t) => t.includes('Удалить'))).toBe(true);
    expect(labels.some((t) => t.includes('В архив'))).toBe(true);
  });

  it('на телефоне письмо можно выделить касанием аватара', () => {
    const css = narrowRules(read('mail/MessageList.module.css'), 600);
    const checkbox = block(css, '.rowCheckbox');
    // Наведения на сенсорном экране нет: чекбокс лежит поверх аватара всегда,
    // просто прозрачный. Раньше он показывался только `.virtualRow:hover`,
    // и выделить письмо на телефоне было нечем.
    expect(checkbox).toMatch(/display:\s*flex/u);
    expect(checkbox).toMatch(/opacity:\s*0/u);
  });
});

describe('назад из письма', () => {
  it('жест «назад» ведётся только от левого края и только доведённый', () => {
    expect(swipeBackDone(4, SWIPE_TRIGGER + 10, 4)).toBe(true);
    // Начали не от края — это прокрутка широкого письма, а не «назад»
    expect(swipeBackDone(EDGE_WIDTH + 50, SWIPE_TRIGGER + 10, 4)).toBe(false);
    // Недоведённый — отменяется
    expect(swipeBackDone(4, SWIPE_TRIGGER - 20, 4)).toBe(false);
    // Влево — не «назад»
    expect(swipeBackDone(4, -(SWIPE_TRIGGER + 10), 4)).toBe(false);
  });

  it('страница письма подписана на жест, а кнопка «К списку» осталась', () => {
    const page = read('pages/MessagePage.tsx');
    expect(page, 'страница письма не знает про жест «назад»').toMatch(/useSwipeBack/u);
    expect(page).toMatch(/<article[^>]*\{\.\.\.swipeBack\}/u);
    expect(page, 'кнопка «К списку» пропала — жест остался единственным путём').toMatch(
      /label="К списку"/u,
    );
  });
});

/* ====================================================================== */
/* 3. Нижняя навигация                                                     */
/* ====================================================================== */

const folders: Folder[] = (
  [
    ['inbox', 'INBOX', 'inbox', 3],
    ['sent', 'Sent', 'sent', 0],
    ['drafts', 'Drafts', 'drafts', 0],
    ['trash', 'Trash', 'trash', 0],
    ['archive', 'Archive', 'archive', 0],
    ['spam', 'Spam', 'spam', 0],
  ] as const
).map(([id, name, role, unread]) => ({
  id,
  path: name,
  name,
  role,
  parentId: null,
  depth: 0,
  unreadCount: unread,
  totalCount: 10,
  system: true,
  uidValidity: 1,
})) as Folder[];

function stubApi() {
  vi.spyOn(api, 'getSession').mockResolvedValue({
    authenticated: true,
    email: 'demo@mail.local',
  } as Awaited<ReturnType<typeof api.getSession>>);
  vi.spyOn(api, 'getFolders').mockResolvedValue(folders);
  vi.spyOn(api, 'getAccount').mockResolvedValue({
    email: 'demo@mail.local',
    displayName: 'Демо Пользователь',
    avatarUrl: null,
    signature: '',
  } as Awaited<ReturnType<typeof api.getAccount>>);
  vi.spyOn(api, 'getAiState').mockRejectedValue(new Error('помощник выключен'));
}

/** Даём react-query доехать: список папок приходит отдельным запросом. */
async function flush() {
  for (let i = 0; i < 8; i += 1) {
     
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function renderLayout() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox/']}>
          <SessionProvider>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path=":folderId" element={<div>список писем</div>} />
              </Route>
            </Routes>
          </SessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe('нижняя навигация телефона', () => {
  beforeEach(() => stubApi());

  it('в полосу попадают главные папки в понятном порядке', () => {
    expect(pinnedFolders(folders).map((f) => f.role)).toEqual([
      'inbox',
      'sent',
      'drafts',
      'trash',
    ]);
    // Папки, которой у ящика нет, в полосе быть не должно
    expect(pinnedFolders([folders[0]!]).map((f) => f.role)).toEqual(['inbox']);
    expect(pinnedFolders(undefined)).toEqual([]);
  });

  it('до главных папок — одно касание, до остальных — «Ещё» и второе', async () => {
    renderLayout();
    await flush();

    const bar = host.querySelector('nav[aria-label="Основные папки"]');
    expect(bar, 'нижней полосы папок нет: до папок ведёт только гамбургер').not.toBeNull();

    const hrefs = [...bar!.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/inbox/');
    expect(hrefs).toContain('/sent/');
    expect(hrefs).toContain('/drafts/');
    expect(hrefs).toContain('/trash/');

    // «Ещё» открывает тот же ящик с папками — это второе касание
    const more = bar!.querySelector<HTMLButtonElement>(
      `button[aria-controls="${NAV_DRAWER_ID}"]`,
    );
    expect(more, 'из полосы не добраться до остальных папок').not.toBeNull();
    expect(more!.getAttribute('aria-expanded')).toBe('false');

    act(() => void more!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(more!.getAttribute('aria-expanded')).toBe('true');
  });

  it('число непрочитанных во входящих видно и словами, а не только значком', async () => {
    renderLayout();
    await flush();
    const bar = host.querySelector('nav[aria-label="Основные папки"]')!;
    expect(bar.textContent).toContain('непрочитанных: 3');
  });

  it('написать письмо можно кнопкой у нижнего угла — одной рукой', async () => {
    renderLayout();
    await flush();

    const fab = host.querySelector<HTMLButtonElement>('button[aria-label="Написать письмо"]');
    expect(fab, 'кнопка написания есть только в выдвижном ящике — одной рукой не достать').not.toBeNull();

    act(() => void fab!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(useUiStore.getState().composeWindows).toHaveLength(1);

    // И стоит она внизу справа, а не где придётся
    const css = narrowRules(read('layout/BottomNav.module.css'), 600);
    const rule = block(css, '.fab');
    expect(rule).toMatch(/position:\s*fixed/u);
    expect(rule).toMatch(/right:\s*16px/u);
    expect(rule).toMatch(/bottom:\s*calc\(/u);
  });

  it('полоса живёт только на телефоне и не закрывает собой письма', () => {
    const css = read('layout/BottomNav.module.css');
    // На широком экране колонка папок и так на виду
    expect(block(css, '.bar')).toMatch(/display:\s*none/u);
    expect(block(narrowRules(css, 600), '.bar')).toMatch(/display:\s*flex/u);

    // Контенту оставлено место под полосу — иначе последняя строка списка
    // и нижние кнопки письма оказывались под ней
    const layout = narrowRules(read('layout/AppLayout.module.css'), 600);
    expect(layout).toMatch(/\.content\s*\{[^}]*padding-bottom:\s*calc\(56px/u);

    // Полоса ниже затемнения (55) и ящика (60): открытый ящик её перекрывает
    const z = /z-index:\s*(\d+)/u.exec(block(narrowRules(css, 600), '.bar'));
    expect(z).not.toBeNull();
    expect(Number(z![1])).toBeLessThan(55);
  });
});

/* ====================================================================== */
/* 4. Мелочи, которые решают                                               */
/* ====================================================================== */

describe('касание вместо мыши', () => {
  it('ни одного :hover не осталось снаружи @media (hover: hover)', () => {
    /** Селекторы с :hover, стоящие вне блока про наличие мыши. */
    const stray = (css: string): string[] => {
      const clean = css.replace(/\/\*[\s\S]*?\*\//gu, '');
      const bad: string[] = [];
      const stack: string[] = [];
      let head = '';
      for (const ch of clean) {
        if (ch === '{') {
          const prelude = head.trim();
          head = '';
          stack.push(prelude.startsWith('@') ? prelude : '');
          if (!prelude.startsWith('@') && prelude.includes(':hover')) {
            if (!stack.some((s) => /hover:\s*hover/u.test(s))) {
              bad.push(prelude.replace(/\s+/gu, ' '));
            }
          }
        } else if (ch === '}') {
          stack.pop();
          head = '';
        } else head += ch;
      }
      return bad;
    };

    const offenders: string[] = [];
    for (const file of cssModules()) {
      for (const selector of stray(readFileSync(file, 'utf8'))) {
        offenders.push(`${relative(SRC, file)}: ${selector}`);
      }
    }
    // На сенсорном экране наведение залипает: коснулся строки — она осталась
    // подсвеченной, коснулся кнопки — она осталась «под курсором».
    expect(offenders, `правила наведения вне @media (hover: hover):\n${offenders.join('\n')}`)
      .toHaveLength(0);
  });

  it('там, где было наведение, живой отклик остался нажатием', () => {
    // Правила :active никуда не уводятся: именно они и отвечают на касание
    const button = read('components/Button/Button.module.css');
    expect(button).toMatch(/\.mode_primary:active:not\(:disabled\)/u);
    const stillOutside = /@media \(hover: hover\) \{\s*\.mode_primary:active/u.test(button);
    expect(stillOutside, 'нажатие уехало в блок про мышь вместе с наведением').toBe(false);
  });
});

describe('цели касания на телефоне', () => {
  it('в нижней полосе и у плавающей кнопки не меньше 44px', () => {
    const css = narrowRules(read('layout/BottomNav.module.css'), 600);

    const item = block(css, '.item');
    const height = /min-height:\s*(\d+)px/u.exec(item);
    expect(height, 'у пункта полосы не задана высота цели касания').not.toBeNull();
    expect(Number(height![1])).toBeGreaterThanOrEqual(44);

    const fab = block(css, '.fab');
    expect(Number(/width:\s*(\d+)px/u.exec(fab)![1])).toBeGreaterThanOrEqual(44);
    expect(Number(/height:\s*(\d+)px/u.exec(fab)![1])).toBeGreaterThanOrEqual(44);

    // Впятером на самом узком живом андроиде (360px) это по 72px на пункт
    expect(360 / 5).toBeGreaterThanOrEqual(44);
  });

  it('строка списка на телефоне сама по себе выше 44px', () => {
    expect(rowHeightFor(false, true)).toBeGreaterThanOrEqual(44);
    expect(rowHeightFor(true, true)).toBeGreaterThanOrEqual(44);
  });
});

describe('клавиатура телефона', () => {
  it('страница ужимается под клавиатуру, а не уходит под неё', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const viewport = /<meta[^>]*name="viewport"[\s\S]*?>/u.exec(html);
    expect(viewport).not.toBeNull();
    expect(
      viewport![0],
      'без interactive-widget=resizes-content клавиатура встаёт поверх поля ввода',
    ).toMatch(/interactive-widget=resizes-content/u);
    // Полоса папок опирается на env(safe-area-inset-*) — им нужен viewport-fit
    expect(viewport![0]).toMatch(/viewport-fit=cover/u);
  });

  it('окно написания меряет высоту тем, что видно сейчас, а не всем экраном', () => {
    const css = narrowRules(read('compose/ComposeWindow.module.css'), 640);
    expect(block(css, '.window'), 'окно написания меряет себя в vh — уйдёт под клавиатуру').toMatch(
      /height:\s*100dvh/u,
    );
  });
});
