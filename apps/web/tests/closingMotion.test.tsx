// @vitest-environment jsdom
/**
 * Окно и меню не исчезают рывком: у закрытия есть свой ход.
 *
 * Проверяется поведение, а не стили: окно обязано дожить до конца хода,
 * а выбранный пункт меню — закрыть его сразу, потому что страница за ним
 * уже меняется и досматривать нечего.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { Modal, MODAL_EXIT_MS } from '../src/components/Modal/Modal';
import { Dropdown, MenuItem, MENU_EXIT_MS } from '../src/components/Dropdown/Dropdown';

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

/** Проматывает столько-то миллисекунд настоящих таймеров. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const buttonWith = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').includes(text),
  );

describe('модальное окно', () => {
  it('доигрывает уход и только потом сообщает о закрытии', async () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <Modal title="Создание фильтра" onClose={onClose}>
          тело
        </Modal>,
      );
    });

    act(() => buttonWith('Закрыть')!.click());
    // Окно ещё на месте — иначе уходить было бы нечему
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();

    await wait(MODAL_EXIT_MS + 50);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape уводит окно тем же ходом', async () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <Modal title="Создание фильтра" onClose={onClose}>
          тело
        </Modal>,
      );
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await wait(MODAL_EXIT_MS + 50);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('выпадающее меню', () => {
  function renderMenu(onPick = () => {}) {
    act(() => {
      root.render(
        <Dropdown trigger={({ toggle }) => <button onClick={toggle}>Ещё</button>}>
          <MenuItem onClick={onPick}>Переместить</MenuItem>
        </Dropdown>,
      );
    });
    act(() => buttonWith('Ещё')!.click());
  }

  it('отказ от выбора уводит меню ходом, а не рывком', async () => {
    renderMenu();
    expect(host.querySelector('[role="menu"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    const leaving = host.querySelector('[role="menu"]');
    // Меню ещё в разметке, но уже скрыто от читалок и не нажимается
    expect(leaving).not.toBeNull();
    expect(leaving!.getAttribute('aria-hidden')).toBe('true');

    await wait(MENU_EXIT_MS + 50);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it('выбранный пункт закрывает меню сразу — страница за ним уже меняется', () => {
    const onPick = vi.fn();
    renderMenu(onPick);
    act(() => buttonWith('Переместить')!.click());
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
});
