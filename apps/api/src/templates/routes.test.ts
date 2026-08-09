/**
 * Проверки маршрутов шаблонов писем.
 *
 * Хранилище — в памяти (MemoryTemplateStore), хранилище загрузок —
 * настоящее (UploadStore во временной папке). Второе именно настоящее, а
 * не заглушка, потому что главный вопрос всей возможности — про него:
 * вложение шаблона обязано пережить уборку временных загрузок. Проверить
 * это на заглушке, у которой уборки нет, значило бы ничего не проверить.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from '../http-errors.js';
import type { AppDeps } from '../types.js';
import { UploadStore } from '../uploads.js';
import { MemoryTemplateStore } from './db.js';
import { templateRoutes } from './routes.js';
import { sanitizeTemplateHtml, templateHasText } from './sanitize.js';
import { MAX_TEMPLATE_BYTES } from './types.js';

interface Harness {
  app: FastifyInstance;
  uploads: UploadStore;
  dir: string;
  close(): Promise<void>;
}

async function buildHarness(
  store: MemoryTemplateStore | null = new MemoryTemplateStore(),
  /** Предел временного хранилища на ящик. По умолчанию — как на сервере. */
  mailboxLimit = 250 * 1024 * 1024,
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-templates-'));
  const uploads = new UploadStore(dir);
  await uploads.init();

  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  app.decorate('deps', {
    uploads,
    config: { UPLOAD_MAILBOX_MAX_BYTES: mailboxLimit },
  } as unknown as AppDeps);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', async function (request) {
    request.mailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };
  });
  registerErrorHandling(app);
  await app.register(
    async (api) => {
      await templateRoutes(api, { store, unavailableReason: 'База не настроена' });
    },
    { prefix: '/api' },
  );
  await app.ready();

  return {
    app,
    uploads,
    dir,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Кладёт файл во временное хранилище загрузок и отдаёт его идентификатор. */
async function upload(uploads: UploadStore, name: string, content: string): Promise<string> {
  const meta = await uploads.save(
    'test@mail.local',
    name,
    'application/pdf',
    Readable.from(Buffer.from(content)),
  );
  return meta.id;
}

async function createTemplate(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<{ id: number; body: Record<string, unknown> }> {
  const res = await app.inject({ method: 'POST', url: '/api/templates', payload });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as Record<string, unknown>;
  return { id: body.id as number, body };
}

/* ------------------------------------------------------------------ */
/* Доступность возможности                                             */
/* ------------------------------------------------------------------ */

test('без базы возможность честно объявлена недоступной, и завести шаблон нельзя', async () => {
  const h = await buildHarness(null);
  try {
    const res = await h.app.inject({ method: 'GET', url: '/api/templates' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { available: false, reason: 'База не настроена', items: [] });

    // Обратный ход: раз интерфейс прячет кнопку, то и запрос обязан
    // отказать — иначе «недоступно» было бы только словом.
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { name: 'Ответ клиенту', bodyHtml: '<div>Здравствуйте!</div>' },
    });
    assert.equal(created.statusCode, 400);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* Заведение, правка, удаление                                         */
/* ------------------------------------------------------------------ */

test('шаблон заводится, читается, правится и удаляется', async () => {
  const h = await buildHarness();
  try {
    const { id } = await createTemplate(h.app, {
      name: '  Ответ   клиенту  ',
      subject: 'Ваш заказ',
      bodyHtml: '<div>Здравствуйте, {{имя}}!</div>',
    });

    const list = await h.app.inject({ method: 'GET', url: '/api/templates' });
    assert.equal(list.json().available, true);
    assert.equal(list.json().items.length, 1);
    // Название нормализовано: лишние пробелы внутри и по краям убраны
    assert.equal(list.json().items[0].name, 'Ответ клиенту');
    assert.equal(list.json().items[0].subject, 'Ваш заказ');
    assert.equal(list.json().items[0].bodyHtml, '<div>Здравствуйте, {{имя}}!</div>');

    const patched = await h.app.inject({
      method: 'PUT',
      url: `/api/templates/${String(id)}`,
      payload: { subject: 'Ваш заказ №' },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().subject, 'Ваш заказ №');
    // Тело правку темы не задело
    assert.equal(patched.json().bodyHtml, '<div>Здравствуйте, {{имя}}!</div>');

    const removed = await h.app.inject({ method: 'DELETE', url: `/api/templates/${String(id)}` });
    assert.equal(removed.statusCode, 200, removed.body);
    const after = await h.app.inject({ method: 'GET', url: '/api/templates' });
    assert.deepEqual(after.json().items, []);
  } finally {
    await h.close();
  }
});

test('шаблон без названия и пустой шаблон не заводятся', async () => {
  const h = await buildHarness();
  try {
    const noName = await h.app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { name: '   ', bodyHtml: '<div>текст</div>' },
    });
    assert.equal(noName.statusCode, 400, noName.body);

    /*
     * Пустой — это шаблон без темы, без видимого текста и без вложений.
     * Разметка при этом не пуста: у пустого редактора innerHTML равен
     * `<div><br></div>`, и по строке такой шаблон выглядел бы наполненным.
     */
    const empty = await h.app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { name: 'Пустышка', subject: '  ', bodyHtml: '<div><br></div>&nbsp;' },
    });
    assert.equal(empty.statusCode, 400, empty.body);
  } finally {
    await h.close();
  }
});

test('два шаблона с одним названием не заводятся', async () => {
  const h = await buildHarness();
  try {
    await createTemplate(h.app, { name: 'Реквизиты', bodyHtml: '<div>ИНН</div>' });
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { name: 'реквизиты', bodyHtml: '<div>ИНН</div>' },
    });
    assert.equal(again.statusCode, 400, again.body);
    assert.match(again.json().message as string, /уже есть/u);
  } finally {
    await h.close();
  }
});

