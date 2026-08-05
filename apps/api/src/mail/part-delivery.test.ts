import assert from 'node:assert/strict';
import test from 'node:test';
import { decidePartDelivery } from './part-delivery.js';

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
