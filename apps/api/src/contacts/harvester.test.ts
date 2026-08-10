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
import type { Logger } from 'pino';
import type { ImapPool } from '../imap/pool.js';
import type { MailSession } from '../types.js';
import type { ContactCursor, ContactsDb } from './db.js';
import {
  applyRange,
  ContactHarvester,
  folderPathForRole,
  planRanges,
  type UidRange,
} from './harvester.js';

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

/* ------------------------------------------------------------------ */
/* Что сборщик сообщает наружу                                          */
/* ------------------------------------------------------------------ */

/*
 * Это единственный путь, которым сборщик разговаривает с подсказкой:
 * onProgress -> ContactsService.markComplete -> `complete` в ответе ->
 * подпись «Собираем адреса из переписки…» в поле «Кому».
 *
 * Отдельная беда, ради которой проверки ниже и написаны: отказ (оборванное
 * соединение с Dovecot, недоступная база) выглядел для этого пути в
 * точности как «ящик разобран целиком». Человек, набравший фамилию, видел
 * пустой список без единого слова о том, что половина писем ещё не
 * просмотрена, — и признак был липким, до перезапуска.
 */

const SILENT = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const SESSION: MailSession = { id: 's1', email: 'test@mail.local', password: 'secret' };

const SENT_FOLDER: ListedFolder = {
  path: 'Sent',
  name: 'Sent',
  delimiter: '/',
  parentPath: '',
  specialUse: '\\Sent',
  flags: new Set<string>(),
};

interface HarvesterFakes {
  /** Что сборщик сказал наружу: пары «ящик — разобран целиком». */
  progress: Array<{ email: string; complete: boolean }>;
  /** Сколько порций дошло до базы. */
  upserts: number;
  harvester: ContactHarvester;
}

function buildHarvester(
  fail: { cursors?: boolean; fetch?: boolean } = {},
  letters = 2,
): HarvesterFakes {
  const progress: HarvesterFakes['progress'] = [];
  let upserts = 0;

  const db = {
    cursors: async (): Promise<ContactCursor[]> => {
      if (fail.cursors) throw new Error('база недоступна');
      return [];
    },
    saveCursor: async (): Promise<void> => undefined,
    upsert: async (): Promise<number> => {
      upserts += 1;
      return 1;
    },
    // Потолок указателя: подрезка идёт сразу после пополнения.
    trim: async (): Promise<number> => 0,
  } as unknown as ContactsDb;

  const client = {
    list: async () => [SENT_FOLDER],
    getMailboxLock: async () => ({ release: () => undefined }),
    mailbox: { uidValidity: 1, uidNext: letters + 1, exists: letters },
    fetchAll: async () => {
      if (fail.fetch) throw new Error('соединение оборвано');
      return [
        {
          uid: 1,
          envelope: {
            date: new Date(),
            to: [{ address: 'ivan@example.com', name: 'Иван Петров' }],
          },
        },
      ];
    },
  };

  const pool = {
    withClient: async <T>(
      _email: string,
      _password: string,
      fn: (c: typeof client) => Promise<T>,
    ): Promise<T> => fn(client),
  } as unknown as ImapPool;

  const harvester = new ContactHarvester({
    db,
    pool,
    logger: SILENT,
    backfillPauseMs: 0,
    onProgress: (email, complete) => progress.push({ email, complete }),
  });
  return {
    progress,
    get upserts() {
      return upserts;
    },
    harvester,
  };
}

/** Даёт фоновому заходу закончиться: kick результата не ждёт. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test('разобранный целиком ящик так и объявляется', async () => {
  const fakes = buildHarvester();
  fakes.harvester.kick({ session: SESSION, collectReceived: false });
  await drain();
  assert.deepEqual(fakes.progress, [{ email: SESSION.email, complete: true }]);
  assert.equal(fakes.upserts, 1, 'адреса из конвертов дошли до указателя');
});

test('отказ базы НЕ выдаётся за «ящик разобран целиком»', async () => {
  const fakes = buildHarvester({ cursors: true });
  fakes.harvester.kick({ session: SESSION, collectReceived: false });
  await drain();
  /*
   * Ни слова наружу: сказать «разобран» — соврать, сказать «не разобран» —
   * снять признак с ящика, который на самом деле разобран давно. Прежняя
   * правда остаётся до следующего удачного захода.
   */
  assert.deepEqual(fakes.progress, []);
});

test('оборванное соединение посреди разбора тоже не объявляет ящик разобранным', async () => {
  const fakes = buildHarvester({ fetch: true });
  fakes.harvester.kick({ session: SESSION, collectReceived: false });
  await drain();
  assert.deepEqual(fakes.progress, []);
  assert.equal(fakes.upserts, 0);
  // Обратный ход к молчанию: оно не должно превратиться в вечный перебор.
  // Соединение с Dovecot у человека одно и общее, занимать его
  // бесполезными попытками нельзя — следующая будет по kick.
  await drain();
  assert.equal(fakes.upserts, 0);
});
