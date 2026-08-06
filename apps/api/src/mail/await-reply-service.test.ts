/**
 * Работник «напомнить, если не ответили».
 *
 * Здесь проверяется ровно то, ради чего возможность существует, и то, из-за
 * чего ей перестают верить:
 *
 *   - ответ пришёл — напоминания НЕТ и во «Входящих» ничего не появляется;
 *   - ответа нет — письмо поднимается во «Входящие» непрочитанным и
 *     закреплённым, с пометкой «ответа нет»;
 *   - Dovecot недоступен в срок — запись остаётся живой, а не пропадает.
 *
 * Ни одного из этих случаев не устроить на живом стенде по требованию:
 * чтобы увидеть третий, пришлось бы выключить настоящий Dovecot.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImapFlow } from 'imapflow';
import { pino } from 'pino';
import type { AppConfig } from '../config.js';
import type {
  AnswerKind,
  AwaitState,
  AwaitingInsert,
  AwaitingRow,
  AwaitingStore,
} from './await-reply-db.js';
import { AwaitReplyService, AWAIT_OVERDUE_KEYWORD, AWAIT_PINNED_KEYWORD } from './await-reply-service.js';

const logger = pino({ level: 'silent' });
const config = { IMAP_HOST: 'localhost', IMAP_PORT: 143 } as unknown as AppConfig;

/* ------------------------------------------------------------------ */
/* Заглушки                                                            */
/* ------------------------------------------------------------------ */

class FakeStore implements AwaitingStore {
  readonly rows: AwaitingRow[] = [];
  #next = 1;

  schemaReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  add(entry: AwaitingInsert): Promise<AwaitingRow> {
    const row: AwaitingRow = {
      id: this.#next++,
      accountEmail: entry.accountEmail,
      sentPath: entry.sentPath,
      sentUid: entry.sentUid,
      sentUidValidity: entry.sentUidValidity,
      messageId: entry.messageId,
      subject: entry.subject,
      toAddresses: entry.toAddresses,
      sentAt: entry.sentAt.toISOString(),
      dueAt: entry.dueAt.toISOString(),
      timeZone: entry.timeZone,
      preset: entry.preset,
      state: 'waiting',
      answerKind: null,
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  listWaiting(): Promise<AwaitingRow[]> {
    return Promise.resolve(this.rows.filter((r) => r.state === 'waiting'));
  }

  listDue(now: Date): Promise<AwaitingRow[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.state === 'waiting' && new Date(r.dueAt) <= now),
    );
  }

  close(id: number, state: Exclude<AwaitState, 'waiting'>, kind: AnswerKind = null): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.state = state;
      row.answerKind = kind;
    }
    return Promise.resolve();
  }

  cancelByMessageId(_email: string, messageId: string): Promise<boolean> {
    const row = this.rows.find((r) => r.messageId === messageId && r.state === 'waiting');
    if (!row) return Promise.resolve(false);
    row.state = 'cancelled';
    return Promise.resolve(true);
  }

  markAttempt(id: number, error: string): Promise<number> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return Promise.resolve(0);
    row.attempts += 1;
    row.lastError = error;
    return Promise.resolve(row.attempts);
  }
}

interface FakeMessage {
  uid: number;
  subject: string;
  from: string;
  messageId: string;
  references?: string;
  inReplyTo?: string;
  autoSubmitted?: string;
  date: Date;
  flags: Set<string>;
}

/** Ящик на минимуме: список папок, поиск по заголовкам, копия и пометки. */
class FakeMailbox {
  readonly boxes = new Map<string, FakeMessage[]>([
    ['INBOX', []],
    ['Sent', []],
  ]);
  #selected = 'INBOX';
  #nextUid = 100;

  add(path: string, msg: FakeMessage): void {
    const box = this.boxes.get(path) ?? [];
    box.push(msg);
    this.boxes.set(path, box);
  }

