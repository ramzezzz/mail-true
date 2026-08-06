/**
 * Разбор журналов, чтение файла страницами и разбор очереди.
 *
 * Проверки нарочно опираются на НАСТОЯЩИЕ строки, снятые с живого стенда
 * (docker compose logs postfix / dovecot), а не на придуманные: разбор
 * журнала ценен ровно настолько, насколько он совпадает с тем, что служба
 * на самом деле пишет.
 *
 * Ни одна из этих проверок не проходит на старом коде — ни разбора, ни
 * чтения журналов, ни очереди в продукте не было вовсе.
 */
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  QueueMetaCache,
  directionOf,
  isQueueRemoval,
  levelAtLeast,
  parseLogLine,
  parseSyslogTime,
  pinoLevel,
  postfixLevel,
  toFlowEvent,
  toQueueMeta,
} from './mail-log.js';
import { lastCompleteLineEnd, readLogPage, readLogTail, readNewLines } from './log-files.js';
import { FlowStore, likeEscape } from './flow-store.js';
import type { AdminDb } from './db.js';
import { isQueueId, parseQueueLine, queueMatches, QueueAgent } from './queue-agent.js';

/* ------------------------------------------------------------------ */
/* Уровни                                                               */
/* ------------------------------------------------------------------ */

test('порог уровня пускает выбранный и всё, что важнее', () => {
  assert.equal(levelAtLeast('error', 'warn'), true, 'ошибки видны при пороге «предупреждения»');
  assert.equal(levelAtLeast('warn', 'warn'), true);
  assert.equal(
    levelAtLeast('info', 'warn'),
    false,
    'обычные события при пороге «предупреждения» скрыты',
  );
  assert.equal(levelAtLeast('debug', 'debug'), true);
  assert.equal(levelAtLeast('info', 'error'), false);
});

test('числовые уровни pino сводятся к четырём ступеням', () => {
  assert.equal(pinoLevel(60), 'error', 'fatal — это ошибка');
  assert.equal(pinoLevel(50), 'error');
  assert.equal(pinoLevel(40), 'warn');
  assert.equal(pinoLevel(30), 'info');
  assert.equal(pinoLevel(20), 'debug');
  assert.equal(pinoLevel(10), 'debug', 'trace тоже подробности');
});

/* ------------------------------------------------------------------ */
/* Важность строк Postfix                                               */
/* ------------------------------------------------------------------ */

test('важность строки Postfix выводится из смысла события', () => {
  // Письмо не дойдёт никогда — это ошибка.
  assert.equal(
    postfixLevel('4c2w: to=<a@b>, status=bounced (host said: 550 no such user)'),
    'error',
  );
  assert.equal(postfixLevel('4c2w: to=<a@b>, status=expired, returned to sender'), 'error');
  assert.equal(postfixLevel('fatal: parameter inet_interfaces: no local interface'), 'error');

  // Письмо ещё дойдёт, но что-то не так — предупреждение.
  assert.equal(
    postfixLevel('4c2w: to=<a@b>, status=deferred (connect to mx: Connection refused)'),
    'warn',
  );
  assert.equal(postfixLevel('warning: hostname does not resolve to address'), 'warn');

  // Отказ чужому письму — норма живого сервера, но не «просто событие».
  assert.equal(
    postfixLevel('NOQUEUE: reject: RCPT from x[1.2.3.4]: 550 5.1.1 <a@b>: Recipient rejected'),
    'warn',
  );

  // Обычная жизнь.
  assert.equal(postfixLevel('4c2w: to=<a@b>, status=sent (250 2.0.0 saved)'), 'info');
  assert.equal(postfixLevel('connect from mail-api.mailtrue_default[172.28.0.7]'), 'info');
});

/* ------------------------------------------------------------------ */
/* Разбор строк                                                         */
/* ------------------------------------------------------------------ */

test('строка Postfix разбирается на время, службу, письмо и текст', () => {
  const now = new Date(2026, 7, 5, 21, 0, 0);
  const entry = parseLogLine(
    'postfix',
    'Aug  5 20:30:01 mail postfix/lmtp[42]: 4c2wKp1Vt2z: to=<a@mail.local>, ' +
      'relay=172.28.0.54[172.28.0.54]:24, delay=0.08, dsn=2.0.0, status=sent (250 2.0.0 saved)',
    now,
  );
  assert.equal(entry.component, 'lmtp');
  assert.equal(entry.queueId, '4c2wKp1Vt2z');
  assert.equal(entry.level, 'info');
  assert.equal(entry.at?.getHours(), 20);
  assert.equal(entry.at?.getMinutes(), 30);
  assert.ok(entry.text.startsWith('4c2wKp1Vt2z: to=<a@mail.local>'));
});

test('составное имя службы Postfix разбирается целиком', () => {
  // Именно так выглядит подача почты пользователем на 587 — самое частое
  // событие этого сервера. Без поддержки косой черты в имени вся эта
  // ветка журнала разбиралась бы как неопознанная строка.
  const entry = parseLogLine(
    'postfix',
    'Aug 05 18:19:42 mail postfix/submission/smtpd[53310]: connect from ' +
      'mail-api.mailtrue_default[172.28.0.7]',
    new Date(2026, 7, 5, 19, 0, 0),
  );
  assert.equal(entry.component, 'submission/smtpd');
  assert.equal(entry.text, 'connect from mail-api.mailtrue_default[172.28.0.7]');
});

