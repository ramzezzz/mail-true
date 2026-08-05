/**
 * Операторы поиска.
 *
 * Раньше вся поисковая строка целиком уходила в IMAP как поиск по тексту.
 * Поэтому `от:волкова` не находило ничего: сервер честно искал письмо, где
 * встречается сама подстрока «от:волкова». То есть попытка уточнить запрос
 * делала поиск хуже, чем его отсутствие: `волкова` находило письмо,
 * `от:волкова` — ноль.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { hasOperators, parseSearch } from './search-query.js';

test('оператор «от» вынимается из строки и не остаётся текстом', () => {
  const q = parseSearch('от:волкова');
  assert.equal(q.from, 'волкова');
  assert.equal(q.text, null, 'иначе сервер искал бы подстроку «от:волкова» в теле');
});

test('латинские названия операторов работают наравне с русскими', () => {
  assert.equal(parseSearch('from:ivanov').from, 'ivanov');
  assert.equal(parseSearch('to:sales').to, 'sales');
  assert.equal(parseSearch('subject:contract').subject, 'contract');
  assert.equal(parseSearch('cc:boss').cc, 'boss');
});

test('операторы и свободные слова уживаются в одной строке', () => {
  const q = parseSearch('от:петрова договор аренды');
  assert.equal(q.from, 'петрова');
  assert.equal(q.text, 'договор аренды');
});

test('кавычки держат несколько слов вместе', () => {
  const q = parseSearch('тема:"годовой отчёт" срочно');
  assert.equal(q.subject, 'годовой отчёт');
  assert.equal(q.text, 'срочно');
});

test('слова-признаки узнаются без двоеточия', () => {
  assert.equal(parseSearch('непрочитанные').seen, false);
  assert.equal(parseSearch('важные').flagged, true);
  assert.equal(parseSearch('unread').seen, false);
  // и не остаются мусором в тексте поиска
  assert.equal(parseSearch('непрочитанные').text, null);
});

test('«есть:вложение» просит отбор по вложениям', () => {
  assert.equal(parseSearch('есть:вложение').hasAttachment, true);
  assert.equal(parseSearch('has:attachment').hasAttachment, true);
  assert.equal(parseSearch('есть:луна').hasAttachment, false, 'неизвестное значение — это просто слова');
});

test('даты разбираются в календарные границы', () => {
  const q = parseSearch('после:2026-01-15 до:2026-08-01');
  assert.equal(q.since?.toISOString(), '2026-01-15T00:00:00.000Z');
  assert.equal(q.before?.toISOString(), '2026-08-01T00:00:00.000Z');
});

test('несуществующая дата не молчит, а остаётся словами поиска', () => {
  // «2026-02-31» при наивном разборе молча переехало бы на 3 марта, и человек
  // искал бы не тот месяц, ничего об этом не зная.
  const q = parseSearch('после:2026-02-31');
  assert.equal(q.since, null);
  assert.equal(q.text, 'после:2026-02-31');
});

test('адрес с двоеточием не ломает разбор', () => {
  // Двоеточие встречается в обычном тексте не реже, чем в операторах:
  // время «14:30» в теме, «Re:» в начале. Объявлять такое ошибкой нельзя.
  const q = parseSearch('встреча 14:30');
  assert.equal(q.text, 'встреча 14:30');
  assert.equal(hasOperators(q), false);
});

test('оператор без значения — это просто слово', () => {
  const q = parseSearch('от:');
  assert.equal(q.from, null);
  assert.equal(q.text, 'от:');
});

test('повторный оператор уточняет, а не заменяет', () => {
  assert.equal(parseSearch('от:иван от:петров').from, 'иван петров');
});

test('пустой запрос ничего не просит', () => {
  const q = parseSearch('   ');
  assert.equal(q.text, null);
  assert.equal(hasOperators(q), false);
});

test('регистр названия оператора не важен', () => {
  assert.equal(parseSearch('От:Волкова').from, 'Волкова');
  assert.equal(parseSearch('FROM:Ivanov').from, 'Ivanov');
});
