/**
 * Недописанный архив выгрузки после перезапуска процесса.
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
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import type { AppConfig } from '../config.js';
import type { SettingsConfig } from './config.js';
import { ExportRunner } from './export-runner.js';
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

async function runOnce(row: ExportRow): Promise<{ store: FakeStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-export-'));
  const store = new FakeStore(row);
  const runner = new ExportRunner({
    config: {} as AppConfig,
    settings: {
      MAILBOX_EXPORT_DIR: dir,
      MAILBOX_EXPORT_CONCURRENCY: 1,
      MAILBOX_EXPORT_MAX_BYTES: 1024 * 1024,
      MAILBOX_EXPORT_TTL_HOURS: 24,
      MAILBOX_EXPORT_TICK_MS: 1000,
    } as SettingsConfig,
    logger,
    store: store as unknown as OwnerStore,
    master: null,
    // Настоящая причина, по которой задание подхватывается заново, —
    // упавший процесс или недоступный Dovecot. Её и воспроизводим.
    connect: () => Promise.reject(new Error('Dovecot недоступен')),
  });

  await runner.tick();
  await store.closed;
  return { store, dir };
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