test('строка Dovecot берёт уровень из своей пометки', () => {
  const now = new Date(2026, 7, 5, 19, 0, 0);
  const info = parseLogLine(
    'dovecot',
    'Aug 05 18:19:53 lmtp(31): Info: Connect from 127.0.0.1',
    now,
  );
  assert.equal(info.level, 'info');
  assert.equal(info.component, 'lmtp');

  const err = parseLogLine(
    'dovecot',
    'Aug 05 18:20:11 imap(user@mail.local)<77><abc>: Error: Mailbox INBOX: Corrupted index',
    now,
  );
  assert.equal(err.level, 'error');
  assert.equal(err.component, 'imap');
  assert.ok(err.text.includes('user@mail.local'), 'кому именно — остаётся в тексте');

  assert.equal(
    parseLogLine('dovecot', 'Aug 05 18:20:11 master: Warning: Killed with signal 15', now).level,
    'warn',
  );
  assert.equal(
    parseLogLine('dovecot', 'Aug 05 18:20:11 imap: Debug: Effective uid=5000', now).level,
    'debug',
  );
});

test('строка сервера приложения разбирается из JSON pino', () => {
  const line = JSON.stringify({
    level: 40,
    time: Date.UTC(2026, 7, 5, 18, 0, 0),
    pid: 1,
    hostname: 'mail-api',
    msg: 'Redis недоступен',
    err: 'ECONNRESET',
  });
  const entry = parseLogLine('api', line);
  assert.equal(entry.level, 'warn');
  assert.equal(entry.at?.getTime(), Date.UTC(2026, 7, 5, 18, 0, 0));
  assert.ok(entry.text.includes('Redis недоступен'));
  assert.ok(entry.text.includes('err=ECONNRESET'), 'подробности записи не теряются');
});

test('непонятная строка не теряется, а показывается как есть', () => {
  // Молча выбрасывать неразобранное нельзя: именно непонятная строка чаще
  // всего и оказывается той, ради которой журнал открыли.
  const entry = parseLogLine('postfix', 'что-то совсем не по формату');
  assert.equal(entry.text, 'что-то совсем не по формату');
  assert.equal(entry.level, 'info');
  assert.equal(entry.at, null);
});

test('строка от 31 декабря не уезжает на год вперёд', () => {
  // В syslog-метке года нет. Если наивно взять текущий, вся история
  // новогодней ночи оказалась бы «в будущем» и не показалась бы никогда.
  const now = new Date(2027, 0, 1, 0, 30, 0);
  const at = parseSyslogTime('Dec', '31', '23:59:30', now);
  assert.equal(at?.getFullYear(), 2026);
  assert.equal(at?.getMonth(), 11);
  assert.equal(at?.getDate(), 31);
});

/* ------------------------------------------------------------------ */
/* События доставки                                                     */
/* ------------------------------------------------------------------ */

const NOW = new Date(2026, 7, 5, 21, 0, 0);

function postfixEvent(text: string) {
  return parseLogLine('postfix', `Aug  5 20:30:01 mail ${text}`, NOW);
}

test('доставленное письмо становится строкой истории со всеми полями', () => {
  const meta = toQueueMeta(
    postfixEvent(
      'postfix/qmgr[9]: 4c2wKp1Vt2z: from=<sender@example.com>, size=2481, nrcpt=1 (queue active)',
    ),
  );
  assert.deepEqual(meta, { sender: 'sender@example.com', sizeBytes: 2481 });

  const event = toFlowEvent(
    postfixEvent(
      'postfix/lmtp[42]: 4c2wKp1Vt2z: to=<user@mail.local>, ' +
        'relay=172.28.0.54[172.28.0.54]:24, delay=0.08, delays=0.05/0/0.01/0.02, ' +
        'dsn=2.0.0, status=sent (250 2.0.0 <user@mail.local> saved)',
    ),
    meta ?? undefined,
  );
  assert.ok(event);
  assert.equal(event.status, 'sent');
  assert.equal(event.direction, 'in', 'доставка через lmtp — это входящее');
  assert.equal(event.recipient, 'user@mail.local');
  assert.equal(event.sender, 'sender@example.com', 'отправитель берётся из более ранней строки');
  assert.equal(event.sizeBytes, 2481);
  assert.equal(event.delaySeconds, 0.08);
  assert.equal(event.dsn, '2.0.0');
  assert.equal(event.queueId, '4c2wKp1Vt2z');
  assert.ok(event.reason?.includes('250 2.0.0'), 'ответ принимающей стороны сохранён целиком');
});

test('отложенное письмо получает причину отсрочки, отбитое — постоянный отказ', () => {
  const deferred = toFlowEvent(
    postfixEvent(
      'postfix/smtp[7]: 4c2wKp1Vt2z: to=<a@example.org>, relay=none, delay=302, ' +
        'dsn=4.4.1, status=deferred (connect to example.org: Connection timed out)',
    ),
    undefined,
  );
  assert.equal(deferred?.status, 'deferred');
  assert.equal(deferred?.direction, 'out', 'отправка через smtp — это исходящее');
  assert.equal(deferred?.dsn, '4.4.1');
  assert.ok(deferred?.reason?.includes('Connection timed out'));
  assert.equal(deferred?.delaySeconds, 302);

  const bounced = toFlowEvent(
    postfixEvent(
      'postfix/smtp[7]: 4c2wKp1Vt2z: to=<нет@example.org>, relay=mx.example.org[1.2.3.4]:25, ' +
        'delay=1.2, dsn=5.1.1, status=bounced (host mx.example.org said: 550 5.1.1 unknown)',
    ),
    undefined,
  );
  assert.equal(bounced?.status, 'bounced');
  assert.equal(bounced?.dsn, '5.1.1');
  assert.ok(bounced?.reason?.includes('550 5.1.1 unknown'));
});

