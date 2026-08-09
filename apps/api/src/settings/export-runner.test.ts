/**
 * Выгрузка ящика: недописанный архив, потерянные папки и потолок размера.
 *
 * ------------------------------------------------------------------
 * ЧТО ЛОМАЛОСЬ
 * ------------------------------------------------------------------
 * Работник умел удалять недописанный архив прошлой попытки — и не удалял
 * никогда. Путь к файлу попадал в запись задания только в finishExport,
 * то есть у ГОТОВОГО архива; у задания в работе он всегда был NULL.
 * Перезапуск контейнера посреди выгрузки оставлял на диске частичную
 * копию ПЕРЕПИСКИ человека: имя нового файла содержит текущее время,
 * старый файл никто не перезаписывал, а уборщик по сроку смотрит только
 * на готовые записи. Знать о таком файле было некому.
 *
 * Проверяется поэтому ровно две вещи: путь к архиву записывается ДО
 * первого байта, и подхваченное заново задание сносит файл прошлой
 * попытки. Настоящий Dovecot не нужен — вход в ящик подменён отказом,
 * и это ближе всего к настоящей причине перезапуска.
 *
 * ------------------------------------------------------------------
 * ОСТАЛЬНОЕ ЗДЕСЬ — ПРО ПОЧТУ, КОТОРОЙ В АРХИВЕ НЕ ОКАЗАЛОСЬ
 * ------------------------------------------------------------------
 * Человек заказывает выгрузку, чтобы забрать СВОЮ почту, и проверяет
 * полноту архива в лучшем случае через месяцы. Поэтому каждая проверка
 * ниже отвечает на один вопрос: если часть писем в архив не попала,
 * узнает ли он об этом — и остаётся ли у него то, что уже собралось.
 * Подставной ящик умеет ровно то, что ломалось на живом сервере: папка
 * без ответа на STATUS, папка, исчезнувшая посреди обхода, и архив,
 * доросший до потолка.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import type { ImapFlow } from 'imapflow';
import type { Folder } from '@mail-true/shared';
import type { AppConfig } from '../config.js';
import type { SettingsConfig } from './config.js';
import { ExportRunner, entryName } from './export-runner.js';
import type { ExportFinishPatch, ExportProgressPatch, ExportRow, OwnerStore } from './owner-db.js';

const logger = pino({ level: 'silent' });

function job(id: number, filePath: string | null): ExportRow {
  return {
    id,
    accountEmail: 'ivan@mail.true',
    state: 'running',
    includeSpam: false,
    includeTrash: false,
    totalMessages: 0,
    doneMessages: 0,
    totalBytes: 0,
    doneBytes: 0,
    skipped: 0,
    filePath,
    fileBytes: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
  };
}

/** Хранилище-подделка: помнит правки и говорит, когда задание закрыто. */
class FakeStore {
  readonly progress: ExportProgressPatch[] = [];
  readonly finished: ExportFinishPatch[] = [];
  #row: ExportRow | null;
  #done: () => void = () => undefined;
  readonly closed: Promise<void>;

  constructor(row: ExportRow) {
    this.#row = row;
    this.closed = new Promise((resolve) => {
      this.#done = resolve;
    });
  }

  listExpiredExports(): Promise<ExportRow[]> {
    return Promise.resolve([]);
  }

  claimExport(): Promise<ExportRow | null> {
    const row = this.#row;
    // Задание берётся в работу ровно один раз — как и настоящим запросом
    // с FOR UPDATE SKIP LOCKED.
    this.#row = null;
    return Promise.resolve(row);
  }

  updateExportProgress(_id: number, patch: ExportProgressPatch): Promise<void> {
    this.progress.push(patch);
    return Promise.resolve();
  }

  finishExport(_id: number, patch: ExportFinishPatch): Promise<void> {
    this.finished.push(patch);
    this.#done();
    return Promise.resolve();
  }

  findExport(): Promise<ExportRow | null> {
    return Promise.resolve(null);
  }
}

async function runOnce(
  row: ExportRow,
  options: {
    /** Чем открывать ящик. По умолчанию — отказ входа. */
    connect?: () => Promise<ImapFlow>;
    /** Потолок архива: маленький — чтобы упереться в него на трёх письмах. */
    maxBytes?: number;
  } = {},
): Promise<{ store: FakeStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-export-'));
  const store = new FakeStore(row);
  const runner = new ExportRunner({
    config: {} as AppConfig,
    settings: {
      MAILBOX_EXPORT_DIR: dir,
      MAILBOX_EXPORT_CONCURRENCY: 1,
      MAILBOX_EXPORT_MAX_BYTES: options.maxBytes ?? 1024 * 1024,
      MAILBOX_EXPORT_TTL_HOURS: 24,
      MAILBOX_EXPORT_TICK_MS: 1000,
    } as SettingsConfig,
    logger,
    store: store as unknown as OwnerStore,
    master: null,
    // Настоящая причина, по которой задание подхватывается заново, —
    // упавший процесс или недоступный Dovecot. Её и воспроизводим.
    connect: options.connect ?? (() => Promise.reject(new Error('Dovecot недоступен'))),
  });

  await runner.tick();
  await store.closed;
  return { store, dir };
}

