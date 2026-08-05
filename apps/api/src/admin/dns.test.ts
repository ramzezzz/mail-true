/**
 * Разбор и сравнение DNS-записей.
 *
 * Здесь закрыты те места проверки, где ошибка не видна глазом и потому
 * особенно дорога:
 *
 *   1. Недоступный резольвер выдавался за «записи нет». Администратор шёл
 *      к регистратору заводить то, что уже заведено, вместо того чтобы
 *      чинить сеть.
 *   2. Ключ DKIM сравнивался посимвольно. Панели DNS режут его на куски
 *      по 255 символов и дописывают переводы строк — верная запись
 *      объявлялась ошибочной.
 *   3. «Записи нет» и «запись есть, но не та» сливались в один вывод,
 *      хотя лечатся они по-разному.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkDomainDns,
  combineNameAnswers,
  dkimKeysMatch,
  mergeDnsCheck,
  normalizeDkimKey,
  parseDkimRecord,
  parseDmarcRecord,
  parseSpfRecord,
  spfAllowsHost,
  statusOf,
  worstStatus,
  type DnsAnswer,
  type DnsCheckResult,
  type DnsQuerier,
  type DnsRecordType,
} from './dns.js';

/* ------------------------------------------------------------------ */
/* Подставной резольвер                                                 */
/* ------------------------------------------------------------------ */

const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvXk3Fh8sWq2Zx0pQ7rTuY';

/**
 * Отвечает по таблице «ТИП имя» -> записи. Чего нет в таблице — «записи
 * нет». Имена в списке `dead` не отвечают вовсе.
 */
function fakeQuerier(
  table: Record<string, string[]>,
  options: { dead?: string[]; allDead?: boolean } = {},
): DnsQuerier {
  const answered = new Set<string>();
  return {
    servers: ['198.51.100.1'],
    answeredBy: () => [...answered],
    query(type: DnsRecordType, name: string): Promise<DnsAnswer> {
      const key = `${type} ${name}`;
      if (options.allDead === true || (options.dead ?? []).includes(key)) {
        return Promise.resolve<DnsAnswer>({
          kind: 'unreachable',
          reason: '198.51.100.1: резольвер не ответил вовремя',
        });
      }
      answered.add('198.51.100.1');
      const values = table[key];
      if (values === undefined || values.length === 0) {
        return Promise.resolve<DnsAnswer>({ kind: 'absent', via: '198.51.100.1' });
      }
      return Promise.resolve<DnsAnswer>({ kind: 'records', values, via: '198.51.100.1' });
    },
  };
}

/** Полностью настроенный домен — точка отсчёта для остальных проверок. */
function goodZone(): Record<string, string[]> {
  return {
    'A mail.example.ru': ['203.0.113.10'],
    'MX example.ru': ['10 mail.example.ru'],
    'TXT example.ru': ['v=spf1 mx ~all'],
    'TXT mail._domainkey.example.ru': [`v=DKIM1; k=rsa; p=${KEY}`],
    'TXT _dmarc.example.ru': ['v=DMARC1; p=quarantine; rua=mailto:postmaster@example.ru'],
    'PTR 203.0.113.10': ['mail.example.ru'],
    'A example.ru': ['203.0.113.10'],
    'CNAME admin.example.ru': ['mail.example.ru'],
    'CNAME autoconfig.example.ru': ['mail.example.ru'],
    'CNAME autodiscover.example.ru': ['mail.example.ru'],
    'SRV _imaps._tcp.example.ru': ['0 1 993 mail.example.ru'],
    'SRV _submission._tcp.example.ru': ['0 1 587 mail.example.ru'],
    'SRV _pop3s._tcp.example.ru': ['0 1 995 mail.example.ru'],
    'SRV _autodiscover._tcp.example.ru': ['0 0 443 mail.example.ru'],
  };
}

const OPTIONS = {
  mailHostname: 'mail.example.ru',
  publicIpv4: '203.0.113.10',
  dkimSelector: 'mail',
  dkimPublicKey: KEY,
};

const by = (checks: DnsCheckResult[], id: string): DnsCheckResult => {
  const found = checks.find((c) => c.id === id);
  assert.ok(found, `нет проверки ${id}`);
  return found;
};