test('отказ на приёме тоже попадает в историю, хотя очереди у него нет', () => {
  const event = toFlowEvent(
    postfixEvent(
      'postfix/smtpd[3]: NOQUEUE: reject: RCPT from unknown[203.0.113.9]: 550 5.1.1 ' +
        '<нет@mail.local>: Recipient address rejected: User unknown in virtual mailbox table; ' +
        'from=<spam@example.net> to=<нет@mail.local> proto=ESMTP helo=<x>',
    ),
    undefined,
  );
  assert.ok(event);
  assert.equal(event.status, 'rejected');
  // NOQUEUE стоит ровно там, где обычно идентификатор письма, и означает
  // обратное: очереди у этого письма нет. Принять его за идентификатор —
  // значит связать между собой чужие друг другу отказы.
  assert.equal(event.queueId, null, 'письму, отбитому на RCPT, очередь не заводится');
  assert.equal(event.recipient, 'нет@mail.local');
  assert.equal(event.sender, 'spam@example.net');
  assert.ok(event.reason?.includes('Recipient address rejected'));
});

test('обычная строка журнала событием доставки не притворяется', () => {
  assert.equal(
    toFlowEvent(postfixEvent('postfix/anvil[2926]: statistics: max cache size 3'), undefined),
    null,
  );
  assert.equal(
    toFlowEvent(postfixEvent('postfix/smtpd[1]: connect from x[1.2.3.4]'), undefined),
    null,
  );
});

test('направление определяется транспортом, а не адресом', () => {
  // Адрес врёт: алиас, пересылка, ящик на чужом домене. Транспорт — нет.
  assert.equal(directionOf('lmtp', null), 'in');
  assert.equal(directionOf('smtp', 'mx.example.org[1.2.3.4]:25'), 'out');
  assert.equal(directionOf('submission/smtpd', null), 'unknown');
  assert.equal(directionOf('bounce', null), 'unknown', 'чего не знаем — тем и называем');
  assert.equal(directionOf('unknown', '172.28.0.54[172.28.0.54]:24'), 'in', 'по порту LMTP');
});

test('строка «removed» опознаётся: письмо ушло из очереди', () => {
  assert.equal(isQueueRemoval(postfixEvent('postfix/qmgr[9]: 4c2wKp1Vt2z: removed')), true);
  assert.equal(
    isQueueRemoval(postfixEvent('postfix/qmgr[9]: 4c2wKp1Vt2z: from=<a@b>, size=1')),
    false,
  );
});

test('память об отправителях ограничена и вытесняет самое старое', () => {
  // Без предела эта память росла бы вместе с очередью: строка from= приходит
  // раз, а письмо может пролежать в очереди сутки.
  const cache = new QueueMetaCache(3);
  for (const id of ['aaaaa', 'bbbbb', 'ccccc', 'ddddd']) {
    cache.set(id, { sender: `${id}@x`, sizeBytes: 1 });
  }
  assert.equal(cache.size, 3);
  assert.equal(cache.get('aaaaa'), undefined, 'самое старое вытеснено');
  assert.equal(cache.get('ddddd')?.sender, 'ddddd@x');
});

/* ------------------------------------------------------------------ */
/* Очередь                                                              */
/* ------------------------------------------------------------------ */

test('строка postqueue -j превращается в письмо очереди', () => {
  const line = JSON.stringify({
    queue_name: 'deferred',
    queue_id: '4c2wKp1Vt2z',
    arrival_time: 1754419200,
    message_size: 2481,
    sender: 'sender@example.com',
    recipients: [
      { address: 'a@mail.local', delay_reason: 'connect to 172.28.0.54: Connection refused' },
      { address: 'b@mail.local' },
    ],
  });
  const message = parseQueueLine(line);
  assert.ok(message);
  assert.equal(message.queueId, '4c2wKp1Vt2z');
  assert.equal(message.queueName, 'deferred');
  assert.equal(message.sizeBytes, 2481);
  assert.equal(message.arrivalTime.getTime(), 1754419200 * 1000);
  assert.equal(message.recipients.length, 2);
  assert.equal(message.recipients[1]?.delayReason, null);
  assert.ok(message.reason?.includes('Connection refused'), 'причина отсрочки видна сразу');
});

test('пустой отправитель показывается как отбойник, а не как пустота', () => {
  const message = parseQueueLine(
    JSON.stringify({
      queue_name: 'active',
      queue_id: 'ABCDE12345',
      arrival_time: 1,
      message_size: 10,
      sender: '',
      recipients: [{ address: 'a@mail.local' }],
    }),
  );
  assert.equal(message?.sender, '<>');
});

