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

test('разбор большого письма линеен, а не квадратичен', () => {
  /*
   * ЭТА ПРОВЕРКА СТОИТ ЗДЕСЬ ИЗ-ЗА НАСТОЯЩЕЙ ОСТАНОВКИ СЕРВЕРА.
   *
   * Прежнее выражение искало от тега `<img` с ленивым `[^>]*?` и на теле
   * без закрывающих скобок просматривало остаток заново для каждого
   * вхождения. Замеры на этой же функции: 100 КБ — 167 мс, 200 КБ —
   * 663 мс, 400 КБ — 2663 мс. Учетверение на каждое удвоение; при
   * разрешённых десяти мегабайтах — часы, в течение которых Node не
   * отвечает НИКОМУ: ни почте, ни входу, ни панели.
   *
   * Порог намеренно щедрый (полсекунды на два мегабайта): проверка
   * ловит возврат квадратичного поведения, а не колебания машины.
   */
  const evil =
    `<p><img src="${URL_PNG}"></p>` + '<img '.repeat(40000) + 'x'.repeat(2 * 1024 * 1024);
  const started = Date.now();
  const result = inlineDataImages(evil, 10 * 1024 * 1024);
  const spent = Date.now() - started;

  assert.equal(result.attachments.length, 1, 'настоящая картинка обязана найтись');
  assert.ok(
    spent < 500,
    `разбор двух мегабайт занял ${String(spent)} мс — похоже на возврат квадрата`,
  );
});

test('картинка из background и из стиля тоже уезжает вложением', () => {
  /*
   * Раньше переносился только `<img src>`, а `background=` и
   * `url(data:…)` в стиле оставались как есть и уезжали получателю
   * ссылкой `data:` — то есть ровно тем, ради чего модуль и написан:
   * Outlook и Gmail такие картинки не показывают.
   */
  const html =
    `<td background="${URL_PNG}">a</td>` + `<div style="background-image: url(${URL_PNG})">b</div>`;
  const result = inlineDataImages(html, 1024 * 1024);

  assert.equal(result.attachments.length, 1, 'одна и та же картинка — одно вложение');
  assert.doesNotMatch(result.html, /data:image/, 'в теле не должно остаться data:');
  assert.equal(result.html.split('cid:').length - 1, 2, 'обе ссылки должны указывать на вложение');
});

test('data-src не путается с src', () => {
  // Такую ссылку санитайзер всё равно снимет, и вложение уехало бы
  // получателю без единой ссылки на него, заняв место в пределе письма.
  const result = inlineDataImages(
    `<img data-src="${URL_PNG}" src="https://example.org/a.png">`,
    1024 * 1024,
  );

  assert.deepEqual(result.attachments, []);
  assert.match(result.html, /data:image/, 'тело остаётся как было');
});
