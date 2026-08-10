/**
 * Уборка почтового хранилища после удаления ящика.
 *
 * Проверяется то, ради чего всё это и делалось: после удаления каталог
 * не остаётся лежать под тем же именем (иначе повторно созданный ящик
 * с тем же адресом покажет чужую старую переписку), а место на диске
 * действительно освобождается — не «когда-нибудь», а проходом уборщика.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import type { AdminDb } from './db.js';
import { AdminJanitor } from './janitor.js';
import {
  findOrphanMaildirs,
  maildirPathOf,
  QUARANTINE_DIR,
  quarantineMaildir,
  removeTree,
  treeSize,
} from './mailbox-cleanup.js';

const logger = pino({ level: 'silent' });

async function seed(root: string, email: string, bytes = 4096): Promise<string> {
  const dir = maildirPathOf(root, email);
  assert.ok(dir);
  await mkdir(path.join(dir, 'cur'), { recursive: true });
  await writeFile(path.join(dir, 'cur', '1.mail'), 'x'.repeat(bytes));
  return dir;
}

void test('путь каталога ящика строится по правилу Dovecot и не выходит за корень', () => {
  assert.equal(maildirPathOf('/var/mail/vhosts', 'ivan@x.local'), '/var/mail/vhosts/x.local/ivan');
  assert.equal(maildirPathOf('/var/mail/vhosts', 'Ivan@X.Local'), '/var/mail/vhosts/x.local/ivan');
  // Ни одна часть адреса не должна уметь увести rm -rf в другое место.
  assert.equal(maildirPathOf('/var/mail/vhosts', '../../etc@x.local'), null);
  assert.equal(maildirPathOf('/var/mail/vhosts', 'ivan@../..'), null);
  assert.equal(maildirPathOf('/var/mail/vhosts', 'без-собаки'), null);
});

void test('карантин уводит каталог из-под нового ящика с тем же адресом', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-quar-'));
  const dir = await seed(root, 'gone@x.local');

  const result = await quarantineMaildir(root, 'gone@x.local', '42');

  assert.equal(result.existed, true);
  assert.equal(result.error, null);
  assert.ok(result.quarantinePath);
  // Старого пути больше нет — это и есть главное следствие исправления.
  await assert.rejects(stat(dir));
  // А содержимое цело: до прохода уборщика письма можно спасти.
  assert.ok((await treeSize(result.quarantinePath)) > 0);
  const inside = await readdir(path.join(root, 'x.local', QUARANTINE_DIR));
  assert.deepEqual(inside, ['gone.42']);
});

void test('карантин ящика, который ни разу не открывали, — не ошибка', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-quar-'));
  const result = await quarantineMaildir(root, 'never@x.local', '1');
  assert.equal(result.existed, false);
  assert.equal(result.quarantinePath, null);
  assert.equal(result.error, null);
});

void test('уборщик удаляет карантин и записывает освобождённое место', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-quar-'));
  await seed(root, 'gone@x.local', 10_000);
  const quarantined = await quarantineMaildir(root, 'gone@x.local', '7');
  assert.ok(quarantined.quarantinePath);

  const updates: Array<Record<string, unknown>> = [];
  const db = {
    listDeletionsToPurge: async () => [
      { id: 7, email: 'gone@x.local', quarantinePath: quarantined.quarantinePath },
    ],
    updateMailboxDeletion: async (_id: number, patch: Record<string, unknown>) => {
      updates.push(patch);
    },
    expireStaleMailboxAccess: async () => 0,
    deleteExpiredImportJobs: async () => 0,
    failStaleImportJobs: async () => 0,
    sweepAdminLoginFailures: async () => 0,
    // Застрявших удалений в этих проверках нет: они про обычный проход.
    countStuckDeletions: async () => 0,
    // Ящика с этим адресом больше нет — иначе уборщик обязан обойти
    // каталог стороной (см. проверку про заново заведённый ящик).
    listEmailsIn: async () => [],
    listAllMailboxEmails: async () => [],
  };

  const janitor = new AdminJanitor({
    db: db as unknown as AdminDb,
    logger,
    mailRoot: root,
    intervalSeconds: 0,
  });
  const result = await janitor.runOnce();

  assert.equal(result.purgedMaildirs, 1);
  assert.ok(result.bytesFreed >= 10_000, 'освобождённое место должно быть посчитано');
  await assert.rejects(stat(quarantined.quarantinePath));
  assert.equal(updates[0]?.state, 'purged');
});

void test('карантин не удался — уборщик не смеет закрыть запись как убранную', async () => {
  /*
   * Самый дорогой из возможных исходов, и выглядел он как успех.
   *
   * У записи об удалении нет пути карантина в двух совершенно разных
   * случаях: каталога не было вовсе (ящик ни разу не открывали) и увести
   * каталог в карантин НЕ УДАЛОСЬ — том смонтирован только на чтение,
   * чужой владелец, нет прав. Уборщик их не различал и в обоих ставил
   * «purged».
   *
   * Цена ошибки: почта осталась лежать по живому пути
   * <корень>/<домен>/<логин>, и её открывает тот, кто заведёт ящик с этим
   * же адресом заново. Над чужой перепиской при этом стоит зелёная
   * отметка «убрано».
   *
   * Отличаем по записанной ошибке предыдущей попытки — она и есть
   * доказательство, что каталог был и остался.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'mt-fail-'));
  const live = await seed(root, 'stuck@x.local', 5_000);

  const updates: Array<Record<string, unknown>> = [];
  const db = {
    listDeletionsToPurge: async () => [
      {
        id: 9,
        email: 'stuck@x.local',
        quarantinePath: null,
        maildirPath: live,
        error: 'EACCES: permission denied, rename',
      },
    ],
    updateMailboxDeletion: async (_id: number, patch: Record<string, unknown>) => {
      updates.push(patch);
    },
    expireStaleMailboxAccess: async () => 0,
    deleteExpiredImportJobs: async () => 0,
    failStaleImportJobs: async () => 0,
    sweepAdminLoginFailures: async () => 0,
    // Застрявших удалений в этих проверках нет: они про обычный проход.
    countStuckDeletions: async () => 0,
    // Ящика с этим адресом больше нет — иначе уборщик обязан обойти
    // каталог стороной (см. проверку про заново заведённый ящик).
    listEmailsIn: async () => [],
    listAllMailboxEmails: async () => [],
  };

  const janitor = new AdminJanitor({
    db: db as unknown as AdminDb,
    logger,
    mailRoot: root,
    intervalSeconds: 0,
  });
  await janitor.runOnce();

  // Здесь повторная попытка УДАЁТСЯ (прав в тесте хватает), поэтому
  // каталог обязан уехать в карантин и быть убран — но ни в одном
  // обновлении не должно быть «purged» раньше, чем это случилось.
  const closedBlindly = updates.some(
    (patch) => patch.state === 'purged' && patch.bytesFreed === undefined,
  );
  assert.equal(closedBlindly, false, 'запись закрыта как убранная без единого убранного байта');
  await assert.rejects(stat(live), 'каталог остался лежать по живому пути');
});

void test('карантин не удался и не удаётся снова — запись остаётся открытой с причиной', async () => {
  // Второй раз тоже не вышло: корень указывает в никуда, значит увести
  // каталог некуда. Единственный честный исход — оставить запись
  // открытой, увеличив счётчик попыток, и сохранить причину.
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    listDeletionsToPurge: async () => [
      {
        id: 11,
        email: 'stuck@x.local',
        quarantinePath: null,
        maildirPath: '/нет/такого/пути/stuck',
        error: 'EROFS: read-only file system, rename',
      },
    ],
    updateMailboxDeletion: async (_id: number, patch: Record<string, unknown>) => {
      updates.push(patch);
    },
    expireStaleMailboxAccess: async () => 0,
    deleteExpiredImportJobs: async () => 0,
    failStaleImportJobs: async () => 0,
    sweepAdminLoginFailures: async () => 0,
    // Застрявших удалений в этих проверках нет: они про обычный проход.
    countStuckDeletions: async () => 0,
    // Ящика с этим адресом больше нет — иначе уборщик обязан обойти
    // каталог стороной (см. проверку про заново заведённый ящик).
    listEmailsIn: async () => [],
    listAllMailboxEmails: async () => [],
  };

  const janitor = new AdminJanitor({
    db: db as unknown as AdminDb,
    logger,
    mailRoot: '/нет/такого/корня',
    intervalSeconds: 0,
  });
  const result = await janitor.runOnce();

  assert.equal(result.purgedMaildirs, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.state, undefined, 'состояние менять нельзя: ничего не убрано');
  assert.equal(updates[0]?.bumpAttempts, true);
  assert.ok(
    typeof updates[0]?.error === 'string' && (updates[0].error as string).length > 0,
    'причина обязана сохраниться — по ней это и разбирают',
  );
});

void test('уборщик находит осиротевшие каталоги, но сам их не трогает', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-orph-'));
  const living = await seed(root, 'alive@x.local');
  const orphan = await seed(root, 'orphan@x.local');

  const found = await findOrphanMaildirs(root, ['alive@x.local']);
  assert.deepEqual(found, ['orphan@x.local']);

  const db = {
    listDeletionsToPurge: async () => [],
    updateMailboxDeletion: async () => undefined,
    expireStaleMailboxAccess: async () => 0,
    deleteExpiredImportJobs: async () => 0,
    failStaleImportJobs: async () => 0,
    sweepAdminLoginFailures: async () => 0,
    // Застрявших удалений в этих проверках нет: они про обычный проход.
    countStuckDeletions: async () => 0,
    listAllMailboxEmails: async () => ['alive@x.local'],
  };
  const janitor = new AdminJanitor({
    db: db as unknown as AdminDb,
    logger,
    mailRoot: root,
    intervalSeconds: 0,
  });
  const result = await janitor.runOnce();

  assert.equal(result.orphanMaildirs, 1);
  // Молча стирать чужую почту нельзя: каталог мог быть заведён руками.
  assert.ok((await stat(orphan)).isDirectory());
  assert.ok((await stat(living)).isDirectory());
});

/**
 * Уборщик ходит раз в минуту, а осиротевший каталог живёт неделями.
 * Пока состав не меняется, повторять предупреждение нельзя: иначе одна
 * забытая папка даёт ~1440 записей в сутки, и настоящие предупреждения
 * в журнале тонут. Проверяем именно частоту, а не сам факт находки.
 */
