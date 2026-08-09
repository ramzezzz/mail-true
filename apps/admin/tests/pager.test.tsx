/**
 * Пейджер не запирает человека на пустой странице.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Условие показа было одно — «записей меньше страницы», — и оно
 * срабатывало ровно тогда, когда вернуться было нужнее всего. Было 55
 * ящиков, человек ушёл на вторую страницу и удалил там пятерых: записей
 * стало 50, отступ так и остался 50, таблица пишет «Ящиков пока нет», а
 * кнопки «Назад» на экране уже нет. Вернуться к своим пятидесяти ящикам
 * нечем, кроме перезагрузки страницы. То же на алиасах и везде, где
 * стоит этот пейджер.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pager } from '../src/components/ui';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(props: { total: number; limit: number; offset: number }): void {
  act(() => {
    root.render(<Pager {...props} onChange={() => undefined} />);
  });
}

/** Кнопка по её подписи. */
function button(label: string): HTMLButtonElement | null {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) ?? null;
}

describe('пейджер', () => {
  it('одной страницы мало — листать нечего, пейджера нет', () => {
    render({ total: 12, limit: 50, offset: 0 });
    expect(host.textContent).toBe('');
  });

  it('страниц несколько — пейджер на месте', () => {
    render({ total: 120, limit: 50, offset: 0 });
    expect(host.textContent).toContain('1–50 из 120');
    expect(button('Назад')?.disabled).toBe(true);
    expect(button('Вперёд')?.disabled).toBe(false);
  });

  it('записи кончились, а мы на второй странице — «Назад» остаётся', () => {
    // Ровно тот случай: было 55, удалили пятерых со второй страницы.
    render({ total: 50, limit: 50, offset: 50 });
    const back = button('Назад');
    expect(back, 'кнопка «Назад» пропала — вернуться нечем').not.toBe(null);
    expect(back?.disabled).toBe(false);
  });

  it('на пустой странице пишем правду, а не «51–50 из 50»', () => {
    render({ total: 50, limit: 50, offset: 50 });
    expect(host.textContent).not.toContain('51–50');
    expect(host.textContent).toContain('Записей больше нет');
    expect(host.textContent).toContain('50');
  });

  it('удалили всё до единой записи — уйти со страницы всё равно можно', () => {
    render({ total: 0, limit: 50, offset: 50 });
    expect(button('Назад')?.disabled).toBe(false);
  });
});
