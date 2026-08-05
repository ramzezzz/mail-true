/**
 * Поведение диалога: фокус и уход.
 *
 * Здесь нужен настоящий DOM, а не разметка строкой: и ловушка фокуса,
 * и уезжающая копия живут в эффектах.
 *
 * На прежнем коде падало всё: Tab из открытого диалога уходил в шапку за
 * ним (первой же кнопкой была «Выйти»), после закрытия фокус пропадал
 * на body, а диалог исчезал мгновенно — без обратного хода.
 *
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal, MODAL_EXIT_MS } from '../src/components/ui';

let container: HTMLDivElement;
let root: Root;

/** Кнопка вне диалога — с неё диалог открывают и на неё возвращают фокус. */
let opener: HTMLButtonElement;

beforeEach(() => {
  // React 18 хочет знать, что окружение тестовое
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom не умеет requestAnimationFrame по кадрам — зовём сразу
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});

  opener = document.createElement('button');
  opener.textContent = 'Открыть';
  document.body.append(opener);

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  opener.remove();
  // Уезжающие копии живут MODAL_EXIT_MS и пережили бы тест: следующая
  // проверка нашла бы чужую копию вместо своей
  document.querySelectorAll('body > [inert]').forEach((ghost) => ghost.remove());
  vi.unstubAllGlobals();
});

function open(): void {
  opener.focus();
  act(() =>
    root.render(
      <Modal title="Новый домен" onClose={() => {}}>
        <input placeholder="Домен" />
        <input placeholder="Селектор" />
      </Modal>,
    ),
  );
}

function tab(shift = false): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true }),
    );
  });
}

const dialog = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[role="dialog"]:not([inert] *)');
  if (!found) throw new Error('диалог не открыт');
  return found;
};

describe('фокус не убегает из диалога', () => {
  it('при открытии фокус уходит внутрь, а не остаётся снаружи', () => {
    open();
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);
  });

  it('Tab с последнего элемента возвращается на первый, а не в шапку', () => {
    open();
    const stops = dialog().querySelectorAll<HTMLElement>('input, button');
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;

    last.focus();
    tab();
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab с первого элемента уходит на последний, а не наружу', () => {
    open();
    const stops = dialog().querySelectorAll<HTMLElement>('input, button');
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;

    first.focus();
    tab(true);
    expect(document.activeElement).toBe(last);
  });

  it('фокус, уведённый наружу, возвращается в диалог', () => {
    open();
    opener.focus();
    tab();
    expect(dialog().contains(document.activeElement)).toBe(true);
  });
});

describe('диалог объявляется скринридеру', () => {
  it('это диалог, он модальный и у него есть имя из заголовка', () => {
    open();
    const card = dialog();
    expect(card.getAttribute('aria-modal')).toBe('true');
    const labelledBy = card.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Новый домен');
  });
});

describe('уход диалога', () => {
  it('фокус возвращается на кнопку, которой диалог открыли', () => {
    open();
    // Сначала он обязан оттуда уйти — иначе проверка ничего не проверяет:
    // на прежнем коде фокус так и оставался на кнопке снаружи
    expect(document.activeElement).not.toBe(opener);

    act(() => root.render(null));
    expect(document.activeElement).toBe(opener);
  });

  it('вместо мгновенного исчезновения остаётся уезжающая копия', () => {
    open();
    const typed = dialog().querySelector('input')!;
    typed.value = 'proverka.example';

    act(() => root.render(null));

    const ghost = document.querySelector<HTMLElement>('body > [inert]');
    expect(ghost, 'копия для обратного хода не появилась').not.toBeNull();
    // Копия ничем не управляет: ни щелчком, ни Tab, ни чтением
    expect(ghost!.getAttribute('aria-hidden')).toBe('true');
    expect(ghost!.className).toContain('backdropClosing');
    expect(ghost!.querySelector('[role="dialog"]')!.className).toContain('modalClosing');
    // Набранное в полях уезжает вместе с диалогом, а не пропадает раньше него
    expect(ghost!.querySelector('input')!.getAttribute('value')).toBe('proverka.example');
  });

  it('копия убирается сама, когда обратный ход доигран', () => {
    // Подменяем только таймеры: подменённый заодно requestAnimationFrame
    // не дал бы диалогу «прожить кадр», и копия не появилась бы вовсе
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      open();
      act(() => root.render(null));
      expect(document.querySelector('body > [inert]')).not.toBeNull();

      act(() => void vi.advanceTimersByTime(MODAL_EXIT_MS + 10));
      expect(document.querySelector('body > [inert]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('страница под диалогом не прокручивается, пока он открыт', () => {
    open();
    expect(document.body.style.overflow).toBe('hidden');
    act(() => root.render(null));
    expect(document.body.style.overflow).toBe('');
  });
});
