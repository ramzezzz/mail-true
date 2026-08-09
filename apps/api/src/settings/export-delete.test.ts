/**
 * Готовый архив выгрузки можно убрать с сервера сразу.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Убрать его было нечем. Отмена работает только с выгрузкой, которая ещё
 * собирается (`queued`/`running`), а готовый файл лежал до истечения срока
 * хранения — по умолчанию двое суток. В нём вся переписка ящика в открытом
 * виде, и за это время он попадает в каждую резервную копию сервера.
 *
 * Человек, который заказал выгрузку и скачал её себе, закрыть за собой
 * дверь не мог никак: оставалось просить администратора лезть в том с
 * файлами. При этом в соседнем разделе («Восстановление писем») кнопка
 * «Удалить всё сейчас» есть ровно с этим смыслом.
 *
 * Найдено живой проверкой на сервере: заказал выгрузку, скачал, полез
 * убирать — и убирать оказалось нечем.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerErrorHandling } from '../http-errors.js';
import { ownerRoutes } from './owner-routes.js';
import type { ExportRow, ExportState } from './owner-db.js';

/** Хранилище заданий выгрузки в памяти — ровно то, чем пользуется маршрут. */
class FakeExportStore {
  rows = new Map<number, ExportRow>();

  add(row: Partial<ExportRow> & { id: number; accountEmail: string }): ExportRow {
    const full: ExportRow = {
      id: row.id,
      accountEmail: row.accountEmail,
      state: row.state ?? 'ready',
      includeSpam: false,
      includeTrash: false,
      totalMessages: 3,
      doneMessages: 3,
      doneBytes: 100,
      skipped: 0,
      fileBytes: 100,
      filePath: row.filePath ?? null,
      error: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      runner: null,
      heartbeatAt: null,
      totalBytes: 100,
      lastError: null,
    } as unknown as ExportRow;
    this.rows.set(row.id, full);
    return full;
  }

  async findExport(id: number): Promise<ExportRow | null> {
    return this.rows.get(id) ?? null;
  }

  async listExports(email: string): Promise<ExportRow[]> {
    return [...this.rows.values()].filter((r) => r.accountEmail === email);
  }

  async finishExport(
    id: number,
    patch: { state: ExportState; filePath?: string | null },
  ): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.state = patch.state;
    if (patch.filePath !== undefined) row.filePath = patch.filePath;
  }
}

async function harness(email: string): Promise<{ app: FastifyInstance; store: FakeExportStore }> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const store = new FakeExportStore();
  registerErrorHandling(app);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email, password: 'x' };
  });
  app.decorate('deps', {} as unknown as FastifyInstance['deps']);
  await app.register(
    async (api) => {
      await ownerRoutes(api, {
        settings: { MAILBOX_EXPORT_ENABLED: true, MAILBOX_EXPORT_TTL_HOURS: 48 } as never,
        store: store as never,
        ready: { access: true, export: true, recovery: true },
        reasons: { access: null, export: null, recovery: null },
        exportRunner: { available: true } as never,
        recovery: { sweep: async () => ({ removed: 0, kept: 0, restoreUntil: null }) } as never,
        serviceAddresses: { has: () => false } as never,
      } as never);
    },
    { prefix: '/api/settings' },
  );
  await app.ready();
  return { app, store };
}

test('удаление готового архива стирает файл с диска и закрывает право скачать', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-export-'));
  const file = path.join(dir, 'archive.zip');
  await writeFile(file, 'письма');

  const { app, store } = await harness('ivan@mail.local');
  store.add({ id: 7, accountEmail: 'ivan@mail.local', filePath: file });
  try {
    const res = await app.inject({ method: 'DELETE', url: '/api/settings/export/7' });
    assert.equal(res.statusCode, 200, res.body);

    await assert.rejects(() => access(file), 'файл архива остался на диске');
    assert.equal(store.rows.get(7)?.state, 'expired');
    assert.equal(store.rows.get(7)?.filePath, null);

    // Скачать после удаления нечего — и об этом говорится прямо.
    const download = await app.inject({ method: 'GET', url: '/api/settings/export/7/file' });
    assert.equal(download.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('чужую выгрузку удалить нельзя — её как будто и нет', async () => {
  const { app, store } = await harness('ivan@mail.local');
  store.add({ id: 8, accountEmail: 'anna@mail.local', filePath: null });
  try {
    const res = await app.inject({ method: 'DELETE', url: '/api/settings/export/8' });
    assert.equal(res.statusCode, 404, 'чужое задание отдалось на удаление');
    assert.equal(store.rows.get(8)?.state, 'ready', 'чужая выгрузка изменилась');
  } finally {
    await app.close();
  }
});

test('идущую выгрузку удалять не предлагаем: сначала отмена', async () => {
  const { app, store } = await harness('ivan@mail.local');
  store.add({ id: 9, accountEmail: 'ivan@mail.local', state: 'running', filePath: null });
  try {
    const res = await app.inject({ method: 'DELETE', url: '/api/settings/export/9' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /отмен/i, 'человеку не сказано, что делать вместо этого');
  } finally {
    await app.close();
  }
});
