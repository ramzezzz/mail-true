/**
 * Проверки маршрутов работы с письмами на подставном IMAP-клиенте.
 * Приложение собирается минимальным: маршруты + тот же перевод ошибок,
 * что и в бою (registerErrorHandling), без Redis и Postgres.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps } from '../types.js';
import { listQuerySchema, messageRoutes } from './messages.js';

interface FolderSpec {
  path: string;
  specialUse?: string;
  uids: number[];
  /** У каких писем есть настоящее вложение. */
  withAttachment?: number[];
}

/** Разворачивает набор номеров IMAP вида `1:100,105` в список. */
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

/** Подставной IMAP-клиент: только то, чем пользуются проверяемые маршруты. */
class FakeClient {
  readonly boxes = new Map<string, Set<number>>();
  readonly attachments = new Map<string, Set<number>>();
  private selected = 'INBOX';

  /** Журнал изменяющих вызовов — по нему видно, что тронули, а что нет. */
  readonly calls: string[] = [];

  constructor(private readonly specs: FolderSpec[]) {
    for (const spec of specs) {
      this.boxes.set(spec.path, new Set(spec.uids));
      this.attachments.set(spec.path, new Set(spec.withAttachment ?? []));
    }
  }

  async list(): Promise<unknown[]> {
    return this.specs.map((spec) => ({
      path: spec.path,
      name: spec.path,
      delimiter: '/',
      parentPath: '',
      specialUse: spec.specialUse,
      flags: new Set<string>(),
      status: {
        messages: this.boxes.get(spec.path)?.size ?? 0,
        unseen: 0,
        uidValidity: 1n,
      },
    }));
  }

  /**
   * Возможности сервера. Настоящий клиент их всегда знает, поддельный —
   * не знал, и обращение к ним валило проверки, как только продукт научился
   * спрашивать про SORT.
   *
   * Пустой набор означает «сервер ничего сверх обязательного не умеет» —
   * значит, продукт пойдёт запасным путём. Это и правильное поведение по
   * умолчанию для заглушки: она проверяет наш код, а не чужой сервер.
   */
  readonly capabilities = new Set<string>();

  async getMailboxLock(path: string): Promise<{ release(): void }> {
    this.selected = path;
    return { release: () => undefined };
  }

  /**
   * NOOP. Настоящий продукт зовёт его перед поиском, чтобы почтовый сервер
   * пересмотрел папку: соединение живёт между запросами, и без этого список
   * отставал ровно на одно письмо.
   *
   * Заглушка обязана уметь всё, что умеет настоящий клиент. Когда NOOP
   * появился в продукте, заглушки его не знали — и падали. Это десятый по
   * счёту случай, когда заглушка разошлась с настоящим; хорошо, что на этот
   * раз расхождение поймали проверки, а не человек.
   */
  async noop(): Promise<void> {}

  async search(query: { uid?: string; all?: boolean }): Promise<number[]> {
    const present = this.boxes.get(this.selected) ?? new Set<number>();
    if (typeof query.uid === 'string') {
      return expandSet(query.uid).filter((uid) => present.has(uid));
    }
    return [...present];
  }

  // Настоящий IMAP принимает набор вида `1:100,105` — и API теперь именно
  // так и сворачивает списки номеров, чтобы команда не упиралась в предел
  // длины (см. imap/service.ts, chunkUidSets)
  async fetchAll(range: string | number[]): Promise<unknown[]> {
    const uids = typeof range === 'string' ? expandSet(range) : range;
    const withAttachment = this.attachments.get(this.selected) ?? new Set<number>();
    return uids.map((uid) => ({
      uid,
      envelope: { subject: `Письмо ${uid}`, from: [], date: new Date('2026-08-05T10:00:00Z') },
      flags: new Set<string>(),
      size: 100,
      internalDate: new Date('2026-08-05T10:00:00Z'),
      bodyStructure: withAttachment.has(uid)
        ? {
            type: 'multipart/mixed',
            childNodes: [
              { part: '1', type: 'text/plain', size: 10 },
              {
                part: '2',
                type: 'application/pdf',
                size: 90,
                disposition: 'attachment',
                dispositionParameters: { filename: 'счёт.pdf' },
              },
            ],
          }
        : { part: '1', type: 'text/plain', size: 100 },
    }));
  }

