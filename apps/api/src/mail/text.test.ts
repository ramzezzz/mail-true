/**
 * Преобразование HTML письма в текст — то, из чего собирается сниппет для
 * списка писем и текстовая часть отправляемого письма.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from './text.js';

test('обрезанный HTML не выдаёт CSS за начало письма', () => {
  /*
   * Сниппет для списка качает первые 4 КБ тела (imap/service.ts,
   * fetchSnippet), и блок стилей рассылки в них почти никогда не
   * помещается: закрывающего тега в куске нет. Парная замена его не
   * находила, тег снимался как обычный — и в списке писем, а заодно во
   * всплывающем уведомлении о новой почте, человек читал
   * `body{margin:0;padding:0}…` вместо первых слов письма.
   */
  const cut = '<html><head><style type="text/css">body{margin:0;padding:0}.wrap{width:100%}';
  assert.equal(htmlToText(cut).trim(), '');
});

test('целый документ разбирается как и прежде', () => {
  assert.equal(
    htmlToText('<html><head><style>body{margin:0}</style></head><body><p>Привет</p></body>').trim(),
    'Привет',
  );
});

test('закрытый блок стилей не съедает письмо целиком', () => {
  // Важен порядок замен: если бы незакрытые вырезались первыми без учёта
  // парных, первый же <style> унёс бы с собой весь текст письма.
  assert.equal(
    htmlToText('<style>a{color:red}</style><p>Текст</p><style>b{color:blue}').trim(),
    'Текст',
  );
});

test('переводы строк и сущности сохраняются', () => {
  assert.equal(htmlToText('<p>Первая</p><p>Вторая</p>').trim(), 'Первая\nВторая');
  assert.equal(htmlToText('Пять &lt; шесть &amp; семь').trim(), 'Пять < шесть & семь');
});
