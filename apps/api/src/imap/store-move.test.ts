/**
 * Отказ IMAP-команды не должен выдаваться за успех.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * imapflow на неудачную команду STORE, MOVE или EXPUNGE исключение НЕ
 * бросает: он пишет ошибку в собственный журнал (а он у нас выключен —
 * `logger: false`) и возвращает `false`. Для сравнения, APPEND в том же
 * пакете заканчивается `throw err`, и на это в продукте уже полагаются.
 *
 * Разницу не учли нигде, кроме поиска. Маршруты массовых действий писали
 * «изменено N» и «перенесено N» сразу после вызова, по длине присланного
 * списка. Что из этого выходило:
 *
 *   - «Удалить» на письмах при переполненном ящике: Dovecot отвечает
 *     `NO [OVERQUOTA]`, API отвечает 200 и «перенесено 25», браузер
 *     убирает строки из списка — письма остаются на месте;
 *   - заглушение переписки: `\Seen` уже проставлен, MOVE отказал, письма
 *     остались во «Входящих», но прочитанными — то есть исчезли и из
 *     счётчика непрочитанных, и из внимания человека;
 *   - удаление метки «снять с писем»: ключевое слово оставалось на
 *     письмах навсегда, а метку из справочника стирали физически.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import { countUids, moveUids, storeFlags } from './service.js';

interface Call {
  range: string;
  flags?: string[];
}

/** Клиент, который отвечает на команды так же, как imapflow: возвратом. */
class FakeClient {
  readonly stores: Call[] = [];
  readonly moves: Call[] = [];
  constructor(private readonly answer: boolean | { uidMap?: Map<number, number> } = true) {}

  async messageFlagsAdd(range: string, flags: string[]): Promise<boolean> {
    this.stores.push({ range, flags });
    return this.answer === false ? false : true;
  }

  async messageFlagsRemove(range: string, flags: string[]): Promise<boolean> {
    this.stores.push({ range, flags });
    return this.answer === false ? false : true;
  }

  async messageMove(
    range: string,
    _path: string,
  ): Promise<boolean | { uidMap?: Map<number, number> }> {
    this.moves.push({ range });
    return this.answer;
  }
}

function asClient(fake: FakeClient): ImapFlow {
  return fake as unknown as ImapFlow;
}

test('отказ STORE становится видимой ошибкой, а не тихим успехом', async () => {
  const fake = new FakeClient(false);
  await assert.rejects(() => storeFlags(asClient(fake), [1, 2, 3], ['\\Seen'], 'add'), /пометки/i);
});

test('удачный STORE проходит молча и получает наш набор номеров', async () => {
  const fake = new FakeClient(true);
  await storeFlags(asClient(fake), [3, 1, 2], ['mt-1'], 'remove');
  assert.deepEqual(fake.stores, [{ range: '1:3', flags: ['mt-1'] }]);
});

test('длинный список режется на команды: Dovecot отвергает слишком длинный аргумент', async () => {
  // Номера через один — свернуть в диапазон нечего, строка растёт линейно.
  const uids = Array.from({ length: 4000 }, (_, i) => i * 2 + 1);
  const fake = new FakeClient(true);
  await storeFlags(asClient(fake), uids, ['mt-1'], 'add');
  assert.ok(fake.stores.length > 1, 'весь список ушёл одной командой');
  for (const call of fake.stores) {
    assert.ok(call.range.length <= 8192, `порция длиной ${String(call.range.length)}`);
  }
  // Ни одного письма не потеряли по дороге.
  const total = fake.stores.reduce((sum, call) => sum + countUids(call.range), 0);
  assert.equal(total, uids.length);
});

test('отказ MOVE становится видимой ошибкой и не считается перенесённым', async () => {
  const fake = new FakeClient(false);
  await assert.rejects(() => moveUids(asClient(fake), [1, 2], 'Trash'), /не перенёс/i);
});

test('перенос считается по ответу сервера, когда тот его дал', async () => {
  // UIDPLUS: сервер назвал новые номера — их и считаем.
  const uidMap = new Map([
    [1, 100],
    [2, 101],
  ]);
  const fake = new FakeClient({ uidMap });
  assert.equal(await moveUids(asClient(fake), [1, 2, 3], 'Archive'), 2);
});

test('без UIDPLUS считаем по выполненной порции, а не по присланному списку', async () => {
  const fake = new FakeClient(true);
  assert.equal(await moveUids(asClient(fake), [5, 6, 7], 'Archive'), 3);
});

test('счёт писем в наборе понимает и перечисление, и диапазоны', () => {
  assert.equal(countUids('1'), 1);
  assert.equal(countUids('1,4,9'), 3);
  assert.equal(countUids('1:20000'), 20000);
  assert.equal(countUids('1,4:6,9'), 5);
});