void test('про осиротевшие каталоги уборщик сообщает один раз, а не на каждом проходе', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-orph-'));
  await seed(root, 'orphan@x.local');

  const warnings: string[] = [];
  const noisy = pino(
    { level: 'warn' },
    {
      write(line: string) {
        warnings.push(line);
      },
    },
  );

  let known: string[] = ['alive@x.local'];
  const db = {
    listDeletionsToPurge: async () => [],
    updateMailboxDeletion: async () => undefined,
    expireStaleMailboxAccess: async () => 0,
    deleteExpiredImportJobs: async () => 0,
    failStaleImportJobs: async () => 0,
    sweepAdminLoginFailures: async () => 0,
    // Застрявших удалений в этих проверках нет: они про обычный проход.
    countStuckDeletions: async () => 0,
    listAllMailboxEmails: async () => known,
  };
  // Часы под управлением теста: иначе суточное напоминание не проверить.
  let clock = 1_000_000;
  const janitor = new AdminJanitor({
    db: db as unknown as AdminDb,
    logger: noisy,
    mailRoot: root,
    intervalSeconds: 0,
    now: () => clock,
  });

  const first = await janitor.runOnce();
  assert.equal(first.orphanMaildirs, 1);
  assert.equal(first.orphanReported, true, 'о новой находке сообщить обязаны');

  // Десять проходов подряд, состав тот же — в журнале не должно прибавиться.
  for (let i = 0; i < 10; i += 1) {
    clock += 60_000;
    const again = await janitor.runOnce();
    assert.equal(again.orphanMaildirs, 1, 'каталог по-прежнему находится');
    assert.equal(again.orphanReported, false, 'повторять то же самое нельзя');
  }
  assert.equal(warnings.length, 1, `ожидалась одна запись, получено ${warnings.length}`);

  // Появился НОВЫЙ каталог — это новость, о ней сообщаем сразу.
  await seed(root, 'orphan2@x.local');
  clock += 60_000;
  const changed = await janitor.runOnce();
  assert.equal(changed.orphanReported, true, 'о новом каталоге сообщаем немедленно');
  assert.equal(warnings.length, 2);

  // Прошли сутки, состав тот же — одно напоминание, чтобы не забылось.
  clock += 24 * 60 * 60 * 1000;
  const reminder = await janitor.runOnce();
  assert.equal(reminder.orphanReported, true, 'суточное напоминание должно быть');
  assert.equal(warnings.length, 3);
  assert.match(warnings[2] ?? '', /"reason":"reminder"/);

  // Каталоги убрали руками — уборщик молчит и забывает сказанное.
  known = ['alive@x.local', 'orphan@x.local', 'orphan2@x.local'];
  clock += 60_000;
  const clean = await janitor.runOnce();
  assert.equal(clean.orphanMaildirs, 0);
  assert.equal(clean.orphanReported, false);
  assert.equal(warnings.length, 3);
});