/* ------------------------------------------------------------------ */
/* Подставной ящик                                                      */
/* ------------------------------------------------------------------ */

interface FakeFolder {
  path: string;
  messages: Array<{ uid: number; source: string }>;
  /**
   * Сервер не ответил на STATUS этой папки.
   *
   * Не выдумка: STATUS отказывает при повреждённом индексе, при
   * переименовании папки прямо сейчас и при отказе в доступе. Счётчик
   * тогда взять негде — и раньше он молча становился нулём.
   */
  statusFails?: boolean;
  /** Папки больше нет: SELECT по ней бросает. */
  gone?: boolean;
}

/** Письмо ровно такого размера, чтобы считать байты в проверке потолка. */
function letter(uid: number, bytes = 400): { uid: number; source: string } {
  return { uid, source: `Subject: Письмо ${String(uid)}\r\n\r\n${'.'.repeat(bytes)}` };
}

class FakeImap {
  #selected = '';
  constructor(readonly folders: FakeFolder[]) {}

  #find(path: string): FakeFolder {
    const folder = this.folders.find((f) => f.path === path);
    if (!folder) throw new Error(`нет такой папки: ${path}`);
    return folder;
  }

  get client(): ImapFlow {
    const self = this;
    const api = {
      list() {
        return Promise.resolve(
          self.folders.map((folder) => ({
            path: folder.path,
            name: folder.path,
            delimiter: '/',
            parentPath: '',
            flags: new Set<string>(),
            // Сервер с LIST-STATUS отвечает счётчиками сразу; папка, по
            // которой STATUS не проходит, приезжает без них.
            status: folder.statusFails
              ? undefined
              : { messages: folder.messages.length, unseen: 0, uidValidity: 1n },
          })),
        );
      },
      status(path: string) {
        const folder = self.#find(path);
        if (folder.statusFails) return Promise.reject(new Error('STATUS не прошёл'));
        return Promise.resolve({
          messages: folder.messages.length,
          unseen: 0,
          uidValidity: 1n,
        });
      },
      getMailboxLock(path: string) {
        const folder = self.#find(path);
        if (folder.gone) return Promise.reject(new Error('Mailbox does not exist'));
        self.#selected = path;
        return Promise.resolve({ release: () => undefined });
      },
      async *fetch() {
        for (const msg of self.#find(self.#selected).messages) {
          yield {
            uid: msg.uid,
            source: Buffer.from(msg.source, 'utf8'),
            size: msg.source.length,
            envelope: { subject: `Письмо ${String(msg.uid)}`, date: new Date('2026-08-01') },
          };
        }
      },
      logout() {
        return Promise.resolve();
      },
      on() {
        return api;
      },
    };
    return api as unknown as ImapFlow;
  }
}

/** Сколько писем задание записало в архив по своей последней отметке. */
function doneMessages(store: FakeStore): number {
  const reports = store.progress.filter((p) => p.doneMessages !== undefined);
  return reports[reports.length - 1]?.doneMessages ?? 0;
}

test('путь к архиву записывается в задание до первого байта', async () => {
  const { store, dir } = await runOnce(job(7, null));

  const recorded = store.progress.find((p) => typeof p.filePath === 'string');
  assert.ok(
    recorded,
    'у задания в работе путь к архиву остался NULL — недописанный файл будет некому найти',
  );
  assert.ok(recorded.filePath?.startsWith(dir), 'путь ведёт в каталог выгрузок');
  assert.equal(store.finished[0]?.state, 'failed');
});

test('подхваченное заново задание сносит недописанный архив прошлой попытки', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mt-export-old-'));
  const stale = join(dir, '7-1000.zip');
  await writeFile(stale, 'кусок настоящей переписки');
  assert.ok((await stat(stale)).isFile(), 'файл прошлой попытки должен существовать до прохода');

  const { dir: workDir } = await runOnce(job(7, stale));

  await assert.rejects(() => stat(stale), 'частичный архив остался на диске');
  // За собой работник тоже убирает: отказ входа не оставляет мусора.
  assert.deepEqual(await readdir(workDir), []);
});

/*
 * Папка, счётчик которой не прочитался, ВЫПАДАЛА ИЗ АРХИВА МОЛЧА.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Обход начинался с `if (folder.totalCount === 0) continue`, а счётчик
 * берётся из STATUS, который может и не пройти. В этом случае «не смогли
 * прочитать» и «пусто» были одним и тем же нулём — папка пропускалась
 * целиком. Наружу не выходило НИЧЕГО: полоска доходила до 100%, задание
 * становилось «Готово», единственный признак потерь на экране (`skipped`)
 * не рос, а в ЧИТАТЬ.txt было написано «писем: 0». Человек забирал «всю
 * свою почту» — и папки в архиве не было.
 */