test('мусор вместо строки очереди пропускается, а не роняет весь список', () => {
  assert.equal(parseQueueLine('postqueue: warning: something'), null);
  assert.equal(parseQueueLine('{'), null);
  assert.equal(parseQueueLine(JSON.stringify({ queue_id: 'нет' })), null);
});

test('отбор по строке ищет и в адресатах, и в причине', () => {
  const message = parseQueueLine(
    JSON.stringify({
      queue_name: 'deferred',
      queue_id: 'ABCDE12345',
      arrival_time: 1,
      message_size: 10,
      sender: 'boss@example.com',
      recipients: [{ address: 'ivanov@mail.local', delay_reason: 'Connection timed out' }],
    }),
  )!;
  assert.equal(queueMatches(message, 'ivanov'), true);
  assert.equal(queueMatches(message, 'boss@'), true);
  assert.equal(queueMatches(message, 'timed out'), true);
  assert.equal(queueMatches(message, 'abcde'), true, 'идентификатор ищется без учёта регистра');
  assert.equal(queueMatches(message, 'петров'), false);
});

test('идентификатор письма проверяется до того, как попадёт в команду', () => {
  // Это не косметика: идентификатор уходит в аргументы postsuper/postcat.
  assert.equal(isQueueId('4c2wKp1Vt2z'), true);
  assert.equal(isQueueId('ABCDE'), true);
  assert.equal(isQueueId('; rm -rf /'), false);
  assert.equal(isQueueId('../../etc/passwd'), false);
  assert.equal(isQueueId('4c2w'), false, 'слишком короткий');
  assert.equal(isQueueId('a'.repeat(33)), false, 'слишком длинный');
});

test('ненастроенный посредник честно объясняет отказ и никуда не ходит', async () => {
  const agent = new QueueAgent({
    baseUrl: '',
    token: '',
    logger: { warn: () => undefined } as never,
  });
  assert.equal(agent.configured, false);
  await assert.rejects(
    () => agent.snapshot(),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 503);
      assert.ok(err.message.includes('QUEUE_AGENT_TOKEN'), 'сказано, что именно задать');
      return true;
    },
  );
});

/* ------------------------------------------------------------------ */
/* Запись истории в базу                                                */
/* ------------------------------------------------------------------ */

test('большая порция событий кладётся частями: у Postgres предел параметров', async () => {
  // Не теория, а пойманное нагрузкой на стенде. Число параметров запроса в
  // протоколе Postgres ДВУХБАЙТОВОЕ — не больше 65535. При одиннадцати
  // столбцах это 5957 строк; на 6500 счётчик переполнялся, база отвечала
  // «bind message has 11178 parameter formats but 0 parameters», сборщик
  // падал и НЕ ДВИГАЛ курсор, то есть вставал навсегда и повторял ту же
  // неудачу каждые пять секунд. История переставала пополняться совсем.
  const queries: number[] = [];
  const fakeDb = {
    query: async (_text: string, values: unknown[] = []) => {
      queries.push(values.length);
      return [];
    },
    one: async () => null,
  };
  const store = new FlowStore(fakeDb as unknown as AdminDb);

  const events = Array.from({ length: 6500 }, (_, i) => ({
    occurredAt: new Date(),
    queueId: `Q${String(i).padStart(9, '0')}`,
    direction: 'in',
    status: 'sent',
    sender: 'a@b',
    recipient: 'c@d',
    relay: null,
    delaySeconds: 1,
    sizeBytes: 100,
    dsn: '2.0.0',
    reason: 'ok',
  }));

  const written = await store.insertEvents(events);
  assert.equal(written, 6500, 'записаны все события, ни одно не потеряно');
  assert.ok(queries.length > 1, 'порция разбита на несколько запросов');
  for (const count of queries) {
    assert.ok(count <= 65535, `в одном запросе ${count} параметров — больше предела Postgres`);
  }
  assert.equal(
    queries.reduce((sum, n) => sum + n, 0),
    6500 * 11,
    'суммарно записаны все поля всех событий',
  );
});

test('подстановочные знаки в строке поиска ищутся буквально', () => {
  // Для SQL «%» — это «любые символы», «_» — «любой символ». В адресах
  // они встречаются (ivan_petrov@…), а «%» ещё и приезжает из адресной
  // строки браузера («%40» вместо «@»). Поймано на стенде: поиск по
  // «user77%40mail.local» не находил ничего, потому что «%40» превращалось
  // в подстановку вместо собаки.
  assert.equal(likeEscape('ivan_petrov'), 'ivan\\_petrov');
  assert.equal(likeEscape('user77%40mail.local'), 'user77\\%40mail.local');
  assert.equal(likeEscape('a\\b'), 'a\\\\b', 'обратная косая экранируется первой');
  assert.equal(likeEscape('обычный@адрес'), 'обычный@адрес', 'обычное не трогаем');
});

test('поиск уходит в запрос экранированным и с указанием знака экранирования', async () => {
  const seen: Array<{ text: string; values: unknown[] }> = [];
  const fakeDb = {
    query: async (text: string, values: unknown[] = []) => {
      seen.push({ text, values });
      return [];
    },
    one: async () => null,
  };
  const store = new FlowStore(fakeDb as unknown as AdminDb);
  await store.listEvents({ search: 'ivan_petrov', limit: 10 });
  const q = seen[0];
  assert.ok(q);
  assert.ok(q.text.includes("ESCAPE '\\'"), 'знак экранирования задан явно');
  assert.ok(
    q.values.includes('%ivan\\_petrov%'),
    `подчёркивание уехало в запрос как есть: ${JSON.stringify(q.values)}`,
  );
});

