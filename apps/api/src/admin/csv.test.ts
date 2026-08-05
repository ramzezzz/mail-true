/** Проверка разбора CSV для массового импорта ящиков. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseCsv, parseQuota, parseUserImport } from './csv.js';

test('parseCsv: запятые, кавычки, экранирование, CRLF', () => {
  const rows = parseCsv('a,b,c\r\n"стро, ка","он сказал ""да""",3\r\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['стро, ка', 'он сказал "да"', '3'],
  ]);
});

test('parseCsv: точка с запятой как разделитель (Excel по-русски)', () => {
  const rows = parseCsv('email;name;quota\nivan@mail.local;Иван;1G');
  assert.deepEqual(rows, [
    ['email', 'name', 'quota'],
    ['ivan@mail.local', 'Иван', '1G'],
  ]);
});

test('parseCsv: BOM и пустые строки отбрасываются', () => {
  const rows = parseCsv('﻿email\n\na@mail.local\n\n');
  assert.deepEqual(rows, [['email'], ['a@mail.local']]);
});

test('parseQuota понимает человеческие обозначения', () => {
  assert.equal(parseQuota('1G'), 1024 ** 3);
  assert.equal(parseQuota('1 гб'), 1024 ** 3);
  assert.equal(parseQuota('500M'), 500 * 1024 ** 2);
  assert.equal(parseQuota('2,5G'), Math.round(2.5 * 1024 ** 3));
  assert.equal(parseQuota('1073741824'), 1073741824);
  assert.equal(parseQuota('0'), 0);
  assert.equal(parseQuota(''), null);
  assert.equal(parseQuota('много'), null);
  assert.equal(parseQuota('-1G'), null);
});

test('импорт с заголовком: всё разобрано по столбцам', () => {
  const csv = [
    'email,name,password,quota',
    'ivan@mail.local,Иван Петров,parol12345,1G',
    'anna@mail.local,Анна,,500M',
  ].join('\n');

  const preview = parseUserImport(csv, { knownDomains: ['mail.local'] });
  assert.equal(preview.hasHeader, true);
  assert.equal(preview.validCount, 2);
  assert.equal(preview.invalidCount, 0);
  assert.deepEqual(preview.domains, ['mail.local']);

  const [ivan, anna] = preview.rows;
  assert.equal(ivan?.email, 'ivan@mail.local');
  assert.equal(ivan?.displayName, 'Иван Петров');
  assert.equal(ivan?.password, 'parol12345');
  assert.equal(ivan?.quotaBytes, 1024 ** 3);
  assert.deepEqual(ivan?.errors, []);

  assert.equal(anna?.password, null, 'пустой пароль -> будет сгенерирован');
  assert.ok(anna?.warnings.some((w) => w.includes('сгенерирован')));
});

test('импорт без заголовка: порядок email,name,password,quota', () => {
  const preview = parseUserImport('petr@mail.local,Пётр,parol12345,2G', {
    knownDomains: ['mail.local'],
  });
  assert.equal(preview.hasHeader, false);
  assert.equal(preview.validCount, 1);
  assert.equal(preview.rows[0]?.email, 'petr@mail.local');
  assert.equal(preview.rows[0]?.quotaBytes, 2 * 1024 ** 3);
});

test('импорт: столбцы в произвольном порядке и с русскими названиями', () => {
  const csv = ['Квота;Пароль;Адрес;ФИО', '1G;parol12345;ivan@mail.local;Иван'].join('\n');
  const preview = parseUserImport(csv, { knownDomains: ['mail.local'] });
  assert.equal(preview.rows[0]?.email, 'ivan@mail.local');
  assert.equal(preview.rows[0]?.displayName, 'Иван');
  assert.equal(preview.rows[0]?.password, 'parol12345');
  assert.equal(preview.rows[0]?.quotaBytes, 1024 ** 3);
});

test('импорт ловит все виды плохих строк', () => {
  const csv = [
    'email,name,password,quota',
    'нет-собаки,Кто-то,parol12345,1G',
    'dup@mail.local,Первый,parol12345,1G',
    'dup@mail.local,Второй,parol12345,1G',
    'chuzhoy@other.tld,Чужой,parol12345,1G',
    'busy@mail.local,Занятый,parol12345,1G',
    'short@mail.local,Короткий,123,1G',
    'badquota@mail.local,Квота,parol12345,очень много',
  ].join('\n');

  const preview = parseUserImport(csv, {
    knownDomains: ['mail.local'],
    existingEmails: ['busy@mail.local'],
  });

  const byLine = new Map(preview.rows.map((r) => [r.line, r]));
  assert.match(byLine.get(2)?.errors.join() ?? '', /Некорректный адрес/);
  assert.deepEqual(byLine.get(3)?.errors, []);
  assert.match(byLine.get(4)?.errors.join() ?? '', /Повтор адреса/);
  assert.match(byLine.get(5)?.errors.join() ?? '', /не заведён/);
  assert.match(byLine.get(6)?.errors.join() ?? '', /уже существует/);
  assert.match(byLine.get(7)?.errors.join() ?? '', /Пароль короче/);
  assert.match(byLine.get(8)?.errors.join() ?? '', /квоту/);

  assert.equal(preview.validCount, 1);
  assert.equal(preview.invalidCount, 6);
});

test('импорт: незнакомый домен становится предупреждением, если разрешено создавать', () => {
  const preview = parseUserImport('email\nuser@new.tld', {
    knownDomains: ['mail.local'],
    allowNewDomains: true,
  });
  assert.deepEqual(preview.rows[0]?.errors, []);
  assert.match(preview.rows[0]?.warnings.join() ?? '', /будет создан/);
});

test('импорт: квота по умолчанию подставляется, если столбца нет', () => {
  const preview = parseUserImport('email,name\nuser@mail.local,Имя', {
    knownDomains: ['mail.local'],
    defaultQuotaBytes: 5 * 1024 ** 3,
  });
  assert.equal(preview.rows[0]?.quotaBytes, 5 * 1024 ** 3);
});

test('импорт: предел числа строк', () => {
  const csv = ['email', ...Array.from({ length: 10 }, (_, i) => `u${i}@mail.local`)].join('\n');
  const preview = parseUserImport(csv, { knownDomains: ['mail.local'], maxRows: 3 });
  assert.equal(preview.validCount, 3);
  assert.match(preview.rows.at(-1)?.errors.join() ?? '', /Превышен предел импорта/);
});

test('импорт: адреса приводятся к нижнему регистру и обрезаются пробелы', () => {
  const preview = parseUserImport('email\n  IVAN@Mail.Local  ', { knownDomains: ['mail.local'] });
  assert.equal(preview.rows[0]?.email, 'ivan@mail.local');
  assert.deepEqual(preview.rows[0]?.errors, []);
});

test('импорт пустого файла не падает', () => {
  const preview = parseUserImport('', {});
  assert.equal(preview.rows.length, 0);
  assert.equal(preview.validCount, 0);
});
