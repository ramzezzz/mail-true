/**
 * Раскладка разделов «Почтовый поток» и «Журналы почты» на узком экране.
 *
 * Проверяется не «красиво ли», а два правила, на которых раскладка ломалась
 * у заказчика:
 *
 *   1. Ширина поля отбора считается ОТ СОДЕРЖИМОГО. Общая ширина числом на
 *      все списки сразу не годится: у списка направления самый длинный
 *      вариант, и он не помещался.
 *   2. У стрелки списка есть своё место справа. Стрелку рисует браузер
 *      ВНУТРИ поля, и без отступа она ложится поверх последних букв —
 *      «Входящие и исходящщ▾».
 *
 * На старом коде падают обе: ширины стояли инлайновыми числами
 * (style={{ width: 160 }}), отступа под стрелку не было вовсе.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PAGES = ['FlowPage', 'LogsPage'] as const;

function css(page: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/pages/${page}.module.css`, import.meta.url)),
    'utf8',
  );
}

function tsx(page: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/pages/${page}.tsx`, import.meta.url)), 'utf8');
}

/** Тело правила по его селектору. */
function rule(text: string, selector: string): string {
  const at = text.indexOf(selector);
  expect(at, `в стилях нет правила ${selector}`).toBeGreaterThanOrEqual(0);
  const open = text.indexOf('{', at);
  const close = text.indexOf('}', open);
  return text.slice(open + 1, close);
}

describe.each(PAGES)('%s: поля отбора', (page) => {
  it('ширина списка считается от самого длинного варианта', () => {
    // width: auto — это и есть «по содержимому»: браузер меряет варианты сам.
    expect(rule(css(page), 'select.control')).toMatch(/width:\s*auto/);
  });

  it('у стрелки списка своё место — она не ложится на текст', () => {
    const body = rule(css(page), 'select.control');
    const padding = /padding-right:\s*(\d+)px/.exec(body)?.[1];
    expect(padding, 'у списка не задан отступ справа под стрелку').toBeDefined();
    expect(Number(padding)).toBeGreaterThanOrEqual(24);
  });

  it('на узком экране поле занимает свою строку целиком', () => {
    // Три списка в ряд при 390 точках тесно в любом случае.
    const text = css(page);
    const at = text.indexOf('@media (max-width: 600px)');
    expect(at, 'нет правила для узкого экрана').toBeGreaterThanOrEqual(0);
    const block = text.slice(at, text.indexOf('}\n}', at));
    expect(block).toMatch(/select\.control/);
    expect(block).toMatch(/width:\s*100%/);
  });

  it('инлайновых ширин у полей отбора не осталось', () => {
    // Именно они и были причиной: число в разметке не знает, что внутри
    // списка, и не меняется вместе с текстом вариантов.
    const markup = tsx(page);
    const inline = markup.match(/style=\{\{\s*width:\s*\d+\s*\}\}/g) ?? [];
    expect(inline, `в разметке остались фиксированные ширины: ${inline.join(', ')}`).toEqual([]);
  });
});

describe('таблицы на узком экране убирают колонки, а не режут их', () => {
  it('«Почтовый поток» размечает необязательные колонки так же, как список ящиков', () => {
    // Приём общий с UsersPage: optional уходит на планшете, optionalNarrow —
    // на телефоне. Заново придумывать раскладку для этой таблицы незачем.
    const markup = tsx('FlowPage');
    expect(markup).toMatch(/tableStyles\.optional\b/);
    expect(markup).toMatch(/tableStyles\.optionalNarrow\b/);
  });

  it('адресат и причина остаются при любой ширине', () => {
    // Ради них таблицу и открывают: кому не дошло и почему.
    const markup = tsx('FlowPage');
    const recipientHeader = /<th>Адресаты<\/th>/.test(markup);
    const oneRecipient = /<th>Адресат<\/th>/.test(markup);
    expect(recipientHeader && oneRecipient, 'колонка адресата помечена как необязательная').toBe(
      true,
    );
    expect(markup).toMatch(/<th>Последняя причина отсрочки<\/th>/);
    expect(markup).toMatch(/<th>Ответ принимающей стороны<\/th>/);
  });
});

describe('FlowPage: счётчик новых записей', () => {
  it('не занимает места в потоке — таблица под ним не сдвигается', () => {
    // Появившись, счётчик иначе уводит вниз ту самую строку, которую в этот
    // момент читают, — ровно у того человека, ради которого он показан.
    const body = rule(css('FlowPage'), '.unread');
    expect(body).toMatch(/height:\s*0/);
    expect(body).toMatch(/position:\s*sticky/);
  });

  it('счётчик не перехватывает нажатия мимо самой кнопки', () => {
    expect(rule(css('FlowPage'), '.unread')).toMatch(/pointer-events:\s*none/);
  });
});