test('пустая порция до базы не доходит вовсе', async () => {
  let calls = 0;
  const fakeDb = {
    query: async () => {
      calls += 1;
      return [];
    },
    one: async () => null,
  };
  const store = new FlowStore(fakeDb as unknown as AdminDb);
  assert.equal(await store.insertEvents([]), 0);
  assert.equal(calls, 0, 'запроса не было');
});

/* ------------------------------------------------------------------ */
/* Чтение журнала страницами                                            */
/* ------------------------------------------------------------------ */

async function withLog(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mailflow-'));
  await writeFile(join(dir, 'postfix.log'), `${lines.join('\n')}\n`, 'utf8');
  return dir;
}

function logLine(index: number, level: 'sent' | 'deferred' | 'bounced'): string {
  const status =
    level === 'sent'
      ? 'status=sent (250 ok)'
      : level === 'deferred'
        ? 'status=deferred (connect refused)'
        : 'status=bounced (550 no such user)';
  return (
    `Aug  5 20:30:01 mail postfix/smtp[1]: Q${String(index).padStart(9, '0')}: ` +
    `to=<user${index}@mail.local>, relay=none, delay=1, dsn=2.0.0, ${status}`
  );
}

test('страница журнала отдаётся с конца и листается курсором без потерь', async () => {
  const total = 500;
  const dir = await withLog(Array.from({ length: total }, (_, i) => logLine(i, 'sent')));

  const seen: string[] = [];
  let before: number | undefined;
  let fileId: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await readLogPage(dir, 'postfix', { limit: 60, before, fileId });
    fileId = result.fileId;
    for (const item of result.items) seen.push(item.text);
    if (result.nextBefore === null) break;
    before = result.nextBefore;
  }

  assert.equal(seen.length, total, 'по страницам вычитан весь журнал, ни одной строки не потеряно');
  assert.equal(new Set(seen).size, total, 'ни одна строка не пришла дважды');
  assert.ok(seen[0]?.includes('user499@'), 'первой идёт самая свежая строка');
  assert.ok(seen[total - 1]?.includes('user0@'), 'последней — самая старая');
});

test('строка на границе куска чтения не пропадает', async () => {
  // Файл читается кусками по 64 КБ с конца. Если при склейке кусков
  // потерять перевод строки, на КАЖДОЙ границе исчезала бы ровно одна
  // строка — та самая, которую человек и ищет. Файл здесь заведомо
  // больше нескольких кусков.
  const lines: string[] = [];
  for (let i = 0; i < 3000; i += 1) lines.push(logLine(i, 'sent'));
  const dir = await withLog(lines);
  const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  assert.ok(bytes > 3 * 64 * 1024, `журнал должен пересекать несколько кусков, а он ${bytes} Б`);

  const seen = new Set<string>();
  let before: number | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await readLogPage(dir, 'postfix', { limit: 500, before });
    for (const item of result.items) seen.add(item.text);
    if (result.nextBefore === null) break;
    before = result.nextBefore;
  }
  assert.equal(seen.size, lines.length, 'на границах кусков строки не теряются');
});

test('отбор по уровню оставляет только важное', async () => {
  const dir = await withLog([
    logLine(1, 'sent'),
    logLine(2, 'deferred'),
    logLine(3, 'bounced'),
    logLine(4, 'sent'),
  ]);

  const errors = await readLogPage(dir, 'postfix', { limit: 50, levelAtMost: 'error' });
  assert.equal(errors.items.length, 1);
  assert.ok(errors.items[0]?.text.includes('user3@'), 'осталось только отбитое письмо');

  const warns = await readLogPage(dir, 'postfix', { limit: 50, levelAtMost: 'warn' });
  assert.equal(warns.items.length, 2, 'предупреждения показываются вместе с ошибками');

  const all = await readLogPage(dir, 'postfix', { limit: 50, levelAtMost: 'debug' });
  assert.equal(all.items.length, 4);
});

test('поиск по подстроке применяется к сырой строке', async () => {
  const dir = await withLog([logLine(1, 'sent'), logLine(2, 'sent'), logLine(33, 'sent')]);
  const found = await readLogPage(dir, 'postfix', { limit: 50, search: 'user33@' });
  assert.equal(found.items.length, 1);
});

test('проворот журнала между запросами не выдаёт чужие строки за свои', async () => {
  // Смещения в новом файле указывают на совсем другие строки. Молча отдать
  // их — значит показать человеку неправду; поэтому отдаём начало и
  // говорим об этом отдельным признаком.
  const dir = await withLog([logLine(1, 'sent'), logLine(2, 'sent')]);
  const page = await readLogPage(dir, 'postfix', { limit: 1 });
  const after = await readLogPage(dir, 'postfix', {
    limit: 1,
    before: page.nextBefore ?? undefined,
    fileId: 'совсем-другой-файл',
  });
  assert.equal(after.rotated, true);
  assert.ok(after.items[0]?.text.includes('user2@'), 'страница отдана с начала, а не с курсора');
});