/* ------------------------------------------------------------------ */
/* Ключ DKIM: сравнение по существу                                     */
/* ------------------------------------------------------------------ */

test('DKIM: ключ, разрезанный панелью на куски, совпадает с исходным', () => {
  // Ровно так значение приходит из панели, которая режет TXT по 255
  // символов, и так его вставляют руками из файла rspamd.
  const chopped = `${KEY.slice(0, 20)}\n  ${KEY.slice(20, 40)}\t${KEY.slice(40)}`;
  assert.equal(normalizeDkimKey(chopped), KEY);
  assert.ok(dkimKeysMatch(chopped, KEY), 'разрезанный ключ должен считаться тем же самым');
});

test('DKIM: разное выравнивание «=» — тот же ключ', () => {
  assert.ok(dkimKeysMatch(`${KEY}==`, KEY));
  assert.ok(dkimKeysMatch(`${KEY}=`, `${KEY}==`));
});

test('DKIM: чужой ключ не признаётся своим', () => {
  assert.equal(dkimKeysMatch(KEY, `${KEY}x`), false);
  assert.equal(dkimKeysMatch('', ''), false, 'пустой ключ — не совпадение, а отсутствие ключа');
  assert.equal(dkimKeysMatch(null, KEY), false);
});

test('DKIM: теги читаются в любом порядке и с лишними пробелами', () => {
  const record = parseDkimRecord(`  k = rsa ;  p =${KEY} ;  v=DKIM1 `);
  assert.equal(record.version, 'DKIM1');
  assert.equal(record.keyType, 'rsa');
  assert.equal(record.key, KEY);
  assert.equal(record.revoked, false);
});

test('DKIM: пустой «p=» — отозванный ключ, а не совпадение', () => {
  const record = parseDkimRecord('v=DKIM1; k=rsa; p=');
  assert.equal(record.key, '');
  assert.equal(record.revoked, true);
});

/* ------------------------------------------------------------------ */
/* SPF и DMARC                                                          */
/* ------------------------------------------------------------------ */

test('SPF: механизмы и завершающий «all» разбираются отдельно', () => {
  const record = parseSpfRecord('v=spf1 mx a:mail.example.ru ip4:203.0.113.10 ~all');
  assert.equal(record.valid, true);
  assert.equal(record.all, '~all');
  assert.deepEqual(record.mechanisms, ['mx', 'a:mail.example.ru', 'ip4:203.0.113.10']);
  assert.equal(record.delegates, false);
});

test('SPF: наш сервер разрешён через mx, через a: и через ip4', () => {
  const host = 'mail.example.ru';
  assert.equal(spfAllowsHost(parseSpfRecord('v=spf1 mx ~all'), host), 'yes');
  assert.equal(spfAllowsHost(parseSpfRecord('v=spf1 a:mail.example.ru -all'), host), 'yes');
  assert.equal(
    spfAllowsHost(parseSpfRecord('v=spf1 ip4:203.0.113.10 -all'), host, '203.0.113.10'),
    'yes',
  );
});

test('SPF: чужая запись через include — «убедиться нельзя», а не «разрешено»', () => {
  // Молчаливое «всё хорошо» здесь опаснее прямой ошибки: отправка идёт
  // с нашего сервера, а разрешение выдано чужому.
  assert.equal(spfAllowsHost(parseSpfRecord('v=spf1 include:_spf.mail.ru -all'), 'mail.example.ru'), 'unclear');
  assert.equal(spfAllowsHost(parseSpfRecord('v=spf1 ip4:198.51.100.7 -all'), 'mail.example.ru'), 'no');
});

test('DMARC: теги читаются, значение с «mailto:» не ломает разбор', () => {
  const tags = parseDmarcRecord('v=DMARC1; p=reject; rua=mailto:postmaster@example.ru; pct=100');
  assert.equal(tags.get('p'), 'reject');
  assert.equal(tags.get('rua'), 'mailto:postmaster@example.ru');
});

/* ------------------------------------------------------------------ */
/* Перевод вывода в статус                                              */
/* ------------------------------------------------------------------ */

