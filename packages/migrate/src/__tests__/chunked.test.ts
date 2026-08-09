/**
 * Перенос большого ящика не должен съедать память и не должен ходить
 * в базу за каждым письмом.
 *
 * ЧЕМ ЭТО БЫЛО НА ДЕЛЕ. Метаописания ВСЕХ писем папки собирались в один
 * массив и держались до конца копирования; рядом лежал полный перечень
 * содержимого папки-приёмника; а решение «дубль или нет» принималось
 * запросом в базу на каждое письмо. INBOX на 300–500 тысяч писем при
 * потолке кучи в 512 МБ означал падение процесса api — то есть всей
 * веб-почты и админки, а не «переноса». Контейнер поднимался, работник
 * брал то же задание и падал снова.
 *
 * На прежнем коде падают все проверки этого файла: чтение шло одним
 * FETCH по всей папке, а состояние спрашивалось поштучно.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImapFlow } from 'imapflow';
import { MailboxMigrator } from '../migrator.js';
import { FileStateStore, type FolderCursor, type StateStore } from '../state.js';
import type { ImapEndpoint, MailboxReport, MigrateMailboxOptions } from '../types.js';
import { asImapFlow, FakeImap, makeMessage } from './fake-imap.js';

const source: ImapEndpoint = { host: 'staraya.ru', user: 'ivanov@staraya.ru', pass: 'p' };
const dest: ImapEndpoint = { host: 'novaya.ru', user: 'ivanov@novaya.ru', pass: 'p' };

/** Перенос, который ходит на поддельные серверы вместо настоящих. */
class TestMigrator extends MailboxMigrator {
  constructor(
    options: MigrateMailboxOptions,
    private readonly from: FakeImap,
    private readonly to: FakeImap,
  ) {
    super(options);
  }

  protected override makeClient(endpoint: ImapEndpoint): ImapFlow {
    return asImapFlow(endpoint.host === source.host ? this.from : this.to);
  }
}

/**
 * Хранилище состояния, которое считает обращения к себе.
 *
 * Считаем именно ОБРАЩЕНИЯ: в бою за ними стоит запрос в Postgres, и
 * разница между «один запрос на порцию» и «запрос на письмо» — это
 * разница между «перенос пошёл» и «счётчики стоят десятки минут».
 */
class CountingState implements StateStore {
  /** Запросов «сколько копий этого одного письма» (поштучных). */
  perMessage = 0;
  /** Запросов «сколько копий этих писем» (на порцию). */
  perChunk = 0;
  /** Записи курсора: папка и до какого UID разобрано. */
  readonly cursorWrites: Array<{ folder: string; lastUid: number }> = [];
  /** Порядок событий: по нему видно, что курсор пишется ПО ХОДУ. */
  readonly journal: string[] = [];

  constructor(private readonly inner: StateStore) {}

  async init(): Promise<void> {
    await this.inner.init();
  }
  async wasMigrated(account: string, folder: string, key: string): Promise<boolean> {
    return this.inner.wasMigrated(account, folder, key);
  }
  async migratedCount(account: string, folder: string, key: string): Promise<number> {
    this.perMessage += 1;
    return this.inner.migratedCount(account, folder, key);
  }
  async migratedCounts(
    account: string,
    folder: string,
    keys: string[],
  ): Promise<Map<string, number>> {
    this.perChunk += 1;
    return this.inner.migratedCounts(account, folder, keys);
  }
  async markMigrated(account: string, folder: string, key: string): Promise<void> {
    this.journal.push('письмо');
    await this.inner.markMigrated(account, folder, key);
  }
  async getCursor(account: string, folder: string): Promise<FolderCursor | null> {
    return this.inner.getCursor(account, folder);
  }
  async setCursor(account: string, folder: string, cursor: FolderCursor): Promise<void> {
    this.cursorWrites.push({ folder, lastUid: cursor.lastUid });
    this.journal.push(`курсор ${folder} ${String(cursor.lastUid)}`);
    await this.inner.setCursor(account, folder, cursor);
  }
  async close(): Promise<void> {
    await this.inner.close();
  }
}

/** Папка-источник из n писем с разными Message-ID. */
function inbox(count: number, prefix = 'm'): ReturnType<typeof makeMessage>[] {
  return Array.from({ length: count }, (_, i) => makeMessage(i + 1, `${prefix}${String(i + 1)}@x`));
}

/** Один перенос ящика на поддельных серверах. */
async function migrate(
  from: FakeImap,
  to: FakeImap,
  options: Partial<MigrateMailboxOptions> = {},
): Promise<MailboxReport> {
  return new TestMigrator({ source, dest, ...options }, from, to).run();
}

