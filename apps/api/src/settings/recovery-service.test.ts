/**
 * Восстановление после очистки корзины — на подставном ящике и хранилище
 * в памяти.
 *
 * Проверяется то, что ломается молча и дорого:
 *
 *   * очистка корзины НЕ удаляет письма, пока срок хранения включён;
 *   * при выключенном сроке поведение прежнее — удалять сразу;
 *   * сервер без подтверждения номеров (нет UIDPLUS) не должен порождать
 *     обещание вернуть письмо, которого мы не записали;
 *   * письмо, унесённое из служебной папки мимо нас, закрывает запись
 *     молча, а не роняет возврат всех остальных;
 *   * работник удаляет ровно то, чему вышел срок.
 *
 * Настоящий Dovecot для этого не нужен и был бы вреден: проверить «что
 * будет, если сервер не подтвердит перенос» на живом сервере нельзя.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import type { Folder } from '@mail-true/shared';
import type { AppConfig } from '../config.js';
import type { SettingsConfig } from './config.js';
import type {
  AccessInsert,
  AccessRow,
  ExportRow,
  OwnerStore,
  RecoveryInsert,
  RecoveryRow,
  RecoveryState,
} from './owner-db.js';
import { RecoveryService } from './recovery-service.js';

/** Набор номеров списком: строку `1,4:6` разворачиваем в числа. */
function uidsOf(range: string | number[]): number[] {
  if (Array.isArray(range)) return range;
  const out: number[] = [];
  for (const part of range.split(',')) {
    const [from, to] = part.split(':');
    const start = Number(from);
    const end = to === undefined ? start : Number(to);
    for (let uid = start; uid <= end; uid += 1) out.push(uid);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Подставное хранилище                                                 */
/* ------------------------------------------------------------------ */

class MemoryStore implements OwnerStore {
  rows: RecoveryRow[] = [];
  days = new Map<string, number>();
  #next = 1;

  accessReady(): Promise<boolean> {
    return Promise.resolve(true);
  }
  exportReady(): Promise<boolean> {
    return Promise.resolve(true);
  }
  recoveryReady(): Promise<boolean> {
    return Promise.resolve(true);
  }
  addAccess(_entry: AccessInsert): Promise<void> {
    return Promise.resolve();
  }
  listAccess(): Promise<AccessRow[]> {
    return Promise.resolve([]);
  }
  purgeAccess(): Promise<number> {
    return Promise.resolve(0);
  }
  purgeClosedHistory(): Promise<number> {
    return Promise.resolve(0);
  }
  createExport(): Promise<ExportRow> {
    throw new Error('не нужно в этой проверке');
  }
  listExports(): Promise<ExportRow[]> {
    return Promise.resolve([]);
  }
  findExport(): Promise<ExportRow | null> {
    return Promise.resolve(null);
  }
  claimExport(): Promise<ExportRow | null> {
    return Promise.resolve(null);
  }
  updateExportProgress(): Promise<void> {
    return Promise.resolve();
  }
  finishExport(): Promise<void> {
    return Promise.resolve();
  }
  listExpiredExports(): Promise<ExportRow[]> {
    return Promise.resolve([]);
  }
  runningExports(): Promise<number> {
    return Promise.resolve(0);
  }

  getRecoveryDays(email: string): Promise<number | null> {
    return Promise.resolve(this.days.get(email.toLowerCase()) ?? null);
  }
  setRecoveryDays(email: string, days: number): Promise<void> {
    this.days.set(email.toLowerCase(), days);
    return Promise.resolve();
  }

  addRecovery(entry: RecoveryInsert): Promise<void> {
    this.rows.push({
      id: this.#next++,
      accountEmail: entry.accountEmail,
      recoveryPath: entry.recoveryPath,
      recoveryUid: entry.recoveryUid,
      recoveryUidValidity: entry.recoveryUidValidity,
      originPath: entry.originPath,
      messageId: entry.messageId,
      subject: entry.subject,
      fromAddress: entry.fromAddress,
      sentAt: entry.sentAt?.toISOString() ?? null,
      sizeBytes: entry.sizeBytes,
      deletedAt: new Date().toISOString(),
      purgeAt: entry.purgeAt.toISOString(),
      state: 'pending',
      attempts: 0,
      lastError: null,
    });
    return Promise.resolve();
  }
  /** Отказ записи — им проверяется откат переноса. */
  failWrites = false;

  async addRecoveryBatch(entries: readonly RecoveryInsert[]): Promise<void> {
    if (this.failWrites) throw new Error('база недоступна');
    for (const entry of entries) await this.addRecovery(entry);
  }

  listRecovery(email: string): Promise<RecoveryRow[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.state === 'pending' && r.accountEmail === email),
    );
  }
  recoveryTotals(email: string): Promise<{ count: number; bytes: number }> {
    const live = this.rows.filter((r) => r.state === 'pending' && r.accountEmail === email);
    return Promise.resolve({
      count: live.length,
      bytes: live.reduce((s, r) => s + r.sizeBytes, 0),
    });
  }
  findRecovery(email: string, ids: number[]): Promise<RecoveryRow[]> {
    return Promise.resolve(
      this.rows.filter(
        (r) => r.state === 'pending' && r.accountEmail === email && ids.includes(r.id),
      ),
    );
  }
  listRecoveryDue(now: Date): Promise<RecoveryRow[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.state === 'pending' && new Date(r.purgeAt) < now),
    );
  }
  closeRecovery(id: number, state: Exclude<RecoveryState, 'pending'>): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row && row.state === 'pending') row.state = state;
    return Promise.resolve();
  }
  markRecoveryAttempt(id: number, error: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.attempts += 1;
      row.lastError = error;
    }
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------------ */
/* Подставной ящик                                                      */
/* ------------------------------------------------------------------ */

