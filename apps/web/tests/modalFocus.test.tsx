// @vitest-environment jsdom
/**
 * Клавиатура в модальном окне.
 *
 * Комментарий в самом окне обещал: «Фокус внутрь окна: иначе Tab уводит в
 * страницу под затемнением». Обещание выполнял однократный focus() на
 * карточку — а он от ухода Tab не защищает вовсе: дойдя до последнего
 * элемента диалога, Tab уходит ровно туда, куда обещали не пускать.
 *
 * Клавиатурой это выглядит так: несколько нажатий — и человек «печатает»
 * в невидимый список писем позади, не понимая, где он. Возврата фокуса на
 * вызвавшую кнопку при закрытии тоже не было: после Esc фокус оказывался
 * в начале страницы.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { Modal } from '../src/components/Modal/Modal';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function press(key: string, shiftKey = false): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
  });
}

describe('ловушка фокуса в модальном окне', () => {
  it('Tab с последнего элемента возвращается к первому, а не уходит на страницу', () => {
    const outside = document.createElement('button');
    outside.textContent = 'Кнопка страницы под затемнением';
    document.body.append(outside);

    act(() => {
      root.render(
        <Modal title="Проверка" onClose={() => undefined}>
          <button type="button">Первая</button>
          <button type="button">Вторая</button>
        </Modal>,
      );
    });

    // Порядок обхода — как в самом окне: первым идёт крестик «Закрыть»,
    // он тоже часть диалога и тоже обязан попадать в обход.
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const stops = [...dialog.querySelectorAll('button')];
    expect(stops.length).toBeGreaterThanOrEqual(3);
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;

    // Фокус вошёл в окно сам — на первый элемент, а не на карточку.
    expect(document.activeElement).toBe(first);

    act(() => last.focus());
    press('Tab');
    expect(document.activeElement, 'Tab с последнего обязан вернуться в окно').toBe(first);

    press('Tab', true);
    expect(document.activeElement, 'Shift+Tab с первого обязан уйти на последний').toBe(last);

    outside.remove();
  });

  it('фокус за пределами окна возвращается внутрь', () => {
    const outside = document.createElement('button');
    outside.textContent = 'Снаружи';
    document.body.append(outside);

    act(() => {
      root.render(
        <Modal title="Проверка" onClose={() => undefined}>
          <button type="button">Единственная</button>
        </Modal>,
      );
    });

    // Так бывает после щелчка мышью мимо окна или после программного
    // фокуса: следующий Tab обязан вернуть человека в диалог.
    act(() => outside.focus());
    press('Tab');
    expect(document.activeElement).not.toBe(outside);

    outside.remove();
  });

  it('после закрытия фокус возвращается на кнопку, которая открыла окно', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Открыть';
    document.body.append(opener);
    act(() => opener.focus());

    act(() => {
      root.render(
        <Modal title="Проверка" onClose={() => undefined}>
          <button type="button">Внутри</button>
        </Modal>,
      );
    });
    expect(document.activeElement).not.toBe(opener);

    act(() => root.render(<></>));
    expect(
      document.activeElement,
      'без возврата фокуса человек с клавиатурой заново идёт до места, откуда открыл окно',
    ).toBe(opener);

    opener.remove();
  });
});