  find(path: string, uid: number): FakeMessage | undefined {
    return this.boxes.get(path)?.find((m) => m.uid === uid);
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
            specialUse:
              path === 'INBOX' ? '\\Inbox' : path === 'Sent' ? '\\Sent' : undefined,
            status: { messages: self.boxes.get(path)?.length ?? 0, unseen: 0, uidValidity: 1n },
          })),
        ),
      status: () => Promise.resolve({ messages: 0, unseen: 0, uidValidity: 1n }),
      getMailboxLock: (path: string) => {
        self.#selected = path;
        return Promise.resolve({ release: () => undefined });
      },
      get mailbox() {
        return { path: self.#selected, uidValidity: 1n, exists: 0 };
      },
      search: (query: Record<string, unknown>) => {
        const box = self.boxes.get(self.#selected) ?? [];
        return Promise.resolve(box.filter((m) => matches(m, query)).map((m) => m.uid));
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
                inReplyTo: m.inReplyTo,
                date: m.date,
                from: [{ address: m.from }],
                to: [{ address: 'kolya@example.com' }],
              },
              headers: Buffer.from(
                `References: ${m.references ?? ''}\r\n` +
                  `In-Reply-To: ${m.inReplyTo ?? ''}\r\n` +
                  `Auto-Submitted: ${m.autoSubmitted ?? ''}\r\n`,
                'utf8',
              ),
            })),
        );
      },
      messageCopy: (uids: number[], target: string) => {
        const from = self.boxes.get(self.#selected) ?? [];
        const to = self.boxes.get(target) ?? [];
        const uidMap = new Map<number, number>();
        for (const m of from) {
          if (!uids.includes(m.uid)) continue;
          const copy = { ...m, uid: self.#nextUid++, flags: new Set(m.flags) };
          to.push(copy);
          uidMap.set(m.uid, copy.uid);
        }
        self.boxes.set(target, to);
        return Promise.resolve({ uidMap, uidValidity: 1n });
      },
      messageFlagsAdd: (uids: number[], flags: string[]) => {
        for (const m of self.boxes.get(self.#selected) ?? []) {
          if (uids.includes(m.uid)) for (const f of flags) m.flags.add(f);
        }
        return Promise.resolve(true);
      },
      messageFlagsRemove: (uids: number[], flags: string[]) => {
        for (const m of self.boxes.get(self.#selected) ?? []) {
          if (uids.includes(m.uid)) for (const f of flags) m.flags.delete(f);
        }
        return Promise.resolve(true);
      },
    } as unknown as ImapFlow;
  }
}

/** Разбор тех запросов поиска, которыми пользуется служба. */
function matches(msg: FakeMessage, query: Record<string, unknown>): boolean {
  if (Array.isArray(query['or'])) {
    return (query['or'] as Array<Record<string, unknown>>).some((q) => matches(msg, q));
  }
  const header = query['header'] as Record<string, string> | undefined;
  if (header) {
    for (const [name, value] of Object.entries(header)) {
      const field =
        name === 'references'
          ? (msg.references ?? '')
          : name === 'in-reply-to'
            ? (msg.inReplyTo ?? '')
            : name === 'message-id'
              ? msg.messageId
              : '';
      if (!field.toLowerCase().includes(value.toLowerCase())) return false;
    }
    return true;
  }
  let ok = true;
  if (typeof query['from'] === 'string') {
    ok = ok && msg.from.toLowerCase().includes((query['from'] as string).toLowerCase());
  }
  if (query['since'] instanceof Date) ok = ok && msg.date >= (query['since'] as Date);
  if (query['uid'] !== undefined) ok = ok && String(query['uid']).includes(String(msg.uid));
  return ok;
}

function makeService(connect: (email: string) => Promise<ImapFlow>) {
  const store = new FakeStore();
  const service = new AwaitReplyService({
    config,
    logger,
    master: { user: 'mtadmin', password: 'x', separator: '*' },
    connect,
  });
  service.attachStore(store);
  return { service, store };
}

const SENT_AT = new Date('2026-08-05T09:00:00Z');
const DUE_AT = new Date('2026-08-08T09:00:00Z');
const AFTER_DUE = new Date('2026-08-08T09:01:00Z');

function mailboxWithSentLetter(): FakeMailbox {
  const box = new FakeMailbox();
  box.add('Sent', {
    uid: 7,
    subject: 'Согласуем смету',
    from: 'ivan@mail.local',
    messageId: '<ask-1@mail.local>',
    date: SENT_AT,
    flags: new Set(['\\Seen', '$AwaitReply']),
  });
  return box;
}

async function waitFor(box: FakeMailbox, store: FakeStore, service: AwaitReplyService) {
  await store.add({
    accountEmail: 'ivan@mail.local',
    sentPath: 'Sent',
    sentUid: 7,
    sentUidValidity: 1,
    messageId: 'ask-1@mail.local',
    subject: 'Согласуем смету',
    toAddresses: 'kolya@example.com',
    sentAt: SENT_AT,
    dueAt: DUE_AT,
    timeZone: 'Europe/Moscow',
    preset: 'custom',
  });
  return service.tick(AFTER_DUE);
}

/* ------------------------------------------------------------------ */
/* Проверки                                                            */
/* ------------------------------------------------------------------ */

test('ответа нет — письмо поднимается во «Входящие» непрочитанным и закреплённым', async () => {
  const box = mailboxWithSentLetter();
  const { service, store } = makeService(() => Promise.resolve(box.client));

  const reminded = await waitFor(box, store, service);

  assert.equal(reminded, 1);
  assert.equal(store.rows[0]?.state, 'reminded');
  const inbox = box.boxes.get('INBOX') ?? [];
  assert.equal(inbox.length, 1, 'копия письма должна появиться во «Входящих»');
  const raised = inbox[0] as FakeMessage;
  assert.equal(raised.flags.has('\\Seen'), false, 'поднятое письмо обязано быть непрочитанным');
  assert.ok(raised.flags.has(AWAIT_OVERDUE_KEYWORD));
  assert.ok(raised.flags.has(AWAIT_PINNED_KEYWORD));
  // «Отправленные» остаются полной записью отправленного: копия, не перенос.
  assert.equal(box.boxes.get('Sent')?.length, 1);
  /*
   * И пометка «ждём ответа» с отправленного письма снята: ждать больше
   * нечего, напоминание уже пришло. Иначе в «Отправленных» письмо вечно
   * показывалось бы ожидающим ответа, а кнопка «Больше не ждать»
   * предлагала бы отменить то, что уже случилось.
   */
  assert.equal(box.find('Sent', 7)?.flags.has('$AwaitReply'), false);
});

test('ответ по ссылкам — напоминания нет и во «Входящих» ничего не появляется', async () => {
  const box = mailboxWithSentLetter();
  box.add('INBOX', {
    uid: 11,
    subject: 'Re: Согласуем смету',
    from: 'kolya@example.com',
    messageId: '<reply-1@example.com>',
    inReplyTo: '<ask-1@mail.local>',
    references: '<ask-1@mail.local>',
    date: new Date('2026-08-06T10:00:00Z'),
    flags: new Set(),
  });
  const { service, store } = makeService(() => Promise.resolve(box.client));

  const reminded = await waitFor(box, store, service);

  assert.equal(reminded, 0);
  assert.equal(store.rows[0]?.state, 'answered');
  assert.equal(store.rows[0]?.answerKind, 'references');
  assert.equal(box.boxes.get('INBOX')?.length, 1, 'лишней копии быть не должно');
  // Пометка «ждём ответа» с отправленного письма снята.
  assert.equal(box.find('Sent', 7)?.flags.has('$AwaitReply'), false);
});

test('ответ без In-Reply-To узнаётся по собеседнику и теме', async () => {
  const box = mailboxWithSentLetter();
  box.add('INBOX', {
    uid: 12,
    subject: 'Re: Согласуем смету',
    from: 'kolya@example.com',
    messageId: '<reply-2@example.com>',
    date: new Date('2026-08-06T10:00:00Z'),
    flags: new Set(),
  });
  const { service, store } = makeService(() => Promise.resolve(box.client));

  assert.equal(await waitFor(box, store, service), 0);
  assert.equal(store.rows[0]?.answerKind, 'subject');
});

test('автоответ об отпуске ответом не считается — напоминание всё равно приходит', async () => {
  const box = mailboxWithSentLetter();
  box.add('INBOX', {
    uid: 13,
    subject: 'Re: Согласуем смету',
    from: 'kolya@example.com',
    messageId: '<vacation@example.com>',
    inReplyTo: '<ask-1@mail.local>',
    autoSubmitted: 'auto-replied',
    date: new Date('2026-08-06T10:00:00Z'),
    flags: new Set(),
  });
  const { service, store } = makeService(() => Promise.resolve(box.client));

  assert.equal(await waitFor(box, store, service), 1);
  assert.equal(store.rows[0]?.state, 'reminded');
});

test('недоступный Dovecot не стирает срок — запись остаётся живой', async () => {
  const box = mailboxWithSentLetter();
  const { service, store } = makeService(() => Promise.reject(new Error('соединение отвергнуто')));

  assert.equal(await waitFor(box, store, service), 0);
  assert.equal(store.rows[0]?.state, 'waiting');
  assert.equal(store.rows[0]?.attempts, 1);
  assert.match(store.rows[0]?.lastError ?? '', /отвергнуто/);
});

test('отправленного письма больше нет — записи закрываются, а не копятся', async () => {
  const box = new FakeMailbox();
  const { service, store } = makeService(() => Promise.resolve(box.client));

  assert.equal(await waitFor(box, store, service), 0);
  assert.equal(store.rows[0]?.state, 'gone');
  assert.equal(box.boxes.get('INBOX')?.length, 0);
});

test('без служебного входа работник не запускается вовсе', () => {
  const service = new AwaitReplyService({ config, logger, master: null });
  service.attachStore(new FakeStore());
  assert.equal(service.available, true);
  assert.equal(service.scheduledCheckAvailable, false);
  // start() без служебного входа не заводит таймера — иначе процесс
  // держал бы будильник, который всё равно ничего не сможет сделать.
  service.start(10);
  service.stop();
});
