/**
 * Разбор ответов управляющего интерфейса rspamd и правка карт.
 *
 * Проверяется не «функция вернула объект», а те три вещи, на которых
 * раздел «Спам» может соврать:
 *
 *   1. правка списка НЕ ДОЛЖНА стирать заголовок файла — иначе первая же
 *      добавленная запись уносит объяснение, зачем этот файл нужен;
 *   2. в «топе правил» не должно быть полутора тысяч строк с нулём —
 *      ответа на вопрос «по каким правилам чаще» в них нет;
 *   3. недоступный или не принявший пароль rspamd обязан объясняться
 *      словами и кодом 503, а не «внутренней ошибкой сервера».
 *
 * Образцы ответов взяты с живого rspamd 4.1.4 (контейнер стенда), а не
 * придуманы: придуманный образец проверяет только фантазию автора.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMapEntry,
  parseActions,
  parseCounters,
  parseHistory,
  parseMapEntries,
  parseMaps,
  parseStat,
  parseVerdict,
  removeMapEntry,
  RspamdClient,
  RspamdUnavailableError,
  senderFromMessage,
  topSymbols,
} from './rspamd.js';

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

/* ------------------------------------------------------------------ */
/* Разбор                                                              */
/* ------------------------------------------------------------------ */

test('parseStat: счётчики и время работы читаются в том виде, в каком их отдаёт rspamd', () => {
  const stat = parseStat({
    version: '4.1.4',
    uptime: 3424,
    scanned: 12,
    learned: 1,
    spam_count: 0,
    ham_count: 12,
    actions: { reject: 2, 'add header': 3, greylist: 0, 'no action': 7 },
    statfiles: [{ symbol: 'BAYES_SPAM', type: 'redis', revision: 0, users: 0 }],
    connections: 0,
  });
  assert.equal(stat.uptimeSeconds, 3424);
  assert.equal(stat.scanned, 12);
  // Имена действий НЕ переименовываются: под этими же именами они
  // приходят в /history и в /actions, и любое расхождение пришлось бы
  // потом сводить руками в трёх местах.
  assert.equal(stat.actions['add header'], 3);
  assert.equal(stat.statfiles[0]?.symbol, 'BAYES_SPAM');
});

test('parseStat: пустой ответ не роняет разбор', () => {
  const stat = parseStat(null);
  assert.equal(stat.scanned, 0);
  assert.deepEqual(stat.statfiles, []);
});

test('topSymbols: правила с нулём срабатываний в список не попадают', () => {
  const counters = parseCounters([
    { symbol: 'NEVER_FIRED', weight: 7, hits: 0, frequency: 0, time: 0 },
    { symbol: 'MISSING_DATE', weight: 1, hits: 12, frequency: 0.1, time: 0 },
    { symbol: 'BAYES_SPAM', weight: 5, hits: 40, frequency: 0.4, time: 0 },
  ]);
  const top = topSymbols(counters);
  assert.deepEqual(
    top.map((c) => c.symbol),
    ['BAYES_SPAM', 'MISSING_DATE'],
  );
});

test('parseHistory: у письма остаются только значащие символы, от большего к меньшему', () => {
  const rows = parseHistory({
    version: 2,
    rows: [
      {
        unix_time: 1786035827,
        action: 'add header',
        score: 8.5,
        required_score: 15,
        subject: 'Дешёвые таблетки',
        sender_smtp: 'spam@evil.example',
        rcpt_smtp: ['user@mail.local'],
        ip: '203.0.113.7',
        user: '',
        size: 2048,
        is_skipped: false,
        symbols: {
          BLACKLIST_SENDER_DOMAIN: { name: 'BLACKLIST_SENDER_DOMAIN', score: 10 },
          FROM_NO_DN: { name: 'FROM_NO_DN', score: 0 },
          MISSING_DATE: { name: 'MISSING_DATE', score: 1 },
        },
      },
    ],
  });
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.action, 'add header');
  // Символы с нулевым весом на решение не влияли — в объяснении «почему
  // спам» им не место.
  assert.deepEqual(
    row.symbols.map((s) => s.name),
    ['BLACKLIST_SENDER_DOMAIN', 'MISSING_DATE'],
  );
});

test('parseActions: выключенное действие остаётся null, а не превращается в ноль', () => {
  const actions = parseActions([
    { action: 'greylist', value: null },
    { action: 'add header', value: 6.0 },
    { action: 'reject', value: 15.0 },
  ]);
  // Ноль означал бы «порог нулевой», то есть «в спам уходит всё подряд» —
  // ровно противоположное тому, что означает выключенное действие.
  assert.equal(actions.greylist, null);
  assert.equal(actions['add header'], 6);
  assert.equal(actions.reject, 15);
});

