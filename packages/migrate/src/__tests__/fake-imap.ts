/**
 * Поддельный IMAP-сервер для проверок переноса.
 *
 * Зачем он есть: проверять надо не «доедут ли письма» (это видно на живом
 * стенде), а КАК мы читаем чужой сервер — порциями или всё разом, сколько
 * раз спрашиваем хранилище состояния, перечитываем ли папку-приёмник на
 * каждом сборе. Поднимать ради этого настоящий Dovecot значило бы проверять
 * не то и не там.
 *
 * Сервер считает обращения к себе: сколько писем отдал каждый FETCH и по
 * какому диапазону. Именно по этим числам видно, что порции есть.
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ImapFlow } from 'imapflow';

/** Письмо на поддельном сервере. */
export interface FakeMessage {
  uid: number;
  flags: Set<string>;
  internalDate: Date;
  /** Заголовки письма целиком (из них считается ключ дедупликации). */
  headers: string;
  body: string;
}

/** Сколько писем отдал один FETCH и по какому диапазону. */
export interface FetchCall {
  range: string;
  byUid: boolean;
  returned: number;
}

/** Собрать письмо с заданным Message-ID. */
export function makeMessage(uid: number, messageId: string, subject = 'Письмо'): FakeMessage {
  return {
    uid,
    flags: new Set(['\\Seen']),
    internalDate: new Date('2026-01-01T10:00:00.000Z'),
    headers:
      `Message-ID: <${messageId}>\r\n` +
      `Date: Thu, 1 Jan 2026 10:00:00 +0300\r\n` +
      `From: otpravitel@staraya.ru\r\n` +
      `To: poluchatel@novaya.ru\r\n` +
      `Subject: ${subject}\r\n`,
    body: `Тело письма ${String(uid)}\r\n`,
  };
}

/** Разобрать диапазон вида «5:*» или «1:120». */
function inRange(range: string, value: number, max: number): boolean {
  const [rawFrom, rawTo] = range.split(':');
  const from = Number.parseInt(rawFrom ?? '1', 10);
  const to = rawTo === undefined || rawTo === '*' ? max : Number.parseInt(rawTo, 10);
  return value >= from && value <= to;
}

/**
 * Поддельный сервер. Умеет ровно то, что зовёт перенос, и ничего сверх:
 * лишние возможности здесь означали бы проверку выдуманного поведения.
 */
export class FakeImap extends EventEmitter {
  usable = true;
  mailbox: unknown = false;
  /** Папка → письма (по возрастанию UID). */
  readonly folders = new Map<string, FakeMessage[]>();
  /** UIDVALIDITY: меняется, если папку «пересоздали». */
  uidValidity = 7;
  /** Каждый FETCH: диапазон и сколько писем отдано. */
  readonly fetches: FetchCall[] = [];
  /** Каждый SEARCH: диапазон. */
  readonly searches: string[] = [];
  /** Скачанные тела писем — по ним видно, что тела читаются по одному. */
  downloads = 0;

  constructor(folders: Record<string, FakeMessage[]> = {}) {
    super();
    for (const [path, messages] of Object.entries(folders)) this.folders.set(path, [...messages]);
  }

  /** Наибольшее число писем, отданное одним FETCH (пик расхода памяти). */
  get biggestFetch(): number {
    return this.fetches.reduce((max, call) => Math.max(max, call.returned), 0);
  }

  /** Сколько писем прочитано всеми FETCH вместе. */
  get fetchedTotal(): number {
    return this.fetches.reduce((sum, call) => sum + call.returned, 0);
  }

  private messagesOf(path: string): FakeMessage[] {
    const messages = this.folders.get(path);
    if (!messages) {
      const err = Object.assign(new Error(`нет папки ${path}`), {
        serverResponseCode: 'NONEXISTENT',
      });
      throw err;
    }
    return messages;
  }

  /* --- то, что зовёт перенос ------------------------------------- */

  async connect(): Promise<void> {
    /* соединяться некуда — сервер и так «поднят» */
  }

  async logout(): Promise<void> {
    this.usable = false;
  }

