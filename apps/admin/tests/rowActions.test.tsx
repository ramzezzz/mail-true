/**
 * Действия в строке таблицы: значок, раскрывающийся в подпись.
 *
 * Что было до правки: в строке списка ящиков стояло шесть текстовых
 * кнопок. На окне 1440 таблице не хватало 47 точек, на 1280 — 207,
 * «Войти в ящик» и «Удалить» оказывались за правым краем внутри
 * прокрутки, о которой человек не догадывается.
 *
 * Что проверяется здесь — не красота, а то, без чего замена слов на
 * значки превращает панель в набор безымянных квадратиков:
 *
 *   1. У КАЖДОЙ кнопки есть доступное имя. Подпись, появляющаяся при
 *      наведении, доступным именем не является: без мыши её нет.
 *   2. Имя называет не только действие, но и над чем оно совершается:
 *      одиннадцать одинаковых «Удалить» подряд диктор читает как одно.
 *   3. Раскрывающаяся подпись помечена aria-hidden — иначе имя читается
 *      дважды («Удалить demo@mail.local Удалить»).
 *   4. Значок для доступности не существует (aria-hidden).
 *   5. Опасное действие отделено от частых промежутком.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RowActions, type RowAction } from '../src/components/RowActions';
import { IconKey, IconPencil, IconSettings, IconTrash } from '../src/components/icons';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const ACTIONS: RowAction[] = [
  { id: 'settings', icon: <IconSettings />, label: 'Настройки', to: '/users/7/settings' },
  { id: 'edit', icon: <IconPencil />, label: 'Изменить', onClick: () => undefined },
  { id: 'password', icon: <IconKey />, label: 'Пароль', onClick: () => undefined },
  { id: 'delete', icon: <IconTrash />, label: 'Удалить', danger: true, onClick: () => undefined },
];

function render(actions: RowAction[] = ACTIONS, subject = 'demo@mail.local'): void {
  act(() => {
    root.render(
      <MemoryRouter>
        <RowActions actions={actions} subject={subject} />
      </MemoryRouter>,
    );
  });
}

/** Все интерактивные элементы полосы — так их видит клавиатура. */
function controls(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('button, a')];
}

describe('доступные имена', () => {
  it('у каждого действия есть имя, и оно называет ящик', () => {
    render();
    const names = controls().map((c) => c.getAttribute('aria-label'));
    expect(names).toEqual([
      'Настройки: demo@mail.local',
      'Изменить: demo@mail.local',
      'Пароль: demo@mail.local',
      'Удалить: demo@mail.local',
    ]);
    // Ни одной кнопки без имени.
    expect(names.every((n) => n !== null && n !== '')).toBe(true);
  });

  it('раскрывающаяся подпись не читается вторым именем', () => {
    render();
    for (const control of controls()) {
      const label = control.querySelector('span:not([class*="icon"])');
      expect(label?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('значок для доступности не существует', () => {
    render();
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
    }
  });

  it('подпись видна в разметке — её раскрывает CSS, а не перерисовка', () => {
    render();
    // Текст лежит в разметке всегда: иначе при наведении происходил бы
    // не ход, а подстановка, и анимировать было бы нечего.
    expect(container.textContent).toContain('Настройки');
    expect(container.textContent).toContain('Удалить');
  });
});

describe('порядок и опасные действия', () => {
  it('опасное действие уходит в конец и отделяется промежутком', () => {
    render([
      { id: 'delete', icon: <IconTrash />, label: 'Удалить', danger: true, onClick: () => undefined },
      { id: 'edit', icon: <IconPencil />, label: 'Изменить', onClick: () => undefined },
    ]);
    const names = controls().map((c) => c.getAttribute('aria-label'));
    expect(names).toEqual(['Изменить: demo@mail.local', 'Удалить: demo@mail.local']);
    // Разделитель ровно один и стоит перед опасным.
    const strip = container.firstElementChild as HTMLElement;
    const kinds = [...strip.children].map((el) => el.tagName.toLowerCase());
    expect(kinds).toEqual(['button', 'span', 'button']);
  });

  it('переход рисуется ссылкой — его можно открыть в новой вкладке', () => {
    render();
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/users/7/settings');
    // И ровно одним элементом: ссылка с кнопкой внутри дала бы две
    // остановки табуляции на одно и то же действие.
    expect(link?.querySelector('button')).toBeNull();
  });
});

describe('ширина полосы', () => {
  it('место под раскрытие зарезервировано по числу кнопок', () => {
    render();
    const strip = container.firstElementChild as HTMLElement;
    // Именно из этого числа CSS считает ширину: без него раскрытие
    // расширяло бы колонку и выталкивало соседей за край таблицы.
    expect(strip.style.getPropertyValue('--mt-row-action-count')).toBe('4');
  });
});
