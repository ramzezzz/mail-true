/**
 * Остановка переноса человеком.
 *
 * Перенос идёт часами, и решение «хватит» принимается по ходу: не тот
 * ящик, не тот сервер, началось рабочее время и чужой сервер надо оставить
 * в покое. Убить процесс — не выход: задание должно закончиться ОТЧЁТОМ
 * о том, что успело переехать, иначе непонятно, с чего продолжать.
 *
 * Ключевое требование: остановка — это НЕ ошибка. Отчёт со статусом failed
 * заставил бы разбираться, что сломалось, хотя ничего не ломалось.
 *
 * На старом коде падают все проверки: поля signal не существовало,
 * а статуса 'stopped' не было в наборе значений.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateMailbox } from '../migrator.js';
import { migrateBatch } from '../batch.js';

/** Заведомо недоступные концы: если к ним пойдут, это будет видно по тексту. */
const nowhere = { host: '127.0.0.1', port: 1, user: 'kto@example.org', pass: 'x' };

test('остановленное до начала задание не ходит к чужому серверу', async () => {
  // Лишний вход в чужую почту — это след в ЕГО журналах и в его системе
  // обнаружения вторжений, взятый ни за чем.
  const control = new AbortController();
  control.abort();

  const report = await migrateMailbox({ source: nowhere, dest: nowhere, signal: control.signal });

  assert.equal(report.status, 'stopped');
  assert.doesNotMatch(
    report.error ?? '',
    /Не удалось подключиться/,
    'к серверу всё-таки пошли: остановка проверяется слишком поздно',
  );
  assert.match(report.error ?? '', /остановлен/i);
  assert.deepEqual(report.folders, [], 'папок не трогали — их и не должно быть в отчёте');
});

test('остановка не выдаётся за ошибку и не выдаётся за успех', async () => {
  const control = new AbortController();
  control.abort();
  const report = await migrateMailbox({ source: nowhere, dest: nowhere, signal: control.signal });

  assert.notEqual(report.status, 'failed', 'остановку нельзя показывать как поломку');
  assert.notEqual(report.status, 'ok', 'остановку нельзя показывать как успешный перенос');
  // Обратный ход: без сигнала тот же вызов обязан дать именно failed —
  // значит, статус берётся из остановки, а не «всегда stopped».
  const without = await migrateMailbox({ source: nowhere, dest: nowhere });
  assert.equal(without.status, 'failed');
  assert.match(without.error ?? '', /Не удалось подключиться/);
});

test('пакет: до ящиков, стоявших в очереди, не доходят вовсе', async () => {
  const control = new AbortController();
  control.abort();
  const accounts = [
    { source: nowhere, dest: nowhere },
    { source: nowhere, dest: nowhere },
    { source: nowhere, dest: nowhere },
  ];

  const report = await migrateBatch({ accounts, concurrency: 1, migrate: { signal: control.signal } });

  assert.deepEqual(report.accounts, [], 'ящик без отчёта читается как сломанный, а он не начинался');
  assert.equal(report.failed, 0, 'нетронутые ящики не должны считаться неудавшимися');
  assert.equal(report.ok, 0);
  assert.equal(report.stopped, 0);
});

test('пакет без остановки те же ящики всё-таки пробует', async () => {
  // Обратный ход к предыдущей проверке: пустой отчёт получается ИЗ-ЗА
  // остановки, а не потому, что пакетный перенос вообще ничего не делает.
  const accounts = [{ source: nowhere, dest: nowhere }];
  const report = await migrateBatch({ accounts, concurrency: 1 });
  assert.equal(report.accounts.length, 1);
  assert.equal(report.failed, 1);
});
