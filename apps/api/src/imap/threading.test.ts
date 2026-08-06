/**
 * Список писем, собранный в переписки, — на подставном почтовом сервере.
 *
 * Проверяется то, чего не было: признак `threaded` в `GET /api/messages`
 * принимался и молча терялся, список оставался плоским (docs/gaps.md, п. 11).
 *
 * Каждая проверка идёт в обе стороны: рядом с «переписка стала одной
 * строкой» стоит «в этой строке названы ВСЕ её письма». Вторая половина
 * важнее первой — именно на ней заводится дефект «удалил цепочку, а два
 * письма остались».
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImapFlow } from 'imapflow';
import type { Folder } from '@mail-true/shared';
import { THREAD_CAPABILITY } from '../mail/threads.js';
import { listMessages } from './service.js';

function folder(id: string, role: Folder['role'], path = id.toUpperCase()): Folder {
  return {
    id,
    path,
    name: path,
    role,
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 0,
    system: true,
    uidValidity: 1,
  };
}

const INBOX = folder('inbox', 'inbox', 'INBOX');
const DRAFTS = folder('drafts', 'drafts', 'Drafts');

/** Письмо в подставном ящике. */
interface FakeLetter {
  uid: number;
  from: { name: string; address: string };
  subject: string;
  seen?: boolean;
  flagged?: boolean;
  attachment?: boolean;
  /** Ключевые слова письма: свои метки и служебные слова продукта. */
  keywords?: string[];
}

interface FakeOptions {
  letters: FakeLetter[];
  /** Ветви ответа THREAD: `[[1,2,3],[4]]`. */
  groups: number[][];
  /** Сервер не умеет THREAD=REFS. */
  noThreadSupport?: boolean;
  /** Команда THREAD отвечает отказом. */
  threadFails?: boolean;
}

const withAttachment = (): unknown => ({
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/plain', size: 10 },
    {
      part: '2',
      type: 'application/pdf',
      disposition: 'attachment',
      dispositionParameters: { filename: 'акт.pdf' },
      encoding: 'base64',
      size: 1000,
    },
  ],
});

function expandRange(range: string): number[] {
  const out: number[] = [];
  for (const part of range.split(',')) {
    const [a, b] = part.split(':');
    const from = Number(a);
    const to = b === undefined ? from : Number(b);
    for (let i = from; i <= to; i += 1) out.push(i);
  }
  return out;
}

class FakeMailbox {
  /** Команды THREAD, ушедшие на сервер, — по ним видно, спрашивали ли вообще. */
  readonly threadCommands: string[][] = [];
  /** Условия поиска: по ним видно, ушёл ли отбор на сервер или сделан у нас. */
  readonly searchQueries: Array<Record<string, unknown>> = [];
  readonly capabilities = new Map<string, boolean>();

  constructor(private readonly options: FakeOptions) {
    if (!options.noThreadSupport) this.capabilities.set(THREAD_CAPABILITY, true);
  }

  async getMailboxLock(): Promise<{ release(): void }> {
    return { release: () => undefined };
  }

  async noop(): Promise<void> {}

  /**
   * Поиск подставного сервера.
   *
   * `KEYWORD` и `UNSEEN` он отрабатывает по-настоящему, и оба сразу —
   * логическим И, как и настоящий IMAP. Иначе проверка отбора по метке
   * доказывала бы только то, что команду послали, а не то, что список
   * после неё верный; а проверка «отбор складывается с непрочитанными»
   * не доказывала бы вовсе ничего.
   */
  async search(query: Record<string, unknown>): Promise<number[]> {
    this.searchQueries.push(query);
    const keyword = typeof query['keyword'] === 'string' ? query['keyword'] : null;
    const unseen = query['seen'] === false;
    return this.options.letters
      .filter((l) => keyword === null || (l.keywords ?? []).includes(keyword))
      .filter((l) => !unseen || l.seen === false)
      .map((l) => l.uid);
  }

  async exec(
    command: string,
    attributes: Array<{ value: string }>,
    options: { untagged: Record<string, (u: { attributes?: unknown }) => Promise<void>> },
  ): Promise<{ next(): void }> {
    this.threadCommands.push([command, ...attributes.map((a) => a.value)]);
    if (this.options.threadFails) throw new Error('THREAD failed');
    const handler = options.untagged['THREAD'];
    if (handler) {
      await handler({
        // Ровно та форма, в которой ответ отдаёт разбор imapflow:
        // список ветвей, в ветви — атомы со строковыми номерами.
        attributes: this.options.groups.map((group) =>
          group.map((uid) => ({ value: String(uid) })),
        ),
      });
    }
    return { next: () => undefined };
  }

