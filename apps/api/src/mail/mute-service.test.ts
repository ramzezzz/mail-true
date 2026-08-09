/**
 * Порядок действий при заглушении переписки.
 *
 * Проверяется не «кнопка нажалась», а то, из-за чего эту возможность
 * страшно делать:
 *
 *   - запись в базе без правила доставки — это ЛОЖЬ человеку: подборка
 *     показывает переписку заглушённой, а письма продолжают приходить.
 *     Не записался файл правил — записи быть не должно;
 *   - файл правил собирается по ВСЕЙ базе ящика, а не по одной записи:
 *     иначе заглушение второй переписки расглушало бы первую;
 *   - снятие заглушки обязано убрать идентификаторы из файла, иначе
 *     «вернуть переписку» ничего не меняет.
 *
 * Ни одного из этих случаев не устроить на живом стенде по требованию —
 * ради них и написаны заглушки ящика и хранилища.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImapFlow } from 'imapflow';
import { pino } from 'pino';
import type { MuteInsert, MuteStore, MutedRow } from './mute-db.js';
import { collectIds, MuteService } from './mute-service.js';
import type { SieveIncludeStore } from '../settings/sieve-include.js';

const logger = pino({ level: 'silent' });

/* ------------------------------------------------------------------ */
/* Заглушки                                                            */
/* ------------------------------------------------------------------ */

class FakeStore implements MuteStore {
  readonly rows: MutedRow[] = [];
  #next = 1;

  schemaReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  mute(entry: MuteInsert): Promise<MutedRow> {
    const existing = this.rows.find((r) => r.threadKey === entry.threadKey);
    if (existing) {
      existing.state = 'muted';
      existing.messageIds = [...new Set([...existing.messageIds, ...entry.messageIds])];
      return Promise.resolve(existing);
    }
    const row: MutedRow = {
      id: this.#next++,
      accountEmail: entry.accountEmail,
      threadKey: entry.threadKey,
      messageIds: entry.messageIds,
      subject: entry.subject,
      fromAddress: entry.fromAddress,
      state: 'muted',
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  listMuted(): Promise<MutedRow[]> {
    return Promise.resolve(this.rows.filter((r) => r.state === 'muted'));
  }

  lift(_email: string, threadKey: string): Promise<boolean> {
    const row = this.rows.find((r) => r.threadKey === threadKey && r.state === 'muted');
    if (!row) return Promise.resolve(false);
    row.state = 'lifted';
    return Promise.resolve(true);
  }

  restore(_email: string, threadKey: string): Promise<boolean> {
    const row = this.rows.find((r) => r.threadKey === threadKey && r.state === 'lifted');
    if (!row) return Promise.resolve(false);
    row.state = 'muted';
    return Promise.resolve(true);
  }
}

/** Хранилище включаемых файлов: помнит последнюю запись и умеет ломаться. */
class FakeIncludes {
  script: string | null = null;
  broken = false;
  readonly calls: string[] = [];
  enabled = true;

  write(_email: string, _name: string, text: string): Promise<{ written: boolean; error: string }> {
    this.calls.push('write');
    if (this.broken) return Promise.resolve({ written: false, error: 'нет доступа к хранилищу' });
    this.script = text;
    return Promise.resolve({ written: true, error: '' });
  }

  remove(): Promise<void> {
    this.calls.push('remove');
    this.script = null;
    return Promise.resolve();
  }

  invalidateCompiled(): Promise<void> {
    this.calls.push('invalidate');
    return Promise.resolve();
  }
}

interface FakeMessage {
  uid: number;
  subject: string;
  messageId: string;
  references: string;
  flags: Set<string>;
}

/**
 * Ящик на минимуме: список папок, поиск по номерам, чтение заголовков,
 * пометка и перенос. Больше службе заглушек ничего и не нужно.
 */
class FakeMailbox {
  readonly boxes = new Map<string, FakeMessage[]>([
    ['INBOX', []],
    ['Muted', []],
  ]);
  readonly calls: string[] = [];
  #selected = 'INBOX';

  add(path: string, msg: FakeMessage): void {
    const box = this.boxes.get(path);
    if (box) box.push(msg);
    else this.boxes.set(path, [msg]);
  }

  get client(): ImapFlow {
    const self = this;
    return {
      list: () =>
        Promise.resolve(
          [...self.boxes.keys()].map((path) => ({
            path,
            name: path,
            delimiter: '.',
            parentPath: '',
            flags: new Set<string>(),
            specialUse: path === 'INBOX' ? '\\Inbox' : undefined,
            status: { messages: self.boxes.get(path)?.length ?? 0, unseen: 0, uidValidity: 1n },
          })),
        ),
      status: () => Promise.resolve({ messages: 0, unseen: 0, uidValidity: 1n }),
      getMailboxLock: (path: string) => {
        self.#selected = path;
        return Promise.resolve({ release: () => undefined });
      },
      search: (query: { uid?: string }) => {
        const box = self.boxes.get(self.#selected) ?? [];
        if (!query.uid) return Promise.resolve(box.map((m) => m.uid));
        const wanted = new Set(
          query.uid.split(',').flatMap((part) => {
            const [from, to] = part.split(':');
            const start = Number(from);
            const end = to === undefined ? start : Number(to);
            const out: number[] = [];
            for (let i = start; i <= end; i += 1) out.push(i);
            return out;
          }),
        );
        return Promise.resolve(box.filter((m) => wanted.has(m.uid)).map((m) => m.uid));
      },
      fetchAll: (uids: number[]) => {
        const box = self.boxes.get(self.#selected) ?? [];
        return Promise.resolve(
          box
            .filter((m) => uids.includes(m.uid))
            .map((m) => ({
              uid: m.uid,
              envelope: {
                subject: m.subject,
                messageId: m.messageId,
                date: new Date('2026-08-05T10:00:00Z'),
                from: [{ address: 'kolya@example.com' }],
              },
              headers: Buffer.from(`References: ${m.references}\r\n`, 'utf8'),
            })),
        );
      },
      messageFlagsAdd: (uids: number[], flags: string[]) => {
        self.calls.push(`flags:${flags.join(',')}`);
        const box = self.boxes.get(self.#selected) ?? [];
        for (const m of box) if (uids.includes(m.uid)) for (const f of flags) m.flags.add(f);
        return Promise.resolve(true);
      },
      messageMove: (uids: number[], target: string) => {
        self.calls.push(`move:${self.#selected}->${target}`);
        const from = self.boxes.get(self.#selected) ?? [];
        const to = self.boxes.get(target) ?? [];
        for (const m of [...from]) {
          if (!uids.includes(m.uid)) continue;
          from.splice(from.indexOf(m), 1);
          to.push(m);
        }
        self.boxes.set(target, to);
        return Promise.resolve(true);
      },
      mailboxCreate: (path: string) => {
        if (!self.boxes.has(path)) self.boxes.set(path, []);
        return Promise.resolve(true);
      },
      mailboxSubscribe: () => Promise.resolve(true),
    } as unknown as ImapFlow;
  }
}

function makeService(includes: FakeIncludes, sync = { written: true, error: '' }) {
  const store = new FakeStore();
  const service = new MuteService({
    logger,
    includes: () => includes as unknown as SieveIncludeStore,
    syncSieve: () => Promise.resolve(sync),
  });
  service.attachStore(store);
  return { service, store };
}

function inboxWith(): FakeMailbox {
  const box = new FakeMailbox();
  box.add('INBOX', {
    uid: 1,
    subject: 'Переезд офиса',
    messageId: '<root@x>',
    references: '',
    flags: new Set(),
  });
  box.add('INBOX', {
    uid: 2,
    subject: 'Re: Переезд офиса',
    messageId: '<second@x>',
    references: '<root@x>',
    flags: new Set(),
  });
  return box;
}

/* ------------------------------------------------------------------ */
/* Проверки                                                            */
/* ------------------------------------------------------------------ */

test('заглушение пишет правило доставки и уносит письма в «Заглушённые»', async () => {
  const includes = new FakeIncludes();
  const { service, store } = makeService(includes);
  const box = inboxWith();

  const result = await service.mute(box.client, 'ivan@mail.local', ['inbox:1', 'inbox:2']);

  assert.equal(result.muted, 1, 'два письма одной переписки — одна запись');
  assert.equal(result.moved, 2);
  assert.equal(result.deliveryError, '');
  assert.equal(store.rows.length, 1);
  // Файл правил знает оба письма: следующий ответ может сослаться на любое.
  assert.ok(includes.script?.includes('<root@x>'));
  assert.ok(includes.script?.includes('<second@x>'));
  // Прочитанным помечаем ДО переноса, пока письмо ещё в исходной папке.
  const flagsAt = box.calls.indexOf('flags:\\Seen');
  const moveAt = box.calls.indexOf('move:INBOX->Muted');
  assert.ok(flagsAt >= 0 && moveAt > flagsAt, `порядок нарушен: ${box.calls.join(' ')}`);
  assert.equal(box.boxes.get('INBOX')?.length, 0);
  assert.equal(box.boxes.get('Muted')?.length, 2);
});

test('не записался файл правил — записи в базе не остаётся', async () => {
  /*
   * Это главный случай. Запись без правила доставки означала бы, что
   * подборка «Заглушённые» показывает переписку заглушённой, а письма
   * продолжают падать во «Входящие» — то есть продукт врёт.
   */
  const includes = new FakeIncludes();
  includes.broken = true;
  const { service, store } = makeService(includes);
  const box = inboxWith();

  await assert.rejects(
    () => service.mute(box.client, 'ivan@mail.local', ['inbox:1']),
    /НЕ заглушена/,
  );
  assert.equal(store.rows.filter((r) => r.state === 'muted').length, 0);
  // И письма остались на месте: переносить их было не за чем.
  assert.equal(box.boxes.get('INBOX')?.length, 2);
});

test('вторая заглушённая переписка не расглушает первую', async () => {
  const includes = new FakeIncludes();
  const { service } = makeService(includes);
  const box = inboxWith();
  box.add('INBOX', {
    uid: 3,
    subject: 'Другой разговор',
    messageId: '<other@y>',
    references: '',
    flags: new Set(),
  });

  await service.mute(box.client, 'ivan@mail.local', ['inbox:1']);
  await service.mute(box.client, 'ivan@mail.local', ['inbox:3']);

  assert.ok(includes.script?.includes('<root@x>'), 'первая переписка исчезла из файла правил');
  assert.ok(includes.script?.includes('<other@y>'));
});

test('снятие заглушки убирает идентификаторы из файла правил', async () => {
  const includes = new FakeIncludes();
  const { service } = makeService(includes);
  const box = inboxWith();

  await service.mute(box.client, 'ivan@mail.local', ['inbox:1']);
  assert.ok(includes.script);

  const { lifted } = await service.unmute('ivan@mail.local', ['root@x']);
  assert.equal(lifted, 1);
  // Заглушённых не осталось — файла быть не должно вовсе: условие без
  // значений Pigeonhole не примет.
  assert.equal(includes.script, null);
  assert.ok(includes.calls.includes('remove'));
});

test('переписку без Message-ID заглушить нельзя, и об этом говорится прямо', async () => {
  const includes = new FakeIncludes();
  const { service } = makeService(includes);
  const box = new FakeMailbox();
  box.add('INBOX', {
    uid: 1,
    subject: 'Письмо кривого рассыльщика',
    messageId: '',
    references: '',
    flags: new Set(),
  });

  await assert.rejects(
    () => service.mute(box.client, 'ivan@mail.local', ['inbox:1']),
    /Message-ID/,
  );
});

test('без доступа к хранилищу правил возможность честно объявляется неполной', () => {
  const includes = new FakeIncludes();
  includes.enabled = false;
  const { service } = makeService(includes);
  assert.equal(service.available, true);
  assert.equal(service.deliveryAvailable, false);
});

test('идентификаторы всех переписок сводятся в один список без повторов', () => {
  const rows = [{ messageIds: ['a@x', 'b@x'] }, { messageIds: ['B@X', 'c@x'] }] as MutedRow[];
  assert.deepEqual(collectIds(rows), ['a@x', 'b@x', 'c@x']);
});

test('снятие заглушки откатывается, если файл правил не записался', async () => {
  /*
   * Порядок действий: сперва база, потом файл правил. Отказ на втором шаге
   * оставлял состояние, из которого нет выхода:
   *
   *   * в базе переписка расглушена — значит ПРОПАЛА из подборки
   *     «Заглушённые» (там только state = 'muted');
   *   * на диске лежит прежний файл со всеми правилами, включая снятое.
   *
   * Дальше письма этой переписки Sieve продолжает уводить в «Заглушённые»
   * и помечать прочитанными — во «Входящие» они не приходят, счётчик не
   * растёт, человек об этом не узнаёт ничем.
   *
   * Починить было нельзя даже намеренно: повтор отвечал 200 и «lifted: 0»
   * (запись уже 'lifted'), а ключ переписки взять неоткуда — из подборки
   * она исчезла.
   */
  const includes = new FakeIncludes();
  const { service, store } = makeService(includes);
  const box = inboxWith();
  box.add('INBOX', {
    uid: 3,
    subject: 'Другой разговор',
    messageId: '<other@y>',
    references: '',
    flags: new Set(),
  });

  // Две заглушки: снимаем одну, значит файл будет переписываться (write),
  // а не удаляться — иначе отказ негде было бы воспроизвести.
  await service.mute(box.client, 'ivan@mail.local', ['inbox:1']);
  await service.mute(box.client, 'ivan@mail.local', ['inbox:3']);
  const before = (await store.listMuted()).map((r) => r.threadKey).sort();
  assert.equal(before.length, 2);

  includes.broken = true;
  await assert.rejects(
    () => service.unmute('ivan@mail.local', ['root@x']),
    /заглушка НЕ снята/,
    'отказ обязан дойти до человека: иначе он уверен, что переписка расглушена',
  );

  const after = (await store.listMuted()).map((r) => r.threadKey).sort();
  assert.deepEqual(
    after,
    before,
    'запись обязана вернуться в подборку — иначе снять заглушку станет нечем',
  );
});

test('повторное снятие после отката работает как обычно', async () => {
  const includes = new FakeIncludes();
  const { service, store } = makeService(includes);
  const box = inboxWith();
  box.add('INBOX', {
    uid: 3,
    subject: 'Другой разговор',
    messageId: '<other@y>',
    references: '',
    flags: new Set(),
  });

  await service.mute(box.client, 'ivan@mail.local', ['inbox:1']);
  await service.mute(box.client, 'ivan@mail.local', ['inbox:3']);

  includes.broken = true;
  await assert.rejects(() => service.unmute('ivan@mail.local', ['root@x']));

  includes.broken = false;
  const { lifted } = await service.unmute('ivan@mail.local', ['root@x']);
  assert.equal(lifted, 1, 'после отката ключ снова живой, и снятие проходит');
  assert.equal((await store.listMuted()).length, 1);
});

/*
 * Смешанное выделение: одно письмо нормальной переписки и одно от
 * кривого рассыльщика — без Message-ID и без ссылок.
 *
 * Второе заглушить нечем, и служба честно его пропускает: узнать его
 * продолжение при доставке не по чему. Но в перенос уходил ИСХОДНЫЙ
 * список выделенного — и это письмо всё равно уезжало из «Входящих» в
 * «Заглушённые» и помечалось прочитанным. Вернуть его было нечем: в
 * подборке «Заглушённые» его нет (она строится по базе), ключа переписки
 * не существует. Ответ при этом бодро сообщал «заглушено 1, перенесено 2».
 */
test('письмо, которое заглушить нельзя, остаётся во «Входящих»', async () => {
  const includes = new FakeIncludes();
  const { service, store } = makeService(includes);
  const box = new FakeMailbox();
  box.add('INBOX', {
    uid: 1,
    subject: 'Переезд офиса',
    messageId: '<root@x>',
    references: '',
    flags: new Set(),
  });
  box.add('INBOX', {
    uid: 2,
    subject: 'Скидки только сегодня',
    messageId: '',
    references: '',
    flags: new Set(),
  });

  const result = await service.mute(box.client, 'ivan@mail.local', ['inbox:1', 'inbox:2']);

  assert.equal(result.muted, 1, 'заглушить можно только одну переписку');
  assert.equal(result.moved, 1, 'перенести можно только её письма');
  assert.equal(store.rows.length, 1);

  const inbox = box.boxes.get('INBOX') ?? [];
  assert.deepEqual(
    inbox.map((m) => m.uid),
    [2],
    'письмо без Message-ID унесли в «Заглушённые», откуда его не вернуть',
  );
  const muted = box.boxes.get('Muted') ?? [];
  assert.deepEqual(muted.map((m) => m.uid).length, 1);
  // И прочитанным его тоже не помечали: человек его не читал.
  assert.equal(inbox[0]?.flags.has('\\Seen'), false);
});

/*
 * «Вернуть переписку» обещает снять заглушку с переписок ВЫДЕЛЕННЫХ
 * писем. Браузер вместо этого слал ключи всей подборки, и одно нажатие
 * возвращало во «Входящие» всё, от чего человек прятался неделями. А как
 * только заглушённых становилось больше сотни, запрос упирался в предел
 * схемы и не работал вовсе — снять заглушку было нечем.
 */
test('снятие по письмам трогает только их переписки', async () => {
  const includes = new FakeIncludes();
  const { service, store } = makeService(includes);
  const box = inboxWith();
  box.add('INBOX', {
    uid: 3,
    subject: 'Совсем другой разговор',
    messageId: '<other@x>',
    references: '',
    flags: new Set(),
  });

  await service.mute(box.client, 'ivan@mail.local', ['inbox:1']);
  await service.mute(box.client, 'ivan@mail.local', ['inbox:3']);
  assert.equal(store.rows.length, 2);

  // Письма уехали в «Заглушённые» — снимаем по ним же.
  const mutedIds = (box.boxes.get('Muted') ?? []).map((m) => `muted:${String(m.uid)}`);
  assert.equal(mutedIds.length, 2);

  const result = await service.unmuteByMessages(box.client, 'ivan@mail.local', [mutedIds[0]!]);
  assert.equal(result.lifted, 1, 'снялась не одна переписка');
  const stillMuted = store.rows.filter((r) => r.state === 'muted');
  assert.equal(stillMuted.length, 1, 'вторая переписка обязана остаться заглушённой');
});
