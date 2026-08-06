/**
 * Приведение адресов и строка поиска.
 *
 * Каждое правило проверяется в обе стороны. Проверка «Иван находится по
 * запросу „ив“» сама по себе бесполезна: функция, которая отвечает
 * «совпало» всегда, прошла бы её и весь файл наполовину, а подсказка
 * предлагала бы весь указатель на любую букву.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contactTokens,
  escapeLike,
  normalizeAddress,
  normalizeName,
  normalizeQuery,
  tokensMatch,
} from './tokens.js';

test('адрес приводится к нижнему регистру и теряет угловые скобки', () => {
  assert.equal(normalizeAddress('<Ivan.Petrov@Example.COM>'), 'ivan.petrov@example.com');
  assert.equal(normalizeAddress('  ivan@example.com  '), 'ivan@example.com');
});

test('не адрес — не адрес', () => {
  // Обратный ход: всё перечисленное раньше попало бы в подсказку мусором.
  for (const bad of [
    '',
    null,
    undefined,
    'ivan',
    '@example.com',
    'ivan@',
    'ivan@@example.com',
    'ivan@example',
    'ivan@.com',
    'ivan@example.com.',
    'Иван <ivan@example.com>',
    'ivan example@mail.ru',
  ]) {
    assert.equal(normalizeAddress(bad), null, `должно быть отброшено: ${String(bad)}`);
  }
  // И прямой ход: обычный адрес проходит.
  assert.equal(normalizeAddress('a.b-c_d@sub.example.co.uk'), 'a.b-c_d@sub.example.co.uk');
});

test('слишком длинный адрес отбрасывается', () => {
  const long = `${'a'.repeat(320)}@example.com`;
  assert.equal(normalizeAddress(long), null);
});

test('имя очищается, но не выдумывается', () => {
  assert.equal(normalizeName('  Иван   Петров '), 'Иван Петров');
  assert.equal(normalizeName('"Петров, Иван"'), 'Петров, Иван');
  assert.equal(normalizeName(''), null);
  assert.equal(normalizeName(null), null);
  // Имя, равное адресу, — это не имя, а повтор
  assert.equal(normalizeName('IVAN@example.com', 'ivan@example.com'), null);
  // …а непохожее имя остаётся
  assert.equal(normalizeName('Иван', 'ivan@example.com'), 'Иван');
});

test('перевод строки внутри имени не разрывает строку поиска', () => {
  const name = normalizeName('Иван\r\nПетров');
  assert.equal(name, 'Иван Петров');
  assert.ok(!contactTokens(name, 'ivan@example.com').includes('\n'));
});

test('строка поиска содержит слова имени, адрес и его части', () => {
  const tokens = contactTokens('Иван Петров', 'ivan.petrov@mail.example.com');
  for (const expected of [
    'ivan.petrov@mail.example.com',
    'ivan.petrov',
    'mail.example.com',
    'ivan',
    'petrov',
    'mail',
    'иван',
    'петров',
  ]) {
    assert.ok(tokens.split(' ').includes(expected), `нет слова «${expected}» в «${tokens}»`);
  }
});

test('слова не повторяются', () => {
  const tokens = contactTokens('ivan', 'ivan@example.com').split(' ');
  assert.equal(tokens.filter((t) => t === 'ivan').length, 1);
});

test('человек находится и по имени, и по фамилии, и по адресу', () => {
  const tokens = contactTokens('Иван Петров', 'ivan.petrov@example.com');
  for (const query of ['иван', 'петр', 'петров', 'iva', 'ivan.p', 'example', 'ИВАН']) {
    assert.ok(tokensMatch(tokens, query), `«${query}» должно находить`);
  }
});

test('поиск идёт по началу слова, а не по любой подстроке', () => {
  const tokens = contactTokens('Иван Петров', 'ivan.petrov@example.com');
  // Обратный ход: середина слова не совпадает. Иначе выдача превращалась
  // бы в кашу, в которой нужного человека не видно.
  for (const query of ['етров', 'ван', 'xample', 'zzz']) {
    assert.ok(!tokensMatch(tokens, query), `«${query}» находить не должно`);
  }
  assert.ok(!tokensMatch(tokens, ''), 'пустой запрос не находит ничего');
});

test('запрос приводится к тому же виду, что и строка поиска', () => {
  assert.equal(normalizeQuery('  ИвАн   Петров '), 'иван петров');
  assert.equal(normalizeQuery(''), '');
});

test('спецсимволы LIKE экранируются', () => {
  assert.equal(escapeLike('no_reply'), 'no\\_reply');
  assert.equal(escapeLike('100%'), '100\\%');
  assert.equal(escapeLike('a\\b'), 'a\\\\b');
  // Обратный ход: обычный адрес не портится
  assert.equal(escapeLike('ivan.petrov@example.com'), 'ivan.petrov@example.com');
});
