/**
 * Чтение черновика обратно в окно написания — встроенные картинки.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ЭТО
 * ------------------------------------------------------------------
 * Черновик с картинками в теле сохраняется так же, как уходящее письмо:
 * сами картинки лежат частями `multipart/related`, а в теле на них стоит
 * `cid:`. Прежнее чтение снимало атрибут `src` целиком (браузеру такую
 * ссылку открыть нечем) и выбрасывало сами части как «уже показанные в
 * теле». Вместе это давало потерю: человек открывал сохранённый черновик
 * пересылки, а картинок не было ни в теле, ни во вложениях.
 *
 * Починка первого захода — подставлять адрес части письма
 * (`/api/messages/drafts:<номер>/parts/<N>`) — работала ровно ОДИН раз:
 * номер черновика меняется при каждом сохранении, прежний удаляется, и
 * второе автосохранение шло за картинкой по мёртвому адресу. Поэтому
 * теперь картинка вшивается прямо в тело (`data:`), а при сборке письма
 * переносится во встроенное вложение (mail/inline-data.ts).
 *
 * Проверки идут по СОБРАННОМУ ПИСЬМУ, а не по выдуманной структуре: только
 * так видно, что разбор понимает настоящий `multipart/related` — с теми же
 * заголовками, что кладёт сборщик писем.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDraftSource } from './draft-read.js';

/** Однопиксельный PNG — настоящие байты, а не выдуманные. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Черновик с картинкой в теле — ровно так его кладёт сборщик писем. */
function draftWithInlineImage(): Buffer {
  return Buffer.from(
    [
      'From: test@mail.local',
      'To: irina@mail.local',
      'Subject: Test',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="rel-1"',
      '',
      '--rel-1',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      '<div>Look: <img src="cid:logo@mail.true"></div>',
      '',
      '--rel-1',
      'Content-Type: image/png; name="logo.png"',
      'Content-ID: <logo@mail.true>',
      'Content-Disposition: inline; filename="logo.png"',
      'Content-Transfer-Encoding: base64',
      '',
      PNG_BASE64,
      '',
      '--rel-1--',
      '',
    ].join('\r\n'),
    'utf8',
  );
}

test('картинка черновика отдаётся отдельно, а тело остаётся лёгким', async () => {
  const parsed = await parseDraftSource(draftWithInlineImage());

  /*
   * В теле — `cid:`, байтов в нём нет. Адрес по номеру загрузки
   * подставляет маршрут (routes/compose.ts): номер постоянен и переживает
   * любое число пересохранений, в отличие от номера черновика.
   *
   * Два прежних подхода не годились. Ссылка на часть письма умирала при
   * первом же пересохранении — письмо уходило без картинки, хотя на
   * экране она была. Вшитые в тело байты чинили потерю, но росли на треть
   * и уезжали на сервер при каждом автосохранении, а крупный черновик и
   * вовсе переставал сохраняться: не влезал в предел запроса.
   */
  assert.match(parsed.bodyHtml, /src="cid:logo@mail\.true"/);
  assert.doesNotMatch(parsed.bodyHtml, /data:image/, 'байтов в теле быть не должно');
  assert.doesNotMatch(parsed.bodyHtml, /\/parts\//, 'привязки к номеру черновика быть не должно');

  assert.equal(parsed.inlineImages.length, 1, 'картинка обязана уехать отдельным полем');
  assert.equal(parsed.inlineImages[0]?.cid, 'logo@mail.true');
  assert.equal(parsed.inlineImages[0]?.mimeType, 'image/png');
  assert.ok((parsed.inlineImages[0]?.content.length ?? 0) > 0, 'байты картинки обязаны быть');

  // И вложением та же картинка НЕ прикладывается: человек увидел бы файл,
  // которого не прикреплял, и он уехал бы получателю вторым экземпляром.
  assert.deepEqual(parsed.attachments, []);
});

test('часть, на которую тело не ссылается, остаётся вложением', async () => {
  /*
   * Обратный ход: `related`-часть, чей `cid` в теле нигде не упомянут.
   * Прежний разбор выбрасывал такие части безусловно — то есть терял
   * вложение молча. Лишний файл в окне человек увидит и уберёт сам;
   * исчезнувший не увидит никогда.
   */
  const source = Buffer.from(
    [
      'From: test@mail.local',
      'To: irina@mail.local',
      'Subject: Test',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="rel-2"',
      '',
      '--rel-2',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<div>Без картинок</div>',
      '',
      '--rel-2',
      'Content-Type: image/png; name="orphan.png"',
      'Content-ID: <orphan@mail.true>',
      'Content-Disposition: inline; filename="orphan.png"',
      'Content-Transfer-Encoding: base64',
      '',
      PNG_BASE64,
      '',
      '--rel-2--',
      '',
    ].join('\r\n'),
    'utf8',
  );

  const parsed = await parseDraftSource(source);

  assert.equal(parsed.attachments.length, 1, 'картинка потерялась целиком');
  assert.equal(parsed.attachments[0]?.filename, 'orphan.png');
  assert.ok((parsed.attachments[0]?.content.length ?? 0) > 0, 'байты картинки обязаны быть');
});

test('обычное вложение черновика остаётся вложением', async () => {
  const source = Buffer.from(
    [
      'From: test@mail.local',
      'To: irina@mail.local',
      'Subject: Test',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="mix-1"',
      '',
      '--mix-1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<div>Text</div>',
      '',
      '--mix-1',
      'Content-Type: application/pdf; name="dogovor.pdf"',
      'Content-Disposition: attachment; filename="dogovor.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 тело', 'utf8').toString('base64'),
      '',
      '--mix-1--',
      '',
    ].join('\r\n'),
    'utf8',
  );

  const parsed = await parseDraftSource(source);

  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0]?.filename, 'dogovor.pdf');
});
