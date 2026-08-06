/**
 * Откладывание письма до срока и возврат в назначенный час.
 *
 * Проверяется не «кнопка нажалась», а то, из-за чего эту возможность
 * страшно делать:
 *
 *   - письмо не должно потеряться между папками ни на одном обрыве;
 *   - письмо, которое человек сам утащил из «Отложенных», не должно
 *     ронять возврат остальных;
 *   - недоступный в срок Dovecot не должен стирать срок;
 *   - перезапуск сервера не должен терять просроченные записи.
 *
 * Все четыре случая невозможно устроить на живом стенде по требованию —
 * ради них и написаны заглушки ящика и хранилища.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImapFlow } from 'imapflow';
import { pino } from 'pino';
import type { AppConfig } from '../config.js';
import type { SnoozeInsert, SnoozeState, SnoozeStore, SnoozedRow } from './snooze-db.js';
import { SnoozeService } from './snooze-service.js';

/* ------------------------------------------------------------------ */
/* Заглушка ящика                                                      */
/* ------------------------------------------------------------------ */

interface FakeMessage {
  uid: number;
  subject: string;
  from: string;
  messageId: string;
  flags: Set<string>;
}

interface FakeBox {
  path: string;
  specialUse?: string | undefined;
  uidValidity: number;
  nextUid: number;
  messages: FakeMessage[];
}

/** Разворачивает набор номеров IMAP вида `1:100,105`. */
function expandSet(set: string): number[] {
  const out: number[] = [];
  for (const part of set.split(',')) {
    const [from, to] = part.split(':');
    const start = Number(from);
    const end = to === undefined ? start : Number(to);
    for (let uid = start; uid <= end; uid += 1) out.push(uid);
  }
  return out;
}

class FakeMailbox {
  readonly boxes = new Map<string, FakeBox>();
  /** Журнал изменяющих команд — по нему и проверяется ПОРЯДОК действий. */
  readonly calls: string[] = [];
  /** Сервер не поддерживает UIDPLUS: COPY отвечает без номеров копий. */
  uidplus = true;
  /** Копирование падает (нет места, папка только для чтения). */
  copyFails = false;
  #selected = 'INBOX';

  constructor(boxes: Array<Partial<FakeBox> & { path: string }>) {
    for (const box of boxes) {
      this.boxes.set(box.path, {
        path: box.path,
        specialUse: box.specialUse,
        uidValidity: box.uidValidity ?? 1,
        nextUid: box.nextUid ?? 100,
        messages: box.messages ?? [],
      });
    }
  }

  box(path: string): FakeBox {
    const found = this.boxes.get(path);
    if (!found) throw new Error(`нет папки ${path}`);
    return found;
  }

  get current(): FakeBox {
    return this.box(this.#selected);
  }

  async list(): Promise<unknown[]> {
    return [...this.boxes.values()].map((box) => ({
      path: box.path,
      name: box.path,
      delimiter: '/',
      parentPath: '',
      specialUse: box.specialUse,
      flags: new Set<string>(),
      status: {
        messages: box.messages.length,
        unseen: 0,
        uidValidity: BigInt(box.uidValidity),
      },
    }));
  }

  readonly capabilities = new Set<string>();

  async noop(): Promise<void> {}

  async getMailboxLock(path: string): Promise<{ release(): void }> {
    if (!this.boxes.has(path)) throw new Error(`нет папки ${path}`);
    this.#selected = path;
    return { release: () => undefined };
  }

  get mailbox(): { exists: number; uidValidity: bigint } {
    const box = this.current;
    return { exists: box.messages.length, uidValidity: BigInt(box.uidValidity) };
  }

  async search(query: {
    uid?: string;
    all?: boolean;
    header?: Record<string, string>;
  }): Promise<number[]> {
    const box = this.current;
    if (query.header) {
      const needle = Object.values(query.header)[0] ?? '';
      return box.messages.filter((m) => m.messageId.includes(needle)).map((m) => m.uid);
    }
    if (typeof query.uid === 'string') {
      const wanted = new Set(expandSet(query.uid));
      return box.messages.filter((m) => wanted.has(m.uid)).map((m) => m.uid);
    }
    return box.messages.map((m) => m.uid);
  }

  async fetchAll(range: string | number[]): Promise<unknown[]> {
    const uids = typeof range === 'string' ? expandSet(range) : range;
    const box = this.current;
    return box.messages
      .filter((m) => uids.includes(m.uid))
      .map((m) => ({
        uid: m.uid,
        envelope: {
          subject: m.subject,
          messageId: `<${m.messageId}>`,
          from: [{ address: m.from }],
          date: new Date('2026-08-05T10:00:00Z'),
        },
        flags: m.flags,
      }));
  }

  #transfer(uids: number[], destination: string, remove: boolean) {
    const from = this.current;
    const to = this.box(destination);
    const uidMap = new Map<number, number>();
    for (const uid of uids) {
      const index = from.messages.findIndex((m) => m.uid === uid);
      if (index === -1) continue;
      const message = from.messages[index]!;
      const copy: FakeMessage = { ...message, uid: to.nextUid++, flags: new Set(message.flags) };
      to.messages.push(copy);
      uidMap.set(uid, copy.uid);
      if (remove) from.messages.splice(index, 1);
    }
    return { uidValidity: BigInt(to.uidValidity), uidMap };
  }