  async fetchAll(range: string, query: Record<string, unknown>): Promise<unknown[]> {
    const wanted = new Set(expandRange(range));
    return this.options.letters
      .filter((l) => wanted.has(l.uid))
      .map((l) => ({
        uid: l.uid,
        bodyStructure: l.attachment
          ? withAttachment()
          : { part: '1', type: 'text/plain', size: 10 },
        ...(query['envelope']
          ? {
              envelope: {
                subject: l.subject,
                from: [l.from],
                date: new Date(2026, 6, 1, 12, 0, l.uid),
              },
              flags: new Set<string>([
                ...(l.seen === false ? [] : ['\\Seen']),
                ...(l.flagged ? ['\\Flagged'] : []),
                ...(l.keywords ?? []),
              ]),
              size: 100,
              internalDate: new Date(2026, 6, 1, 12, 0, l.uid),
            }
          : {}),
      }));
  }

  get client(): ImapFlow {
    return this as unknown as ImapFlow;
  }
}

/**
 * Переписка «Смета» (1, 4, 9) и два одиночных письма.
 *
 * Метки расставлены так, чтобы поймать главную ошибку показа: «Оплатить»
 * стоит на ПЕРВОМ письме разговора, «Юрист» — на среднем, а последнее
 * письмо (9) — свежий ответ, не несущий ни одного ключевого слова. Считай
 * строка метки по показанному письму — не было бы видно ни одной.
 * Рядом лежат служебные слова продукта: пометка возврата и чип категории.
 */
function conversationMailbox(overrides: Partial<FakeOptions> = {}): FakeMailbox {
  return new FakeMailbox({
    letters: [
      {
        uid: 1,
        from: { name: 'Иван', address: 'ivan@example.com' },
        subject: 'Смета',
        keywords: ['mt-oplatit', '$Snoozed'],
      },
      { uid: 2, from: { name: 'Анна', address: 'anna@example.com' }, subject: 'Отпуск' },
      {
        uid: 4,
        from: { name: 'Пётр', address: 'petr@example.com' },
        subject: 'Re: Смета',
        seen: false,
        attachment: true,
        keywords: ['mt-yurist'],
      },
      {
        uid: 9,
        from: { name: 'Иван', address: 'ivan@example.com' },
        subject: 'Re: Смета',
        flagged: true,
      },
    ],
    groups: [[1, 4, 9], [2]],
    ...overrides,
  });
}

const list = (mailbox: FakeMailbox, args: Partial<Parameters<typeof listMessages>[1]> = {}) =>
  listMessages(mailbox.client, {
    folder: INBOX,
    offset: 0,
    limit: 25,
    filter: 'all',
    withSnippets: false,
    ...args,
  });

/* ------------------------------------------------------------------ */
/* Строка — одна на переписку                                           */
/* ------------------------------------------------------------------ */

test('переписка из трёх писем занимает одну строку', async () => {
  const page = await list(conversationMailbox(), { threaded: true });

  assert.equal(page.items.length, 2, 'две строки: переписка и одиночное письмо');
  // `total` считает СТРОКИ, а не письма: по нему интерфейс решает,
  // есть ли что подгружать
  assert.equal(page.total, 2);

  const thread = page.items[0];
  assert.equal(thread?.subject, 'Re: Смета', 'в строке — последнее письмо переписки');
  assert.equal(thread?.thread?.count, 3);
});

test('обратный ход: без группировки те же письма дают четыре строки', async () => {
  const flat = await list(conversationMailbox());
  assert.equal(flat.items.length, 4);
  assert.equal(flat.total, 4);
  // И ни у одной строки нет сводки переписки — список остался плоским
  assert.equal(
    flat.items.every((m) => m.thread === undefined),
    true,
  );
});

test('строка-переписка называет ВСЕ свои письма — иначе действие тронет не все', async () => {
  const grouped = await list(conversationMailbox(), { threaded: true });
  const flat = await list(conversationMailbox());

  const fromThreads = grouped.items.flatMap((m) => m.thread?.messageIds ?? [m.id]);
  const fromFlat = flat.items.map((m) => m.id);

  // Прямой ход: письма, названные строками, — это ровно письма плоского списка
  assert.deepEqual([...fromThreads].sort(), [...fromFlat].sort());
  // Обратный ход: ни одно письмо не названо дважды
  assert.equal(new Set(fromThreads).size, fromThreads.length);
});

/* ------------------------------------------------------------------ */
/* Что показывает строка переписки                                      */
/* ------------------------------------------------------------------ */

