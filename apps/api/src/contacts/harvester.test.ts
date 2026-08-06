/**
 * Порядок обхода ящика сборщиком адресов.
 *
 * Здесь проверяется то, ради чего сборщик вообще устроен порциями: ящик,
 * заведённый вчера, и ящик с десятью тысячами писем должны вести себя
 * одинаково хорошо. Проверки идут в обе стороны — не только «весь ящик
 * рано или поздно разобран», но и «первый же заход берёт СВЕЖИЕ письма»
 * и «разобранное не разбирается второй раз». Без второй половины прошла
 * бы реализация, честно читающая ящик с начала времён, — та самая, при
 * которой подсказка молчит первые минуты.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContactCursor } from './db.js';
import { applyRange, folderPathForRole, planRanges, type UidRange } from './harvester.js';

const CHUNK = 500;

function fresh(role: 'inbox' | 'sent' = 'sent'): ContactCursor {
  return { role, uidValidity: 1, topUid: 0, bottomUid: 0, backfillDone: false, scanned: 0 };
}

test('первый заход по большому ящику берёт самые свежие письма', () => {
  const ranges = planRanges(fresh(), 10_001, CHUNK, 1, true);
  const first = ranges[0];
  assert.equal(first?.kind, 'forward');
  assert.equal(first?.to, 10_000, 'хвост — это последнее письмо ящика');
  assert.equal(first?.from, 9501);
  // Обратный ход: с начала ящика сборщик не начинает
  assert.notEqual(first?.from, 1);
});

test('маленький ящик разбирается целиком за один заход', () => {
  const ranges = planRanges(fresh(), 13, CHUNK, 4, true);
  assert.equal(ranges.length, 1);
  assert.deepEqual(ranges[0], { from: 1, to: 12, kind: 'forward' });
  const applied = applyRange(fresh(), ranges[0] as UidRange, 12);
  assert.equal(applied.backfillDone, true, 'добирать больше нечего');
});

test('пустая папка не порождает ни одного запроса', () => {
  assert.deepEqual(planRanges(fresh(), 1, CHUNK, 4, true), []);
  assert.deepEqual(planRanges(fresh(), 0, CHUNK, 4, true), []);
});

test('ящик на десять тысяч писем разбирается целиком и без пропусков', () => {
  const uidNext = 10_001;
  let cursor = fresh();
  const covered = new Set<number>();
  let runs = 0;
  while (!cursor.backfillDone) {
    runs += 1;
    assert.ok(runs < 100, 'обход обязан закончиться, а не идти вечно');
    const ranges = planRanges(cursor, uidNext, CHUNK, 4, true);
    assert.ok(ranges.length > 0, 'пока не разобрано — заход не может быть пустым');
    for (const range of ranges) {
      for (let uid = range.from; uid <= range.to; uid += 1) {
        // Обратный ход: ни один номер не должен встретиться дважды, иначе
        // счётчики переписки завышаются вдвое на ровном месте.
        assert.ok(!covered.has(uid), `номер ${String(uid)} разобран повторно`);
        covered.add(uid);
      }
      cursor = applyRange(cursor, range, range.to - range.from + 1);
    }
  }
  assert.equal(covered.size, 10_000, 'разобраны все письма ящика');
  assert.equal(cursor.bottomUid, 1);
  // Пять заходов по четыре порции в пятьсот номеров — двадцать порций
  assert.equal(runs, 5);
});

test('разобранный ящик больше не перечитывается', () => {
  const done: ContactCursor = {
    role: 'sent',
    uidValidity: 1,
    topUid: 10_000,
    bottomUid: 1,
    backfillDone: true,
    scanned: 10_000,
  };
  assert.deepEqual(planRanges(done, 10_001, CHUNK, 4, true), []);
  // Обратный ход: новая почта всё-таки подхватывается
  const withNew = planRanges(done, 10_004, CHUNK, 4, true);
  assert.deepEqual(withNew, [{ from: 10_001, to: 10_003, kind: 'forward' }]);
});

test('новая почта не проверяется, когда её только что проверяли', () => {
  const done: ContactCursor = {
    role: 'sent',
    uidValidity: 1,
    topUid: 10_000,
    bottomUid: 1,
    backfillDone: true,
    scanned: 10_000,
  };
  // checkFresh = false: каждая набранная буква не должна слать команду
  // в Dovecot — ровно от этого указатель и избавляет.
  assert.deepEqual(planRanges(done, 10_050, CHUNK, 4, false), []);
});

test('добор старой почты идёт и без проверки новой', () => {
  const partial: ContactCursor = {
    role: 'sent',
    uidValidity: 1,
    topUid: 10_000,
    bottomUid: 9501,
    backfillDone: false,
    scanned: 500,
  };
  const ranges = planRanges(partial, 10_001, CHUNK, 2, false);
  assert.deepEqual(ranges, [
    { from: 9001, to: 9500, kind: 'backfill' },
    { from: 8501, to: 9000, kind: 'backfill' },
  ]);
});

test('отметка двигается только вниз и только вверх, каждая в свою сторону', () => {
  let cursor = fresh();
  cursor = applyRange(cursor, { from: 500, to: 999, kind: 'forward' }, 500);
  assert.equal(cursor.topUid, 999);
  assert.equal(cursor.bottomUid, 500);
  cursor = applyRange(cursor, { from: 1, to: 499, kind: 'backfill' }, 499);
  assert.equal(cursor.topUid, 999, 'добор старой почты не сдвигает верхнюю границу');
  assert.equal(cursor.bottomUid, 1);
  assert.equal(cursor.backfillDone, true);
  assert.equal(cursor.scanned, 999);
});

/* ------------------------------------------------------------------ */
/* Поиск папки по роли                                                  */
/* ------------------------------------------------------------------ */

interface ListedFolder {
  path: string;
  name: string;
  delimiter: string;
  parentPath: string;
  specialUse?: string;
  flags: Set<string>;
}

function fakeClient(folders: ListedFolder[]): Parameters<typeof folderPathForRole>[0] {
  return { list: async () => folders } as unknown as Parameters<typeof folderPathForRole>[0];
}

test('«Отправленные» находятся по флагу, а не по названию', async () => {
  const client = fakeClient([
    { path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', flags: new Set() },
    {
      path: 'Ausgang',
      name: 'Ausgang',
      delimiter: '/',
      parentPath: '',
      specialUse: '\\Sent',
      flags: new Set(),
    },
  ]);
  assert.equal(await folderPathForRole(client, 'sent'), 'Ausgang');
  assert.equal(await folderPathForRole(client, 'inbox'), 'INBOX');
});

test('русское название «Отправленные» тоже опознаётся', async () => {
  const client = fakeClient([
    { path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', flags: new Set() },
    {
      path: 'Отправленные',
      name: 'Отправленные',
      delimiter: '/',
      parentPath: '',
      flags: new Set(),
    },
  ]);
  assert.equal(await folderPathForRole(client, 'sent'), 'Отправленные');
});

test('служебные каталоги Dovecot и невыбираемые папки пропускаются', async () => {
  const client = fakeClient([
    {
      path: 'dovecot/lda-dupes',
      name: 'lda-dupes',
      delimiter: '/',
      parentPath: 'dovecot',
      flags: new Set(),
    },
    {
      path: 'Sent',
      name: 'Sent',
      delimiter: '/',
      parentPath: '',
      flags: new Set(['\\Noselect']),
    },
  ]);
  // Обратный ход: раз подходящей папки нет — честный null, а не первая
  // попавшаяся
  assert.equal(await folderPathForRole(client, 'sent'), null);
});