interface FakeMessage {
  uid: number;
  subject: string;
  size: number;
  messageId: string;
}

/**
 * Ящик из двух папок: «Trash» и служебная «Recovery».
 *
 * Умеет ровно то, что зовёт служба, и запоминает ПОРЯДОК вызовов —
 * именно порядок здесь и проверяется.
 */
class FakeMailbox {
  folders = new Map<string, FakeMessage[]>([
    ['Trash', []],
    ['Recovery', []],
  ]);
  calls: string[] = [];
  /** Сервер не поддерживает UIDPLUS: MOVE не отвечает соответствием номеров. */
  noUidPlus = false;
  /** На какой по счёту команде переноса ответить отказом (0 — никогда). */
  failMoveAtCall = 0;
  /**
   * Сервер отказывает в переносе и в удалении — БЕЗ исключения.
   *
   * Так и ведёт себя imapflow: `messageMove` и `messageDelete` при неудаче
   * возвращают `false` (ящик у квоты, папку удалили из соседней вкладки,
   * слишком длинный аргумент), а бросает у него только APPEND. Изобразить
   * это на живом Dovecot нельзя, и ровно поэтому такие отказы дважды
   * проходили мимо кода.
   */
  refuseMoves = false;
  refuseDeletes = false;
  /** Сколько команд переноса уже прошло — для нарезки длинных списков. */
  moveCalls = 0;
  #selected = 'Trash';
  #nextUid = 100;

  seedTrash(count: number): void {
    const list = this.folders.get('Trash')!;
    for (let i = 1; i <= count; i += 1) {
      list.push({ uid: i, subject: `Письмо ${i}`, size: 1000 * i, messageId: `m${i}@t` });
    }
  }

