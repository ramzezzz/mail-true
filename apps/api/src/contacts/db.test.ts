/**
 * Проверки указателя переписки, которые можно сделать без живой базы.
 *
 * Здесь не «SQL написан правильно» (это проверяется стендом, см.
 * admin/db.integration.test.ts), а то, что решают ЗНАЧЕНИЯ, уходящие в
 * запрос. Одно такое значение стоило человеку найденного контакта:
 * скрытие ещё не собранного адреса помечало строку моментом скрытия, и
 * сборщик после этого не мог проставить ей имя никогда.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HIDDEN_PLACEHOLDER_SEEN_AT, setHiddenStatement } from './db.js';

test('скрытие ещё не собранного адреса не выдаёт себя за самое свежее письмо', () => {
  const statement = setHiddenStatement('me@mail.local', 'ivan@example.com', true);

  const seen = statement.values.find((value): value is Date => value instanceof Date);
  assert.ok(
    seen,
    'давность строки обязана быть значением запроса: с now() внутри SQL она всегда «сегодня»',
  );

  /*
   * Главное условие. `upsert` обновляет имя и строку поиска только тогда,
   * когда письмо НЕ СТАРШЕ уже учтённого:
   *
   *   WHEN EXCLUDED.last_seen_at >= mail_contacts.last_seen_at
   *
   * Значит, строка-заглушка обязана быть старше любого письма, какое
   * сборщик может встретить, — иначе имя в неё не попадёт никогда, и
   * возвращённый из скрытых контакт будет находиться по адресу, но не по
   * фамилии.
   */
  const oldestLetterEver = new Date('1971-01-01T00:00:00Z');
  assert.ok(
    seen.getTime() < oldestLetterEver.getTime(),
    `заглушка (${seen.toISOString()}) обязана быть старше любого письма`,
  );
  assert.equal(seen.getTime(), HIDDEN_PLACEHOLDER_SEEN_AT.getTime());

  // Обратный ход: остальное в строке — то же, что было. Имени мы не знаем
  // (письма ещё не разобраны), а по адресу такой контакт искаться обязан.
  assert.ok(statement.values.includes('ivan@example.com'));
  assert.ok(
    statement.values.some(
      (value) => typeof value === 'string' && value.includes('ivan@example.com'),
    ),
    'строка поиска собирается хотя бы из адреса',
  );
  assert.ok(statement.text.includes('ON CONFLICT'), 'уже собранный адрес просто помечается');
});
