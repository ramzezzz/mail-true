/**
 * Проверки операций над ящиком на подставном IMAP-клиенте.
 *
 * Все три случая ниже воспроизводились на живом стенде и молчали в коде:
 * отказ поиска выдавался за пустую папку, фильтр «с вложениями» упирался
 * в предел длины команды IMAP, а после ответа исходное письмо не получало
 * флага «отвечено».
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImapFlow } from 'imapflow';
import type { Folder } from '@mail-true/shared';
import { ApiError } from '../errors.js';
import {
  UID_SET_MAX_CHARS,
  buildSearchQuery,
  chunkUidSets,
  existingUids,
  listMessages,
  markAnswered,
  searchUids,
} from './service.js';

const INBOX: Folder = {
  id: 'inbox',
  path: 'INBOX',
  name: 'INBOX',
  role: 'inbox',
  parentId: null,
  depth: 0,
  unreadCount: 0,
  totalCount: 0,
  system: true,
  uidValidity: 1,
};

/** Структура письма с настоящим вложением. */
function withAttachment(): unknown {
  return {
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain', size: 10 },
      {
        part: '2',
        type: 'application/pdf',
        disposition: 'attachment',
        dispositionParameters: { filename: 'счёт.pdf' },
        encoding: 'base64',
        size: 1000,
      },
    ],
  };
}

function plainMessage(): unknown {
  return { part: '1', type: 'text/plain', size: 10 };
}

/** Разворачивает набор вида `1:5,9` обратно в номера. */
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

interface FakeOptions {
  uids?: number[];
  /** search отвечает отказом — imapflow возвращает не массив */
  searchFails?: boolean;
  withAttachments?: (uid: number) => boolean;
}

class FakeMailbox {
  /** Все аргументы-наборы, ушедшие в FETCH: по ним видно длину команды. */
  readonly fetchRanges: string[] = [];
  readonly flagsAdded: Array<{ uids: number[]; flags: string[] }> = [];

  constructor(private readonly options: FakeOptions = {}) {}

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

