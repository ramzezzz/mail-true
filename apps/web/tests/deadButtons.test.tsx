// @vitest-environment jsdom
/**
 * Кнопок, которые молча ничего не делают, в интерфейсе быть не должно.
 *
 * Человек нажимает — и не понимает, сломалось ли: это хуже, чем если бы
 * кнопки не было вовсе. Найденные пустышки были двух видов:
 *
 *   1. Обработчика нет совсем — «Открытку», «Опрос», «Видеовстречу»
 *      в меню рядом с «Написать письмо» и «Подробнее» в плашке надёжного
 *      отправителя. Первых трёх продуктов у нас нет и не будет, поэтому
 *      меню убрано целиком; «Подробнее» теперь раскрывает подлинность
 *      отправителя, на которой плашка и держится.
 *   2. Обработчик пишет в консоль браузера — «Уведомить о прочтении»,
 *      «Отложенная отправка», «Переслать как вложение». Все три сделаны
 *      по-настоящему (см. соседние проверки).
 *
 * Этот файл сторожит оба вида разом.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../src/layout/Sidebar';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

function tsxFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, found);
    else if (entry.name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

/**
 * Открывающий тег целиком, от `<` до его собственного `>`.
 *
 * Простым `[^>]*>` тут не обойтись: внутри выражений в фигурных скобках
 * встречается `>` как оператор сравнения (`total > 0` в подписи кнопки),
 * и тег обрывался бы на нём — проверка ругалась бы на исправную кнопку.
 */
function openingTag(source: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = source.indexOf(' ', start); i < source.length && i > 0; i += 1) {
    const ch = source[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

describe('кнопок-пустышек нет в разметке', () => {
  it.each([['Открытку'], ['Опрос'], ['Видеовстречу']])(
    'пункта «%s» больше нет: такого продукта у нас нет и не будет',
    (label) => {
      const guilty = tsxFiles(SRC)
        .filter((file) => readFileSync(file, 'utf8').includes(`>${label}<`))
        .map((file) => relative(SRC, file));
      expect(guilty).toEqual([]);
    },
  );

  /**
   * Обработчик, который только пишет в консоль, — та же пустышка: человеку
   * консоль не видна, и для него кнопка не делает ничего.
   *
   * Проверяется любая стрелка, сводящаяся к записи в консоль, а не только
   * `onClick`: три из четырёх найденных пустышек передавались вниз
   * свойством (`onForwardAsAttachment={() => console.info(…)}`), и правило
   * по одному `onClick` их не поймало бы.
   */
  it('ни один обработчик не сводится к записи в консоль', () => {
    const guilty = tsxFiles(SRC)
      .filter((file) => /=>\s*console\./.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(guilty).toEqual([]);
  });

  /**
   * Нажатие должно куда-то вести. Проверяется весь набор разметки: кнопка
   * без обработчика — это либо пустышка, либо триггер меню, а меню
   * открывают тем же `onClick`.
   */
  it('у каждой кнопки есть обработчик', () => {
    const guilty: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/<button(?=[\s/>])/g)) {
        const tag = openingTag(source, match.index);
        if (tag === null) continue;
        if (/onClick|onMouseDown|onPointerDown|type="submit"|\{\.\.\./.test(tag)) continue;
        const line = source.slice(0, match.index).split('\n').length;
        guilty.push(`${relative(SRC, file)}:${String(line)}`);
      }
    }
    expect(guilty).toEqual([]);
  });
});

describe('колонка папок', () => {
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

  it('«Написать письмо» на месте, а стрелки с пустым меню больше нет', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Sidebar />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const labels = [...host.querySelectorAll('button')].map(
      (b) => `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`,
    );
    expect(labels.some((t) => t.includes('Написать письмо'))).toBe(true);
    expect(labels.some((t) => t.includes('Ещё варианты письма'))).toBe(false);
  });
});
