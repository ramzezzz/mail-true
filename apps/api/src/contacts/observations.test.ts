/**
 * Что вынимается из письма в указатель переписки.
 *
 * Правила отбора проверяются в обе стороны: не только «отправитель
 * входящего письма попадает в указатель», но и «остальные получатели
 * входящего — не попадают». Проверка в одну сторону пропустила бы
 * реализацию, кладущую в указатель все адреса подряд, — а это и есть тот
 * случай, когда подсказка отправляет письмо не туда.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { foldObservations, messageDate, observationsFromEnvelope } from './observations.js';

const NOW = new Date('2026-08-06T12:00:00.000Z');
const OWN = new Set(['test@mail.local']);

test('из полученного письма берётся отправитель', () => {
  const result = observationsFromEnvelope(
    {
      from: [{ name: 'Иван Петров', address: 'Ivan.Petrov@Example.com' }],
      to: [{ address: 'test@mail.local' }],
      date: new Date('2026-08-01T10:00:00.000Z'),
    },
    'inbox',
    OWN,
    NOW,
  );
  assert.deepEqual(result, [
    {
      address: 'ivan.petrov@example.com',
      name: 'Иван Петров',
      direction: 'received',
      at: new Date('2026-08-01T10:00:00.000Z'),
    },
  ]);
});

test('прочие получатели входящего письма в указатель не попадают', () => {
  // Там сидят адреса рассылок и все прочие подписчики, с которыми человек
  // не переписывался ни разу.
  const result = observationsFromEnvelope(
    {
      from: [{ address: 'list@example.com' }],
      to: [{ address: 'test@mail.local' }, { address: 'stranger@example.com' }],
      cc: [{ address: 'another@example.com' }],
      date: NOW,
    },
    'inbox',
    OWN,
    NOW,
  );
  assert.deepEqual(
    result.map((r) => r.address),
    ['list@example.com'],
  );
});

test('из отправленного письма берутся все получатели, включая скрытых', () => {
  const result = observationsFromEnvelope(
    {
      from: [{ address: 'test@mail.local' }],
      to: [{ name: 'Анна', address: 'anna@example.com' }],
      cc: [{ address: 'boss@example.com' }],
      bcc: [{ address: 'copy@example.com' }],
      date: NOW,
    },
    'sent',
    OWN,
    NOW,
  );
  assert.deepEqual(
    result.map((r) => r.address),
    ['anna@example.com', 'boss@example.com', 'copy@example.com'],
  );
  assert.ok(result.every((r) => r.direction === 'sent'));
});

test('свой адрес в указатель не идёт', () => {
  const result = observationsFromEnvelope(
    { to: [{ address: 'TEST@mail.local' }, { address: 'anna@example.com' }], date: NOW },
    'sent',
    OWN,
    NOW,
  );
  assert.deepEqual(
    result.map((r) => r.address),
    ['anna@example.com'],
  );
});

test('один адрес в «Кому» и «Копии» считается один раз', () => {
  const result = observationsFromEnvelope(
    { to: [{ address: 'anna@example.com' }], cc: [{ address: 'Anna@Example.com' }], date: NOW },
    'sent',
    OWN,
    NOW,
  );
  assert.equal(result.length, 1);
});

test('негодные адреса отбрасываются, годные остаются', () => {
  const result = observationsFromEnvelope(
    {
      to: [{ address: 'мусор' }, { address: '' }, { address: 'anna@example.com' }],
      date: NOW,
    },
    'sent',
    OWN,
    NOW,
  );
  assert.deepEqual(
    result.map((r) => r.address),
    ['anna@example.com'],
  );
});

test('дата из будущего заменяется временем разбора', () => {
  const far = new Date('2037-01-01T00:00:00.000Z');
  assert.equal(messageDate(far, NOW).getTime(), NOW.getTime());
  assert.equal(messageDate('не дата', NOW).getTime(), NOW.getTime());
  assert.equal(messageDate(null, NOW).getTime(), NOW.getTime());
  // Обратный ход: обычная дата остаётся собой
  const normal = new Date('2026-07-01T00:00:00.000Z');
  assert.equal(messageDate(normal, NOW).getTime(), normal.getTime());
});

test('свёртка складывает счётчики и не теряет направление', () => {
  const folded = foldObservations([
    { address: 'a@example.com', name: null, direction: 'sent', at: new Date('2026-01-01') },
    { address: 'a@example.com', name: null, direction: 'sent', at: new Date('2026-02-01') },
    { address: 'a@example.com', name: null, direction: 'received', at: new Date('2026-03-01') },
    { address: 'b@example.com', name: null, direction: 'received', at: new Date('2026-01-05') },
  ]);
  const a = folded.find((f) => f.address === 'a@example.com');
  assert.equal(a?.sentDelta, 2);
  assert.equal(a?.recvDelta, 1);
  assert.equal(a?.lastSeenAt.toISOString(), new Date('2026-03-01').toISOString());
  assert.equal(folded.length, 2);
});

test('имя берётся из самого свежего письма', () => {
  const folded = foldObservations([
    { address: 'a@example.com', name: 'Анна Иванова', direction: 'received', at: new Date('2026-01-01') },
    { address: 'a@example.com', name: 'Анна Петрова', direction: 'received', at: new Date('2026-05-01') },
  ]);
  assert.equal(folded[0]?.name, 'Анна Петрова');
});

test('письмо без имени не затирает уже известное имя', () => {
  // Рассылки часто приходят вовсе без имени; терять из-за них человеческое
  // имя в подсказке нельзя.
  const folded = foldObservations([
    { address: 'a@example.com', name: 'Анна', direction: 'received', at: new Date('2026-01-01') },
    { address: 'a@example.com', name: null, direction: 'received', at: new Date('2026-05-01') },
  ]);
  assert.equal(folded[0]?.name, 'Анна');
});

test('пустой список сворачивается в пустой', () => {
  assert.deepEqual(foldObservations([]), []);
});
