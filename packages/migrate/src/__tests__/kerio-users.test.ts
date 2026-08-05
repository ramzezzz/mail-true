/** Тесты разбора выгрузки пользователей Kerio Connect. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKerioUsersCsv,
  parseKerioUsersCfg,
  toMailboxList,
  domainFromKerioFilename,
} from '../kerio-users.js';
import { parseCsv, detectDelimiter } from '../csv.js';

/** Выгрузка Kerio Connect, вариант 1: разделитель «;», мультизначения через «,». */
const KERIO_CSV = [
  'Name;Password;FullName;Description;MailAddress;Groups',
  'ivanov;VbD66op1;Иван Иванов;Отдел продаж;ivanov,i.ivanov;Sales,All',
  'petrov;;Пётр Петров;;petrov@example.com;',
  'sidorova;;"Анна Сидорова; бухгалтер";Бухгалтерия;sidorova;Accounting',
  ';;;;;',
].join('\r\n');

/** Вариант 2: разделитель «,», многозначные поля в кавычках (пример из мануала GFI). */
const KERIO_CSV_COMMA = [
  'Name,Password,FullName,Description,MailAddress,Groups',
  'abird,VbD66op1,Alexandra Bird,Development,abird,"read,all"',
].join('\r\n');

describe('detectDelimiter / parseCsv', () => {
  it('определяет «;» в выгрузке Kerio', () => {
    assert.equal(detectDelimiter(KERIO_CSV), ';');
  });

  it('уважает кавычки с разделителем внутри', () => {
    const rows = parseCsv('a;"b;c";d', { delimiter: ';' });
    assert.deepEqual(rows, [['a', 'b;c', 'd']]);
  });

  it('разбирает экранированные кавычки', () => {
    const rows = parseCsv('"скажи ""да""",x');
    assert.deepEqual(rows, [['скажи "да"', 'x']]);
  });
});

describe('parseKerioUsersCsv', () => {
  it('разбирает типовую выгрузку Kerio', () => {
    const users = parseKerioUsersCsv(KERIO_CSV);
    assert.equal(users.length, 3); // пустая строка отброшена

    const ivanov = users[0];
    assert.ok(ivanov);
    assert.equal(ivanov.login, 'ivanov');
    assert.equal(ivanov.fullName, 'Иван Иванов');
    assert.equal(ivanov.description, 'Отдел продаж');
    assert.equal(ivanov.email, 'ivanov');
    assert.deepEqual(ivanov.aliases, ['i.ivanov']);
    assert.deepEqual(ivanov.groups, ['Sales', 'All']);
    assert.equal(ivanov.password, 'VbD66op1'); // Kerio выгружает пароли открытым текстом

    const petrov = users[1];
    assert.ok(petrov);
    assert.equal(petrov.email, 'petrov@example.com');
    assert.deepEqual(petrov.groups, []);

    const sidorova = users[2];
    assert.ok(sidorova);
    assert.equal(sidorova.fullName, 'Анна Сидорова; бухгалтер');
  });

  it('разбирает вариант с запятой и кавычками вокруг многозначных полей', () => {
    const users = parseKerioUsersCsv(KERIO_CSV_COMMA);
    assert.equal(users.length, 1);
    const abird = users[0];
    assert.ok(abird);
    assert.equal(abird.login, 'abird');
    assert.equal(abird.password, 'VbD66op1');
    assert.equal(abird.fullName, 'Alexandra Bird');
    assert.equal(abird.email, 'abird'); // без домена — дополнится позже
    assert.deepEqual(abird.groups, ['read', 'all']);
  });

  it('устойчив к другому порядку и подмножеству колонок', () => {
    const users = parseKerioUsersCsv('FullName;Name\r\nИмя;login1\r\n');
    assert.equal(users[0]?.login, 'login1');
    assert.equal(users[0]?.email, null);
  });

  it('бросает понятную ошибку без колонки Name', () => {
    assert.throws(() => parseKerioUsersCsv('Foo;Bar\r\na;b\r\n'), /колонка логина/);
  });
});

describe('parseKerioUsersCfg', () => {
  it('best-effort разбирает XML users.cfg', () => {
    const xml = `<?xml version="1.0"?>
<config>
  <list name="User">
    <listitem>
      <variable name="Name">ivanov</variable>
      <variable name="FullName">Иван &amp; Ко</variable>
      <variable name="EmailAddress">ivanov,sales</variable>
    </listitem>
    <listitem>
      <variable name="Name">petrov</variable>
    </listitem>
  </list>
</config>`;
    const users = parseKerioUsersCfg(xml);
    assert.equal(users.length, 2);
    assert.equal(users[0]?.login, 'ivanov');
    assert.equal(users[0]?.fullName, 'Иван & Ко');
    assert.equal(users[0]?.email, 'ivanov');
    assert.deepEqual(users[0]?.aliases, ['sales']);
    assert.equal(users[1]?.login, 'petrov');
  });
});

describe('toMailboxList', () => {
  it('достраивает домен и готовит список для создания ящиков (без паролей)', () => {
    const users = parseKerioUsersCsv(KERIO_CSV);
    const list = toMailboxList(users, 'mail.local');
    assert.deepEqual(list[0], {
      email: 'ivanov@mail.local',
      displayName: 'Иван Иванов',
      aliases: ['i.ivanov@mail.local'],
    });
    // по умолчанию пароль (открытый текст!) в список не попадает
    assert.equal('password' in (list[0] ?? {}), false);
    // адрес с доменом не дополняется
    assert.equal(list[1]?.email, 'petrov@example.com');
  });

  it('включает пароль только по явному запросу', () => {
    const users = parseKerioUsersCsv(KERIO_CSV);
    const list = toMailboxList(users, 'mail.local', true);
    assert.equal(list[0]?.password, 'VbD66op1');
    assert.equal('password' in (list[1] ?? {}), false); // пустой пароль не включается
  });
});

describe('domainFromKerioFilename', () => {
  it('извлекает домен из имени файла выгрузки', () => {
    assert.equal(domainFromKerioFilename('users_example.com_2026-08-05.csv'), 'example.com');
    assert.equal(domainFromKerioFilename('C:\\tmp\\users_mail.local_20260805.csv'), 'mail.local');
    assert.equal(domainFromKerioFilename('/tmp/users_mail.local_20260805.csv'), 'mail.local');
  });

  it('null для файлов с другим именем', () => {
    assert.equal(domainFromKerioFilename('export.csv'), null);
    assert.equal(domainFromKerioFilename('users.cfg'), null);
  });
});
