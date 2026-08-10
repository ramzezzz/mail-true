/**
 * Встроенные картинки цитаты — во вложения отправляемого письма.
 *
 * Проверяется то, что видел получатель: до этого пересылка письма с
 * картинками в подписи или рассылки давала письмо БЕЗ единой картинки, и
 * молча. В теле стояла ссылка на наш маршрут `/api/messages/…/parts/…` —
 * готовое для чтения, но не для отправки: санитайзер снимает такой адрес
 * целиком, потому что схема ему незнакома.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineQuotedImages, parsePartUrl, type InlineImageSource } from './inline-images.js';

function source(parts: Record<string, { type?: string; bytes?: number }>): InlineImageSource {
  return {
    fetchPart: async (messageId, partId) => {
      const found = parts[`${messageId} ${partId}`];
      if (!found) return null;
      return {
        content: Buffer.alloc(found.bytes ?? 10, 1),
        contentType: found.type ?? 'image/png',
        filename: 'kartinka.png',
      };
    },
  };
}

test('ссылка на часть письма разбирается на письмо и часть', () => {
  assert.deepEqual(parsePartUrl('/api/messages/inbox:42/parts/2.1'), {
    messageId: 'inbox:42',
    partId: '2.1',
  });
  // Адрес в теле бывает закодирован — двоеточие в идентификаторе письма.
  assert.deepEqual(parsePartUrl('/api/messages/inbox%3A42/parts/2.1'), {
    messageId: 'inbox:42',
    partId: '2.1',
  });
  assert.equal(parsePartUrl('https://example.com/kartinka.png'), null);
});

test('картинка цитаты становится вложением, а в теле остаётся cid', async () => {
  const html = '<p>Пересылаю</p><img src="/api/messages/inbox:42/parts/2.1">';
  const result = await inlineQuotedImages(
    html,
    source({ 'inbox:42 2.1': { type: 'image/png' } }),
    1_000_000,
  );

  assert.equal(result.attachments.length, 1);
  const cid = result.attachments[0]?.cid ?? '';
  assert.ok(cid, 'у вложения обязан быть свой cid');
  assert.match(result.html, new RegExp(`src="cid:${cid.replace(/[.@]/g, '\\$&')}"`));
  // Адреса на наш сервер в отправляемом письме остаться не должно: он
  // требует сессии, и у получателя картинка всё равно не откроется.
  assert.ok(!result.html.includes('/api/messages/'));
  assert.equal(result.attachments[0]?.contentDisposition, 'inline');
});

test('одна и та же картинка вкладывается один раз', async () => {
  const html =
    '<img src="/api/messages/inbox:42/parts/2.1">' + '<img src="/api/messages/inbox:42/parts/2.1">';
  const result = await inlineQuotedImages(html, source({ 'inbox:42 2.1': {} }), 1_000_000);
  assert.equal(result.attachments.length, 1, 'дважды вложенная картинка удвоила бы письмо');
  const cid = result.attachments[0]?.cid ?? '';
  assert.equal(result.html.split(`cid:${cid}`).length - 1, 2, 'обе ссылки ведут на неё');
});

test('чужой тип и пропавшая часть письмо не ломают', async () => {
  const html =
    '<img src="/api/messages/inbox:42/parts/2.1">' + '<img src="/api/messages/inbox:42/parts/9.9">';
  const result = await inlineQuotedImages(
    html,
    source({ 'inbox:42 2.1': { type: 'application/pdf' } }),
    1_000_000,
  );
  // Ни pdf, ни исчезнувшая часть не вкладываются, но письмо уходит:
  // худший случай здесь равен прежнему поведению, а не хуже него.
  assert.equal(result.attachments.length, 0);
  assert.ok(result.html.includes('/api/messages/inbox:42/parts/2.1'));
});

test('предел письма соблюдается: лишняя картинка не вкладывается', async () => {
  const html =
    '<img src="/api/messages/inbox:42/parts/1">' + '<img src="/api/messages/inbox:42/parts/2">';
  const result = await inlineQuotedImages(
    html,
    source({ 'inbox:42 1': { bytes: 800 }, 'inbox:42 2': { bytes: 800 } }),
    1000,
  );
  assert.equal(result.attachments.length, 1, 'вторая картинка не помещается в предел');
  /*
   * И об этом сказано наружу. Молча оставленная ссылка на наш сервер —
   * это письмо без картинки у получателя: ровно то, что здесь чинилось.
   * Маршрут отправки по этому числу отказывает до отправки.
   */
  assert.equal(result.skipped, 1);
});

test('тело без картинок из ящика ничего не спрашивает', async () => {
  let asked = 0;
  const html = '<p>Обычное письмо</p><img src="https://example.com/kartinka.png">';
  const result = await inlineQuotedImages(
    html,
    {
      fetchPart: async () => {
        asked += 1;
        return null;
      },
    },
    1_000_000,
  );
  assert.equal(asked, 0, 'лишних заходов в ящик быть не должно');
  assert.equal(result.html, html);
});
