// @vitest-environment jsdom
/**
 * Меню, которому не хватило места, возвращается на экран целиком.
 *
 * Подгонка к краю была написана, но не работала. Сдвиг выставлялся внешним
 * отступом слева (marginLeft), а меню, прибитое правым краем (align="right",
 * в стилях — right: 0), от такого отступа не двигается вовсе: левый край у
 * него auto, и этот auto отступ и съедает. Замер в браузере: левый край меню
 * панели выделения писем как был на 125 точек за экраном, так и остался — при
 * выставленном marginLeft в 52 точки. Тем же способом оставались срезанными
 * меню «Фильтр», меню ящика, меню темы и меню окна написания; обрезалось
 * молча — содержимое приложения скрывает переполнение, прокрутки там нет.
 *
 * Настоящей раскладки в jsdom нет, поэтому размеры меню объявляются здесь —
 * но объявляются ЧЕСТНО: подставной замер учитывает уже применённый сдвиг,
 * как это делает браузер. Иначе проверка не отличила бы работающую подгонку
 * от неработающей.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { Dropdown, MenuItem } from '../src/components/Dropdown/Dropdown';

let host: HTMLDivElement;
let root: Root;
const realRect = Element.prototype.getBoundingClientRect;
const realWidth = window.innerWidth;

/** Ширина окна: подгонка считается от неё, и на телефоне она мала. */
function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
}

/**
 * Подставной замер меню: где оно оказалось бы БЕЗ подгонки — плюс уже
 * применённый сдвиг.
 *
 * Сдвиг читается из той стороны, которой меню прибито, — ровно так его и
 * видит браузер. Замер, не замечающий сдвига, врал бы в обе стороны: он
 * одобрил бы и подгонку, которая никуда не двигает, и повторный пересчёт
 * поверх уже сдвинутого меню.
 */
function stubMenuRect(base: { left: number; width: number }): void {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this.getAttribute('role') !== 'menu') return realRect.call(this);
    const style = (this as HTMLElement).style;
    let applied = 0;
    if (style.left !== '') applied = Number.parseFloat(style.left);
    else if (style.right !== '') applied = -Number.parseFloat(style.right);
    const left = base.left + applied;
    return {
      x: left,
      y: 0,
      left,
      right: left + base.width,
      top: 0,
      bottom: 0,
      width: base.width,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Element.prototype.getBoundingClientRect = realRect;
  setViewport(realWidth);
});

/** Раскрывает меню и отдаёт его элемент. */
function openMenu(align: 'left' | 'right'): HTMLElement {
  act(() => {
    root.render(
      <Dropdown align={align} trigger={({ toggle }) => <button onClick={toggle}>Ещё</button>}>
        <MenuItem>Переслать как вложение</MenuItem>
      </Dropdown>,
    );
  });
  act(() => host.querySelector('button')!.click());
  const menu = host.querySelector<HTMLElement>('[role="menu"]');
  expect(menu).not.toBeNull();
  return menu!;
}

describe('подгонка выпадающего меню к краю экрана', () => {
  it('меню панели выделения, срезанное слева, видно целиком', () => {
    // Меню прибито правым краем кнопки, а кнопка стоит у левого края
    // экрана: 125 точек меню оказываются за краем, и начала строк
    // («Переместить», «Пометить») не прочитать вовсе.
    setViewport(1024);
    stubMenuRect({ left: -125, width: 200 });

    const menu = openMenu('right');

    expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(8);
    expect(menu.style.right).toBe('-133px');
    expect(menu.style.marginLeft).toBe('');
  });

  it('меню «Ещё действия» на телефоне не уходит за правый край', () => {
    // Обратная сторона: меню прибито левым краем кнопки, а справа места
    // нет. Именно так с экрана уезжали «Спам», «Создать фильтр» и
    // «Сохранить .eml».
    setViewport(360);
    stubMenuRect({ left: 200, width: 280 });

    const menu = openMenu('left');

    expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(352);
    expect(menu.style.left).toBe('-128px');
  });

  it('меню, которому места хватает, не сдвигается ни на точку', () => {
    // Обратный ход: подгонка обязана срабатывать по нужде, а не всегда.
    setViewport(1024);
    stubMenuRect({ left: 300, width: 200 });

    const menu = openMenu('right');

    expect(menu.style.right).toBe('');
    expect(menu.style.left).toBe('');
  });

  it('меню уезжает оттуда, где стояло, а не из-за края', () => {
    // Пересчёт при закрытии мерил уже сдвинутое меню, получал ноль и
    // возвращал меню за край на всё время ухода: человек видел, как оно
    // уезжает не с того места, где только что было.
    setViewport(1024);
    stubMenuRect({ left: -125, width: 200 });

    const menu = openMenu('right');
    expect(menu.style.right).toBe('-133px');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    const leaving = host.querySelector<HTMLElement>('[role="menu"]');
    expect(leaving).not.toBeNull();
    expect(leaving!.getAttribute('aria-hidden')).toBe('true');
    expect(leaving!.style.right).toBe('-133px');
  });
});