test('правка несуществующего шаблона — 404, а не молчаливое согласие', async () => {
  const h = await buildHarness();
  try {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/templates/9999',
      payload: { name: 'Нет такого' },
    });
    assert.equal(res.statusCode, 404, res.body);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* Вложения — главное в этой возможности                               */
/* ------------------------------------------------------------------ */

test('вложение шаблона переживает уборку временных загрузок', async () => {
  const h = await buildHarness();
  try {
    const uploadId = await upload(h.uploads, 'прайс.pdf', 'СОДЕРЖИМОЕ ПРАЙСА');
    const { id, body } = await createTemplate(h.app, {
      name: 'С прайсом',
      subject: 'Наши цены',
      bodyHtml: '<div>Прайс во вложении.</div>',
      attachmentIds: [uploadId],
    });
    assert.equal((body.attachments as unknown[]).length, 1);

    /*
     * Ровно тот случай, ради которого байты лежат в базе: временное
     * хранилище чистится, и загрузки, на которую можно было бы сослаться,
     * больше нет. Убираем ВСЁ (maxAgeMs = 0) — это и есть завтрашний день.
     */
    const swept = await h.uploads.sweep(0);
    assert.ok(swept >= 1, `уборка ничего не удалила: ${String(swept)}`);
    assert.equal(await h.uploads.get(uploadId, 'test@mail.local'), null);

    const materialized = await h.app.inject({
      method: 'POST',
      url: `/api/templates/${String(id)}/attachments`,
    });
    assert.equal(materialized.statusCode, 200, materialized.body);
    const files = materialized.json().attachments as Array<{
      id: string;
      filename: string;
      size: number;
    }>;
    assert.equal(files.length, 1);
    assert.equal(files[0]?.filename, 'прайс.pdf');
    // Идентификатор НОВЫЙ: это другая загрузка, а не воскресшая прежняя
    assert.notEqual(files[0]?.id, uploadId);

    // И содержимое то самое, а не пустышка с правильным именем
    const found = await h.uploads.get(files[0]?.id ?? '', 'test@mail.local');
    assert.ok(found);
    assert.equal(found.meta.size, Buffer.from('СОДЕРЖИМОЕ ПРАЙСА').length);
  } finally {
    await h.close();
  }
});

test('вставка шаблона отдаёт КОПИЮ: убрав вложение из письма, шаблон не портим', async () => {
  const h = await buildHarness();
  try {
    const uploadId = await upload(h.uploads, 'договор.pdf', 'ДОГОВОР');
    const { id } = await createTemplate(h.app, {
      name: 'С договором',
      bodyHtml: '<div>Договор во вложении.</div>',
      attachmentIds: [uploadId],
    });

    const first = await h.app.inject({
      method: 'POST',
      url: `/api/templates/${String(id)}/attachments`,
    });
    const firstId = (first.json().attachments as Array<{ id: string }>)[0]?.id ?? '';
    // Человек передумал и убрал вложение из письма — удалилась КОПИЯ
    await h.uploads.delete(firstId);

    const second = await h.app.inject({
      method: 'POST',
      url: `/api/templates/${String(id)}/attachments`,
    });
    assert.equal(second.statusCode, 200, second.body);
    const secondFiles = second.json().attachments as Array<{ id: string; filename: string }>;
    assert.equal(secondFiles.length, 1);
    assert.equal(secondFiles[0]?.filename, 'договор.pdf');
    assert.notEqual(secondFiles[0]?.id, firstId);
  } finally {
    await h.close();
  }
});

test('повторные вставки шаблона не съедают предел ящика молча', async () => {
  /*
   * Каждая вставка шаблона заводит НОВЫЕ файлы, живущие сутки. Без
   * проверки предела десяток вставок забивал место ящика, и человек
   * узнавал об этом с другой стороны: обычный файл к обычному письму
   * перестаёт прикрепляться, хотя сам он ничего не загружал.
   */
  const limit = 2048;
  const h = await buildHarness(new MemoryTemplateStore(), limit);
  try {
    const payload = 'п'.repeat(300); // кириллица — два байта на знак, 600 Б
    const uploadId = await upload(h.uploads, 'прайс.pdf', payload);
    const { id } = await createTemplate(h.app, {
      name: 'С прайсом',
      bodyHtml: '<div>Прайс.</div>',
      attachmentIds: [uploadId],
    });

    // Пока помещается — вставка работает как работала
    for (let i = 0; i < 2; i += 1) {
      const ok = await h.app.inject({
        method: 'POST',
        url: `/api/templates/${String(id)}/attachments`,
      });
      assert.equal(ok.statusCode, 200, ok.body);
    }

    const before = await h.uploads.usedBy('test@mail.local');
    assert.ok(before + 600 > limit, 'подготовка: следующая вставка обязана не поместиться');

    const denied = await h.app.inject({
      method: 'POST',
      url: `/api/templates/${String(id)}/attachments`,
    });
    assert.equal(denied.statusCode, 413, denied.body);
    // Числами, а не словом «нельзя»: человек должен понять, что убирать
    assert.match(denied.json().message as string, /Отправьте или удалите начатые письма/u);

    // И отказ не оставил на диске половину вложений шаблона
    assert.equal(await h.uploads.usedBy('test@mail.local'), before);
  } finally {
    await h.close();
  }
});

test('правка без слова о вложениях их НЕ стирает, а пустой список — стирает', async () => {
  const h = await buildHarness();
  try {
    const uploadId = await upload(h.uploads, 'прайс.pdf', 'ЦЕНЫ');
    const { id } = await createTemplate(h.app, {
      name: 'С прайсом',
      bodyHtml: '<div>Прайс.</div>',
      attachmentIds: [uploadId],
    });

    // Переименование — про название, и только про него
    const renamed = await h.app.inject({
      method: 'PUT',
      url: `/api/templates/${String(id)}`,
      payload: { name: 'Цены' },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal((renamed.json().attachments as unknown[]).length, 1);

    // А явный пустой список — это просьба убрать вложения
    const cleared = await h.app.inject({
      method: 'PUT',
      url: `/api/templates/${String(id)}`,
      payload: { attachmentIds: [] },
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(cleared.json().attachments, []);
  } finally {
    await h.close();
  }
});

test('пропавшая загрузка — отказ с объяснением, а не шаблон без прайса', async () => {
  const h = await buildHarness();
  try {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: {
        name: 'С прайсом',
        bodyHtml: '<div>Прайс.</div>',
        attachmentIds: ['00000000-0000-0000-0000-000000000000'],
      },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().message as string, /заново/u);

    // И шаблон при этом не завёлся вовсе — половинчатого не осталось
    const list = await h.app.inject({ method: 'GET', url: '/api/templates' });
    assert.deepEqual(list.json().items, []);
  } finally {
    await h.close();
  }
});

test('вложения тяжелее предела отклоняются числами, а не словом «нельзя»', async () => {
  const h = await buildHarness();
  try {
    const big = 'ы'.repeat(MAX_TEMPLATE_BYTES); // кириллица — два байта на знак
    const uploadId = await upload(h.uploads, 'толстый.pdf', big);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { name: 'Толстый', bodyHtml: '<div>.</div>', attachmentIds: [uploadId] },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().message as string, /МБ/u);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* Порядок                                                             */
/* ------------------------------------------------------------------ */

test('порядок задаётся списком, а не заводится заново', async () => {
  const h = await buildHarness();
  try {
    const a = await createTemplate(h.app, { name: 'Первый', bodyHtml: '<div>1</div>' });
    const b = await createTemplate(h.app, { name: 'Второй', bodyHtml: '<div>2</div>' });
    const c = await createTemplate(h.app, { name: 'Третий', bodyHtml: '<div>3</div>' });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/templates/order',
      payload: { ids: [c.id, a.id, b.id] },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      (res.json().items as Array<{ name: string }>).map((t) => t.name),
      ['Третий', 'Первый', 'Второй'],
    );
  } finally {
    await h.close();
  }
});

test('шаблон, не названный в порядке, встаёт ЗА названными, а не первым', async () => {
  const h = await buildHarness();
  try {
    const a = await createTemplate(h.app, { name: 'Первый', bodyHtml: '<div>1</div>' });
    const b = await createTemplate(h.app, { name: 'Второй', bodyHtml: '<div>2</div>' });
    // Третий как будто завели во второй вкладке, пока здесь тащили мышкой
    await createTemplate(h.app, { name: 'Забытый', bodyHtml: '<div>3</div>' });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/templates/order',
      payload: { ids: [b.id, a.id] },
    });
    assert.deepEqual(
      (res.json().items as Array<{ name: string }>).map((t) => t.name),
      ['Второй', 'Первый', 'Забытый'],
    );
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ */
/* Чистка разметки                                                     */
/* ------------------------------------------------------------------ */

test('скрипт в теле шаблона не доезжает до базы', async () => {
  const h = await buildHarness();
  try {
    const { body } = await createTemplate(h.app, {
      name: 'С сюрпризом',
      bodyHtml: '<div>Привет<script>alert(1)</script><img src=x onerror="alert(2)"></div>',
    });
    const stored = body.bodyHtml as string;
    assert.ok(!stored.includes('<script'), stored);
    assert.ok(!stored.includes('onerror'), stored);
    assert.ok(stored.includes('Привет'), stored);
  } finally {
    await h.close();
  }
});

test('чистка шаблона НЕ трогает картинки и ссылки — письмо уходит как набрали', () => {
  /*
   * Отдельно от маршрутов: это про разницу с санитайзером чтения писем.
   * Тот подменяет src заглушкой и вешает на ссылки target="_blank" —
   * в письме, которое человек отправляет сам, и то и другое было бы порчей.
   */
  const html = sanitizeTemplateHtml(
    '<p>См. <a href="https://example.com/цены">цены</a></p><img src="https://example.com/логотип.png">',
  );
  assert.ok(html.includes('https://example.com/%D1%86%D0%B5%D0%BD%D1%8B') || html.includes('цены'));
  assert.ok(!html.includes('target='), html);
  assert.ok(html.includes('<img'), html);
  assert.ok(!html.includes('data-mt-src'), html);
});

test('пустоту тела видно по тексту, а не по разметке', () => {
  assert.equal(templateHasText('<div><br></div>'), false);
  assert.equal(templateHasText('<div>&nbsp;</div>'), false);
  assert.equal(templateHasText('<div> </div>'), false);
  assert.equal(templateHasText('<div>Здравствуйте</div>'), true);
});