test('участники переписки — по порядку появления, без повторов', async () => {
  const page = await list(conversationMailbox(), { threaded: true });
  assert.deepEqual(
    page.items[0]?.thread?.participants.map((p) => p.name),
    ['Иван', 'Пётр'],
    'Иван написал дважды — в списке участников он один раз и первым',
  );
});

test('переписка непрочитана, если непрочитано хоть одно письмо', async () => {
  const page = await list(conversationMailbox(), { threaded: true });
  const thread = page.items[0];

  assert.equal(thread?.thread?.unreadCount, 1, 'непрочитано одно письмо из трёх');
  // Обратный ход: последнее письмо переписки при этом ПРОЧИТАНО. Считай
  // строка непрочитанность по нему — непрочитанное письмо исчезло бы из
  // виду от того, что на него пришёл ответ.
  assert.equal(thread?.flags.seen, true);
});

test('флажок и скрепка переписки собираются со всех её писем', async () => {
  const page = await list(conversationMailbox(), { threaded: true });
  const thread = page.items[0];

  assert.equal(thread?.thread?.flagged, true, 'флажок стоит на письме 9');
  assert.equal(thread?.thread?.hasAttachments, true, 'вложение при письме 4');
  // Обратный ход: у одиночного письма без флажка и вложений — ничего
  assert.equal(page.items[1]?.thread?.flagged, false);
  assert.equal(page.items[1]?.thread?.hasAttachments, false);
});

/* ------------------------------------------------------------------ */
/* Метки переписки                                                      */
/* ------------------------------------------------------------------ */

test('метка стоит на переписке, если стоит хоть на одном её письме', async () => {
  const page = await list(conversationMailbox(), { threaded: true });
  const thread = page.items[0];

  assert.deepEqual(
    thread?.thread?.labels,
    ['mt-oplatit', 'mt-yurist'],
    'в сводке — метки со всех писем разговора, в порядке писем',
  );
  /*
   * Обратный ход, ради которого поле и заведено: у ПОКАЗАННОГО письма
   * метки нет ни одной. Считай строка метки по нему — пометка «оплатить»
   * пропадала бы из списка ровно тогда, когда на разговор пришёл ответ.
   */
  assert.deepEqual(thread?.labels, [], 'последнее письмо разговора без меток');
  // И у одиночного письма без меток сводка их не выдумывает
  assert.deepEqual(page.items[1]?.thread?.labels, []);
});

test('служебное слово продукта в метки переписки не попадает', async () => {
  // На письме 1 лежит `$Snoozed` — пометка возврата из «Отложенных».
  // В ряду с «Оплатить» и «Юрист» она выглядела бы как ярлык человека,
  // а снять её он не может: слово ставит и снимает сам продукт.
  const page = await list(conversationMailbox(), { threaded: true });
  assert.equal(page.items[0]?.thread?.labels.includes('$Snoozed'), false);
});

test('одна метка на двух письмах разговора не задваивается', async () => {
  // Ключевые слова у Dovecot нечувствительны к регистру: `MT-OPLATIT`
  // и `mt-oplatit` — одно слово, и второй пилюли в строке быть не должно.
  const mailbox = conversationMailbox({
    letters: [
      {
        uid: 1,
        from: { name: 'Иван', address: 'ivan@example.com' },
        subject: 'Смета',
        keywords: ['mt-oplatit'],
      },
      {
        uid: 9,
        from: { name: 'Пётр', address: 'petr@example.com' },
        subject: 'Re: Смета',
        keywords: ['MT-OPLATIT'],
      },
    ],
    groups: [[1, 9]],
  });
  const page = await list(mailbox, { threaded: true });
  assert.deepEqual(page.items[0]?.thread?.labels, ['mt-oplatit']);
});

/* ------------------------------------------------------------------ */
/* Отбор по метке                                                       */
/* ------------------------------------------------------------------ */

test('отбор по метке уходит в поиск, а не считается по загруженному', async () => {
  const mailbox = conversationMailbox();
  await list(mailbox, { threaded: true, label: 'mt-oplatit' });
  // Условие поиска — вот доказательство: отбор выполняет почтовый сервер
  // по своему индексу, значит он видит ВСЮ папку, а не загруженную страницу.
  assert.equal(mailbox.searchQueries.at(0)?.['keyword'], 'mt-oplatit');
});