test('журнала нет — отказ объясняет, куда смотреть', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mailflow-empty-'));
  await assert.rejects(
    () => readLogPage(dir, 'postfix', { limit: 10 }),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 503);
      assert.ok(err.message.includes('maillogs'), 'названо, какой том подключается');
      return true;
    },
  );
});

test('автообновление отдаёт только дописанное, и ровно один раз', async () => {
  // Перечитывание первой страницы для этого не годится: оно не отличает
  // новое от уже показанного и теряет строки между опросами на быстром
  // журнале. Поэтому курсор — точное место в байтах.
  const dir = await withLog([logLine(1, 'sent'), logLine(2, 'sent')]);
  const first = await readLogPage(dir, 'postfix', { limit: 10 });
  assert.equal(first.items.length, 2);

  // Ничего не дописано — новых строк нет, и место не двигается.
  const idle = await readLogTail(dir, 'postfix', { after: first.tailOffset, limit: 50 });
  assert.equal(idle.items.length, 0);
  assert.equal(idle.nextAfter, first.tailOffset);

  await appendFile(
    join(dir, 'postfix.log'),
    `${logLine(3, 'sent')}
${logLine(4, 'bounced')}
`,
  );
  const tail = await readLogTail(dir, 'postfix', { after: first.tailOffset, limit: 50 });
  assert.equal(tail.items.length, 2, 'пришли обе дописанные строки');
  assert.ok(tail.items[0]?.text.includes('user3@'), 'порядок от старого к новому');
  assert.ok(tail.items[1]?.text.includes('user4@'));

  // Второй заход с новым местом не должен повторить те же строки.
  const again = await readLogTail(dir, 'postfix', { after: tail.nextAfter, limit: 50 });
  assert.equal(again.items.length, 0, 'строки не приходят дважды');
});

test('отбор по уровню действует и на новые строки', async () => {
  // Иначе человек выбрал «только ошибки», а к нему приезжает всё подряд.
  const dir = await withLog([logLine(1, 'sent')]);
  const first = await readLogPage(dir, 'postfix', { limit: 10, levelAtMost: 'error' });
  await appendFile(
    join(dir, 'postfix.log'),
    `${logLine(2, 'sent')}
${logLine(3, 'bounced')}
${logLine(4, 'deferred')}
`,
  );
  const tail = await readLogTail(dir, 'postfix', {
    after: first.tailOffset,
    limit: 50,
    levelAtMost: 'error',
  });
  assert.equal(tail.items.length, 1, 'мимо фильтра ничего не проехало');
  assert.ok(tail.items[0]?.text.includes('user3@'));
});

test('поиск действует и на новые строки', async () => {
  const dir = await withLog([logLine(1, 'sent')]);
  const first = await readLogPage(dir, 'postfix', { limit: 10, search: 'user77@' });
  await appendFile(
    join(dir, 'postfix.log'),
    `${logLine(2, 'sent')}
${logLine(77, 'sent')}
`,
  );
  const tail = await readLogTail(dir, 'postfix', {
    after: first.tailOffset,
    limit: 50,
    search: 'user77@',
  });
  assert.equal(tail.items.length, 1);
  assert.ok(tail.items[0]?.text.includes('user77@'));
});

test('порция новых строк ограничена, и об остатке сказано честно', async () => {
  // Иначе один опрос после долгой паузы вывалил бы в браузер весь журнал.
  const dir = await withLog([logLine(0, 'sent')]);
  const first = await readLogPage(dir, 'postfix', { limit: 10 });
  const many = Array.from({ length: 20 }, (_, i) => logLine(i + 1, 'sent')).join('\n');
  await appendFile(join(dir, 'postfix.log'), `${many}\n`);

  const tail = await readLogTail(dir, 'postfix', { after: first.tailOffset, limit: 5 });
  assert.equal(tail.items.length, 5);
  assert.equal(tail.more, true, 'сказано, что это не всё');

  const next = await readLogTail(dir, 'postfix', { after: tail.nextAfter, limit: 50 });
  assert.equal(next.items.length, 15, 'остаток дочитывается без потерь и без повторов');
  assert.ok(next.items[0]?.text.includes('user6@'), 'продолжение ровно с той строки');
});

test('место для дочитывания стоит за последней ЦЕЛОЙ строкой', async () => {
  // Размер файла может прийтись на середину строки, которую служба ещё
  // дописывает. Начать оттуда — значит показать обрубок как строку.
  const dir = await mkdtemp(join(tmpdir(), 'mailflow-tailoffset-'));
  const path = join(dir, 'postfix.log');
  const whole = `${logLine(1, 'sent')}
`;
  await writeFile(path, `${whole}${logLine(2, 'sent')}`, 'utf8');
  const size = (await stat(path)).size;

  const end = await lastCompleteLineEnd(path, size);
  assert.equal(end, Buffer.byteLength(whole), 'недописанная строка осталась за границей');

  const tail = await readLogTail(dir, 'postfix', { after: end, limit: 10 });
  assert.equal(tail.items.length, 0, 'обрубок не выдан за строку');
});

test('проворот журнала при автообновлении не выдаёт чужие строки', async () => {
  const dir = await withLog([logLine(1, 'sent'), logLine(2, 'sent')]);
  const tail = await readLogTail(dir, 'postfix', {
    after: 0,
    limit: 50,
    fileId: 'совсем-другой-файл',
  });
  assert.equal(tail.rotated, true);
  assert.equal(tail.items.length, 0, 'весь новый журнал разом не вываливается');
});

