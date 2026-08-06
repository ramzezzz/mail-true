/**
 * Работник переноса: что происходит при перезапуске контейнера и куда
 * деваются пароли.
 *
 * Проверяется без сети и без Postgres: база подменена, чужого IMAP-сервера
 * здесь нет. Проверяется НЕ перенос писем (он проверен в packages/migrate),
 * а поведение задания — то, ради чего эти файлы и написаны:
 *   - задание переживает смерть процесса и продолжается, а не начинается
 *     заново и не пропадает;
 *   - уже перенесённые ящики повторно не трогаются;
 *   - пароли исчезают вместе с завершением задания.
 *
 * На старом коде падают все проверки: работника переноса не существовало.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import type { StateStore } from '@mail-true/migrate';
import { SecretBox } from '../crypto.js';
import { MigrationRunner } from './migrate-runner.js';
import { packSecrets, type DestSettings } from './migrate-jobs.js';
import type { AdminDb, MigrationItemRow, MigrationJobRow } from './db.js';

const SECRET = 'sekret-dlya-proverki-perenosa-pochty';
const logger = pino({ level: 'silent' });

const dest: DestSettings = {
  host: 'dovecot',
  port: 993,
  secure: true,
  allowInsecureTls: true,
  masterUser: 'sluzhebnyj',
  masterPassword: 'parol-sluzhebnogo',
  masterSeparator: '*',
};

/** Хранилище состояния-пустышка: настоящее живёт в Postgres. */
const nullState: StateStore = {
  init: async () => undefined,
  wasMigrated: async () => false,
  migratedCount: async () => 0,
  markMigrated: async () => undefined,
  getCursor: async () => null,
  setCursor: async () => undefined,
  close: async () => undefined,
};

/** Заготовка строки задания. */
function jobRow(patch: Partial<MigrationJobRow> = {}): MigrationJobRow {
  return {
    id: '7',
    admin_login: 'rukovodstvo',
    state: 'running',
    stop_requested: false,
    source_host: 'kerio.staraya.ru',
    source_port: 993,
    source_secure: true,
    source_insecure_tls: true,
    source_master_user: null,
    source_master_separator: null,
    secret_enc: null,
    total: 2,
    done_count: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    error: null,
    runner: null,
    heartbeat_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    started_at: null,
    finished_at: null,
    ...patch,
  };
}

function itemRow(position: number, patch: Partial<MigrationItemRow> = {}): MigrationItemRow {
  return {
    id: String(100 + position),
    job_id: '7',
    position,
    source_user: `user${String(position)}@staraya.ru`,
    dest_user: `user${String(position)}@novaya.ru`,
    // По умолчанию ящик-приёмник существует и включён: иначе работник
    // (справедливо) откажется в него писать, и проверка проверяла бы
    // не то, ради чего написана.
    dest_user_id: 500 + position,
    dest_active: true,
    state: 'queued',
    total: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    current_folder: null,
    errors: null,
    started_at: null,
    finished_at: null,
    ...patch,
  };
}

/** Подменённая база: запоминает всё, что ей велели записать. */
class FakeDb {
  claimed: Array<{ runner: string; stale: number }> = [];
  jobPatches: Array<Record<string, unknown>> = [];
  itemPatches: Array<{ position: number; patch: Record<string, unknown> }> = [];
  items: MigrationItemRow[] = [];
  stopRequested = false;
  released: number[] = [];

  async releaseMigrationJob(id: number): Promise<void> {
    this.released.push(id);
  }

  async expireStaleMigrationJobs(): Promise<number> {
    return 0;
  }
  async claimMigrationJobs(runner: string, stale: number): Promise<MigrationJobRow[]> {
    this.claimed.push({ runner, stale });
    return [];
  }
  async touchMigrationJob(): Promise<void> {
    /* биение проверяется отдельно */
  }
  async isMigrationStopRequested(): Promise<boolean> {
    return this.stopRequested;
  }
  async updateMigrationJob(_id: number, patch: Record<string, unknown>): Promise<void> {
    this.jobPatches.push(patch);
  }
  async listMigrationItems(): Promise<MigrationItemRow[]> {
    return this.items;
  }
  async updateMigrationItem(
    _jobId: number,
    position: number,
    patch: Record<string, unknown>,
  ): Promise<void> {
    this.itemPatches.push({ position, patch });
  }
}

