/**
 * Заголовки, присланные в восьмибитной кодировке БЕЗ RFC 2047.
 *
 * Найдено проверкой на настоящей почте. Правильный способ передать русскую
 * тему — закодировать её по RFC 2047. Но старые почтовые программы
 * (The Bat!, самописные рассылки, 1С, старые CRM) кладут в заголовок сырые
 * байты в KOI8-R или CP1251, а кодировку называют только у тела.
 *
 * Человек видел вместо темы строку ромбиков — при том что тело письма
 * читалось правильно, то есть кодировка была известна, ею просто не
 * пользовались. Письмо к тому же не находилось поиском по своей теме.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import iconv from 'iconv-lite';
import { hasEncodedWord, rawHeaderValue, repairHeader } from './header-charset.js';

/** Собирает блок заголовков с темой в заданной кодировке. */
function headersWith(subject: string, charset: string): Buffer {
  return Buffer.concat([
    Buffer.from('From: someone@example.com\r\nSubject: ', 'latin1'),
    iconv.encode(subject, charset),
    Buffer.from('\r\nDate: Tue, 05 Aug 2026 10:00:00 +0300\r\n', 'latin1'),
  ]);
}

test('тема в KOI8-R восстанавливается по кодировке тела', () => {
  const block = headersWith('Привет из КОИ8', 'koi8-r');
  assert.equal(repairHeader(block, 'Subject', 'koi8-r'), 'Привет из КОИ8');
});

test('тема в CP1251 восстанавливается', () => {
  const block = headersWith('Счёт за услуги', 'windows-1251');
  assert.equal(repairHeader(block, 'Subject', 'windows-1251'), 'Счёт за услуги');
});

test('тема в ISO-8859-1 восстанавливается', () => {
  const block = headersWith('Café Grüße Zürich', 'iso-8859-1');
  assert.equal(repairHeader(block, 'Subject', 'iso-8859-1'), 'Café Grüße Zürich');
});

test('корректный UTF-8 без объявления кодировки читается и без подсказки', () => {
  // Единственный случай, где можно обойтись без кодировки тела: UTF-8 узнаётся
  // по самой последовательности байтов, ошибиться тут почти невозможно.
  const block = headersWith('Тема без объявления', 'utf-8');
  assert.equal(repairHeader(block, 'Subject', null), 'Тема без объявления');
});

test('заголовок по RFC 2047 не трогаем — его разберут без нас', () => {
  const block = Buffer.from('Subject: =?UTF-8?B?0J/RgNC40LLQtdGC?=\r\n', 'latin1');
  assert.equal(repairHeader(block, 'Subject', 'koi8-r'), null);
});

test('чистая латиница остаётся как есть', () => {
  const block = Buffer.from('Subject: Quarterly report\r\n', 'latin1');
  assert.equal(repairHeader(block, 'Subject', 'koi8-r'), null);
});

test('без названной кодировки восьмибитные байты не угадываются', () => {
  // Угадывание ошибается, а ошибка здесь — подмена одного нечитаемого текста
  // другим, только правдоподобным. Лучше оставить как было.
  const block = headersWith('Счёт', 'windows-1251');
  assert.equal(repairHeader(block, 'Subject', null), null);
});

test('объявленный us-ascii при восьмибитных байтах — заведомая неправда', () => {
  const block = headersWith('Счёт', 'windows-1251');
  assert.equal(repairHeader(block, 'Subject', 'us-ascii'), null);
});

test('неизвестное название кодировки не роняет разбор', () => {
  const block = headersWith('Счёт', 'windows-1251');
  assert.equal(repairHeader(block, 'Subject', 'x-неведомая-кодировка'), null);
});

test('перенесённая на несколько строк тема склеивается', () => {
  const block = Buffer.concat([
    Buffer.from('Subject: ', 'latin1'),
    iconv.encode('Первая часть', 'koi8-r'),
    Buffer.from('\r\n ', 'latin1'),
    iconv.encode('вторая часть', 'koi8-r'),
    Buffer.from('\r\nFrom: a@b.c\r\n', 'latin1'),
  ]);
  assert.equal(repairHeader(block, 'Subject', 'koi8-r'), 'Первая часть вторая часть');
});

test('соседние заголовки не попадают в значение', () => {
  const block = headersWith('Тема', 'koi8-r');
  const value = rawHeaderValue(block, 'Subject');
  assert.ok(value);
  assert.ok(!value.toString('latin1').includes('Date'), 'значение не должно захватывать соседей');
});

test('имя заголовка ищется без учёта регистра', () => {
  const block = Buffer.concat([
    Buffer.from('SUBJECT: ', 'latin1'),
    iconv.encode('Регистр', 'koi8-r'),
    Buffer.from('\r\n', 'latin1'),
  ]);
  assert.equal(repairHeader(block, 'Subject', 'koi8-r'), 'Регистр');
});

test('отсутствующий заголовок — это null, а не падение', () => {
  const block = Buffer.from('From: a@b.c\r\n', 'latin1');
  assert.equal(repairHeader(block, 'Subject', 'koi8-r'), null);
  assert.equal(repairHeader(undefined, 'Subject', 'koi8-r'), null);
  assert.equal(repairHeader(Buffer.alloc(0), 'Subject', 'koi8-r'), null);
});

test('признак кодирования по RFC 2047 узнаётся в обеих формах', () => {
  assert.equal(hasEncodedWord('=?UTF-8?B?0J8=?='), true);
  assert.equal(hasEncodedWord('=?windows-1251?Q?=D1=E7?='), true);
  assert.equal(hasEncodedWord('Обычная тема'), false);
  // Похожее, но не encoded-word: одиночный знак вопроса не должен обманывать
  assert.equal(hasEncodedWord('Вопрос? Ответ'), false);
});