  /** Одно письмо целиком: нужно выдаче исходника (.eml). */
  async fetchOne(seq: string): Promise<{ uid: number; source: Buffer } | false> {
    const uid = Number(seq);
    const present = this.boxes.get(this.selected) ?? new Set<number>();
    if (!present.has(uid)) return false;
    return {
      uid,
      source: Buffer.from(`Subject: Pismo ${String(uid)}

Telo pisma.
`, 'utf8'),
    };
  }

  async messageFlagsAdd(uids: number[], flags: string[]): Promise<boolean> {
    this.calls.push(`flagsAdd ${this.selected} ${uids.join(',')} ${flags.join(',')}`);
    return true;
  }

  async messageFlagsRemove(uids: number[], flags: string[]): Promise<boolean> {
    this.calls.push(`flagsRemove ${this.selected} ${uids.join(',')} ${flags.join(',')}`);
    return true;
  }

  async messageMove(
    uids: number[],
    destination: string
  ): Promise<{ path: string; destination: string; uidMap: Map<number, number> }> {
    this.calls.push(`move ${this.selected}->${destination} ${uids.join(',')}`);
    const from = this.boxes.get(this.selected);
    const to = this.boxes.get(destination) ?? new Set<number>();
    const uidMap = new Map<number, number>();
    let next = 1000;
    for (const uid of uids) {
      if (!from?.has(uid)) continue;
      from.delete(uid);
      const newUid = next++;
      to.add(newUid);
      uidMap.set(uid, newUid);
    }
    this.boxes.set(destination, to);
    return { path: this.selected, destination, uidMap };
  }

  async mailboxCreate(path: string): Promise<void> {
    this.calls.push(`mailboxCreate ${path}`);
    this.specs.push({ path, uids: [] });
    this.boxes.set(path, new Set());
  }

  async mailboxSubscribe(): Promise<void> {
    /* не важно для проверок */
  }
}

async function buildTestApp(client: FakeClient): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  const pool = {
    withClient: async <T>(_e: string, _p: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> =>
      fn(client as unknown as ImapFlow),
  };
  app.decorate('deps', { pool } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);
  await app.register(messageRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

function mailbox(): FakeClient {
  return new FakeClient([
    { path: 'INBOX', specialUse: '\\Inbox', uids: [1, 2, 3], withAttachment: [2] },
    { path: 'Trash', specialUse: '\\Trash', uids: [] },
  ]);
}

// --- Флаги ---

/**
 * Главный случай. Папки разбирались по ходу дела: письмо из несуществующей
 * папки в середине списка приводило к 404 уже ПОСЛЕ того, как часть флагов
 * проставлена, — список расходился с ящиком.
 */
test('флаги: несуществующая папка в списке не даёт изменить ничего', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/flags',
      payload: { ids: ['inbox:1', 'нет-такой-папки:5'], seen: true },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'NOT_FOUND');
    assert.deepEqual(client.calls, [], `ящик тронули: ${client.calls.join(' | ')}`);
  } finally {
    await app.close();
  }
});

/**
 * И наоборот: для несуществующего письма возвращалось `{"updated":1}`,
 * потому что считалась длина списка, а не результат IMAP.
 */
test('флаги: несуществующее письмо не считается изменённым', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/flags',
      payload: { ids: ['inbox:999'], seen: true },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { updated: 0 });
    assert.deepEqual(client.calls, []);
  } finally {
    await app.close();
  }
});