test('parseVerdict: пороги письма читаются вместе с оценкой', () => {
  const verdict = parseVerdict({
    score: 14.5,
    action: 'add header',
    thresholds: { reject: 15.0, 'add header': 6.0 },
    symbols: { DATE_IN_PAST: { name: 'DATE_IN_PAST', score: 1 } },
  });
  assert.equal(verdict.score, 14.5);
  assert.equal(verdict.thresholds.reject, 15);
});

test('parseMaps: путь карты сохраняется целиком — по нему её и находят', () => {
  const maps = parseMaps([
    {
      map: 1682882174681119,
      uri: '/etc/rspamd/maps.d/whitelist_from.map',
      description: 'Адрес отправителя в белом списке администратора',
      type: 'file',
    },
  ]);
  assert.equal(maps[0]?.id, 1682882174681119);
  assert.equal(maps[0]?.uri, '/etc/rspamd/maps.d/whitelist_from.map');
});

/* ------------------------------------------------------------------ */
/* Отправитель конверта                                                */
/* ------------------------------------------------------------------ */

test('senderFromMessage: адрес берётся из From, даже если он в угловых скобках', () => {
  // Это не украшение разбора. Rspamd судит об отправителе по КОНВЕРТУ,
  // и с постоянным служебным адресом вместо настоящего правила по
  // отправителю не срабатывали бы никогда. Проверено на стенде: письмо
  // с домена из чёрного списка набирало 11,8 балла БЕЗ символа
  // BLACKLIST_SENDER_DOMAIN.
  assert.equal(
    senderFromMessage('From: Иван Петров <Ivan@Partner.Example>\r\nSubject: тест\r\n\r\nтекст'),
    'ivan@partner.example',
  );
  assert.equal(
    senderFromMessage('From: seller@spam.example\r\n\r\nтекст'),
    'seller@spam.example',
  );
});

test('senderFromMessage: строка «From:» в теле письма конвертом не считается', () => {
  const message = 'Subject: пересылка\r\n\r\n> From: fake@evil.example\r\nсмотри что прислали';
  assert.equal(senderFromMessage(message), null);
});

test('senderFromMessage: мусор вместо адреса не подставляется', () => {
  assert.equal(senderFromMessage('From: неизвестно\r\n\r\nтекст'), null);
  assert.equal(senderFromMessage('Subject: без отправителя\r\n\r\nтекст'), null);
});

/* ------------------------------------------------------------------ */
/* Правка карт                                                         */
/* ------------------------------------------------------------------ */

const MAP_HEADER = [
  '# БЕЛЫЙ СПИСОК: адреса отправителей (правится админкой)',
  '#',
  '# Пример:',
  '# director@partner-company.com',
  '',
].join('\n');

test('parseMapEntries: комментарии и пустые строки записями не считаются', () => {
  assert.deepEqual(parseMapEntries(MAP_HEADER), []);
  assert.deepEqual(parseMapEntries(`${MAP_HEADER}ivan@partner.example\n`), [
    'ivan@partner.example',
  ]);
});

