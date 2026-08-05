/**
 * Текст, который обязан помещаться.
 *
 * Оба случая пришли снимками от заказчика, и оба — один и тот же дефект в
 * двух местах: размер элемента задан числом, а текст в него не влезает.
 *
 *   1. Меню учётной записи: «Помощник на основе ИИ — вклю…». Название
 *      действия объясняет, ЧТО произойдёт при нажатии; обрезанное, оно
 *      этого не объясняет — включить или уже включён?
 *   2. Диалог фильтра: «больше чем» упиралось в стрелку списка, а
 *      «Оставить во «Входящих»» обрезалось на «Входящ».
 *
 * Подобрать одно число под все подписи нельзя: они разной длины, а после
 * добавления условия или перевода любое подобранное снова окажется мало.
 * Поэтому проверяются не пиксели, а ПРАВИЛА: ширина от содержимого,
 * перенос вместо обрезки, место под стрелку.
 *
 * На старом коде падают обе проверки: там стояли `white-space: nowrap`
 * с жёсткой высотой и `flex: 0 0 130px` / `0 0 200px`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function css(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
}

/** Тело правила по его селектору. */
function rule(text: string, selector: string): string {
  const at = text.indexOf(selector);
  expect(at, `в стилях нет правила ${selector}`).toBeGreaterThanOrEqual(0);
  const open = text.indexOf('{', at);
  const close = text.indexOf('}', open);
  return text.slice(open + 1, close);
}

describe('пункт меню не обрезает название действия', () => {
  const item = rule(css('components/Dropdown/Dropdown.module.css'), '.item {');

  it('текст переносится, а не режется многоточием', () => {
    expect(item).not.toMatch(/white-space:\s*nowrap/);
  });

  it('высота нижняя, а не жёсткая: две строки должны помещаться', () => {
    expect(item).toMatch(/min-height:/);
    expect(item, 'жёсткая высота обрезала бы вторую строку').not.toMatch(/^\s*height:\s*\d/m);
  });
});

describe('диалог фильтра: ширина полей от содержимого', () => {
  const dialog = css('settings/FilterDialog.module.css');

  it('списки условия и оператора не прибиты числом', () => {
    const body = rule(dialog, '.conditionField,');
    expect(body).toMatch(/flex:\s*0\s+1\s+auto/);
    expect(body, 'фиксированная доля снова обрежет длинный вариант').not.toMatch(/flex:\s*0\s+0\s+\d+px/);
  });

  it('сам список меряется по самому длинному варианту', () => {
    expect(dialog).toMatch(/\.conditionField select[\s\S]*?width:\s*auto/);
  });

  it('строка переносится, когда три поля в ряд не помещаются', () => {
    expect(rule(dialog, '.condition {')).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe('у стрелки списка есть своё место', () => {
  it('поле выбора оставляет отступ справа под стрелку', () => {
    const body = rule(css('components/Field/Field.module.css'), '.select {');
    const padding = /padding-right:\s*(\d+)px/.exec(body)?.[1];
    expect(padding, 'без отступа стрелка ложится на последние буквы').toBeDefined();
    expect(Number(padding)).toBeGreaterThanOrEqual(24);
  });
});
