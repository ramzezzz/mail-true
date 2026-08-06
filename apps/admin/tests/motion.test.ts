/**
 * Движение в админке.
 *
 * Проверяется исходный CSS, а не отрисовка: vitest здесь работает в node,
 * стили CSS-модулей он не считает, а именно в правилах и живёт жалоба
 * заказчика — «нет анимации появления/пропадания и переключения меню».
 *
 * Каждая проверка ниже падала на прежнем коде: до этой работы в админке
 * не было ни одного @keyframes, ни одного transition и ни одного правила
 * prefers-reduced-motion.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8');

/** Тело правила по его селектору — вложенных фигурных скобок в правилах нет. */
function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(selector);
  if (at < 0) throw new Error(`нет правила ${selector}`);
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

/** Все файлы админки, где вообще может завестись движение. */
const MOTION_FILES = [
  'styles/admin.css',
  'app/AdminLayout.module.css',
  'components/ui.module.css',
  'components/Table.module.css',
];

describe('движение уважает prefers-reduced-motion', () => {
  const admin = read('styles/admin.css');

  it('выключатель гасит все переходы и анимации разом, а не по одному', () => {
    expect(admin).toContain('@media (prefers-reduced-motion: reduce)');
    const block = admin.slice(admin.indexOf('@media (prefers-reduced-motion: reduce)'));
    // Селектор общий, иначе за каждой новой анимацией пришлось бы следить руками
    expect(block).toContain('*:not([data-motion=');
    expect(block).toMatch(/animation-duration:\s*\S+\s*!important/);
    expect(block).toMatch(/transition-duration:\s*\S+\s*!important/);
    // Без этого бесконечная анимация крутилась бы вхолостую по кругу за 1мс
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });

  it('крутилка загрузки выведена из-под выключателя: остановленная, она врёт', () => {
    // Спиннер админка берёт из почты — там у него стоит метка-исключение
    const spinner = readFileSync(
      fileURLToPath(new URL('../../web/src/components/Spinner/Spinner.tsx', import.meta.url)),
      'utf8',
    );
    expect(spinner).toContain('data-motion="keep"');
    expect(read('styles/admin.css')).toContain("[data-motion='keep']");
  });
});

describe('диалог приезжает и уезжает', () => {
  const ui = read('components/ui.module.css');

  it('у затемнения и карточки есть ход появления', () => {
    expect(ui).toContain('@keyframes adminOverlayShow');
    expect(ui).toContain('@keyframes adminModalShow');
    expect(ruleBody(ui, '.backdrop {')).toContain('animation: adminOverlayShow');
    expect(ruleBody(ui, '.modal {')).toContain('animation: adminModalShow');
  });

  it('уход описан обратным ходом, а не забыт', () => {
    // Уход забывают чаще всего: элемент просто пропадает, и это читается как сбой
    expect(ruleBody(ui, '.backdropClosing {')).toContain('reverse');
    expect(ruleBody(ui, '.modalClosing {')).toContain('reverse');
    // forwards: без него на последнем кадре диалог мигнул бы обратно
    expect(ruleBody(ui, '.backdropClosing {')).toContain('forwards');
    expect(ruleBody(ui, '.modalClosing {')).toContain('forwards');
    // Уезжающая копия не должна ловить щелчки
    expect(ruleBody(ui, '.backdropClosing {')).toContain('pointer-events: none');
  });

  it('уход в коде длится ровно столько же, сколько в стилях', () => {
    const tsx = read('components/ui.tsx');
    expect(tsx).toMatch(/MODAL_EXIT_MS\s*=\s*200/);
    // 200мс — это --mt-anim-duration-m, на него и сослан обратный ход
    expect(ruleBody(ui, '.modalClosing {')).toContain('--mt-anim-duration-m');
  });
});

describe('выделение в меню переезжает, а не мигает', () => {
  const layout = read('app/AdminLayout.module.css');

  it('подложка выделения одна на всё меню и ездит переходом transform', () => {
    const pointer = ruleBody(layout, '.navPointer {');
    expect(pointer).toContain('position: absolute');
    expect(pointer).toMatch(/transition:[\s\S]*transform var\(--mt-anim-duration-m/);
    // Пункты меню разной ширины и высоты — размер подложки тоже едет
    expect(pointer).toMatch(/width var\(--mt-anim-duration-m/);
    expect(pointer).toMatch(/height var\(--mt-anim-duration-m/);
  });

  it('активный пункт своей подложки не рисует — иначе она мигала бы поверх едущей', () => {
    expect(ruleBody(layout, '.navLinkActive {')).not.toContain('background');
  });

  it('наведение на активный пункт не закрывает переехавшую подложку', () => {
    expect(layout).toContain('.navLink:hover:not(.navLinkActive)');
  });
});

describe('движение по месту: наведение и нажатие', () => {
  it('строка таблицы подсвечивается переходом, а не щелчком', () => {
    const table = read('components/Table.module.css');
    expect(ruleBody(table, '.table td {')).toMatch(
      /transition:\s*background-color var\(--mt-anim-duration-s/,
    );
  });

  it('таблица проявляется, когда данные пришли', () => {
    const table = read('components/Table.module.css');
    expect(table).toContain('@keyframes adminRowsShow');
    expect(ruleBody(table, '.wrap {')).toContain('animation: adminRowsShow');
  });

  it('сообщение о результате приезжает, а не возникает из ниоткуда', () => {
    const ui = read('components/ui.module.css');
    expect(ui).toContain('@keyframes adminNoticeShow');
    expect(ruleBody(ui, '.notice {')).toContain('animation: adminNoticeShow');
  });

  it('у логотипа и плитки есть отклик на наведение', () => {
    expect(ruleBody(read('app/AdminLayout.module.css'), '.brand {')).toMatch(
      /transition:\s*opacity var\(--mt-anim-duration-s/,
    );
    expect(ruleBody(read('components/ui.module.css'), '.tile {')).toMatch(
      /transition:\s*border-color var\(--mt-anim-duration-s/,
    );
  });
});

describe('длительности не задерживают работу', () => {
  /** Все объявления движения по всем файлам админки. */
  const motionRules = (): string[] =>
    MOTION_FILES.flatMap((file) =>
      [...read(file).matchAll(/(?:transition|animation):[^;]+;/g)].map(
        ([rule]) => `${file}: ${rule}`,
      ),
    );

  it('нигде не заведено движения длиннее 0.4s', () => {
    // Сначала убеждаемся, что мерить вообще есть что: на прежнем коде
    // движения не было ни одного, и потолок соблюдался сам собой
    expect(motionRules().length).toBeGreaterThan(5);

    for (const file of MOTION_FILES) {
      for (const [, seconds] of read(file).matchAll(/(\d+(?:\.\d+)?)s\b/g)) {
        expect(Number(seconds), `${file}: ${seconds}s`).toBeLessThanOrEqual(0.4);
      }
    }
  });

  it('движение опирается на общие токены длительности, а не на свои числа', () => {
    // Своё «0.25s» рядом с чужим «0.2s» — это уже две разные скорости в одном окне
    const rules = motionRules();
    expect(rules.length).toBeGreaterThan(5);
    for (const rule of rules) {
      expect(rule).toContain('--mt-anim-duration-');
    }
  });
});