  get client(): ImapFlow {
    const self = this;
    const api = {
      async getMailboxLock(path: string) {
        self.calls.push(`lock:${path}`);
        self.#selected = path;
        return { release: () => self.calls.push(`unlock:${path}`) };
      },
      async status(path: string) {
        if (!self.folders.has(path)) throw new Error('нет такой папки');
        return { messages: self.folders.get(path)!.length, uidValidity: 42 };
      },
      async mailboxCreate(path: string) {
        self.folders.set(path, []);
      },
      async mailboxSubscribe() {
        return true;
      },
      async list() {
        return [...self.folders.keys()].map((path) => ({
          path,
          name: path,
          delimiter: '/',
          parentPath: '',
          flags: new Set<string>(),
          status: { messages: self.folders.get(path)!.length, unseen: 0, uidValidity: 42n },
        }));
      },
      async search(query: { uid?: string; header?: Record<string, string> }) {
        const list = self.folders.get(self.#selected)!;
        if (query.header) {
          const id = Object.values(query.header)[0];
          return list.filter((m) => m.messageId === id).map((m) => m.uid);
        }
        const wanted = new Set(
          String(query.uid ?? '')
            .split(',')
            .flatMap((part) => {
              const [from, to] = part.split(':').map(Number);
              if (to === undefined) return [from!];
              const out: number[] = [];
              for (let i = from!; i <= to; i += 1) out.push(i);
              return out;
            }),
        );
        return list.filter((m) => wanted.has(m.uid)).map((m) => m.uid);
      },
      async *fetch(uids: number[]) {
        const list = self.folders.get(self.#selected)!;
        for (const msg of list.filter((m) => uids.includes(m.uid))) {
          yield {
            uid: msg.uid,
            size: msg.size,
            envelope: {
              subject: msg.subject,
              messageId: `<${msg.messageId}>`,
              from: [{ address: 'a@b' }],
              date: new Date('2026-08-01T00:00:00Z'),
            },
          };
        }
      },
      /*
       * Номера приходят набором вида `1,4:6` — так их шлёт и настоящий
       * imapflow, и наш код (длинный список режется на команды-диапазоны:
       * Dovecot отвергает слишком длинный аргумент). Заглушка, умевшая
       * только массив чисел, на такой строке падала.
       */
      async messageMove(range: string | number[], target: string) {
        const uids = uidsOf(range);
        self.calls.push(`move:${self.#selected}->${target}:${uids.join(',')}`);
        // Отказ на N-й по счёту команде: так изображается обрыв связи
        // посреди нарезки длинного списка номеров.
        self.moveCalls += 1;
        if (self.refuseMoves) return false;
        if (self.failMoveAtCall === self.moveCalls) return false;
        const from = self.folders.get(self.#selected)!;
        const to = self.folders.get(target)!;
        const uidMap = new Map<number, number>();
        for (const uid of uids) {
          const at = from.findIndex((m) => m.uid === uid);
          if (at < 0) continue;
          const [msg] = from.splice(at, 1);
          const newUid = self.#nextUid++;
          to.push({ ...msg!, uid: newUid });
          uidMap.set(uid, newUid);
        }
        return self.noUidPlus ? {} : { uidMap, uidValidity: 42 };
      },
      async messageDelete(rangeOrUids: string | number[]) {
        const uids = uidsOf(rangeOrUids);
        self.calls.push(`delete:${self.#selected}:${uids.join(',')}`);
        if (self.refuseDeletes) return false;
        const list = self.folders.get(self.#selected)!;
        for (const uid of uids) {
          const at = list.findIndex((m) => m.uid === uid);
          if (at >= 0) list.splice(at, 1);
        }
        return true;
      },
      async logout() {
        return undefined;
      },
      on() {
        return api;
      },
    };
    return api as unknown as ImapFlow;
  }
}

const TRASH: Folder = {
  id: 'trash',
  path: 'Trash',
  name: 'Trash',
  role: 'trash',
  parentId: null,
  depth: 0,
  unreadCount: 0,
  totalCount: 0,
  system: true,
  uidValidity: 42,
};

const SILENT = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

function service(store: MemoryStore | null, mailbox?: FakeMailbox): RecoveryService {
  return new RecoveryService({
    config: { IMAP_HOST: 'x', IMAP_PORT: 143, IMAP_SECURE: false } as unknown as AppConfig,
    settings: { TRASH_RECOVERY_MAX_DAYS: 30, TRASH_RECOVERY_TICK_MS: 60_000 } as SettingsConfig,
    logger: SILENT,
    store,
    master: { user: 'mtadmin', password: 'x', separator: '*' },
    connect: mailbox ? async () => mailbox.client : undefined,
  });
}

/* ------------------------------------------------------------------ */

test('очистка корзины переносит письма, а не удаляет их', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  box.seedTrash(3);
  const svc = service(store);

  const result = await svc.sweep(box.client, 'test@mail.local', TRASH, [1, 2, 3], 7);

  assert.equal(result.kept, 3);
  assert.equal(result.removed, 0);
  assert.equal(box.folders.get('Trash')!.length, 0, 'корзина должна опустеть');
  assert.equal(box.folders.get('Recovery')!.length, 3, 'письма должны быть целы');
  assert.equal(store.rows.length, 3, 'на каждое письмо должна быть запись со сроком');
  // Ни одного удаления: в этом вся возможность.
  assert.ok(!box.calls.some((c) => c.startsWith('delete:')));
  // Порядок: сперва перенос, потом запись. Иначе появилась бы запись
  // о письме, которого в служебной папке нет.
  assert.ok(box.calls.some((c) => c.startsWith('move:Trash->Recovery')));
});

/*
 * Письма к моменту записи УЖЕ в служебной папке «Recovery», а она скрыта
 * из дерева папок. Пока о письме нет строки в базе, его не видно нигде:
 * ни в почте, ни в разделе «Восстановление писем» (он строится по базе),
 * и работник удаления по сроку его тоже не найдёт — он читает ту же базу.
 * То есть письмо лежит на диске вечно, ест квоту и считается удалённым.
 *
 * Раньше записи создавались по одной в цикле: на корзине в тысячи писем
 * — тысячи запросов подряд, и любой сбой посреди цикла оставлял остаток
 * перенесённым и незаписанным.
 */
test('не удалось записать сроки — письма возвращаются в корзину', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  box.seedTrash(3);
  store.failWrites = true;

  await assert.rejects(
    service(store).sweep(box.client, 'test@mail.local', TRASH, [1, 2, 3], 7),
    /база недоступна/,
  );

  assert.equal(store.rows.length, 0, 'записей нет — значит и писем в «Recovery» быть не должно');
  assert.equal(
    box.folders.get('Recovery')!.length,
    0,
    'письма остались в скрытой папке: их не видно нигде и они не удалятся никогда',
  );
  assert.equal(box.folders.get('Trash')!.length, 3, 'письма обязаны вернуться в корзину');
  // Возврат — это перенос обратно, а не удаление.
  assert.ok(box.calls.some((c) => c.startsWith('move:Recovery->Trash')));
  assert.ok(!box.calls.some((c) => c.startsWith('delete:')));
});

test('срок хранения ноль — служба не сохраняет ничего', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  box.seedTrash(2);
  const result = await service(store).sweep(box.client, 'test@mail.local', TRASH, [1, 2], 0);
  assert.deepEqual(result, { kept: 0, removed: 0, restoreUntil: null });
  assert.equal(store.rows.length, 0);
  assert.equal(box.folders.get('Trash')!.length, 2, 'решение принимает вызывающий, а не служба');
});

test('без подтверждения номеров сервером письма не обещаются к возврату', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  box.noUidPlus = true;
  box.seedTrash(2);
  const result = await service(store).sweep(box.client, 'test@mail.local', TRASH, [1, 2], 7);
  assert.equal(result.kept, 0);
  assert.equal(result.removed, 2);
  assert.equal(store.rows.length, 0, 'записи без подтверждённых номеров бесполезны');
});

