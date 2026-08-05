/** Проверка разбора CSV для массового импорта ящиков. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { nulByteProblem, parseCsv, parseQuota, parseUserImport } from './csv.js';
import { templateCsv, templateCsvWithBom } from '@mail-true/shared';

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
  // «нет-собаки» — адрес без «@». Раньше на любую кривизну отвечала одна
  // фраза «Некорректный адрес: …»; теперь сказано, чего именно не хватает.
  assert.match(byLine.get(2)?.errors.join() ?? '', /нет знака «@»/);
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
  // Строки-заглушки «Превышен предел импорта» в самом низу таблицы больше
  // нет: по ней выходило «отброшено 1 строка» на тысячи потерянных.
  // Об усечении теперь говорит признак truncated и число строк в файле.
  assert.equal(preview.truncated, true);
  assert.equal(preview.totalDataRows, 10);
  assert.equal(preview.maxRows, 3);
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

/* ------------------------------------------------------------------ */
/* Беды импорта, найденные проверкой панели                             */
/* ------------------------------------------------------------------ */

/** Нулевой байт строится в коде: в исходнике его быть не должно. */
const NUL = String.fromCharCode(0);
const header = 'email,name,password,quota\n';

/** Файл из n годных строк. */
function manyRows(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => `user${i}@mail.local,,,1G`);
  return header + rows.join('\n');
}

test('нулевой байт: файл отвергается объяснением, а не падением вставки в базу', () => {
  const problem = nulByteProblem(`email\nivan${NUL}@mail.local`);
  assert.ok(problem);
  assert.ok(problem.includes('0x00'));
  // Человеку нужно знать, что делать, а не код ошибки Postgres
  assert.ok(problem.includes('UTF-8'));
  assert.ok(!problem.includes('invalid byte sequence'));
});

test('нулевой байт: названа строка, в которой он встретился', () => {
  assert.ok(nulByteProblem(`a\nb\nc${NUL}d`)?.includes('строка 3'));
});

test('нулевой байт: обычный файл и прочие управляющие символы претензий не вызывают', () => {
  assert.equal(nulByteProblem(manyRows(3)), null);
  const tab = String.fromCharCode(9);
  const bell = String.fromCharCode(7);
  assert.equal(nulByteProblem(`email${tab}name\nivan@mail.local${tab}${bell}`), null);
});

test('усечение файла объявлено признаком, а не строкой в самом низу таблицы', () => {
  const preview = parseUserImport(manyRows(20_000), {
    knownDomains: ['mail.local'],
    maxRows: 5000,
  });
  assert.equal(preview.truncated, true);
  assert.equal(preview.totalDataRows, 20_000);
  assert.equal(preview.maxRows, 5000);
  // Именно этого числа не хватало человеку: 15 000 человек без почты
  assert.equal(preview.totalDataRows - preview.maxRows, 15_000);

  assert.equal(preview.rows.length, 5000);
  // Раньше отброшенной числилась ровно одна строка — сама заглушка,
  // и выходило «отброшено 1 строка» на 15 000 потерянных.
  assert.equal(preview.invalidCount, 0);
  for (const row of preview.rows) {
    assert.ok(!row.errors.join(' ').includes('Превышен предел'));
  }
});

test('файл в пределах не помечается усечённым', () => {
  const preview = parseUserImport(manyRows(10), { knownDomains: ['mail.local'], maxRows: 5000 });
  assert.equal(preview.truncated, false);
  assert.equal(preview.totalDataRows, 10);
  assert.equal(preview.rows.length, 10);
});

test('длинное имя ящика не проходит через импорт', () => {
  const preview = parseUserImport(`${header}${'a'.repeat(100)}@mail.local,,,1G`, {
    knownDomains: ['mail.local'],
  });
  assert.equal(preview.invalidCount, 1);
  assert.ok(preview.rows[0]?.errors.join(' ').includes('64'));
});

test('длинное отображаемое имя отбрасывает строку, а не режет её молча', () => {
  // Раньше имя обрезалось до 255 символов: ящик создавался, а имя в нём
  // оказывалось не тем, что в файле.
  const name = 'и'.repeat(300);
  const preview = parseUserImport(`${header}ivan@mail.local,${name},,1G`, {
    knownDomains: ['mail.local'],
  });
  assert.equal(preview.invalidCount, 1);
  assert.ok(preview.rows[0]?.errors.join(' ').includes('255'));
  assert.equal(preview.rows[0]?.displayName?.length, 300);
});

test('кириллический адрес объясняется раскладкой, а не общей ошибкой', () => {
  const preview = parseUserImport(`${header}иван@mail.local,,,1G`, {
    knownDomains: ['mail.local'],
  });
  assert.equal(preview.invalidCount, 1);
  const error = preview.rows[0]?.errors.join(' ') ?? '';
  assert.ok(error.includes('латин'));
  assert.ok(!error.includes('Некорректные данные запроса'));
});

test('шаблон, который скачивает панель, наш же разбор принимает без ошибок', () => {
  // Договор между панелью и сервером: выдать человеку шаблон, который
  // импорт не понимает, — худшее, что можно сделать.
  const preview = parseUserImport(templateCsv(), { knownDomains: ['mail.local'] });
  assert.equal(preview.hasHeader, true);
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.invalidCount, 0);
  assert.equal(preview.rows[0]?.email, 'ivan@mail.local');
  assert.equal(preview.rows[1]?.password, null); // пароль сгенерируется

  // И то же самое с меткой кодировки: BOM должен отрезаться, иначе первый
  // столбец назывался бы «\uFEFFemail».
  const withBom = parseUserImport(templateCsvWithBom(), { knownDomains: ['mail.local'] });
  assert.equal(withBom.hasHeader, true);
  assert.equal(withBom.invalidCount, 0);
});