test('addMapEntry: заголовок файла переживает добавление записи', () => {
  const after = addMapEntry(MAP_HEADER, 'ivan@partner.example');
  // Самое важное свойство правки: пояснения в файле остаются на месте.
  // Без этого первая же запись из панели стирала бы объяснение, зачем
  // файл нужен и каким символом он оборачивается.
  assert.match(after, /БЕЛЫЙ СПИСОК/u);
  assert.match(after, /# director@partner-company\.com/u);
  assert.deepEqual(parseMapEntries(after), ['ivan@partner.example']);
});

test('addMapEntry: повторное добавление ничего не меняет', () => {
  const once = addMapEntry(MAP_HEADER, 'ivan@partner.example');
  assert.equal(addMapEntry(once, 'ivan@partner.example'), once);
});

test('removeMapEntry: убирается только своя строка, соседи и комментарии целы', () => {
  const filled = addMapEntry(
    addMapEntry(MAP_HEADER, 'ivan@partner.example'),
    'petr@partner.example',
  );
  const after = removeMapEntry(filled, 'ivan@partner.example');
  assert.deepEqual(parseMapEntries(after), ['petr@partner.example']);
  assert.match(after, /БЕЛЫЙ СПИСОК/u);
  // Строка-пример в комментарии похожа на запись, но записью не является
  assert.match(after, /# director@partner-company\.com/u);
});

test('removeMapEntry: регистр записи значения не имеет', () => {
  const filled = addMapEntry(MAP_HEADER, 'ivan@partner.example');
  assert.deepEqual(parseMapEntries(removeMapEntry(filled, 'IVAN@Partner.Example')), []);
});

/* ------------------------------------------------------------------ */
/* Клиент                                                              */
/* ------------------------------------------------------------------ */

test('без пароля контроллера клиент честно отказывается, а не притворяется пустыми данными', async () => {
  const client = new RspamdClient({ host: 'rspamd', port: 11334, password: '' });
  assert.equal(client.configured, false);
  await assert.rejects(
    () => client.stat(),
    (err: unknown) => {
      assert.ok(err instanceof RspamdUnavailableError);
      assert.equal(err.statusCode, 503);
      assert.match(err.message, /RSPAMD_PASSWORD/u);
      return true;
    },
  );
});

test('пароль уходит заголовком Password на каждый запрос', async () => {
  const seen: Array<{ url: string; password: unknown }> = [];
  const client = new RspamdClient({
    host: 'rspamd',
    port: 11334,
    password: 'секрет',
    fetchImpl: (url, init) => {
      seen.push({ url, password: (init.headers as Record<string, string>).Password });
      return Promise.resolve(response({ version: '4.1.4', uptime: 1 }));
    },
  });
  await client.stat();
  assert.equal(seen[0]?.url, 'http://rspamd:11334/stat');
  assert.equal(seen[0]?.password, 'секрет');
});

test('расхождение паролей называется своим именем, а не «ошибкой 403»', async () => {
  const client = new RspamdClient({
    host: 'rspamd',
    port: 11334,
    password: 'старый',
    fetchImpl: () => Promise.resolve(response('Unauthorized', 403)),
  });
  await assert.rejects(
    () => client.actions(),
    (err: unknown) => {
      assert.ok(err instanceof RspamdUnavailableError);
      assert.match(err.message, /разошлись/u);
      return true;
    },
  );
});

test('недоступный rspamd объясняет последствия: почта идёт без проверки', async () => {
  const client = new RspamdClient({
    host: 'rspamd',
    port: 11334,
    password: 'секрет',
    fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')),
  });
  await assert.rejects(
    () => client.stat(),
    (err: unknown) => {
      assert.ok(err instanceof RspamdUnavailableError);
      assert.match(err.message, /БЕЗ проверки на спам/u);
      return true;
    },
  );
});

test('saveMap отправляет номер карты заголовком Map и тело как есть', async () => {
  let captured: { headers: Record<string, string>; body: unknown } | null = null;
  const client = new RspamdClient({
    host: 'rspamd',
    port: 11334,
    password: 'секрет',
    fetchImpl: (_url, init) => {
      captured = { headers: init.headers as Record<string, string>, body: init.body };
      return Promise.resolve(response({ success: true }));
    },
  });
  await client.saveMap(42, 'ivan@partner.example\n');
  assert.ok(captured);
  const sent = captured as { headers: Record<string, string>; body: unknown };
  assert.equal(sent.headers.Map, '42');
  assert.equal(sent.body, 'ivan@partner.example\n');
});

test('обучение уходит на разные адреса для спама и не-спама', async () => {
  const urls: string[] = [];
  const client = new RspamdClient({
    host: 'rspamd',
    port: 11334,
    password: 'секрет',
    fetchImpl: (url) => {
      urls.push(url);
      return Promise.resolve(response({ success: true }));
    },
  });
  await client.learn('spam', 'From: a@b.c\r\n\r\nтекст письма подлиннее');
  await client.learn('ham', 'From: a@b.c\r\n\r\nтекст письма подлиннее');
  assert.deepEqual(urls, ['http://rspamd:11334/learnspam', 'http://rspamd:11334/learnham']);
});

test('проверка «от своего пользователя» помечается заголовком User', async () => {
  let headers: Record<string, string> = {};
  const client = new RspamdClient({
    host: 'rspamd',
    port: 11334,
    password: 'секрет',
    fetchImpl: (_url, init) => {
      headers = init.headers as Record<string, string>;
      return Promise.resolve(response({ score: 0, action: 'no action' }));
    },
  });
  await client.check('From: a@mail.local\r\n\r\nтекст', {
    ip: '127.0.0.1',
    from: 'a@mail.local',
    rcpt: 'b@mail.local',
    user: 'a@mail.local',
  });
  // Именно по User rspamd понимает, что отправитель прошёл аутентификацию,
  // и применяет к письму профиль своих (пороги мягче, внешние списки не
  // спрашиваются). Без заголовка проверка показала бы оценку, которой
  // у настоящего письма сотрудника не бывает.
  assert.equal(headers.User, 'a@mail.local');
});