test('восстановление возвращает письмо в корзину и закрывает запись', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  box.seedTrash(2);
  const svc = service(store);
  await svc.sweep(box.client, 'test@mail.local', TRASH, [1, 2], 7);

  const ids = store.rows.map((r) => r.id);
  const result = await svc.restore(box.client, 'test@mail.local', ids);

  assert.equal(result.restored, 2);
  assert.equal(result.missing, 0);
  assert.equal(box.folders.get('Trash')!.length, 2);
  assert.equal(box.folders.get('Recovery')!.length, 0);
  assert.ok(store.rows.every((r) => r.state === 'restored'));
});

test('письмо, унесённое мимо нас, закрывает запись молча', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  box.seedTrash(2);
  const svc = service(store);
  await svc.sweep(box.client, 'test@mail.local', TRASH, [1, 2], 7);

  // Человек удалил письмо из служебной папки почтовой программой.
  box.folders.get('Recovery')!.shift();

  const result = await svc.restore(
    box.client,
    'test@mail.local',
    store.rows.map((r) => r.id),
  );
  assert.equal(result.restored, 1);
  assert.equal(result.missing, 1, 'пропавшее письмо не должно останавливать остальные');
  assert.equal(store.rows[0]!.state, 'gone');
});

/*
 * Возврат письма, который сервер НЕ выполнил, — потеря письма навсегда.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Перенос делался голым `client.messageMove`, а его ответ выбрасывался.
 * imapflow при отказе MOVE не бросает — он возвращает `false`, и отказать
 * может буднично: ящик у квоты, корзину удалили из соседней вкладки.
 * Сразу за переносом стояло `closeRecovery(row.id, 'restored')`, а по
 * состоянию 'pending' работают ВСЕ выборки: и список раздела, и работник
 * удаления по сроку. Письмо оставалось в служебной папке «Recovery»,
 * скрытой из дерева папок: ответ «Восстановлено писем: N», запись в
 * журнале — и письма нет ни в корзине, ни в разделе восстановления, ни в
 * дереве. Найти и удалить его не мог уже никто: квота занята навсегда.
 */