void test('папка, счётчик которой не прочитался, попадает в архив, а не выпадает молча', async () => {
  const box = new FakeImap([
    { path: 'INBOX', messages: [letter(1)] },
    { path: 'Договоры', statusFails: true, messages: [letter(2), letter(3)] },
  ]);

  const { store } = await runOnce(job(11, null), { connect: () => Promise.resolve(box.client) });

  assert.equal(store.finished[0]?.state, 'ready');
  assert.equal(
    doneMessages(store),
    3,
    'письма папки, чей счётчик не ответил, в архив не попали — и никто об этом не узнал',
  );
});

/*
 * Одна исчезнувшая папка обрушивала весь многочасовой архив.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Список папок снимается один раз, а обход идёт часами: за это время
 * папку могло не стать (правило фильтрации, телефон, переименование).
 * `getMailboxLock` на исчезнувшей папке бросает, и это исключение
 * долетало до общего разбора, где `zip.abort()`, `rm(file)` и состояние
 * 'failed'. Для отдельного ПИСЬМА отказ намеренно не ронял архив — для
 * папки такой мысли не было, и любая перестановка папок во время
 * выгрузки стирала часы работы. Повторная попытка стоила тех же часов.
 */
void test('исчезнувшая папка не уносит с собой уже собранный архив', async () => {
  const box = new FakeImap([
    { path: 'INBOX', messages: [letter(1), letter(2)] },
    { path: 'Договоры', gone: true, messages: [letter(3)] },
  ]);

  const { store, dir } = await runOnce(job(12, null), {
    connect: () => Promise.resolve(box.client),
  });

  const finished = store.finished[0];
  assert.equal(finished?.state, 'ready', 'одна пропавшая папка стёрла весь архив');
  assert.equal(doneMessages(store), 2, 'прочитанное обязано остаться в архиве');
  assert.match(
    finished?.lastError ?? '',
    /Договоры/u,
    'молчать о непрочитанной папке нельзя: человек считает, что забрал всю почту',
  );
  assert.equal((await readdir(dir)).length, 1, 'файл архива должен остаться на диске');
});

/*
 * Потолок размера был тупиком: архив стирался, а совет в отказе — невыполним.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Дойдя до MAILBOX_EXPORT_MAX_BYTES, работник бросал исключение, общий
 * разбор сносил файл и ставил 'failed', а в тексте отказа советовалось
 * «выгрузите по частям, например без Спама и Корзины». Выбрать при заказе
 * можно ровно эти две вещи, и обе по умолчанию уже выключены — то есть
 * ящик крупнее потолка выгрузить было нельзя никак, и каждая попытка
 * стирала часы работы. Теперь собранное сохраняется и его можно скачать.
 */
void test('архив, доросший до потолка, сохраняется, а не выбрасывается', async () => {
  const box = new FakeImap([
    { path: 'INBOX', messages: [letter(1), letter(2), letter(3)] },
    { path: 'Договоры', messages: [letter(4)] },
  ]);

  const { store, dir } = await runOnce(job(13, null), {
    connect: () => Promise.resolve(box.client),
    // Одного письма хватит, чтобы перешагнуть потолок.
    maxBytes: 200,
  });

  const finished = store.finished[0];
  assert.equal(finished?.state, 'ready', 'работа на потолке выбрасывалась целиком');
  assert.equal((await readdir(dir)).length, 1, 'архив должен остаться на диске');
  assert.ok(doneMessages(store) > 0, 'в архив обязано попасть то, что успело поместиться');
  assert.match(finished?.lastError ?? '', /потолк/u, 'причина обязана быть на экране');
  assert.match(
    finished?.lastError ?? '',
    /Договоры/u,
    'человек должен узнать, каких именно папок в архиве нет',
  );
  assert.doesNotMatch(
    finished?.lastError ?? '',
    /без «Спама» и «Корзины»/u,
    'совет исключить то, что и так не включалось, — тупик',
  );
});

/*
 * Путь папки в архиве резался ещё и по точке.
 *
 * Разделитель у нашего Dovecot только «/», а точка в имени папки не
 * запрещена ничем — так называют папки те, кто раскладывает почту по
 * доменам и номерам договоров. Папка «vip.клиенты» давала тот же каталог,
 * что настоящая «vip/клиенты», номера писем в разных папках совпадают
 * сплошь и рядом — и распаковщик молча клал одно письмо поверх другого.
 */
void test('папка с точкой в имени не сливается с вложенной папкой', async () => {
  const folder = (path: string): Folder => ({
    id: path,
    path,
    name: path,
    role: 'custom',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 1,
    system: false,
    uidValidity: 1,
  });

  const dotted = entryName(folder('vip.клиенты'), 42, 'Договор');
  const nested = entryName(folder('vip/клиенты'), 42, 'Договор');

  assert.notEqual(dotted, nested, 'два разных письма получали одно имя файла в архиве');
  assert.ok(dotted.startsWith('vip.клиенты/'), 'имя папки обязано остаться таким, как в ящике');
  assert.ok(nested.startsWith('vip/клиенты/'), 'вложенная папка обязана остаться каталогом');
});
