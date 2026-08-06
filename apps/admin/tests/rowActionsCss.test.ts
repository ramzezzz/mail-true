/**
 * Правила раскрытия значка в подпись — проверяются по исходному CSS.
 *
 * Так же, как motion.test.ts: vitest считает CSS-модули набором имён
 * классов, вычисленных стилей в нём нет, а вся суть требований заказчика
 * живёт именно в правилах.
 *
 * Каждая проверка закрывает способ сделать «красиво и непригодно»:
 *
 *   1. Раскрытие по наведению — только там, где наведение настоящее.
 *      На касании оно залипает после нажатия, и подпись остаётся висеть
 *      на кнопке, которую человек уже нажал.
 *   2. Раскрытие по :focus-visible. Без него идущий табом видит, что
 *      фокус куда-то встал, но не знает куда: значок без подписи.
 *   3. На касании подписи показаны ВСЕГДА. Значок без подписи и без
 *      наведения не объясним ничем.
 *   4. prefers-reduced-motion убирает ход, но не подпись.
 *   5. Ширина полосы зарезервирована под раскрытие: иначе раскрытие
 *      самой правой кнопки вытолкнуло бы её за край таблицы.
 *   6. Высота строки от раскрытия не меняется.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('../src/components/RowActions.module.css', import.meta.url)),
  'utf8',
);

/** Тело @media-блока целиком (со вложенными правилами). */
function mediaBlock(condition: string): string {
  const at = css.indexOf(`@media ${condition}`);
  if (at < 0) throw new Error(`нет @media ${condition}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`не закрыт @media ${condition}`);
}

describe('раскрытие подписи', () => {
  it('по наведению — только там, где наведение настоящее', () => {
    const hover = mediaBlock('(hover: hover)');
    expect(hover).toMatch(/:hover\s+\.label/);
    // И нигде больше: правило :hover .label вне @media означало бы
    // залипшую подпись на телефоне.
    const outside = css.replace(hover, '');
    expect(outside).not.toMatch(/:hover\s+\.label/);
  });

  it('по фокусу с клавиатуры — везде', () => {
    expect(css).toMatch(/\.action:focus-visible\s+\.label\s*\{/);
    // Раскрытие по фокусу не спрятано внутрь hover-блока: иначе на
    // касании клавиатура осталась бы без подписей.
    const hover = mediaBlock('(hover: hover)');
    expect(hover).not.toMatch(/focus-visible\s+\.label/);
  });

  it('на касании подписи показаны сразу, а не по наведению', () => {
    const touch = mediaBlock('(hover: none)');
    expect(touch).toMatch(/\.label\s*\{[^}]*max-width:\s*none/);
    expect(touch).toMatch(/\.label\s*\{[^}]*opacity:\s*1/);
  });

  it('меньше движения — без хода, но с подписью', () => {
    const reduced = mediaBlock('(prefers-reduced-motion: reduce)');
    expect(reduced).toMatch(/transition:\s*none/);
    // Подпись при этом не спрятана: правил, отменяющих раскрытие, здесь нет.
    expect(reduced).not.toMatch(/max-width:\s*0/);
    expect(reduced).not.toMatch(/display:\s*none/);
  });
});

describe('раскрытие не ломает таблицу', () => {
  it('место под подпись зарезервировано в ширине полосы', () => {
    // Ширина считается из числа кнопок и запаса под раскрытие — значит,
    // раскрытие расходует уже занятое место, а не требует нового.
    expect(css).toMatch(/--mt-row-action-reveal:/);
    expect(css).toMatch(/width:\s*calc\([^)]*--mt-row-action-count/s);
    expect(css).toMatch(/max-width:\s*var\(--mt-row-action-reveal\)/);
  });

  it('высота строки задана и от раскрытия не зависит', () => {
    expect(css).toMatch(/\.actions\s*\{[^}]*height:\s*var\(--mt-row-action-size\)/s);
    // Подпись не переносится: перенос увеличил бы высоту строки.
    expect(css).toMatch(/\.label\s*\{[^}]*white-space:\s*nowrap/s);
  });

  it('ход одинаковой длительности у всего, что двигается', () => {
    const label = css.slice(css.indexOf('.label {'), css.indexOf('}', css.indexOf('.label {')));
    const durations = [...label.matchAll(/var\(--mt-anim-duration-m,\s*([\d.]+)s\)/g)].map(
      (m) => m[1],
    );
    // Три свойства (ширина, отступ, прозрачность) едут одним ходом:
    // разная длительность читается как дёрганье.
    expect(durations).toHaveLength(3);
    expect(new Set(durations).size).toBe(1);
  });
});
