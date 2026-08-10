/**
 * Шаблоны: объём списка и предел «сколько можно завести».
 *
 * ------------------------------------------------------------------
 * ЧТО ЗАКРЫВАЕТСЯ
 * ------------------------------------------------------------------
 * 1. Список отдавал тела ВСЕХ шаблонов целиком. Он запрашивается при
 *    открытии окна написания и на каждой странице настроек, а тело
 *    допускается до 512 КБ при сотне шаблонов на ящик — до полусотни
 *    мегабайт в одном ответе ради меню, где видно первые полсотни
 *    символов.
 * 2. Предел числа шаблонов проверялся ЧТЕНИЕМ СПИСКА перед вставкой.
 *    Между чтением и вставкой пролезает второй такой же запрос: повтор
 *    при обрыве связи или два сохранения из разных вкладок пробивали
 *    потолок молча.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryTemplateStore, TemplateLimitError } from './db.js';
import { MAX_TEMPLATES_PER_ACCOUNT, TEMPLATE_LIST_BODY_CHARS } from './types.js';

const EMAIL = 'ivan@mail.local';

/** Шаблон с телом заданной длины. */
async function add(store: MemoryTemplateStore, name: string, bodyLength: number) {
  return store.create(EMAIL, { name, subject: 'тема', bodyHtml: 'я'.repeat(bodyLength) }, []);
}

void test('короткий шаблон приходит в списке целиком', async () => {
  const store = new MemoryTemplateStore();
  await add(store, 'реквизиты', 300);
  const [item] = await store.list(EMAIL);
  assert.equal(item?.bodyHtml.length, 300);
  assert.equal(item?.bodyTruncated, undefined, 'короткий шаблон не должен помечаться обрезанным');
});

void test('длинный шаблон в списке обрезан и помечен', async () => {
  const store = new MemoryTemplateStore();
  await add(store, 'договор', TEMPLATE_LIST_BODY_CHARS * 3);
  const [item] = await store.list(EMAIL);
  assert.equal(item?.bodyHtml.length, TEMPLATE_LIST_BODY_CHARS);
  assert.equal(item?.bodyTruncated, true, 'без пометки клиент вставит в письмо обрывок');
});

void test('одиночный шаблон приходит целиком — им и вставляют в письмо', async () => {
  const store = new MemoryTemplateStore();
  const created = await add(store, 'договор', TEMPLATE_LIST_BODY_CHARS * 3);
  const full = await store.full(EMAIL, created.id);
  assert.equal(full?.bodyHtml.length, TEMPLATE_LIST_BODY_CHARS * 3);
  assert.equal(full?.bodyTruncated, undefined);
});

void test('чужой шаблон по номеру не отдаётся', async () => {
  // Номер угадывается перебором, и без сверки ящика это было бы чтением
  // чужих заготовок — вместе с реквизитами и текстами договоров.
  const store = new MemoryTemplateStore();
  const created = await add(store, 'реквизиты', 100);
  assert.equal(await store.full('anna@mail.local', created.id), null);
});

void test('предел числа шаблонов держит само хранилище, а не проверка перед вставкой', async () => {
  /*
   * Проверка в маршруте — это «прочитали список, решили, вставили», и
   * два одновременных запроса проходят её оба. Здесь предел проверяется
   * там же, где вставка, поэтому обойти его повтором нельзя.
   */
  const store = new MemoryTemplateStore();
  for (let i = 0; i < MAX_TEMPLATES_PER_ACCOUNT; i += 1) {
    await add(store, `шаблон ${String(i)}`, 10);
  }
  await assert.rejects(() => add(store, 'лишний', 10), TemplateLimitError);
  assert.equal((await store.list(EMAIL)).length, MAX_TEMPLATES_PER_ACCOUNT);
});

void test('два одновременных сохранения не пробивают потолок', async () => {
  const store = new MemoryTemplateStore();
  for (let i = 0; i < MAX_TEMPLATES_PER_ACCOUNT - 1; i += 1) {
    await add(store, `шаблон ${String(i)}`, 10);
  }
  // Место осталось одно, а желающих двое.
  const results = await Promise.allSettled([add(store, 'первый', 10), add(store, 'второй', 10)]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 1, 'прошли оба — потолок пробит');
  assert.equal((await store.list(EMAIL)).length, MAX_TEMPLATES_PER_ACCOUNT);
});

void test('в отказе названо число, а не «слишком много»', async () => {
  // Человеку у формы нужно знать, сколько удалить, а не то, что «нельзя».
  const store = new MemoryTemplateStore();
  for (let i = 0; i < MAX_TEMPLATES_PER_ACCOUNT; i += 1) {
    await add(store, `шаблон ${String(i)}`, 10);
  }
  await assert.rejects(
    () => add(store, 'лишний', 10),
    (err: unknown) => err instanceof TemplateLimitError && err.limit === MAX_TEMPLATES_PER_ACCOUNT,
  );
});