test('дочитывание журнала не разрывает недописанную строку', async () => {
  // Сборщик читает хвост файла, пока служба в него пишет. Половина строки,
  // разобранная как целая, дала бы в истории мусор — поэтому смещение
  // двигается только до последнего полного перевода строки.
  const dir = await mkdtemp(join(tmpdir(), 'mailflow-tail-'));
  const path = join(dir, 'postfix.log');
  const whole = `${logLine(1, 'sent')}\n`;
  await writeFile(path, `${whole}${logLine(2, 'sent')}`, 'utf8');

  const first = await readNewLines(path, 0, 1024 * 1024);
  assert.equal(first.lines.length, 1, 'недописанная строка не отдана');
  assert.equal(first.nextOffset, Buffer.byteLength(whole));

  await writeFile(path, `${whole}${logLine(2, 'sent')}\n`, 'utf8');
  const second = await readNewLines(path, first.nextOffset, 1024 * 1024);
  assert.equal(second.lines.length, 1, 'дописанная строка приходит следующим заходом');
  assert.ok(second.lines[0]?.includes('user2@'));
});

test('обратный курсор отбирает записи строго новее верхней строки', async () => {
  // Автообновление истории дочитывает ТОЛЬКО появившееся: перезапрос всей
  // ленты схлопнул бы то, что человек подгрузил прокруткой.
  const seen: Array<{ text: string; values: unknown[] }> = [];
  const fakeDb = {
    query: async (text: string, values: unknown[] = []) => {
      seen.push({ text, values });
      return [];
    },
    one: async () => null,
  };
  const store = new FlowStore(fakeDb as unknown as AdminDb);
  const at = new Date('2026-08-05T20:30:03.000Z');
  await store.listEvents({ afterTime: at, afterId: '42', limit: 10 });
  const q = seen[0];
  assert.ok(q);
  assert.ok(
    /\(occurred_at, id\) > \(\$\d+, \$\d+::bigint\)/.test(q.text),
    `сравнение пары «время + идентификатор» не по возрастанию: ${q.text}`,
  );
  assert.ok(!q.text.includes('id) < ('), 'в один запрос попали оба курсора сразу');
  assert.ok(q.values.includes(at) && q.values.includes('42'), 'курсор не доехал до запроса');
});

test('порядок выдачи не зависит от направления курсора', async () => {
  // Свежие сверху и на дочитывании тоже: иначе новые записи легли бы в
  // ленту задом наперёд.
  const seen: string[] = [];
  const fakeDb = {
    query: async (text: string) => {
      seen.push(text);
      return [];
    },
    one: async () => null,
  };
  const store = new FlowStore(fakeDb as unknown as AdminDb);
  await store.listEvents({ afterTime: new Date(), afterId: '42', limit: 10 });
  await store.listEvents({ beforeTime: new Date(), beforeId: '42', limit: 10 });
  assert.equal(seen.length, 2);
  for (const text of seen) {
    assert.ok(text.includes('ORDER BY occurred_at DESC, id DESC'), text);
  }
});

test('повторная попытка наследует направление первой, а не становится «неизвестно»', () => {
  // Повторные попытки Postfix пишет псевдотранспортом `error`: «delivery
  // temporarily suspended». Направления он не несёт, и в разделе такие
  // строки показывались как «неизвестно» — при том что первая попытка того
  // же письма честно назвала его исходящим. Письмо одно, направление одно.
  const at = new Date('2026-08-05T20:00:00.000Z');
  const first = parseLogLine(
    'postfix',
    'Aug 05 20:00:00 mail postfix/smtp[9015]: 01F1543FC6: to=<kuda@example.org>,' +
      ' relay=none, delay=21, dsn=4.4.1, status=deferred (connect refused)',
    at,
  );
  const firstEvent = toFlowEvent(first, { sender: 'test@mail.local', sizeBytes: 100 });
  assert.equal(firstEvent?.direction, 'out', 'первая попытка определяется по транспорту');

  const retry = parseLogLine(
    'postfix',
    'Aug 05 20:05:00 mail postfix/error[9099]: 01F1543FC6: to=<kuda@example.org>,' +
      ' relay=none, delay=321, dsn=4.4.1, status=deferred' +
      ' (delivery temporarily suspended: connect refused)',
    at,
  );
  const blind = toFlowEvent(retry, { sender: 'test@mail.local', sizeBytes: 100 });
  assert.equal(blind?.direction, 'unknown', 'сам по себе транспорт error направления не несёт');

  const withMemory = toFlowEvent(retry, {
    sender: 'test@mail.local',
    sizeBytes: 100,
    direction: 'out',
  });
  assert.equal(withMemory?.direction, 'out', 'известное направление письма должно унаследоваться');
});

test('известное направление не перебивает то, что сказал транспорт', () => {
  // Память — только запасной путь. Если строка сама называет транспорт,
  // верить надо ей: письмо могло вернуться в очередь и пойти иначе.
  const entry = parseLogLine(
    'postfix',
    'Aug 05 20:10:00 mail postfix/lmtp[9100]: 01F1543FC6: to=<user@mail.local>,' +
      ' relay=dovecot[172.28.0.54]:24, delay=1, dsn=2.0.0, status=sent (250 ok)',
    new Date('2026-08-05T20:10:00.000Z'),
  );
  const event = toFlowEvent(entry, { sender: 'a@b', sizeBytes: 1, direction: 'out' });
  assert.equal(event?.direction, 'in');
});