/** Временный каталог под журнал состояния. */
async function withState<T>(run: (state: CountingState) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-chunk-'));
  const inner = new FileStateStore(join(dir, 'state.jsonl'));
  const state = new CountingState(inner);
  try {
    return await run(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */

test('папка читается порциями: в памяти не бывает больше порции писем', async () => {
  // Ровно то, из-за чего падал процесс: раньше здесь был один FETCH на
  // всю папку, и её метаописания жили в памяти целиком.
  const from = new FakeImap({ INBOX: inbox(5000) });
  const to = new FakeImap({ INBOX: [] });

  const report = await withState((state) => migrate(from, to, { chunkSize: 500, state }));

  assert.equal(report.status, 'ok');
  assert.equal(report.copied, 5000, 'письма обязаны доехать все');
  assert.equal(
    from.biggestFetch,
    500,
    'один FETCH отдал больше порции — значит, папка снова читается целиком',
  );
  assert.equal(from.fetches.length, 10, '5000 писем порциями по 500 — это десять заходов');
  assert.equal(from.downloads, 5000, 'тела читаются по одному: больше одного письма в памяти нет');
});

test('размер порции — настройка, а не выдумка на месте', async () => {
  const from = new FakeImap({ INBOX: inbox(300) });
  const to = new FakeImap({ INBOX: [] });

  await withState((state) => migrate(from, to, { chunkSize: 100, state }));

  assert.equal(from.biggestFetch, 100);
  assert.equal(from.fetches.length, 3);
});

test('курсор записывается после каждой порции, а не в конце папки', async () => {
  // Иначе перезапуск посреди ящика на полмиллиона писем начинает папку
  // заново: он и так начинал её заново — и снова падал по памяти.
  const from = new FakeImap({ INBOX: inbox(1000) });
  const to = new FakeImap({ INBOX: [] });

  const state = await withState(async (state) => {
    await migrate(from, to, { chunkSize: 250, state });
    return state;
  });

  const inboxCursors = state.cursorWrites.filter((c) => c.folder === 'INBOX');
  assert.ok(
    inboxCursors.length >= 4,
    `курсор записан ${String(inboxCursors.length)} раз(а) — порций было четыре`,
  );
  assert.equal(inboxCursors.at(-1)?.lastUid, 1000, 'в конце курсор обязан стоять на последнем UID');

  // Главное: курсор, накрывающий первую порцию, записан ДО того, как
  // поехало последнее письмо. Иначе он не спасает от перезапуска.
  const firstChunkDone = state.journal.indexOf('курсор INBOX 250');
  const lastLetter = state.journal.lastIndexOf('письмо');
  assert.ok(firstChunkDone >= 0, 'курсора на границе первой порции нет вовсе');
  assert.ok(firstChunkDone < lastLetter, 'курсор записан только в конце — порции ничего не дают');
});

test('перезапуск продолжает с записанного курсора, а не читает папку заново', async () => {
  const from = new FakeImap({ INBOX: inbox(600) });
  const to = new FakeImap({ INBOX: [] });

  await withState(async (state) => {
    await migrate(from, to, { chunkSize: 200, state });
    // Пришло ещё 40 писем — продолжение обязано прочитать только их.
    const messages = from.folders.get('INBOX') ?? [];
    for (let i = 601; i <= 640; i++) messages.push(makeMessage(i, `m${String(i)}@x`));
    from.fetches.length = 0;

    const second = await migrate(from, to, { chunkSize: 200, state });
    assert.equal(second.copied, 40, 'докачаться должны только новые письма');
    assert.equal(
      from.fetchedTotal,
      40,
      'прочитано больше сорока писем — значит, папка перечитывается с начала',
    );
  });
});

test('за каждым письмом в базу не ходят: на порцию — один запрос', async () => {
  /*
   * Раньше решение «дубль или нет» принималось запросом на КАЖДОЕ письмо.
   * Папка на 200 тысяч писем — это 200 тысяч оборотов до базы прежде, чем
   * будет скопировано хотя бы одно письмо: экран стоит, счётчики не
   * двигаются, перенос выглядит зависшим. И всё это время занята та самая
   * база, из которой Postfix берёт карты доставки.
   */
  const from = new FakeImap({ INBOX: inbox(3000) });
  const to = new FakeImap({ INBOX: [] });

  await withState(async (state) => {
    await migrate(from, to, { chunkSize: 500, state });
    assert.equal(
      state.perMessage,
      0,
      'поштучный запрос к состоянию не должен выполняться ни разу (было 3000)',
    );

    // Второй проход (дельта в день переключения MX): пришло 700 писем.
    const messages = from.folders.get('INBOX') ?? [];
    for (let i = 3001; i <= 3700; i++) messages.push(makeMessage(i, `m${String(i)}@x`));
    state.perChunk = 0;

    const second = await migrate(from, to, { chunkSize: 500, state });
    assert.equal(second.copied, 700);
    assert.equal(state.perMessage, 0, 'и на дельте тоже — только пачками');
    assert.ok(
      state.perChunk <= 2,
      `запросов к состоянию ${String(state.perChunk)} — их должно быть по одному на порцию`,
    );
  });
});

test('повторный сбор не перечитывает всю папку-приёмник заново', async () => {
  /*
   * Тем же переносом работает сборщик чужой почты — раз в 15 минут.
   * Обход приёмника шёл по всей папке при каждом сборе: ящик на сто тысяч
   * писем означал сто тысяч наборов заголовков каждые четверть часа на
   * пустом ходу, по сети и по диску нашего же Dovecot.
   */
  const from = new FakeImap({ INBOX: inbox(120) });
  const to = new FakeImap({ INBOX: [] });

  await withState(async (state) => {
    await migrate(from, to, { chunkSize: 50, state }); // приёмник наполнился
    const messages = from.folders.get('INBOX') ?? [];
    for (let i = 121; i <= 125; i++) messages.push(makeMessage(i, `m${String(i)}@x`));
    await migrate(from, to, { chunkSize: 50, state }); // здесь приёмник осмотрен целиком

    for (let i = 126; i <= 130; i++) messages.push(makeMessage(i, `m${String(i)}@x`));
    to.fetches.length = 0;
    const third = await migrate(from, to, { chunkSize: 50, state });

    assert.equal(third.copied, 5);
    assert.ok(
      to.fetchedTotal <= 5,
      `в приёмнике прочитано ${String(to.fetchedTotal)} писем из 125 — обход не сокращён`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Порции не имеют права ломать дедупликацию                           */
/* ------------------------------------------------------------------ */

test('второй перенос того же ящика не создаёт дублей', async () => {
  // Даже без хранилища состояния: дедупликация по содержимому приёмника
  // обязана пережить разбор порциями.
  const from = new FakeImap({ INBOX: inbox(150) });
  const to = new FakeImap({ INBOX: [] });

  const first = await migrate(from, to, { chunkSize: 40 });
  const second = await migrate(from, to, { chunkSize: 40 });

  assert.equal(first.copied, 150);
  assert.equal(second.copied, 0, 'второй проход не должен копировать ничего');
  assert.equal(second.skipped, 150);
  assert.equal(
    to.folders.get('INBOX')?.length,
    150,
    'в приёмнике ровно столько писем, сколько было',
  );
});

test('одинаковые письма на границе порций не пропадают', async () => {
  /*
   * Обратная сторона дедупликации, за которую здесь уже платили почтой:
   * Message-ID генерирует отправитель, и он не обязан быть уникальным.
   * Три письма с одним и тем же Message-ID — это три письма, и разрез на
   * порции не имеет права превратить их в одно.
   */
  const from = new FakeImap({
    INBOX: [
      makeMessage(1, 'povtor@x', 'первое'),
      makeMessage(2, 'povtor@x', 'второе'),
      makeMessage(3, 'povtor@x', 'третье'),
    ],
  });
  const to = new FakeImap({ INBOX: [] });

  const report = await withState((state) => migrate(from, to, { chunkSize: 1, state }));

  assert.equal(report.copied, 3, 'письма с повторным Message-ID нельзя объявлять дублями');
  assert.equal(to.folders.get('INBOX')?.length, 3);
});

test('дубль, уже лежащий в приёмнике, второй раз не кладётся', async () => {
  // Обратный ход к предыдущей проверке: пропуск дублей всё ещё работает.
  const to = new FakeImap({ INBOX: [makeMessage(1, 'odno@x')] });
  const from = new FakeImap({ INBOX: [makeMessage(10, 'odno@x'), makeMessage(11, 'drugoe@x')] });

  const report = await withState((state) => migrate(from, to, { chunkSize: 1, state }));

  assert.equal(report.skipped, 1, 'копия уже лежит в приёмнике');
  assert.equal(report.copied, 1);
  assert.equal(to.folders.get('INBOX')?.length, 2);
});