void test('письмо, которое сервер отказался вернуть, остаётся в списке возвращаемых', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  box.seedTrash(2);
  const svc = service(store);
  await svc.sweep(box.client, 'test@mail.local', TRASH, [1, 2], 7);

  // Ящик у квоты: MOVE отвечает отказом, а не исключением.
  box.refuseMoves = true;
  const result = await svc.restore(
    box.client,
    'test@mail.local',
    store.rows.map((r) => r.id),
  );

  assert.equal(result.restored, 0, 'сервер не перенёс ни одного письма — обещать возврат нельзя');
  assert.equal(result.failed, 2);
  assert.equal(box.folders.get('Recovery')!.length, 2, 'письма и правда остались на месте');
  assert.equal(box.folders.get('Trash')!.length, 0);
  assert.ok(
    store.rows.every((r) => r.state === 'pending'),
    'закрытая запись = письмо в скрытой папке, невидимое всем и вечное',
  );

  // Отказ прошёл — повторить можно той же кнопкой, письма на месте.
  box.refuseMoves = false;
  const again = await svc.restore(
    box.client,
    'test@mail.local',
    store.rows.map((r) => r.id),
  );
  assert.equal(again.restored, 2);
  assert.equal(box.folders.get('Trash')!.length, 2);
});

/*
 * «Удалить всё сейчас» отчитывалось об удалении писем, которые остались.
 *
 * `messageDelete` (EXPUNGE) у imapflow при неудаче тоже возвращает
 * `false`, а не бросает; try/catch вокруг ловил только исключения. Запись
 * закрывалась как 'purged', человек читал «Удалено окончательно: N» — и
 * место в ящике не освобождалось. Тем же путём идёт удаление по сроку,
 * поэтому такие письма не удалялись уже никогда: их запись закрыта, и
 * следующий проход работника их не выберет.
 */
void test('письма, которые сервер отказался удалить, не считаются удалёнными', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  box.seedTrash(3);
  const svc = service(store, box);
  await svc.sweep(box.client, 'test@mail.local', TRASH, [1, 2, 3], 7);

  box.refuseDeletes = true;
  const result = await svc.purgeNow(box.client, 'test@mail.local', 'all');

  assert.equal(result.purged, 0, 'ответ «удалено N» о письмах, которые на месте, — ложь');
  assert.equal(result.failed, 3);
  assert.equal(box.folders.get('Recovery')!.length, 3, 'письма никуда не делись');
  assert.deepEqual(
    await svc.totals('test@mail.local'),
    { count: 3, bytes: 1000 + 2000 + 3000 },
    'квота не освободилась, и раздел обязан показывать это тем же числом',
  );

  // Записи живы — значит, сработает и повтор, и удаление по сроку.
  box.refuseDeletes = false;
  assert.equal((await svc.purgeNow(box.client, 'test@mail.local', 'all')).purged, 3);
});

/*
 * Тот же отказ у работника: срок вышел, а сервер удалить не смог.
 * Запись обязана остаться живой — иначе письмо не удалит уже ничто.
 */
void test('несостоявшееся удаление по сроку остаётся в очереди на следующий проход', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  box.seedTrash(1);
  const svc = service(store, box);
  await svc.sweep(box.client, 'test@mail.local', TRASH, [1], 7);
  store.rows[0]!.purgeAt = new Date('2026-08-01T00:00:00Z').toISOString();

  box.refuseDeletes = true;
  assert.equal(await svc.tick(new Date('2026-08-06T00:00:00Z')), 0);
  assert.equal(store.rows[0]!.state, 'pending', 'закрытую запись работник больше не возьмёт');
  assert.equal(store.rows[0]!.attempts, 1);
  assert.equal(box.folders.get('Recovery')!.length, 1);

  box.refuseDeletes = false;
  assert.equal(await svc.tick(new Date('2026-08-06T00:00:00Z')), 1);
  assert.equal(store.rows[0]!.state, 'purged');
});