test('статус: «есть, но не та» — всегда ошибка, даже у необязательной записи', () => {
  // Неверная запись хуже отсутствующей: она выглядит настроенной,
  // а клиенты уходят на чужой сервер.
  assert.equal(statusOf('mismatch', false), 'fail');
  assert.equal(statusOf('missing', false), 'warn');
  assert.equal(statusOf('missing', true), 'fail');
  assert.equal(statusOf('unreachable', true), 'unknown');
  assert.equal(statusOf('ok', true), 'ok');
});

test('итог по домену — худшее из проверок', () => {
  assert.equal(worstStatus(['ok', 'warn', 'fail', 'unknown']), 'fail');
  assert.equal(worstStatus(['ok', 'unknown']), 'unknown');
  assert.equal(worstStatus(['ok', 'ok']), 'ok');
});

/* ------------------------------------------------------------------ */
/* Ответ имени: CNAME или A                                             */
/* ------------------------------------------------------------------ */

test('имя: «записи нет» только когда по существу ответили на оба вопроса', () => {
  const absent: DnsAnswer = { kind: 'absent', via: '198.51.100.1' };
  const dead: DnsAnswer = { kind: 'unreachable', reason: 'таймаут' };

  assert.equal(combineNameAnswers(absent, absent).answer.kind, 'absent');
  // CNAME спросить не удалось — про имя мы не знаем ничего, и объявлять
  // его ненастроенным нельзя.
  assert.equal(combineNameAnswers(dead, absent).answer.kind, 'unreachable');
  assert.equal(combineNameAnswers(absent, dead).answer.kind, 'unreachable');

  const records: DnsAnswer = { kind: 'records', values: ['mail.example.ru'], via: '198.51.100.1' };
  assert.equal(combineNameAnswers(records, dead).type, 'CNAME');
  assert.equal(combineNameAnswers(absent, records).type, 'A');
});

/* ------------------------------------------------------------------ */
/* Полная проверка домена                                               */
/* ------------------------------------------------------------------ */

test('настроенный домен: все обязательные записи в порядке', async () => {
  const report = await checkDomainDns('example.ru', {
    ...OPTIONS,
    querier: fakeQuerier(goodZone()),
  });
  const core = report.checks.filter((c) => c.group === 'core');
  assert.deepEqual(
    core.filter((c) => c.verdict !== 'ok').map((c) => `${c.id}:${c.verdict}`),
    [],
  );
  assert.equal(report.overall, 'ok');
  assert.equal(report.resolver.reachable, true);
});

test('ключ DKIM, опубликованный кусками, признаётся верным', async () => {
  const zone = goodZone();
  // Панель отдала значение с переводами строк внутри ключа.
  zone['TXT mail._domainkey.example.ru'] = [
    `v=DKIM1; k=rsa; p=${KEY.slice(0, 30)}\n${KEY.slice(30)}==`,
  ];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  const dkim = by(report.checks, 'dkim');
  assert.equal(dkim.verdict, 'ok', dkim.diff ?? '');
});