/* ------------------------------------------------------------------ */
/* Отклонить можно и исходящее                                         */
/* ------------------------------------------------------------------ */

test('отказ на подаче письма пользователем — исходящий, а не входящий', () => {
  // Служба подачи поднята с собственным именем в журнале
  // (infra/postfix/conf/master.cf: syslog_name=postfix/submission).
  const event = toFlowEvent(
    postfixEvent(
      'postfix/submission/smtpd[42]: NOQUEUE: reject: RCPT from mail-api[172.28.0.10]: ' +
        '550 5.7.1 <chuzhoj@example.net>: Recipient address rejected: Access denied; ' +
        'from=<test@mail.local> to=<chuzhoj@example.net> proto=ESMTP helo=<api>',
    ),
    undefined,
  );
  assert.ok(event);
  assert.equal(event.status, 'rejected');
  assert.equal(event.direction, 'out', 'письмо отклонили при ОТПРАВКЕ, а не при приёме');
});

test('представившийся клиент делает отказ исходящим даже на порту 25', () => {
  const event = toFlowEvent(
    postfixEvent(
      'postfix/smtpd[42]: NOQUEUE: reject: RCPT from svoj[172.28.0.10]: 552 5.3.4 ' +
        'Message size exceeds fixed limit; from=<test@mail.local> to=<a@example.net> ' +
        'proto=ESMTP helo=<svoj> sasl_method=PLAIN sasl_username=test@mail.local',
    ),
    undefined,
  );
  assert.equal(event?.direction, 'out', 'sasl_username значит «свой и отправляет»');
});

test('отказ чужому на порту 25 остаётся входящим', () => {
  const event = toFlowEvent(
    postfixEvent(
      'postfix/smtpd[3]: NOQUEUE: reject: RCPT from unknown[203.0.113.9]: 550 5.1.1 ' +
        '<нет@mail.local>: Recipient address rejected; from=<spam@example.net> ' +
        'to=<нет@mail.local> proto=ESMTP helo=<x>',
    ),
    undefined,
  );
  assert.equal(event?.direction, 'in');
});

/* ------------------------------------------------------------------ */
/* Удержанные письма                                                   */
/* ------------------------------------------------------------------ */

test('правило HOLD в cleanup записывается состоянием «придержано»', () => {
  const event = toFlowEvent(
    postfixEvent(
      'postfix/cleanup[7788]: 3F2A1B4C: hold: header Subject: Срочно переведите деньги ' +
        'from unknown[203.0.113.9]; from=<obman@example.net> to=<buhgalter@mail.local> ' +
        'proto=ESMTP helo=<x>',
    ),
    undefined,
  );
  assert.ok(event, 'строка с действием HOLD обязана стать событием');
  assert.equal(event.status, 'held');
  assert.equal(event.queueId, '3F2A1B4C');
  assert.equal(event.recipient, 'buhgalter@mail.local');
  assert.equal(event.sender, 'obman@example.net');
  assert.ok(event.reason?.includes('header Subject'), 'причина удержания — это правило');
});

test('строка с действием HOLD не съедается разбором сведений о письме', () => {
  // Обратный ход к дефекту: `from=` в этой строке ЕСТЬ, и сборщик прежде
  // принимал её за описание письма, обрывая разбор до создания события.
  const entry = postfixEvent(
    'postfix/cleanup[7788]: 3F2A1B4C: hold: header Subject: Срочно; ' +
      'from=<obman@example.net> to=<buhgalter@mail.local>',
  );
  assert.equal(toQueueMeta(entry), null, 'действие — не сведения о письме');
});

test('придержанное руками письмо (postsuper -h) тоже попадает в историю', () => {
  const event = toFlowEvent(postfixEvent('postfix/postsuper[9012]: 3F2A1B4C: placed on hold'), {
    sender: 'rassylka@mail.local',
    sizeBytes: 4096,
    direction: 'out',
  });
  assert.ok(event);
  assert.equal(event.status, 'held');
  assert.equal(event.queueId, '3F2A1B4C');
  // Адресата postsuper не называет — и выдумывать его нельзя.
  assert.equal(event.recipient, null);
  assert.equal(event.sender, 'rassylka@mail.local', 'отправитель известен из строки приёма');
  assert.equal(event.direction, 'out', 'направление письма известно из его приёма');
});

test('состояние «придержано» действительно бывает: фильтр не обещает пустоты', () => {
  // Проверка ровно того, из-за чего пункт и появился: состояние held
  // существовало в схеме и в фильтре, а поставить его было некому.
  const lines = [
    'postfix/cleanup[7788]: AAAABBBB: hold: header Subject: x; from=<a@b.ru> to=<c@mail.local>',
    'postfix/postsuper[9012]: AAAABBBB: placed on hold',
  ];
  for (const line of lines) {
    assert.equal(
      toFlowEvent(postfixEvent(line), { sender: 'a@b.ru', sizeBytes: 1 })?.status,
      'held',
      line,
    );
  }
});