void test('карантин не попадает в список осиротевших каталогов', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-orph-'));
  await seed(root, 'gone@x.local');
  await quarantineMaildir(root, 'gone@x.local', '3');
  assert.deepEqual(await findOrphanMaildirs(root, []), []);
});

void test('удаление дерева возвращает освобождённые байты', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-size-'));
  const dir = await seed(root, 'big@x.local', 20_000);
  const freed = await removeTree(dir);
  assert.ok(freed >= 20_000);
  await assert.rejects(stat(dir));
});

void test('повторный карантин не трогает ящик, заведённый заново с тем же адресом', async () => {
  /*
   * Повтор ходит по ЖИВОМУ пути каталога, и между попытками адрес мог
   * снова стать чьим-то: администратор заводит ящик с тем же именем,
   * Dovecot открывает тот же каталог, туда приходит новая почта.
   *
   * Дальше уборщик переименовывал этот каталог в карантин и удалял —
   * вместе с перепиской, которой три дня от роду, — и записывал
   * «Каталог удалённого ящика убран с диска».
   *
   * Случай не выдуманный: повтор написан ровно для тех отказов, которые
   * чинят руками (том оказался только на чтение, права не те), и между
   * «не получилось» и «починили» проходят часы — их хватает, чтобы
   * завести ящик заново.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'mt-quar-'));
  const dir = await seed(root, 'ivan@x.local', 5_000);

  const updates: Array<Record<string, unknown>> = [];
  const db = {
    listDeletionsToPurge: async () => [
      {
        id: 9,
        email: 'ivan@x.local',
        quarantinePath: null,
        maildirPath: dir,
        error: 'EROFS: read-only file system',
      },
    ],
    updateMailboxDeletion: async (_id: number, patch: Record<string, unknown>) => {
      updates.push(patch);
    },
    // Ящик с этим адресом снова живой.
    listEmailsIn: async () => ['ivan@x.local'],
    expireStaleMailboxAccess: async () => 0,
    deleteExpiredImportJobs: async () => 0,
    failStaleImportJobs: async () => 0,
    sweepAdminLoginFailures: async () => 0,
    // Застрявших удалений в этих проверках нет: они про обычный проход.
    countStuckDeletions: async () => 0,
    listAllMailboxEmails: async () => ['ivan@x.local'],
  };

  const janitor = new AdminJanitor({
    db: db as unknown as AdminDb,
    logger,
    mailRoot: root,
    intervalSeconds: 0,
  });
  const result = await janitor.runOnce();

  // Каталог на месте, письма целы.
  assert.ok((await treeSize(dir)) >= 5_000, 'почта заново заведённого ящика обязана уцелеть');
  assert.equal(result.purgedMaildirs, 0, 'уборщик не должен считать это уборкой');
  assert.equal(
    updates[0]?.state,
    'purged',
    'запись об удалении закрывается — убирать больше нечего',
  );
});

void test('застрявшие удаления не молчат: уборщик считает их и кричит в журнал', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-stuck-'));
  const said: string[] = [];
  const db = {
    // Записи, упёршиеся в предел попыток, из выборки уже не приходят —
    // ровно поэтому раньше о них не говорил никто.
    listDeletionsToPurge: async () => [],
    updateMailboxDeletion: async () => undefined,
    expireStaleMailboxAccess: async () => 0,
    deleteExpiredImportJobs: async () => 0,
    failStaleImportJobs: async () => 0,
    sweepAdminLoginFailures: async () => 0,
    countStuckDeletions: async () => 3,
    listEmailsIn: async () => [],
    listAllMailboxEmails: async () => [],
  };
  const janitor = new AdminJanitor({
    db: db as unknown as AdminDb,
    logger: {
      ...logger,
      error: (_fields: unknown, msg: string) => said.push(msg),
    } as unknown as typeof logger,
    mailRoot: root,
    intervalSeconds: 0,
  });

  const first = await janitor.runOnce();
  assert.equal(first.stuckDeletions, 3);
  assert.equal(said.length, 1, 'о застрявших записях сказано вслух');
  assert.match(said[0] ?? '', /застряло/i);

  // Второй проход в те же сутки молчит: иначе за сутки набралось бы
  // полторы тысячи одинаковых строк и настоящие ошибки в них утонули бы.
  const second = await janitor.runOnce();
  assert.equal(second.stuckDeletions, 3);
  assert.equal(said.length, 1);
});

void test('уборка журналов панели спрашивает существующие колонки', () => {
  /*
   * Тест по исходнику, а не по живой базе: имя колонки — единственное,
   * что здесь можно перепутать, и цена ошибки велика. Проход уборщика
   * падал целиком на «column "created_at" does not exist», то есть
   * вместе с журналами переставали убираться и карантины, и следы
   * подбора паролей — они идут тем же проходом. Поймано живой проверкой
   * на стенде, в журнале сервера.
   */
  const source = readFileSync(
    fileURLToPath(new URL('./db.ts', import.meta.url).href.replace('/dist/', '/src/')),
    'utf8',
  );
  const sweep = source.slice(
    source.indexOf('async sweepAdminLogs'),
    source.indexOf('markAdminLoginFailure'),
  );
  // У каждой таблицы своё имя колонки, и именно это здесь и проверяется.
  assert.match(
    sweep,
    /FROM admin_audit_log[\s\S]*?WHERE created_at </,
    'у журнала действий колонка created_at',
  );
  assert.match(sweep, /FROM ai_audit_log[\s\S]*?WHERE at </, 'у журнала ИИ колонка at');
  assert.match(sweep, /last_success </, 'у справочника адресов — last_success');
});