function runnerWith(db: FakeDb, box: SecretBox | null): MigrationRunner {
  return new MigrationRunner({
    db: db as unknown as AdminDb,
    logger,
    box,
    dest,
    stateConnectionString: 'postgres://nikuda/ne-podklyuchaemsya',
    // Настоящее хранилище состояния полезло бы в Postgres, которого в
    // проверке нет. Само по себе оно проверено в packages/migrate.
    createState: () => nullState,
  });
}

/* ------------------------------------------------------------------ */

test('перезапуск контейнера: задание подхватывается, а не начинается заново', async () => {
  // Ящик, переехавший до перезапуска, второй раз не трогаем: это часы
  // работы и сканирование чужого сервера ни за чем. Ящик, застигнутый
  // перезапуском, начинается снова — но продолжится с курсора, а не с нуля.
  const db = new FakeDb();
  const box = new SecretBox(SECRET);
  db.items = [
    itemRow(0, { state: 'ok', copied: 120, skipped: 3, total: 123 }),
    itemRow(1, { state: 'running', copied: 40, total: 500 }),
  ];
  // Пароля второму ящику нет — до сети дело не дойдёт, а решение
  // «пропускать или нет» видно по записям.
  const job = jobRow({ secret_enc: packSecrets(box, { mailboxPasswords: {} }) });

  await runnerWith(db, box).runJob(job);

  const touched = db.itemPatches.map((p) => p.position);
  assert.equal(touched.includes(0), false, 'уже перенесённый ящик трогать нельзя');
  assert.equal(touched.includes(1), true, 'незаконченный ящик обязан быть подхвачен');
});

test('счётчики после перезапуска продолжают прежние, а не обнуляются', async () => {
  // Иначе человек, вернувшийся к экрану после обновления образа, видит
  // «перенесено 0» при полном хранилище и считает, что всё пропало.
  const db = new FakeDb();
  const box = new SecretBox(SECRET);
  db.items = [
    itemRow(0, { state: 'ok', copied: 120, skipped: 3, failed: 1 }),
    itemRow(1, { state: 'ok', copied: 80, skipped: 0, failed: 0 }),
  ];
  await runnerWith(db, box).runJob(jobRow({ secret_enc: packSecrets(box, {}) }));

  const last = db.jobPatches.at(-1) ?? {};
  assert.equal(last['copied'], 200, 'числа завершённых ящиков должны сохраниться');
  assert.equal(last['skipped'], 3);
  assert.equal(last['failed'], 1);
  assert.equal(last['doneCount'], 2);
});

test('счётчики ящика продолжают прежние, а не начинаются заново', async () => {
  // Поймано на живом стенде: перезапуск посреди ящика на 924 письма.
  // До перезапуска легло 724, после — новый процесс докачал 200 и записал
  // «перенесено 200 из 924». Ящик переехал целиком, а отчёт звал повторять
  // перенос, которого не требуется.
  //
  // Проверяется через ящик, до которого проход не дошёл (пароля нет):
  // сети в проверке нет, а складывание чисел видно по записи задания.
  const db = new FakeDb();
  const box = new SecretBox(SECRET);
  db.items = [itemRow(0, { state: 'running', copied: 724, skipped: 6, total: 924 })];
  await runnerWith(db, box).runJob(
    jobRow({ total: 1, secret_enc: packSecrets(box, { mailboxPasswords: {} }) }),
  );

  const last = db.jobPatches.at(-1) ?? {};
  assert.equal(last['copied'], 724, 'уже перенесённые письма из отчёта пропали');
  assert.equal(last['skipped'], 6);
});

test('завершение задания стирает пароли той же командой', async () => {
  // Отдельную команду «стереть пароли» можно не выполнить: упал процесс,
  // оборвалась связь с базой. Тогда чужие пароли остались бы лежать,
  // хотя переносить уже нечего.
  const db = new FakeDb();
  const box = new SecretBox(SECRET);
  db.items = [itemRow(0, { state: 'ok' })];
  await runnerWith(db, box).runJob(jobRow({ secret_enc: packSecrets(box, {}) }));

  const last = db.jobPatches.at(-1) ?? {};
  assert.equal(last['finished'], true, 'без finished столбец secret_enc не обнуляется (см. db.ts)');
});