test('работник удаляет только то, чему вышел срок', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  box.seedTrash(2);
  const svc = service(store, box);
  await svc.sweep(box.client, 'test@mail.local', TRASH, [1, 2], 7);
  // Одному письму срок вышел, второму — нет.
  store.rows[0]!.purgeAt = new Date('2026-08-01T00:00:00Z').toISOString();

  const purged = await svc.tick(new Date('2026-08-06T00:00:00Z'));

  assert.equal(purged, 1);
  assert.equal(box.folders.get('Recovery')!.length, 1);
  assert.equal(store.rows[0]!.state, 'purged');
  assert.equal(store.rows[1]!.state, 'pending');
});

test('немедленное удаление освобождает место сразу', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  box.seedTrash(3);
  const svc = service(store, box);
  await svc.sweep(box.client, 'test@mail.local', TRASH, [1, 2, 3], 7);

  const totals = await svc.totals('test@mail.local');
  assert.equal(totals.count, 3);
  assert.equal(totals.bytes, 1000 + 2000 + 3000);

  const result = await svc.purgeNow(box.client, 'test@mail.local', 'all');
  assert.equal(result.purged, 3);
  assert.equal(box.folders.get('Recovery')!.length, 0);
  assert.deepEqual(await svc.totals('test@mail.local'), { count: 0, bytes: 0 });
});

test('без базы возможность выключена, а причина — читаемая', async () => {
  const svc = service(null);
  svc.disable('Не применена миграция 0025');
  assert.equal(svc.available, false);
  await assert.rejects(() => svc.totals('test@mail.local'), /миграция 0025/);
});

test('срок ограничивается потолком сервера, а не желанием человека', async () => {
  const store = new MemoryStore();
  const svc = service(store);
  await store.setRecoveryDays('test@mail.local', 365);
  assert.equal(await svc.daysFor('test@mail.local'), 30);
  // Настройки ещё нет — это семь дней, а не ноль: поведение до и после
  // первого сохранения обязано совпадать.
  assert.equal(await svc.daysFor('new@mail.local'), 7);
});

/*
 * Перенос уехал наполовину — записать надо то, что уехало.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Длинный список номеров режется на команды (Dovecot отвергает слишком
 * длинный аргумент), и отказ на второй порции бросался прямо из цикла —
 * унося с собой всё, что успела перенести первая. Вызывающий держит откат
 * только вокруг записи в базу, сюда управление уже не доходило.
 *
 * Цена: несколько сотен писем остаются в скрытой служебной папке БЕЗ
 * строки в базе. Их не видно ни в почте, ни в разделе «Восстановление
 * писем», работник удаления по сроку читает базу и не найдёт их никогда —
 * они лежат вечно и едят квоту. До нарезки этот исход был недостижим:
 * один MOVE либо переносил всё, либо ничего.
 */
void test('отказ на второй порции не теряет письма, перенесённые первой', async () => {
  const store = new MemoryStore();
  const box = new FakeMailbox();
  // Номера через один: свернуть в диапазон нечего, список режется на
  // несколько команд — ровно случай разросшейся корзины.
  const uids: number[] = [];
  const trash = box.folders.get('Trash')!;
  for (let i = 0; i < 5000; i += 1) {
    const uid = i * 2 + 1;
    uids.push(uid);
    trash.push({
      uid,
      subject: `Письмо ${String(uid)}`,
      size: 1000,
      messageId: `m${String(uid)}@t`,
    });
  }
  box.failMoveAtCall = 2;
  const svc = service(store);

  await assert.rejects(
    () => svc.sweep(box.client, 'test@mail.local', TRASH, uids, 7),
    'отказ переноса обязан дойти до человека',
  );

  const moved = box.folders.get('Recovery')!.length;
  assert.ok(moved > 0, 'первая порция никуда не переехала — проверка бессмысленна');
  assert.equal(
    store.rows.length,
    moved,
    'письма лежат в служебной папке без записи в базе: вернуть их нечем, ' +
      'и работник удаления по сроку их не найдёт',
  );
});
