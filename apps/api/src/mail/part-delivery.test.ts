import assert from 'node:assert/strict';
import test from 'node:test';
import { decidePartDelivery, emlFileName } from './part-delivery.js';

test('SVG не показывается в браузере и не отдаётся своим типом', () => {
  // Главный случай: SVG — это документ, а не картинка. Он проходит проверку
  // «начинается с image/», объявляется честно (поэтому nosniff не спасает),
  // а браузер выполняет скрипт внутри — на источнике API, с сессионной кукой.
  const d = decidePartDelivery('image/svg+xml');
  assert.equal(d.inline, false, 'SVG нельзя показывать в браузере');
  assert.equal(d.contentType, 'application/octet-stream');
});

test('SVG с параметрами в заголовке тоже обезврежен', () => {
  const d = decidePartDelivery('image/svg+xml; charset=utf-8');
  assert.equal(d.inline, false);
  assert.equal(d.contentType, 'application/octet-stream');
});

test('регистр в типе не помогает обойти правило', () => {
  const d = decidePartDelivery('IMAGE/SVG+XML');
  assert.equal(d.inline, false);
});

test('HTML не показывается в браузере', () => {
  const d = decidePartDelivery('text/html');
  assert.equal(d.inline, false);
  assert.equal(d.contentType, 'application/octet-stream');
});

test('прочие исполняемые типы тоже скачиваются', () => {
  for (const t of [
    'application/xhtml+xml',
    'text/xml',
    'application/xml',
    'image/svg',
    'application/pdf',
    'text/javascript',
  ]) {
    const d = decidePartDelivery(t);
    assert.equal(d.inline, false, `${t} нельзя показывать в браузере`);
  }
});

test('растровые картинки показываются — встроенные изображения писем должны работать', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']) {
    const d = decidePartDelivery(t);
    assert.equal(d.inline, true, `${t} должен показываться`);
    assert.equal(d.contentType, t);
  }
});

test('отсутствующий тип не приводит к показу', () => {
  for (const t of [undefined, null, '', '   ']) {
    const d = decidePartDelivery(t);
    assert.equal(d.inline, false);
    assert.equal(d.contentType, 'application/octet-stream');
  }
});

/* --- Имя файла для письма, сохранённого как .eml --------------------- */

test('имя файла — тема и дата', () => {
  assert.equal(
    emlFileName('Акт сверки за июль', new Date('2026-07-31T09:15:00Z')),
    'Акт сверки за июль 2026-07-31.eml',
  );
});

test('тема — это данные: путь из неё не собирается', () => {
  // Слэш в теме — обычное дело («Договор 12/2026»), и он не должен
  // превращаться в каталог. Точки подряд — это `..`, уход на уровень выше.
  assert.equal(
    emlFileName('../../etc/passwd', new Date('2026-01-02T00:00:00Z')),
    'etc passwd 2026-01-02.eml',
  );
  assert.equal(
    emlFileName('Договор 12/2026 "новый"', new Date('2026-01-02T00:00:00Z')),
    'Договор 12 2026 новый 2026-01-02.eml',
  );
});

test('письмо без темы получает читаемое имя, а не пустое', () => {
  assert.equal(emlFileName('', new Date('2026-01-02T00:00:00Z')), 'Письмо без темы 2026-01-02.eml');
  assert.equal(emlFileName('   ', new Date('2026-01-02T00:00:00Z')), 'Письмо без темы 2026-01-02.eml');
  assert.equal(emlFileName(null, new Date('2026-01-02T00:00:00Z')), 'Письмо без темы 2026-01-02.eml');
});

test('без даты имя остаётся без даты, а не с сегодняшней', () => {
  assert.equal(emlFileName('Тема', null), 'Тема.eml');
  assert.equal(emlFileName('Тема', new Date('не дата')), 'Тема.eml');
});

test('очень длинная тема обрезается — имя файла должно поместиться в ФС', () => {
  const name = emlFileName('я'.repeat(300), new Date('2026-01-02T00:00:00Z'));
  assert.equal(name, `${'я'.repeat(80)} 2026-01-02.eml`);
  // 80 букв кириллицы — это 160 байт в UTF-8, плюс дата и расширение:
  // с запасом помещается в предел 255 байт на имя файла.
  assert.ok(Buffer.byteLength(name, 'utf8') < 255);
});