test('строка-разговор попадает в отбор по метке на любом своём письме', async () => {
  // «Оплатить» стоит на ПЕРВОМ письме переписки, «Юрист» — на среднем.
  // Оба отбора обязаны показать один и тот же разговор.
  for (const label of ['mt-oplatit', 'mt-yurist']) {
    const page = await list(conversationMailbox(), { threaded: true, label });
    assert.equal(page.items.length, 1, `${label}: разговор не попал в отбор`);
    assert.equal(page.total, 1, `${label}: счётчик строк неверен`);
    assert.equal(page.items[0]?.thread?.labels.includes(label), true);
  }
  // Обратный ход: метки, которой нет ни на одном письме, отбирает пусто —
  // а не «показывает всё, раз ничего не нашлось».
  const none = await list(conversationMailbox(), { threaded: true, label: 'mt-net-takoy' });
  assert.equal(none.items.length, 0);
  assert.equal(none.total, 0);
});

test('отбор по метке складывается с отбором «непрочитанные»', async () => {
  // «Юрист» стоит на письме 4, и оно же единственное непрочитанное.
  const both = await list(conversationMailbox(), {
    threaded: true,
    label: 'mt-yurist',
    filter: 'unread',
  });
  assert.equal(both.items.length, 1);
  // Обратный ход: «Оплатить» стоит на прочитанном письме 1 — вместе
  // с «непрочитанными» не должно найтись ничего.
  const neither = await list(conversationMailbox(), {
    threaded: true,
    label: 'mt-oplatit',
    filter: 'unread',
  });
  assert.equal(neither.items.length, 0, 'условия перестали складываться');
});

test('служебное слово продукта отбором быть не может', async () => {
  /*
   * Главный замок отбора. `label=$Snoozed` показал бы список по служебной
   * пометке продукта — список, которого в интерфейсе нет и смысла которого
   * человек знать не может. То же и с чипом категории, и с признаком
   * надёжного отправителя, и с системным флагом IMAP.
   */
  for (const label of ['$Snoozed', '$MDNSent', 'finance', 'reliable', '\\Deleted', 'chuzhoe']) {
    const mailbox = conversationMailbox();
    await assert.rejects(
      list(mailbox, { threaded: true, label }),
      /пользовательская метка/iu,
      `${label} прошло отбором`,
    );
    // И до почтового сервера такой отбор не доехал вовсе
    assert.deepEqual(mailbox.searchQueries, [], `${label}: поиск всё-таки ушёл`);
  }
});

/* ------------------------------------------------------------------ */
/* Где группировки нет                                                  */
/* ------------------------------------------------------------------ */

test('в черновиках группировки нет, даже когда её просят', async () => {
  const mailbox = conversationMailbox();
  const page = await list(mailbox, { folder: DRAFTS, threaded: true });

  assert.equal(page.items.length, 4, 'каждый черновик — своя строка');
  assert.equal(
    page.items.every((m) => m.thread === undefined),
    true,
  );
  // И сервер об этом даже не спрашивали: лишняя команда IMAP на каждое
  // открытие папки — это плата ни за что
  assert.deepEqual(mailbox.threadCommands, []);
});

test('сервер без THREAD=REFS отдаёт обычный список, а не отказ', async () => {
  const mailbox = conversationMailbox({ noThreadSupport: true });
  const page = await list(mailbox, { threaded: true });

  assert.equal(page.items.length, 4);
  assert.deepEqual(mailbox.threadCommands, [], 'команда не отправлялась вовсе');
});

test('отказ команды THREAD — это видимая ошибка, а не тихий плоский список', async () => {
  // Здесь молчать нельзя: отказ THREAD означает неисправность сервера
  // (обычно испорченный индекс), и подменять её другим видом списка —
  // значит прятать поломку. Ровно эту ошибку однажды допустили с поиском.
  const mailbox = conversationMailbox({ threadFails: true });
  await assert.rejects(list(mailbox, { threaded: true }), /переписк/iu);
});

test('команда уходит с алгоритмом REFS, а не REFERENCES', async () => {
  // REFERENCES дополнительно склеивает письма по одинаковой теме. На живом
  // ящике это превращало 478 писем в 384 строки, причём в одну из них
  // попадало сорок несвязанных рассылок — и достать их из списка было
  // нельзя. Проверка стоит здесь, чтобы алгоритм нельзя было сменить молча.
  const mailbox = conversationMailbox();
  await list(mailbox, { threaded: true });
  assert.deepEqual(mailbox.threadCommands, [['UID THREAD', 'REFS', 'UTF-8', 'ALL']]);
});

/* ------------------------------------------------------------------ */
/* Страницы                                                             */
/* ------------------------------------------------------------------ */

test('страница отсчитывается перепискам, а не письмам', async () => {
  const page = await list(conversationMailbox(), { threaded: true, offset: 1, limit: 1 });

  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2, 'всего строк — две');
  assert.equal(page.items[0]?.id, 'inbox:2', 'вторая строка — одиночное письмо');
});
