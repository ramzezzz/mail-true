/**
 * Картинки, вшитые в тело письма, уезжают получателю вложениями.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ ЭТО ВООБЩЕ ЕСТЬ
 * ------------------------------------------------------------------
 * Два житейских пути дают в теле `data:`-картинку:
 *
 *  1. снимок экрана, вставленный в письмо из буфера, — так его кладёт в
 *     разметку сам браузер;
 *  2. черновик, открытый на дописывание: его картинки отдаются вшитыми в
 *     тело, потому что ссылка на часть письма живёт ровно до следующего
 *     сохранения (номер черновика меняется, прежний удаляется).
 *
 * Отправить `data:` наружу нельзя: Outlook и Gmail такие картинки в
 * письмах не показывают — получатель видит пустое место. Поэтому здесь
 * они превращаются в обычные встроенные вложения с `cid:`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { inlineDataImages } from './inline-data.js';

/** Однопиксельный PNG — настоящие байты. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const URL_PNG = `data:image/png;base64,${PNG}`;

test('вшитая картинка становится вложением, а в теле остаётся cid:', () => {
  const result = inlineDataImages(`<p>Смотрите: <img src="${URL_PNG}"></p>`, 1024 * 1024);

  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0]?.contentType, 'image/png');
  assert.equal(result.attachments[0]?.contentDisposition, 'inline');
  assert.match(String(result.attachments[0]?.filename), /\.png$/);
  assert.ok(result.bytes > 0, 'байты картинки обязаны быть посчитаны');

  const cid = String(result.attachments[0]?.cid);
  assert.match(result.html, new RegExp(`src="cid:${cid.replace(/[.@+]/g, '\\$&')}"`));
  assert.doesNotMatch(result.html, /data:image/, 'вшитой картинки в теле остаться не должно');
});

test('одна и та же картинка дважды вкладывается один раз', () => {
  // Так бывает у подписи, вставленной в письмо и в цитату под ним: два
  // одинаковых `<img>`. Вложить их дважды значит удвоить вес письма.
  const result = inlineDataImages(`<img src="${URL_PNG}"><hr><img src="${URL_PNG}">`, 1024 * 1024);

  assert.equal(result.attachments.length, 1);
  const cid = String(result.attachments[0]?.cid);
  const uses = result.html.split(`cid:${cid}`).length - 1;
  assert.equal(uses, 2, 'обе ссылки обязаны указывать на одно вложение');
});

test('не поместившаяся картинка считается, а не выбрасывается молча', () => {
  /*
   * Вырезать картинку молча нельзя: письмо уйдёт без неё, и человек
   * узнает об этом от получателя. Отказывает тот, кто знает предел
   * письма целиком (composeRaw), — здесь только счёт.
   */
  const result = inlineDataImages(`<img src="${URL_PNG}">`, 10);

  assert.equal(result.skipped, 1);
  assert.equal(result.attachments.length, 0);
  assert.match(result.html, /data:image/, 'тело остаётся как было');
});

test('тело без вшитых картинок не трогается вовсе', () => {
  const html = '<p>Обычное письмо <img src="https://example.org/logo.png"></p>';
  const result = inlineDataImages(html, 1024 * 1024);

  assert.equal(result.html, html);
  assert.deepEqual(result.attachments, []);
  assert.equal(result.bytes, 0);
});