  async messageCopy(uids: number[], destination: string) {
    this.calls.push(`copy ${this.#selected}->${destination} ${uids.join(',')}`);
    if (this.copyFails) throw new Error('сервер отказал в копировании');
    const result = this.#transfer(uids, destination, false);
    // Сервер без UIDPLUS подтверждает копию, но не говорит, какие номера
    // она получила: продукт обязан это заметить и не удалять оригинал.
    return this.uidplus ? result : { uidValidity: result.uidValidity, uidMap: undefined };
  }

  async messageMove(uids: number[], destination: string) {
    this.calls.push(`move ${this.#selected}->${destination} ${uids.join(',')}`);
    return this.#transfer(uids, destination, true);
  }

  async messageDelete(uids: number[]): Promise<boolean> {
    this.calls.push(`delete ${this.#selected} ${uids.join(',')}`);
    const box = this.current;
    box.messages = box.messages.filter((m) => !uids.includes(m.uid));
    return true;
  }

  async messageFlagsAdd(uids: number[], flags: string[]): Promise<boolean> {
    this.calls.push(`flagsAdd ${this.#selected} ${uids.join(',')} ${flags.join(',')}`);
    for (const m of this.current.messages) {
      if (uids.includes(m.uid)) for (const flag of flags) m.flags.add(flag);
    }
    return true;
  }

  async messageFlagsRemove(uids: number[], flags: string[]): Promise<boolean> {
    this.calls.push(`flagsRemove ${this.#selected} ${uids.join(',')} ${flags.join(',')}`);
    for (const m of this.current.messages) {
      if (uids.includes(m.uid)) for (const flag of flags) m.flags.delete(flag);
    }
    return true;
  }

  async mailboxCreate(path: string): Promise<void> {
    this.calls.push(`mailboxCreate ${path}`);
    this.boxes.set(path, { path, uidValidity: 7, nextUid: 500, messages: [] });
  }

  async mailboxSubscribe(): Promise<void> {}

  async logout(): Promise<void> {}
  close(): void {}
  on(): this {
    return this;
  }

  asClient(): ImapFlow {
    return this as unknown as ImapFlow;
  }
}

/* ------------------------------------------------------------------ */
/* Заглушка хранилища                                                  */
/* ------------------------------------------------------------------ */

class MemoryStore implements SnoozeStore {
  readonly rows: SnoozedRow[] = [];
  #nextId = 1;
  /** Запись срока падает — обрыв ровно между копией и записью. */
  addFails = false;

  async schemaReady(): Promise<boolean> {
    return true;
  }