  close(): void {
    this.usable = false;
  }

  async list(): Promise<Array<{ path: string; delimiter: string; flags: Set<string> }>> {
    return [...this.folders.keys()].map((path) => ({ path, delimiter: '/', flags: new Set() }));
  }

  async status(path: string): Promise<{ path: string; messages: number }> {
    return { path, messages: this.folders.get(path)?.length ?? 0 };
  }

  async mailboxCreate(path: string): Promise<{ path: string }> {
    if (this.folders.has(path)) {
      throw Object.assign(new Error('уже есть'), { serverResponseCode: 'ALREADYEXISTS' });
    }
    this.folders.set(path, []);
    return { path };
  }

  async getMailboxLock(path: string): Promise<{ path: string; release: () => void }> {
    const messages = this.messagesOf(path);
    this.mailbox = {
      path,
      delimiter: '/',
      flags: new Set<string>(),
      uidValidity: BigInt(this.uidValidity),
      uidNext: (messages.at(-1)?.uid ?? 0) + 1,
      exists: messages.length,
    };
    return { path, release: () => undefined };
  }

  async search(query: { uid?: string }, options: { uid?: boolean } = {}): Promise<number[]> {
    const path = (this.mailbox as { path?: string } | null)?.path;
    if (path === undefined) return [];
    const messages = this.messagesOf(path);
    const range = query.uid ?? '1:*';
    this.searches.push(range);
    const max = messages.at(-1)?.uid ?? 0;
    void options;
    return messages.filter((m) => inRange(range, m.uid, max)).map((m) => m.uid);
  }

  async *fetch(
    range: string,
    query: { headers?: boolean | string[]; flags?: boolean; internalDate?: boolean },
    options: { uid?: boolean } = {},
  ): AsyncGenerator<Record<string, unknown>> {
    const path = (this.mailbox as { path?: string } | null)?.path;
    if (path === undefined) return;
    const messages = this.messagesOf(path);
    const byUid = options.uid === true;
    const max = byUid ? (messages.at(-1)?.uid ?? 0) : messages.length;
    const call: FetchCall = { range, byUid, returned: 0 };
    this.fetches.push(call);
    for (const [index, message] of messages.entries()) {
      const number = byUid ? message.uid : index + 1;
      if (!inRange(range, number, max)) continue;
      call.returned += 1;
      yield {
        uid: message.uid,
        size: Buffer.byteLength(message.headers + '\r\n' + message.body),
        ...(query.flags === true ? { flags: new Set(message.flags) } : {}),
        ...(query.internalDate === true ? { internalDate: message.internalDate } : {}),
        ...(query.headers !== undefined ? { headers: Buffer.from(message.headers, 'utf8') } : {}),
      };
    }
  }

  async download(uid: string): Promise<{ content: Readable }> {
    const path = (this.mailbox as { path?: string } | null)?.path;
    const messages = this.messagesOf(path ?? 'INBOX');
    const message = messages.find((m) => m.uid === Number.parseInt(uid, 10));
    if (!message) throw new Error(`нет письма ${uid}`);
    this.downloads += 1;
    return { content: Readable.from([Buffer.from(message.headers + '\r\n' + message.body)]) };
  }

  async append(
    path: string,
    content: Buffer,
    flags: string[] = [],
    internalDate?: Date,
  ): Promise<{ path: string; uid: number }> {
    const messages = this.messagesOf(path);
    const text = content.toString('utf8');
    const split = text.indexOf('\r\n\r\n');
    const uid = (messages.at(-1)?.uid ?? 0) + 1;
    messages.push({
      uid,
      flags: new Set(flags),
      internalDate: internalDate ?? new Date(),
      headers: split >= 0 ? text.slice(0, split + 2) : text,
      body: split >= 0 ? text.slice(split + 4) : '',
    });
    return { path, uid };
  }
}

/** Подсунуть поддельный сервер туда, где перенос ждёт настоящий. */
export function asImapFlow(fake: FakeImap): ImapFlow {
  return fake as unknown as ImapFlow;
}