test('флаги: считаются только существующие письма', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/flags',
      payload: { ids: ['inbox:1', 'inbox:999', 'inbox:3'], flagged: true },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { updated: 2 });
    assert.deepEqual(client.calls, ['flagsAdd INBOX 1,3 \\Flagged']);
  } finally {
    await app.close();
  }
});

// --- Перемещение ---

test('перемещение: несуществующая папка-источник не даёт переместить ничего', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/move',
      payload: { ids: ['inbox:1', 'нет-такой-папки:5'], targetFolderId: 'trash' },
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(client.calls, []);
    assert.equal(client.boxes.get('INBOX')?.size, 3, 'письма остались на месте');
  } finally {
    await app.close();
  }
});

test('перемещение: заведомо неудачный запрос не создаёт папку-получатель', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/move',
      payload: { ids: ['нет-такой-папки:5'], targetFolderId: 'archive' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(
      client.calls.some((c) => c.startsWith('mailboxCreate')),
      false,
      'папка «Архив» создана зря'
    );
  } finally {
    await app.close();
  }
});

test('перемещение: несуществующее письмо не считается перемещённым', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/move',
      payload: { ids: ['inbox:999'], targetFolderId: 'trash' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { moved: 0 });
    assert.deepEqual(client.calls, []);
  } finally {
    await app.close();
  }
});

test('перемещение: счётчик равен числу действительно перемещённых писем', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/move',
      payload: { ids: ['inbox:1', 'inbox:999'], targetFolderId: 'trash' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { moved: 1 });
    assert.equal(client.boxes.get('Trash')?.size, 1);
    assert.equal(client.boxes.get('INBOX')?.has(1), false);
  } finally {
    await app.close();
  }
});

// --- Фильтр «с вложениями» ---

/**
 * Фильтр искал по заголовку `Content-Type: multipart/mixed`, а Dovecot по
 * нему не ищет — проверено на живом сервере. Фильтр не находил ничего
 * и никогда.
 */
test('фильтр «с вложениями» находит письма с вложениями', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?folderId=inbox&filter=with-attachments&snippets=0',
    });
    assert.equal(res.statusCode, 200);
    const page = res.json() as { items: Array<{ uid: number; hasAttachments: boolean }>; total: number };
    assert.equal(page.total, 1);
    assert.deepEqual(
      page.items.map((i) => i.uid),
      [2]
    );
    assert.equal(page.items[0]?.hasAttachments, true);
  } finally {
    await app.close();
  }
});

test('без фильтра список остаётся полным', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?folderId=inbox&snippets=0',
    });
    const page = res.json() as { total: number };
    assert.equal(page.total, 3);
  } finally {
    await app.close();
  }
});

test('несуществующий путь отвечает в форме контракта', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/такого-нет' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'NOT_FOUND', message: 'Ресурс не найден' });
  } finally {
    await app.close();
  }
});

/**
 * Исходник письма отдаётся файлом.
 *
 * Нужен там, где разбор не помогает: письмо с испорченным разделителем
 * частей показывалось пустым, и добраться до содержимого было нельзя ничем.
 *
 * Отдавать его для показа в браузере нельзя ни при каких условиях: это чужое
 * содержимое, и решать за нас, что это за файл, браузер не должен.
 */
test('исходник письма отдаётся вложением и не показывается в браузере', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/messages/inbox:1/source' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'message/rfc822');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(String(res.headers['content-disposition']), /^attachment;/);
    assert.match(String(res.headers['content-disposition']), /\.eml/);
    assert.match(res.body, /Telo pisma/);
  } finally {
    await app.close();
  }
});

