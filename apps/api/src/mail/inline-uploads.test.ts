/**
 * Картинки черновика уезжают получателю встроенными вложениями.
 *
 * В теле, которое правит человек, они стоят ссылкой на временное
 * хранилище (`/api/uploads/<номер>/content`): номер постоянен и переживает
 * любое число пересохранений, в отличие от номера черновика, который
 * меняется при каждом. Отправить такую ссылку наружу нельзя — у
 * получателя нет ни нашей сессии, ни доступа к чужому хранилищу.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { inlineUploadImages, type UploadSource } from './inline-uploads.js';

const PNG = Buffer.from('картинка', 'utf8');

function store(entries: Record<string, { mimeType: string; size?: number }>): UploadSource {
  return {
    get: async (id, owner) => {
      const found = entries[id];
      if (!found || owner !== 'test@mail.local') return null;
      return {
        meta: { filename: `${id}.png`, mimeType: found.mimeType, size: found.size ?? PNG.length },
        path: `/tmp/${id}`,
      };
    },
  };
}

const read = async (): Promise<Buffer> => PNG;

test('ссылка на загрузку превращается во встроенное вложение', async () => {
  const html = '<p>Смотрите: <img src="/api/uploads/abc123/content"></p>';
  const result = await inlineUploadImages(
    html,
    store({ abc123: { mimeType: 'image/png' } }),
    'test@mail.local',
    1024 * 1024,
    read,
  );

  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0]?.contentDisposition, 'inline');
  assert.doesNotMatch(
    result.html,
    /\/api\/uploads\//,
    'ссылки на наше хранилище в письме быть не должно',
  );
  assert.match(result.html, /src="cid:/);
});

test('одна и та же загрузка дважды вкладывается один раз', async () => {
  const html = '<img src="/api/uploads/abc/content"><hr><img src="/api/uploads/abc/content">';
  const result = await inlineUploadImages(
    html,
    store({ abc: { mimeType: 'image/png' } }),
    'test@mail.local',
    1024 * 1024,
    read,
  );

  assert.equal(result.attachments.length, 1);
  assert.equal(result.html.split('cid:').length - 1, 2);
});

test('чужая загрузка в письмо не попадает', async () => {
  // Владелец — тот, от чьего имени письмо. Хранилище на чужой номер
  // отвечает «нет такой», и ссылка остаётся ссылкой: картинки у
  // получателя не будет, но чужой файл к нему не уедет.
  const html = '<img src="/api/uploads/abc/content">';
  const result = await inlineUploadImages(
    html,
    store({ abc: { mimeType: 'image/png' } }),
    'someone@mail.local',
    1024 * 1024,
    read,
  );

  assert.deepEqual(result.attachments, []);
  assert.match(result.html, /\/api\/uploads\//);
});

test('не картинка вложением не становится', async () => {
  const html = '<img src="/api/uploads/doc/content">';
  const result = await inlineUploadImages(
    html,
    store({ doc: { mimeType: 'application/pdf' } }),
    'test@mail.local',
    1024 * 1024,
    read,
  );

  assert.deepEqual(result.attachments, []);
});

test('не поместившаяся картинка считается, а не выбрасывается молча', async () => {
  const html = '<img src="/api/uploads/big/content">';
  const result = await inlineUploadImages(
    html,
    store({ big: { mimeType: 'image/png', size: 5000 } }),
    'test@mail.local',
    10,
    read,
  );

  assert.equal(result.skipped, 1);
  assert.deepEqual(result.attachments, []);
});

test('тело без ссылок на хранилище не трогается вовсе', async () => {
  const html = '<p>Обычное письмо</p>';
  const result = await inlineUploadImages(html, store({}), 'test@mail.local', 1024 * 1024, read);

  assert.equal(result.html, html);
  assert.equal(result.bytes, 0);
});