test('нет секрета шифрования — задание отказывается словами, а не молча', async () => {
  const db = new FakeDb();
  await runnerWith(db, null).runJob(jobRow({ secret_enc: 'chto-to' }));

  const last = db.jobPatches.at(-1) ?? {};
  assert.equal(last['state'], 'failed');
  assert.match(String(last['error']), /SESSION_SECRET/, 'должно быть сказано, чего не хватает');
  assert.equal(last['finished'], true, 'пароли стираются и в этом случае');
});

test('пароли стёрты — сказано про пароли, а не «неверный пароль» с чужого сервера', async () => {
  // Самая дорогая подмена причины: увидев отказ IMAP, администратор идёт
  // разбираться с чужим сервером, хотя дело в нашем задании.
  const db = new FakeDb();
  const box = new SecretBox(SECRET);
  await runnerWith(db, box).runJob(jobRow({ secret_enc: null }));

  const last = db.jobPatches.at(-1) ?? {};
  assert.equal(last['state'], 'failed');
  assert.match(String(last['error']), /Пароли исходных ящиков недоступны/);
  assert.equal(last['finished'], true);
});

test('ящик без пароля объясняется паролем, а не отказом сервера', async () => {
  const db = new FakeDb();
  const box = new SecretBox(SECRET);
  db.items = [itemRow(0)];
  await runnerWith(db, box).runJob(
    jobRow({ secret_enc: packSecrets(box, { mailboxPasswords: {} }) }),
  );

  const failed = db.itemPatches.find((p) => p.patch['state'] === 'failed');
  assert.ok(failed, 'ящик без пароля обязан получить отметку');
  assert.match(String(failed.patch['errors']), /Пароль исходного ящика не задан/);
});

test('задание, остановленное до начала, завершается как остановленное', async () => {
  // Не «выполнено» (ничего не переехало) и не «упало» (ничего не ломалось).
  const db = new FakeDb();
  db.stopRequested = true;
  const box = new SecretBox(SECRET);
  db.items = [itemRow(0)];
  await runnerWith(db, box).runJob(
    jobRow({ secret_enc: packSecrets(box, { mailboxPasswords: { '0': 'parol' } }) }),
  );

  const last = db.jobPatches.at(-1) ?? {};
  assert.equal(last['state'], 'stopped');
  assert.match(String(last['error']), /остановлен/i);
  assert.equal(last['finished'], true, 'пароли стираются и при остановке');
});

test('остановка ПРОЦЕССА не завершает задание и не стирает пароли', async () => {
  // Самая дорогая ошибка во всём разделе. Перезапуск контейнера (обновление
  // образа, перезагрузка машины) — это не решение человека прекратить
  // перенос. Завершив задание по SIGTERM, мы стёрли бы пароли — они
  // стираются вместе с завершением — и докачивать ночной перенос стало бы
  // нечем: пришлось бы вводить сотню паролей заново.
  const db = new FakeDb();
  const box = new SecretBox(SECRET);
  db.items = [itemRow(0, { state: 'ok' })];
  const runner = runnerWith(db, box);

  runner.stop(); // как при SIGTERM
  await runner.runJob(jobRow({ secret_enc: packSecrets(box, {}) }));

  assert.deepEqual(db.released, [7], 'задание должно быть отпущено, а не завершено');
  const finishing = db.jobPatches.filter((p) => p['finished'] === true);
  assert.deepEqual(finishing, [], 'ни одна запись не должна завершать задание');
  assert.equal(
    db.jobPatches.some((p) => p['state'] === 'stopped'),
    false,
    'остановка процесса не то же самое, что остановка человеком',
  );
});

test('остановка ЧЕЛОВЕКОМ при гаснущем процессе всё-таки завершает задание', async () => {
  // Обратный ход к предыдущей проверке: различие должно идти от флага
  // в базе, а не от того, что задание никогда не завершается.
  const db = new FakeDb();
  db.stopRequested = true;
  const box = new SecretBox(SECRET);
  db.items = [itemRow(0, { state: 'ok' })];
  const runner = runnerWith(db, box);

  runner.stop();
  await runner.runJob(jobRow({ secret_enc: packSecrets(box, {}) }));

  assert.deepEqual(db.released, [], 'человек просил прекратить — отпускать нечего');
  const last = db.jobPatches.at(-1) ?? {};
  assert.equal(last['state'], 'stopped');
  assert.equal(last['finished'], true, 'пароли обязаны быть стёрты');
});