test('исходника несуществующего письма нет, а не пустой файл', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/messages/inbox:999/source' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});

/* --- Отложенные письма ------------------------------------------------
 *
 * Здесь проверяется то, что живёт именно в маршрутах: снятие пометки
 * «вернулось» при прочтении и честный отказ, когда возможности нет.
 * Сам перенос писем и работник проверяются отдельно и подробно —
 * см. mail/snooze-service.test.ts.
 */

/**
 * Прочитанное письмо перестаёт быть «вернувшимся».
 *
 * Пометка нужна ровно для того, чтобы вернувшееся письмо нашлось: оно
 * приезжает на своё старое место по дате, то есть в середину списка.
 * Как только человек его открыл, задача выполнена — держать письмо
 * приклеенным к верху дальше значит мешать. Снимать её обязан сервер:
 * ключевые слова живут в ящике, и иначе письмо оставалось бы закреплённым
 * в телефоне и во второй вкладке.
 */
test('прочтение письма снимает пометку возврата из «Отложенных»', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/flags',
      payload: { ids: ['inbox:1'], seen: true },
    });
    assert.equal(res.statusCode, 200);
    const removed = client.calls.find((c) => c.startsWith('flagsRemove '));
    assert.ok(removed, `пометку не снимали: ${client.calls.join(' | ')}`);
    assert.match(removed, /\$Snoozed/);
    assert.match(removed, /\$Pinned/);
  } finally {
    await app.close();
  }
});

/** А снятие прочтения — не снимает: письмо снова ждёт, чтобы его заметили. */
test('пометка непрочитанным не трогает пометку возврата', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    await app.inject({
      method: 'POST',
      url: '/api/messages/flags',
      payload: { ids: ['inbox:1'], seen: false },
    });
    const removed = client.calls.find((c) => c.startsWith('flagsRemove '));
    assert.ok(removed);
    assert.doesNotMatch(removed, /\$Snoozed/);
  } finally {
    await app.close();
  }
});

/**
 * Без базы возможности нет — и об этом сказано прямо.
 *
 * Общее правило продукта: кнопка появляется вместе с поведением. Пока
 * `available` ложно, интерфейс не показывает «Отложить» вовсе, а не
 * показывает и отказывает (так же сделано с помощником ИИ).
 */
test('без базы «Отложить» недоступно, и интерфейс узнаёт об этом заранее', async () => {
  const client = mailbox();
  const app = await buildTestApp(client);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/messages/snoozed' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.available, false);
    assert.ok(String(body.reason).length > 0, 'причина отказа не названа');
    assert.deepEqual(body.items, []);

    const attempt = await app.inject({
      method: 'POST',
      url: '/api/messages/snooze',
      payload: { ids: ['inbox:1'], preset: 'tomorrow-morning' },
    });
    assert.equal(attempt.statusCode, 503);
    assert.equal(attempt.json().error, 'SNOOZE_UNAVAILABLE');
    // И ящик при этом не тронут ни на команду.
    assert.deepEqual(client.calls, [], `ящик тронули: ${client.calls.join(' | ')}`);
  } finally {
    await app.close();
  }
});

/* ------------------------------------------------------------------ */
/* Разбор строки запроса списка                                         */
/* ------------------------------------------------------------------ */

/**
 * `threaded=false` означает «не группировать» — и это пришлось написать
 * отдельной проверкой, потому что раньше означало обратное.
 *
 * В схеме стояло `z.coerce.boolean()`, то есть `Boolean(значение)`. Из
 * строки запроса приходит СТРОКА, а непустая строка «false» — истина.
 * Пока признак принимался и молча терялся, ошибка ничего не портила; как
 * только группировка заработала, выключить её стало нельзя. Найдено на
 * живом стенде: список без группировки отдавал 480 строк вместо 483 писем.
 */
test('threaded: истина — только «1» и «true», всё прочее — ложь', () => {
  const parse = (threaded?: string): boolean =>
    listQuerySchema.parse(threaded === undefined ? {} : { threaded }).threaded;

  assert.equal(parse('1'), true);
  assert.equal(parse('true'), true);
  // Обратный ход — то, ради чего проверка и написана
  assert.equal(parse('0'), false);
  assert.equal(parse('false'), false);
  assert.equal(parse(''), false);
  assert.equal(parse('нет'), false);
  // Признака нет вовсе — группировки нет: старый клиент ведёт себя как раньше
  assert.equal(parse(), false);
});