test('чужой ключ DKIM — «настроено с ошибкой», а не «не настроено»', async () => {
  const zone = goodZone();
  zone['TXT mail._domainkey.example.ru'] = ['v=DKIM1; k=rsa; p=AAAABBBBCCCCDDDDEEEEFFFF'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  const dkim = by(report.checks, 'dkim');
  assert.equal(dkim.verdict, 'mismatch');
  assert.equal(dkim.status, 'fail');
  assert.ok(dkim.diff && dkim.diff.length > 0, 'должно быть сказано, в чём расхождение');
});

test('нет записи DKIM — «не настроено», и это другой вывод', async () => {
  const zone = goodZone();
  delete zone['TXT mail._domainkey.example.ru'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  const dkim = by(report.checks, 'dkim');
  assert.equal(dkim.verdict, 'missing');
  assert.equal(dkim.actual.length, 0);
});

test('MX на чужой сервер — ошибка, и видно оба значения', async () => {
  const zone = goodZone();
  zone['MX example.ru'] = ['10 mx.yandex.net'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  const mx = by(report.checks, 'mx');
  assert.equal(mx.verdict, 'mismatch');
  assert.ok(mx.diff?.includes('mx.yandex.net'));
  assert.ok(mx.diff?.includes('mail.example.ru'));
  assert.deepEqual(mx.actual, ['10 mx.yandex.net']);
});

test('SPF: наш сервер не разрешён — ошибка; посторонние TXT домена не мешают', async () => {
  const zone = goodZone();
  zone['TXT example.ru'] = [
    'google-site-verification=abcdef',
    'v=spf1 ip4:198.51.100.7 -all',
  ];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  const spf = by(report.checks, 'spf');
  assert.equal(spf.verdict, 'mismatch');
  assert.deepEqual(spf.actual, ['v=spf1 ip4:198.51.100.7 -all'], 'в «опубликовано» только SPF');
});

test('SPF: две записи — ошибка стандарта, а не замечание', async () => {
  const zone = goodZone();
  zone['TXT example.ru'] = ['v=spf1 mx ~all', 'v=spf1 a:mail.example.ru -all'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  assert.equal(by(report.checks, 'spf').verdict, 'mismatch');
});

test('DMARC с p=none — замечание, а не ошибка', async () => {
  const zone = goodZone();
  zone['TXT _dmarc.example.ru'] = ['v=DMARC1; p=none; rua=mailto:postmaster@example.ru'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  const dmarc = by(report.checks, 'dmarc');
  assert.equal(dmarc.verdict, 'warn');
  assert.equal(dmarc.status, 'warn');
});

test('недоступный резольвер — «не удалось спросить», ни одной записи не объявлено ненастроенной', async () => {
  const report = await checkDomainDns('example.ru', {
    ...OPTIONS,
    querier: fakeQuerier({}, { allDead: true }),
  });
  assert.equal(report.resolver.reachable, false);
  assert.equal(report.overall, 'unknown');
  const wrong = report.checks.filter((c) => c.verdict === 'missing' || c.verdict === 'mismatch');
  assert.deepEqual(wrong.map((c) => c.id), [], 'молчащий резольвер — не повод обвинять DNS домена');
  for (const check of report.checks) {
    assert.equal(check.verdict, 'unreachable');
    assert.equal(check.status, 'unknown');
    assert.equal(check.askedVia, null);
    assert.match(check.hint, /не удалось|не состоялась/i);
  }
});

test('частичный отказ: молчит только DKIM — остальное проверено', async () => {
  const report = await checkDomainDns('example.ru', {
    ...OPTIONS,
    querier: fakeQuerier(goodZone(), { dead: ['TXT mail._domainkey.example.ru'] }),
  });
  assert.equal(by(report.checks, 'dkim').verdict, 'unreachable');
  assert.equal(by(report.checks, 'mx').verdict, 'ok');
  assert.equal(report.overall, 'unknown');
  assert.equal(report.resolver.reachable, true);
});

test('PTR проверяется и без MAIL_PUBLIC_IPV4 — адрес берётся из A-записи', async () => {
  // Установщик выставляет MAIL_PUBLIC_IPV4 не всегда, и проверка PTR
  // молчала «неизвестно» навсегда. Между тем адрес уже опубликован
  // в A-записи почтового хоста — его и спрашиваем.
  const report = await checkDomainDns('example.ru', {
    mailHostname: 'mail.example.ru',
    dkimPublicKey: KEY,
    querier: fakeQuerier(goodZone()),
  });
  const ptr = by(report.checks, 'ptr');
  assert.equal(ptr.verdict, 'ok');
  assert.equal(ptr.recordName, '203.0.113.10');
  assert.match(ptr.hint, /из A-записи/);
  assert.equal(ptr.copyable, false, 'PTR не заводят у регистратора — копировать некуда');
});

test('PTR: адреса нет ниоткуда — сказано, почему проверять нечем и где взять', async () => {
  const zone = goodZone();
  delete zone['A mail.example.ru'];
  const report = await checkDomainDns('example.ru', {
    mailHostname: 'mail.example.ru',
    dkimPublicKey: KEY,
    querier: fakeQuerier(zone),
  });
  const ptr = by(report.checks, 'ptr');
  assert.equal(ptr.verdict, 'unreachable');
  assert.match(ptr.hint, /MAIL_PUBLIC_IPV4/);
  assert.match(ptr.hint, /infra\/\.env/);
  assert.match(ptr.hint, /A-запис/);
});

test('MX проверяется по существу: имя верное, а разворачивать его не во что', async () => {
  // Совпадения имени обменника мало: почта идёт не на имя, а на адрес.
  // Зелёный MX при отсутствующей A-записи не доказывал ничего.
  const zone = goodZone();
  delete zone['A mail.example.ru'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  const mx = by(report.checks, 'mx');
  assert.equal(mx.verdict, 'mismatch');
  assert.match(mx.diff ?? '', /нет A-записи/);
});

test('MX: имя наше, но разворачивается в чужой адрес — ошибка', async () => {
  const zone = goodZone();
  zone['A mail.example.ru'] = ['198.51.100.7'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  const mx = by(report.checks, 'mx');
  assert.equal(mx.verdict, 'mismatch');
  assert.match(mx.diff ?? '', /198\.51\.100\.7/);
});

test('MX: чужое имя, но тот же сервер — замечание, а не «почта не ходит»', async () => {
  const zone = goodZone();
  zone['MX example.ru'] = ['10 mx2.example.ru'];
  zone['A mx2.example.ru'] = ['203.0.113.10'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  const mx = by(report.checks, 'mx');
  assert.equal(mx.verdict, 'warn');
  assert.match(mx.hint, /дойд[её]т/);
});

test('PTR: имя не совпадает с HELO — ошибка с указанием расхождения', async () => {
  const zone = goodZone();
  zone['PTR 203.0.113.10'] = ['static-10.example-hosting.net'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  const ptr = by(report.checks, 'ptr');
  assert.equal(ptr.verdict, 'mismatch');
  assert.ok(ptr.diff?.includes('static-10.example-hosting.net'));
});

test('вместо CNAME опубликована A-запись нашего сервера — это допустимо', async () => {
  const zone = goodZone();
  delete zone['CNAME autoconfig.example.ru'];
  zone['A autoconfig.example.ru'] = ['203.0.113.10'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  assert.equal(by(report.checks, 'autoconfig').verdict, 'ok');
});

test('A-запись автонастройки ведёт на чужой адрес — ошибка, а не «в порядке»', async () => {
  const zone = goodZone();
  delete zone['CNAME autodiscover.example.ru'];
  zone['A autodiscover.example.ru'] = ['198.51.100.7'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  const check = by(report.checks, 'autodiscover');
  assert.equal(check.verdict, 'mismatch');
  assert.equal(check.status, 'fail');
});

test('SRV: верный хост, но чужой порт — ошибка', async () => {
  const zone = goodZone();
  zone['SRV _imaps._tcp.example.ru'] = ['0 1 143 mail.example.ru'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  assert.equal(by(report.checks, 'srv-imaps').verdict, 'mismatch');
});

test('отсутствие необязательной записи — замечание, почта от этого не ломается', async () => {
  const zone = goodZone();
  delete zone['CNAME autoconfig.example.ru'];
  delete zone['SRV _pop3s._tcp.example.ru'];
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  assert.equal(by(report.checks, 'autoconfig').status, 'warn');
  assert.equal(by(report.checks, 'srv-pop3s').status, 'warn');
  assert.equal(report.overall, 'warn');
});

/* ------------------------------------------------------------------ */
/* Перепроверка одной записи                                            */
/* ------------------------------------------------------------------ */

test('точечная проверка спрашивает только про свою запись', async () => {
  // Человек правит записи у регистратора по одной. Ждать полтора десятка
  // ответов ради одного — плохая сделка, особенно когда резольвер тормозит.
  const asked: string[] = [];
  const base = fakeQuerier(goodZone());
  const spy: DnsQuerier = {
    servers: base.servers,
    answeredBy: base.answeredBy,
    query: (type, name) => {
      asked.push(`${type} ${name}`);
      return base.query(type, name);
    },
  };
  const report = await checkDomainDns('example.ru', { ...OPTIONS, querier: spy, only: ['dmarc'] });

  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0]?.id, 'dmarc');
  assert.ok(asked.includes('TXT _dmarc.example.ru'));
  // Адрес сервера нужен почти каждому выводу — его спрашиваем всегда.
  assert.ok(asked.includes('A mail.example.ru'));
  assert.equal(asked.includes('MX example.ru'), false, 'лишнего не спрашиваем');
  assert.equal(asked.includes('SRV _imaps._tcp.example.ru'), false);
});

test('у каждой записи своё время ответа', async () => {
  const report = await checkDomainDns('example.ru', {
    ...OPTIONS,
    querier: fakeQuerier(goodZone()),
  });
  for (const check of report.checks) {
    assert.ok(check.checkedAt, `${check.id}: нет отметки времени ответа`);
    assert.ok(!Number.isNaN(Date.parse(check.checkedAt)));
  }
});

test('свежий ответ вклеивается в прежний отчёт, остальное не трогается', async () => {
  const zone = goodZone();
  zone['TXT _dmarc.example.ru'] = ['v=DMARC1; p=none'];
  const full = await checkDomainDns('example.ru', { ...OPTIONS, querier: fakeQuerier(zone) });
  assert.equal(by(full.checks, 'dmarc').verdict, 'warn');

  // Администратор исправил DMARC и перепроверил ОДНУ запись.
  const fixed = goodZone();
  const one = await checkDomainDns('example.ru', {
    ...OPTIONS,
    querier: fakeQuerier(fixed),
    only: ['dmarc'],
  });
  const merged = mergeDnsCheck(full, one);

  assert.equal(merged.checks.length, full.checks.length, 'записи не должны пропасть');
  assert.equal(by(merged.checks, 'dmarc').verdict, 'ok');
  // Ответы по остальным записям остались прежними — вместе со своим временем.
  assert.equal(by(merged.checks, 'mx').checkedAt, by(full.checks, 'mx').checkedAt);
  assert.equal(merged.overall, 'ok');
});

test('точечная проверка сломанной записи портит общий итог, а не прячет его', async () => {
  const full = await checkDomainDns('example.ru', {
    ...OPTIONS,
    querier: fakeQuerier(goodZone()),
  });
  assert.equal(full.overall, 'ok');

  const broken = goodZone();
  delete broken['MX example.ru'];
  const one = await checkDomainDns('example.ru', {
    ...OPTIONS,
    querier: fakeQuerier(broken),
    only: ['mx'],
  });
  const merged = mergeDnsCheck(full, one);
  assert.equal(merged.overall, 'fail');
  assert.equal(by(merged.checks, 'mx').verdict, 'missing');
});

test('отчёта ещё не было — вклеивать некуда, берётся свежий', async () => {
  const one = await checkDomainDns('example.ru', {
    ...OPTIONS,
    querier: fakeQuerier(goodZone()),
    only: ['spf'],
  });
  assert.deepEqual(mergeDnsCheck(null, one).checks.map((c) => c.id), ['spf']);
});

test('молчащий резольвер при точечной проверке — «не удалось», а не «нет записи»', async () => {
  const report = await checkDomainDns('example.ru', {
    ...OPTIONS,
    querier: fakeQuerier({}, { allDead: true }),
    only: ['dkim'],
  });
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0]?.verdict, 'unreachable');
});

test('каждая проверка объясняет, зачем запись и что сломается без неё', async () => {
  const report = await checkDomainDns('example.ru', {
    ...OPTIONS,
    querier: fakeQuerier(goodZone()),
  });
  const ids = report.checks.map((c) => c.id);
  for (const id of ['a', 'mx', 'spf', 'dkim', 'dmarc', 'ptr', 'web-apex', 'web-admin', 'autoconfig']) {
    assert.ok(ids.includes(id as never), `в отчёте нет проверки ${id}`);
  }
  for (const check of report.checks) {
    assert.ok(check.purpose.length > 10, `${check.id}: не сказано, зачем запись`);
    assert.ok(check.impact.length > 10, `${check.id}: не сказано, что сломается без неё`);
    assert.ok(check.expected.length > 0, `${check.id}: нечего копировать`);
    assert.ok(check.hint.length > 10, `${check.id}: не сказано, что делать`);
  }
});