  async getMailboxLock(): Promise<{ release(): void }> {
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

  async search(): Promise<number[] | false> {
    if (this.options.searchFails) return false;
    return this.options.uids ?? [];
  }

  async fetchAll(range: string | number[], query: Record<string, unknown>): Promise<unknown[]> {
    const asString = typeof range === 'string' ? range : range.join(',');
    this.fetchRanges.push(asString);
    const uids = typeof range === 'string' ? expandRange(range) : range;
    const keep = this.options.withAttachments ?? (() => false);
    return uids.map((uid) => ({
      uid,
      bodyStructure: keep(uid) ? withAttachment() : plainMessage(),
      ...(query['envelope']
        ? {
            envelope: { subject: `письмо ${String(uid)}`, from: [{ name: '', address: 'a@b' }] },
            flags: new Set<string>(),
            size: 100,
            internalDate: new Date('2026-08-05T10:00:00Z'),
          }
        : {}),
    }));
  }

  async messageFlagsAdd(uids: number[], flags: string[]): Promise<boolean> {
    this.flagsAdded.push({ uids, flags });
    return true;
  }

  async list(): Promise<unknown[]> {
    return [
      {
        path: 'INBOX',
        name: 'INBOX',
        delimiter: '/',
        parentPath: '',
        specialUse: '\\Inbox',
        flags: new Set<string>(),
        status: { messages: 1, unseen: 0, uidValidity: 1n },
      },
    ];
  }

  get client(): ImapFlow {
    return this as unknown as ImapFlow;
  }
}

/* ------------------------------------------------------------------ */
/* Находка 1: отказ поиска выдавался за «ничего не найдено»             */
/* ------------------------------------------------------------------ */

/**
 * imapflow при неудаче SEARCH ошибку не бросает, а возвращает `false`.
 * Раньше это подменялось пустым массивом, и API отвечал
 * `{"items":[],"total":0}` с кодом 200 — человек был уверен, что писем нет.
 */
test('отказ поиска — это ошибка, а не пустая папка', async () => {
  const mailbox = new FakeMailbox({ searchFails: true });
  await assert.rejects(
    () =>
      listMessages(mailbox.client, {
        folder: INBOX,
        offset: 0,
        limit: 25,
        filter: 'all',
        withSnippets: false,
      }),
    (err: unknown) =>
      err instanceof ApiError && err.statusCode === 503 && err.code === 'UPSTREAM_UNAVAILABLE',
  );
});

test('searchUids: успешный поиск отдаёт номера как есть', async () => {
  const mailbox = new FakeMailbox({ uids: [3, 1, 2] });
  assert.deepEqual(await searchUids(mailbox.client, { all: true }), [3, 1, 2]);
});

/* ------------------------------------------------------------------ */
/* Тема письма, скопированная в поиск, обязана это письмо найти          */
/* ------------------------------------------------------------------ */

/*
 * Живьём (стенд mtcheck, Dovecot + dovecot-fts-xapian, partial=3):
 * письмо с темой «Договор № 452/26: правки» находилось запросами
 * «Договор», «452», «правки», «Договор 452 правки» — и не находилось
 * собственной темой. Движок делит «452/26» на «452» и «26», требует обе
 * части, а слова короче трёх букв в индексе не бывает. Условие
 * невыполнимо — выдача пуста, и выглядит это как «письма нет».
 */
test('невыполнимый обломок не уходит в TEXT — иначе письмо не найдётся своей же темой', () => {
  assert.deepEqual(buildSearchQuery('all', 'Договор № 452/26: правки'), {
    all: true,
    text: 'Договор № 452 правки',
  });
  // То же и у `тема:` — она ищется тем же полнотекстовым индексом
  assert.deepEqual(buildSearchQuery('all', 'тема:"Договор № 452/26"'), {
    all: true,
    subject: 'Договор № 452',
  });
});

test('адресные условия дроблению не подлежат', () => {
  // FROM/TO/CC — это ОДНА строка целиком, а не набор слов: разбей её на
  // куски — и поиск по адресу перестанет работать вовсе.
  assert.deepEqual(buildSearchQuery('all', 'от:test@mail.local'), {
    all: true,
    from: 'test@mail.local',
  });
  assert.deepEqual(buildSearchQuery('all', 'кому:a@b.co'), { all: true, to: 'a@b.co' });
});

/* ------------------------------------------------------------------ */
/* Отбор по своей метке — условие поиска, а не перебор загруженного      */
/* ------------------------------------------------------------------ */

test('метка становится условием KEYWORD и складывается с остальными', () => {
  // Именно `keyword`: это команда IMAP `KEYWORD <слово>`, и Dovecot
  // отвечает на неё по индексу — по всей папке, а не по странице.
  assert.deepEqual(buildSearchQuery('all', undefined, 'mt-oplatit'), {
    all: true,
    keyword: 'mt-oplatit',
  });
  // Условия соединяются логическим И: «непрочитанные с меткой» —
  // законный запрос, а не спор двух отборов
  assert.deepEqual(buildSearchQuery('unread', undefined, 'mt-oplatit'), {
    seen: false,
    keyword: 'mt-oplatit',
  });
  // Обратный ход: без метки условия KEYWORD в запросе нет вовсе
  assert.equal('keyword' in buildSearchQuery('all', undefined), false);
  assert.equal('keyword' in buildSearchQuery('all', undefined, ''), false);
});

test('служебное слово продукта не становится условием поиска', () => {
  // Отбор по `$Snoozed` или `finance` показал бы список, которого в
  // интерфейсе нет; замок стоит в сборке запроса, а не в разборе строки
  // запроса, — чтобы его нельзя было обойти другим вызывающим.
  for (const label of ['$Snoozed', '$MDNSent', 'reliable', 'finance', '\\Deleted', 'oplatit']) {
    assert.throws(
      () => buildSearchQuery('all', undefined, label),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400,
      `${label} прошло отбором`,
    );
  }
});

/**
 * Тот же обман в другом месте: `{"updated":0}` означал бы «таких писем нет»,
 * хотя на самом деле поиск не выполнился.
 */
test('existingUids не выдаёт отказ поиска за отсутствие писем', async () => {
  const mailbox = new FakeMailbox({ searchFails: true });
  await assert.rejects(
    () => existingUids(mailbox.client, [1, 2, 3]),
    (err: unknown) => err instanceof ApiError && err.statusCode === 503,
  );
});

/* ------------------------------------------------------------------ */
/* Находка 2: фильтр «с вложениями» падал на большом ящике              */
/* ------------------------------------------------------------------ */

test('chunkUidSets: подряд идущие номера сворачиваются в один диапазон', () => {
  const uids = Array.from({ length: 20_000 }, (_, i) => i + 1);
  assert.deepEqual(chunkUidSets(uids), ['1:20000']);
});

test('chunkUidSets: разрозненные номера режутся на команды в пределах длины', () => {
  // Худший случай: ничего не сворачивается
  const uids = Array.from({ length: 20_000 }, (_, i) => i * 2 + 1);
  const chunks = chunkUidSets(uids);
  assert.ok(chunks.length > 1, 'такой список обязан разбиться на несколько команд');
  for (const chunk of chunks) {
    assert.ok(
      chunk.length <= UID_SET_MAX_CHARS,
      `набор длиной ${String(chunk.length)} превышает предел ${String(UID_SET_MAX_CHARS)}`,
    );
  }
  // Ни один номер не потерян и не задвоен
  const restored = chunks.flatMap(expandRange);
  assert.deepEqual(restored, uids);
});

test('chunkUidSets: пустой список — пустой результат', () => {
  assert.deepEqual(chunkUidSets([]), []);
});

/**
 * Замеры до исправления: 2000 писем — 86 мс, 10 271 — 391 мс,
 * 20 000 — HTTP 500 за 33 мс и «Too long argument» в журнале Dovecot.
 * Причина — весь список номеров одной строкой в одной команде FETCH.
 */
test('фильтр «с вложениями» на 20 000 писем не шлёт слишком длинную команду', async () => {
  // Номера вразнобой: свернуть в один диапазон нельзя
  const uids = Array.from({ length: 20_000 }, (_, i) => i * 2 + 1);
  const mailbox = new FakeMailbox({
    uids,
    withAttachments: (uid) => uid % 1001 === 0,
  });

  const page = await listMessages(mailbox.client, {
    folder: INBOX,
    offset: 0,
    limit: 25,
    filter: 'with-attachments',
    withSnippets: false,
  });

  assert.ok(mailbox.fetchRanges.length > 0, 'структуры писем должны запрашиваться');
  for (const range of mailbox.fetchRanges) {
    assert.ok(
      range.length <= UID_SET_MAX_CHARS,
      `команда FETCH длиной ${String(range.length)} символов — Dovecot ответит «Too long argument»`,
    );
  }
  assert.equal(page.total, uids.filter((uid) => uid % 1001 === 0).length);
});

/* ------------------------------------------------------------------ */
/* Находка 8: ответ не помечал исходное письмо                          */
/* ------------------------------------------------------------------ */

test('markAnswered ставит флаг «отвечено» на письме с этим Message-ID', async () => {
  const mailbox = new FakeMailbox({ uids: [42] });
  const done = await markAnswered(mailbox.client, '<abc@mail.local>');
  assert.equal(done, true);
  assert.deepEqual(mailbox.flagsAdded, [{ uids: [42], flags: ['\\Answered'] }]);
});

test('markAnswered молчит, если исходного письма в ящике нет', async () => {
  const mailbox = new FakeMailbox({ uids: [] });
  assert.equal(await markAnswered(mailbox.client, '<нет-такого@mail.local>'), false);
  assert.deepEqual(mailbox.flagsAdded, []);
});