test('у каждого процесса свой опознаватель — на этом держится подхват', async () => {
  // Два работника с одинаковым идентификатором не отличили бы «моё
  // задание» от «задания мертвеца», и перезапущенный контейнер не забрал
  // бы работу у себя прежнего.
  const first = runnerWith(new FakeDb(), null);
  const second = runnerWith(new FakeDb(), null);
  assert.notEqual(first.runnerId, second.runnerId);
  assert.ok(first.runnerId.length > 8);
});

test('проход работника ищет брошенные задания по сроку молчания', async () => {
  const db = new FakeDb();
  const runner = runnerWith(db, new SecretBox(SECRET));
  await runner.scan();
  assert.equal(db.claimed.length, 1);
  assert.equal(db.claimed[0]?.runner, runner.runnerId);
  assert.ok((db.claimed[0]?.stale ?? 0) > 0, 'без срока молчания задание никто бы не подхватил');
});

/* ------------------------------------------------------------------ */
/* Ящик-приёмник исчез или отключён — причина называется честно          */
/* ------------------------------------------------------------------ */

test('отключённый ящик-приёмник объясняется отключением, а не «неверным паролем»', async () => {
  /*
   * Ровно тот случай, который поймали на живом стенде: восстановление
   * настроек из копии выключило ящик посреди переноса. Dovecot отбирает
   * ящики запросом `... WHERE email = '%u' AND active`, поэтому вход в
   * отключённый ящик отклоняется так же, как при неверном пароле, — и
   * раздел переноса звал проверять пароль служебного доступа.
   */
  const db = new FakeDb();
  const box = new SecretBox(SECRET);
  db.items = [itemRow(0, { dest_active: false })];
  const job = jobRow({
    total: 1,
    secret_enc: packSecrets(box, { mailboxPasswords: { '0': 'parol-ishodnogo' } }),
  });

  await runnerWith(db, box).runJob(job);

  const patch = db.itemPatches.find((p) => p.position === 0)?.patch;
  assert.ok(patch, 'строка ящика обязана получить объяснение');
  assert.equal(patch['state'], 'failed');
  const errors = String(patch['errors']);
  assert.match(errors, /отключ/iu, 'причина обязана называться словом «отключён»');
  assert.doesNotMatch(errors, /невер/iu, 'про неверный пароль здесь не должно быть ни слова');

  // Причина видна и на самом задании: в списке заданий отчёт не открыт.
  const finished = db.jobPatches.filter((p) => p['finished'] === true).pop();
  assert.equal(finished?.['state'], 'failed');
  assert.match(String(finished?.['error']), /удалены или отключены/u);
});

test('удалённый ящик-приёмник объясняется отсутствием ящика', async () => {
  const db = new FakeDb();
  const box = new SecretBox(SECRET);
  // dest_active === null означает «ящика в базе нет вовсе».
  db.items = [itemRow(0, { dest_user_id: null, dest_active: null })];
  const job = jobRow({
    total: 1,
    secret_enc: packSecrets(box, { mailboxPasswords: { '0': 'parol-ishodnogo' } }),
  });

  await runnerWith(db, box).runJob(job);

  const errors = String(db.itemPatches.find((p) => p.position === 0)?.patch['errors']);
  assert.match(errors, /нет на сервере/u);
  assert.doesNotMatch(errors, /парол/iu);
});

test('исправный ящик-приёмник по-прежнему переносится', async () => {
  // Обратный ход: проверка выше должна ловить сломанное, а не всё подряд.
  const db = new FakeDb();
  const box = new SecretBox(SECRET);
  db.items = [itemRow(0, { dest_active: true })];
  const job = jobRow({
    total: 1,
    secret_enc: packSecrets(box, { mailboxPasswords: { '0': 'parol-ishodnogo' } }),
  });

  await runnerWith(db, box).runJob(job);

  const errors = String(db.itemPatches.find((p) => p.position === 0)?.patch['errors'] ?? '');
  assert.doesNotMatch(errors, /отключ|нет на сервере/iu, 'исправный ящик не должен отказывать');
});
