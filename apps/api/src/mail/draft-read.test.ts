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
 * пересылки, а картинок не было ни в теле, ни во вложениях. Следующее
 * сохранение закрепляло потерю — в ящик ложилось письмо уже без них.
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

test('картинка из тела черновика превращается в ссылку на часть письма', async () => {
  const parsed = await parseDraftSource(draftWithInlineImage(), {
    resolveCid: (cid) => (cid === 'logo@mail.true' ? `/api/messages/drafts:42/parts/2` : null),
  });

  // Тело показывается: у окна написания есть чем открыть эту ссылку, и
  // при следующем сохранении она вернётся во встроенное вложение
  // (см. mail/inline-images.ts) — круг замыкается без потерь.
  assert.match(parsed.bodyHtml, /src="\/api\/messages\/drafts:42\/parts\/2"/);
  assert.doesNotMatch(parsed.bodyHtml, /cid:/, 'ссылки cid: браузеру показывать нечем');

  // И вложением та же картинка НЕ прикладывается: человек увидел бы файл,
  // которого не прикреплял, и он уехал бы получателю вторым экземпляром.
  assert.deepEqual(parsed.attachments, []);
});

test('картинка, которую не удалось поставить в тело, остаётся вложением', async () => {
  /*
   * Обратный ход. Соответствие «cid -> номер части» собирается из
   * BODYSTRUCTURE, и его может не быть вовсе: старое письмо, чужая
   * почтовая программа, отказ IMAP. Прежний разбор в этом случае терял
   * картинку ОТОВСЮДУ — тело без адреса, вложений нет. Лишний файл в
   * окне человек увидит и уберёт сам; исчезнувший не увидит никогда.
   */
  const parsed = await parseDraftSource(draftWithInlineImage());

  assert.equal(parsed.attachments.length, 1, 'картинка потерялась целиком');
  assert.equal(parsed.attachments[0]?.filename, 'logo.png');
  assert.equal(parsed.attachments[0]?.mimeType, 'image/png');
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

  const parsed = await parseDraftSource(source, { resolveCid: () => null });

  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0]?.filename, 'dogovor.pdf');
});