  async add(entry: SnoozeInsert): Promise<SnoozedRow> {
    if (this.addFails) throw new Error('Postgres недоступен');
    const row: SnoozedRow = {
      id: this.#nextId++,
      accountEmail: entry.accountEmail,
      snoozePath: entry.snoozePath,
      snoozeUid: entry.snoozeUid,
      snoozeUidValidity: entry.snoozeUidValidity,
      originPath: entry.originPath,
      messageId: entry.messageId,
      subject: entry.subject,
      fromAddress: entry.fromAddress,
      wakeAt: entry.wakeAt.toISOString(),
      timeZone: entry.timeZone,
      preset: entry.preset,
      state: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async listPending(accountEmail: string): Promise<SnoozedRow[]> {
    return this.rows.filter(
      (r) => r.state === 'pending' && r.accountEmail.toLowerCase() === accountEmail.toLowerCase(),
    );
  }

  async listDue(now: Date, limit: number): Promise<SnoozedRow[]> {
    return this.rows
      .filter((r) => r.state === 'pending' && Date.parse(r.wakeAt) <= now.getTime())
      .sort((a, b) => a.wakeAt.localeCompare(b.wakeAt))
      .slice(0, limit);
  }

  async findPendingByUids(
    accountEmail: string,
    snoozePath: string,
    uids: number[],
  ): Promise<SnoozedRow[]> {
    return this.rows.filter(
      (r) =>
        r.state === 'pending' &&
        r.accountEmail.toLowerCase() === accountEmail.toLowerCase() &&
        r.snoozePath === snoozePath &&
        uids.includes(r.snoozeUid),
    );
  }

  async close(id: number, state: Exclude<SnoozeState, 'pending'>, note?: string | null) {
    const row = this.rows.find((r) => r.id === id);
    if (row && row.state === 'pending') {
      row.state = state;
      row.lastError = note ?? null;
    }
  }

  async markAttempt(id: number, error: string): Promise<number> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return 0;
    row.attempts += 1;
    row.lastError = error;
    return row.attempts;
  }
}

/* ------------------------------------------------------------------ */
/* Сборка                                                              */
/* ------------------------------------------------------------------ */

const ACCOUNT = 'test@mail.local';
const silent = pino({ level: 'silent' });

function letter(uid: number, name = `pismo-${String(uid)}`): FakeMessage {
  return {
    uid,
    subject: `Письмо ${String(uid)}`,
    from: 'boss@example.com',
    messageId: `${name}@example.com`,
    flags: new Set<string>(['\\Seen']),
  };
}

function mailbox(): FakeMailbox {
  return new FakeMailbox([
    { path: 'INBOX', specialUse: '\\Inbox', messages: [letter(1), letter(2), letter(3)] },
    { path: 'Trash', specialUse: '\\Trash' },
  ]);
}

function service(
  store: SnoozeStore | null,
  connect?: (email: string) => Promise<ImapFlow>,
): SnoozeService {
  const svc = new SnoozeService({
    config: {
      IMAP_HOST: 'dovecot',
      IMAP_PORT: 143,
      IMAP_SECURE: false,
      TLS_REJECT_UNAUTHORIZED: false,
    } as unknown as AppConfig,
    logger: silent,
    master: { user: 'mtadmin', password: 'secret', separator: '*' },
    connect,
  });
  if (store) svc.attachStore(store);
  return svc;
}

/** Через минуту вперёд — ровно так возможность и проверяют на стенде. */
function inAMinute(now: Date): string {
  return new Date(now.getTime() + 60_000).toISOString();
}

/* ------------------------------------------------------------------ */
/* Откладывание                                                        */
/* ------------------------------------------------------------------ */

test('откладывание: копия, потом запись срока, и только потом удаление', async () => {
  const box = mailbox();
  const store = new MemoryStore();
  const now = new Date('2026-08-05T18:30:00Z');

  const result = await service(store).snooze(
    box.asClient(),
    ACCOUNT,
    ['inbox:1'],
    { until: inAMinute(now) },
    now,
  );

  assert.equal(result.snoozed, 1);
  // Порядок команд — главное в этом разделе. Удаление оригинала стоит
  // ПОСЛЕ копии; запись срока (её в журнале ящика нет) — между ними,
  // и это проверяется отдельно ниже, случаем с недоступной базой.
  const copyAt = box.calls.findIndex((c) => c.startsWith('copy '));
  const deleteAt = box.calls.findIndex((c) => c.startsWith('delete '));
  assert.ok(copyAt >= 0, `копии не было: ${box.calls.join(' | ')}`);
  assert.ok(deleteAt > copyAt, `удаление раньше копии: ${box.calls.join(' | ')}`);

  // Письмо ушло из «Входящих» и лежит в «Отложенных».
  assert.deepEqual(
    box.box('INBOX').messages.map((m) => m.uid),
    [2, 3],
  );
  assert.equal(box.box('Snoozed').messages.length, 1);

  // В записи есть всё, чем письмо потом ищут: номер, поколение папки,
  // Message-ID и куда возвращать.
  const row = store.rows[0]!;
  assert.equal(row.originPath, 'INBOX');
  assert.equal(row.snoozeUid, box.box('Snoozed').messages[0]!.uid);
  assert.equal(row.snoozeUidValidity, 7);
  assert.equal(row.messageId, 'pismo-1@example.com');
  assert.equal(row.state, 'pending');
});

test('откладывание: недоступная база не даёт удалить письмо и не оставляет дубля', async () => {
  const box = mailbox();
  const store = new MemoryStore();
  store.addFails = true;
  const now = new Date('2026-08-05T18:30:00Z');

  await assert.rejects(
    service(store).snooze(box.asClient(), ACCOUNT, ['inbox:1'], { until: inAMinute(now) }, now),
  );

  // Оригинал НА МЕСТЕ — это главное. И копии-сироты в «Отложенных» нет:
  // письмо, которое лежит там без срока, не вернулось бы никогда.
  assert.deepEqual(
    box.box('INBOX').messages.map((m) => m.uid),
    [1, 2, 3],
  );
  assert.deepEqual(box.box('Snoozed').messages, []);
  assert.deepEqual(store.rows, []);
});

test('откладывание: сервер без UIDPLUS не даёт удалить оригинал', async () => {
  const box = mailbox();
  box.uidplus = false;
  const store = new MemoryStore();
  const now = new Date('2026-08-05T18:30:00Z');

  // Не зная номера копии, вернуть её потом нечем. Честный отказ лучше,
  // чем письмо, уехавшее в никуда.
  await assert.rejects(
    service(store).snooze(box.asClient(), ACCOUNT, ['inbox:1'], { until: inAMinute(now) }, now),
    /не подтвердил/i,
  );
  assert.deepEqual(
    box.box('INBOX').messages.map((m) => m.uid),
    [1, 2, 3],
  );
  assert.deepEqual(store.rows, []);
});

test('откладывание: письмо из несуществующей папки не трогает ящик вовсе', async () => {
  const box = mailbox();
  const store = new MemoryStore();
  const now = new Date('2026-08-05T18:30:00Z');

  await assert.rejects(
    service(store).snooze(
      box.asClient(),
      ACCOUNT,
      ['inbox:1', 'нет-такой-папки:5'],
      { until: inAMinute(now) },
      now,
    ),
  );
  assert.deepEqual(box.calls, [], `ящик тронули: ${box.calls.join(' | ')}`);
  assert.deepEqual(
    box.box('INBOX').messages.map((m) => m.uid),
    [1, 2, 3],
  );
});

test('откладывание невозможно без базы — и об этом сказано, а не промолчано', async () => {
  const box = mailbox();
  const svc = service(null);
  svc.disable('Не настроена база данных');
  const now = new Date('2026-08-05T18:30:00Z');
  await assert.rejects(
    svc.snooze(box.asClient(), ACCOUNT, ['inbox:1'], { until: inAMinute(now) }, now),
    /база данных/i,
  );
  assert.equal(svc.available, false);
});

/* ------------------------------------------------------------------ */
/* Возврат по сроку                                                    */
/* ------------------------------------------------------------------ */

/** Ящик с одним уже отложенным письмом и записью о нём. */
async function withSnoozed(wakeAt: string) {
  const box = mailbox();
  const store = new MemoryStore();
  const now = new Date('2026-08-05T18:30:00Z');
  await service(store).snooze(box.asClient(), ACCOUNT, ['inbox:1'], { until: inAMinute(now) }, now);
  store.rows[0]!.wakeAt = wakeAt;
  box.calls.length = 0;
  return { box, store };
}

test('возврат: письмо приходит обратно непрочитанным и заметным', async () => {
  const { box, store } = await withSnoozed('2026-08-05T18:31:00Z');
  const svc = service(store, async () => box.asClient());

  const returned = await svc.tick(new Date('2026-08-05T18:31:30Z'));
  assert.equal(returned, 1);

  assert.equal(box.box('Snoozed').messages.length, 0);
  const back = box.box('INBOX').messages.find((m) => m.messageId === 'pismo-1@example.com');
  assert.ok(back, 'письмо не вернулось во «Входящие»');
  // Непрочитанное — человек его и откладывал, чтобы прочитать позже.
  assert.equal(back.flags.has('\\Seen'), false);
  // И заметное: список поднимает такие письма наверх со значком времени.
  assert.equal(back.flags.has('$Snoozed'), true);
  assert.equal(back.flags.has('$Pinned'), true);
  assert.equal(store.rows[0]!.state, 'returned');
});

test('возврат: письмо, унесённое человеком из «Отложенных», молча пропускается', async () => {
  const { box, store } = await withSnoozed('2026-08-05T18:31:00Z');
  // Человек утащил письмо мышью в «Корзину» — база об этом не знает.
  box.box('Snoozed').messages = [];

  const svc = service(store, async () => box.asClient());
  const returned = await svc.tick(new Date('2026-08-05T18:31:30Z'));

  // Ни исключения, ни пустого письма: запись просто закрыта.
  assert.equal(returned, 0);
  assert.equal(store.rows[0]!.state, 'gone');
});

test('возврат: пропавшее письмо не мешает вернуться соседнему', async () => {
  const box = mailbox();
  const store = new MemoryStore();
  const now = new Date('2026-08-05T18:30:00Z');
  await service(store).snooze(
    box.asClient(),
    ACCOUNT,
    ['inbox:1', 'inbox:2'],
    { until: inAMinute(now) },
    now,
  );
  for (const row of store.rows) row.wakeAt = '2026-08-05T18:31:00Z';

  // Первое из двух письмо исчезло из «Отложенных».
  const snoozedBox = box.box('Snoozed');
  const victim = store.rows[0]!.snoozeUid;
  snoozedBox.messages = snoozedBox.messages.filter((m) => m.uid !== victim);

  const svc = service(store, async () => box.asClient());
  assert.equal(await svc.tick(new Date('2026-08-05T18:31:30Z')), 1);
  assert.equal(store.rows[0]!.state, 'gone');
  assert.equal(store.rows[1]!.state, 'returned');
});

test('возврат: письмо находится по Message-ID, когда папку пересоздали', async () => {
  const { box, store } = await withSnoozed('2026-08-05T18:31:00Z');
  // Папку пересоздали: поколение сменилось, все прежние номера пусты.
  const snoozed = box.box('Snoozed');
  snoozed.uidValidity = 42;
  for (const m of snoozed.messages) m.uid += 1000;

  const svc = service(store, async () => box.asClient());
  assert.equal(await svc.tick(new Date('2026-08-05T18:31:30Z')), 1);
  assert.equal(store.rows[0]!.state, 'returned');
  assert.ok(box.box('INBOX').messages.some((m) => m.messageId === 'pismo-1@example.com'));
});

test('возврат: исчезнувшая исходная папка не отменяет возврат — письмо идёт во «Входящие»', async () => {
  const box = new FakeMailbox([
    { path: 'INBOX', specialUse: '\\Inbox', messages: [] },
    { path: 'Проекты', messages: [letter(1)] },
  ]);
  const store = new MemoryStore();
  const now = new Date('2026-08-05T18:30:00Z');
  const folderId = 'f-' + Buffer.from('Проекты', 'utf8').toString('base64url');
  await service(store).snooze(
    box.asClient(),
    ACCOUNT,
    [`${folderId}:1`],
    { until: inAMinute(now) },
    now,
  );
  assert.equal(store.rows[0]!.originPath, 'Проекты');
  box.boxes.delete('Проекты');
  store.rows[0]!.wakeAt = '2026-08-05T18:31:00Z';

  const svc = service(store, async () => box.asClient());
  assert.equal(await svc.tick(new Date('2026-08-05T18:31:30Z')), 1);
  assert.equal(box.box('INBOX').messages.length, 1);
});

test('возврат: недоступный Dovecot НЕ стирает срок — попытка повторится', async () => {
  const { box, store } = await withSnoozed('2026-08-05T18:31:00Z');
  let down = true;
  const svc = service(store, async () => {
    if (down) throw new Error('ECONNREFUSED dovecot:143');
    return box.asClient();
  });

  assert.equal(await svc.tick(new Date('2026-08-05T18:31:30Z')), 0);
  const row = store.rows[0]!;
  // Запись ЖИВА. Это и есть всё требование: недоступность проходит сама,
  // а «сдались» означало бы письмо, которое не вернётся никогда.
  assert.equal(row.state, 'pending');
  assert.equal(row.attempts, 1);
  assert.match(row.lastError ?? '', /ECONNREFUSED/);

  down = false;
  assert.equal(await svc.tick(new Date('2026-08-05T18:32:00Z')), 1);
  assert.equal(store.rows[0]!.state, 'returned');
});

test('перезапуск сервера: просроченное письмо возвращается первым же проходом', async () => {
  // Срок настал, пока контейнер был выключен. Никакого «восстановления»
  // не требуется: срок лежит в базе, а не в памяти процесса.
  const { box, store } = await withSnoozed('2026-08-05T18:31:00Z');
  const svc = service(store, async () => box.asClient());
  // Сервер поднялся на четыре часа позже срока.
  assert.equal(await svc.tick(new Date('2026-08-05T22:31:00Z')), 1);
  assert.equal(store.rows[0]!.state, 'returned');
});

test('возврат: письмо, чей срок ещё не настал, никто не трогает', async () => {
  const { box, store } = await withSnoozed('2026-08-06T08:00:00Z');
  const svc = service(store, async () => box.asClient());
  assert.equal(await svc.tick(new Date('2026-08-05T18:31:30Z')), 0);
  assert.deepEqual(box.calls, []);
  assert.equal(store.rows[0]!.state, 'pending');
});

/* ------------------------------------------------------------------ */
/* Список и досрочный возврат                                          */
/* ------------------------------------------------------------------ */

test('список «Отложенных» показывает и письма без срока — они сами не вернутся', async () => {
  const { box, store } = await withSnoozed('2026-08-06T08:00:00Z');
  // Письмо, положенное в папку руками (или уцелевшее после обрыва между
  // копией и записью срока): в базе его нет, а в папке оно есть.
  box.box('Snoozed').messages.push(letter(777, 'ruchnoe'));

  const items = await service(store).listSnoozed(box.asClient(), ACCOUNT);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.orphan, false);
  assert.equal(items[0]!.wakeAt, '2026-08-06T08:00:00Z');
  // Письмо без срока — в конце и честно помечено: молчать о том, что оно
  // не вернётся, нельзя.
  assert.equal(items[1]!.orphan, true);
  assert.equal(items[1]!.wakeAt, '');
});

test('«вернуть сейчас» возвращает письмо в исходную папку и закрывает срок', async () => {
  const { box, store } = await withSnoozed('2026-08-06T08:00:00Z');
  const uid = store.rows[0]!.snoozeUid;

  const result = await service(store).returnNow(box.asClient(), ACCOUNT, [
    `snoozed:${String(uid)}`,
  ]);
  assert.equal(result.returned, 1);
  assert.equal(store.rows[0]!.state, 'cancelled');
  assert.ok(box.box('INBOX').messages.some((m) => m.messageId === 'pismo-1@example.com'));
});

test('«вернуть сейчас» вытаскивает и письмо без срока — во «Входящие»', async () => {
  const { box, store } = await withSnoozed('2026-08-06T08:00:00Z');
  box.box('Snoozed').messages.push(letter(777, 'ruchnoe'));

  const result = await service(store).returnNow(box.asClient(), ACCOUNT, ['snoozed:777']);
  assert.equal(result.returned, 1);
  assert.ok(box.box('INBOX').messages.some((m) => m.messageId === 'ruchnoe@example.com'));
});
