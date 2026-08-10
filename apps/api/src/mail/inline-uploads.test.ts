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
  const html =
    '<p>Смотрите: <img src="/api/uploads/11111111-1111-4111-8111-111111111111/content"></p>';
  const result = await inlineUploadImages(
    html,
    store({ '11111111-1111-4111-8111-111111111111': { mimeType: 'image/png' } }),
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
  const html =
    '<img src="/api/uploads/22222222-2222-4222-8222-222222222222/content"><hr><img src="/api/uploads/22222222-2222-4222-8222-222222222222/content">';
  const result = await inlineUploadImages(
    html,
    store({ '22222222-2222-4222-8222-222222222222': { mimeType: 'image/png' } }),
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
  const html = '<img src="/api/uploads/22222222-2222-4222-8222-222222222222/content">';
  const result = await inlineUploadImages(
    html,
    store({ '22222222-2222-4222-8222-222222222222': { mimeType: 'image/png' } }),
    'someone@mail.local',
    1024 * 1024,
    read,
  );

  assert.deepEqual(result.attachments, []);
  assert.match(result.html, /\/api\/uploads\//);
});

test('не картинка вложением не становится', async () => {
  const html = '<img src="/api/uploads/44444444-4444-4444-8444-444444444444/content">';
  const result = await inlineUploadImages(
    html,
    store({ '44444444-4444-4444-8444-444444444444': { mimeType: 'application/pdf' } }),
    'test@mail.local',
    1024 * 1024,
    read,
  );

  assert.deepEqual(result.attachments, []);
});

test('не поместившаяся картинка считается, а не выбрасывается молча', async () => {
  const html = '<img src="/api/uploads/55555555-5555-4555-8555-555555555555/content">';
  const result = await inlineUploadImages(
    html,
    store({ '55555555-5555-4555-8555-555555555555': { mimeType: 'image/png', size: 5000 } }),
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

test('унесённая уборщиком картинка считается, а не пропадает молча', async () => {
  /*
   * Начатые письма живут сутки, а окно написания держат открытым
   * дольше. Прежде такая ссылка просто оставалась в теле: письмо
   * уходило без картинки, при том что на экране отправителя она была,
   * и человек узнавал о потере разве что от получателя. Отправка
   * теперь по этому счётчику отказывает (routes/compose.ts).
   */
  const html =
    '<p>Смотрите: <img src="/api/uploads/33333333-3333-4333-8333-333333333333/content"></p>';
  const result = await inlineUploadImages(html, store({}), 'test@mail.local', 1024 * 1024, read);

  assert.equal(result.missing, 1, 'потеря картинки прошла незамеченной');
  assert.equal(result.attachments.length, 0);
});

test('одна пропавшая картинка в теле дважды считается за одну', async () => {
  // Иначе человек читает «картинок не осталось — 2», идёт искать вторую
  // и не находит: в письме она одна, просто вставлена в шапке и в подписи.
  const id = '33333333-3333-4333-8333-333333333333';
  const html = `<img src="/api/uploads/${id}/content"><p>текст</p><img src="/api/uploads/${id}/content">`;
  const result = await inlineUploadImages(html, store({}), 'test@mail.local', 1024 * 1024, read);

  assert.equal(result.missing, 1);
});

test('чужая ссылка вида /api/uploads/…/content письмо не ломает', async () => {
  /*
   * Человек может написать в письме адрес чужой почты — хоть нашей же,
   * но другого сервера. Прежде такой текст считался пропавшей картинкой,
   * и отправка отказывала с советом «вставьте картинки заново», хотя
   * картинок в письме нет вовсе; связи между ссылкой и отказом не видно.
   */
  const html = '<p>Смотрите <a href="https://mail.example/api/uploads/foo/content">там</a></p>';
  const result = await inlineUploadImages(html, store({}), 'test@mail.local', 1024 * 1024, read);

  assert.equal(result.missing, 0, 'чужая ссылка принята за нашу картинку');
  assert.equal(result.html, html, 'тело письма изменено');
});

test('файл пропал, а мета осталась — это тоже потеря, и о ней говорят', async () => {
  // Удаление снимает `.bin` и `.json` двумя разными действиями: между
  // ними мета ещё читается, а файла уже нет.
  const id = '66666666-6666-4666-8666-666666666666';
  const result = await inlineUploadImages(
    `<img src="/api/uploads/${id}/content">`,
    store({ [id]: { mimeType: 'image/png' } }),
    'test@mail.local',
    1024 * 1024,
    () => Promise.reject(new Error('ENOENT')),
  );

  assert.equal(result.missing, 1, 'потеря файла прошла незамеченной');
  assert.equal(result.attachments.length, 0);
});

test('использованной картинке продлевается срок жизни', async () => {
  // Иначе картинка умирает ровно через сутки после открытия черновика —
  // прямо под человеком, который это письмо всё ещё пишет.
  const touched: string[] = [];
  const withTouch: UploadSource = {
    ...store({ '22222222-2222-4222-8222-222222222222': { mimeType: 'image/png' } }),
    touch: async (id: string) => {
      touched.push(id);
    },
  };
  await inlineUploadImages(
    '<img src="/api/uploads/22222222-2222-4222-8222-222222222222/content">',
    withTouch,
    'test@mail.local',
    1024 * 1024,
    read,
  );

  assert.deepEqual(
    touched,
    ['22222222-2222-4222-8222-222222222222'],
    'срок жизни картинки не продлён',
  );
});
