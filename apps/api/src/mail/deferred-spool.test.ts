/**
 * Очередь отправки: письмо не уходит дважды и не пропадает из виду.
 *
 * ------------------------------------------------------------------
 * ЧТО ПРОВЕРЯЕТСЯ
 * ------------------------------------------------------------------
 * 1. Отметка «SMTP уже принял». Конверт стирается только после того, как
 *    доставка вернула «ушло», а между ответом «250» и этим возвратом
 *    стоят копия в «Отправленные» (сетевой заход по IMAP), уборка
 *    вложений и пометка исходного письма. Умри процесс внутри окна —
 *    конверт остаётся, число попыток не выросло (оно растёт только при
 *    неудаче), срок в прошлом, и новый процесс отдаёт письмо СНОВА. У
 *    получателя два одинаковых письма, у отправителя в «Отправленных»
 *    одно, и понять произошедшее нельзя ни по чему.
 *
 * 2. Список ожидающих. Нажав «Отправить позже», человек терял письмо
 *    из виду целиком: из «Черновиков» оно уходит, в «Отправленные» ещё
 *    не попало, а списка очереди не было вовсе — ни посмотреть, ни
 *    отменить, при том что отмена по номеру работает давно.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeferredSpool } from './deferred-send.js';

/** Очередь во временном каталоге. */
async function spool(): Promise<DeferredSpool> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-spool-'));
  const s = new DeferredSpool(dir);
  await s.init();
  return s;
}

/** Кладёт письмо в очередь. */
async function put(
  s: DeferredSpool,
  owner: string,
  subject: string,
  sendAt = new Date(Date.now() - 1000),
): Promise<string> {
  const entry = await s.add(
    {
      owner,
      passwordEnc: 'зашифровано',
      sendAt: sendAt.toISOString(),
      envelopeTo: ['kto@mail.local'],
      subject,
    },
    Buffer.from('Subject: тест\r\n\r\nтело'),
  );
  return entry.id;
}

test('отметка «SMTP принял» переживает перезапуск: письмо не уйдёт дважды', async () => {
  const s = await spool();
  const id = await put(s, 'ivan@mail.local', 'важное письмо');

  // Процесс умер сразу после ответа SMTP — конверт остался с отметкой.
  await s.markSent(id);

  // Новый процесс читает очередь заново.
  const again = await s.get(id);
  assert.ok(again?.sentAt, 'отметка не сохранилась — письмо уйдёт повторно');

  // И письмо по-прежнему в списке «пора отправлять»: доставка обязана
  // сама увидеть отметку и не отдавать его SMTP второй раз.
  const due = await s.due(new Date());
  assert.ok(
    due.some((e) => e.id === id),
    'письмо выпало из обхода — хвост (копия в «Отправленные») никто не доделает',
  );
});

test('до ответа SMTP отметки нет: обычное письмо отправляется как всегда', async () => {
  const s = await spool();
  const id = await put(s, 'ivan@mail.local', 'обычное');
  const entry = await s.get(id);
  assert.equal(entry?.sentAt, undefined);
});

test('отметка на несуществующем письме не роняет очередь', async () => {
  // Так бывает, когда отмена успела снять письмо раньше.
  const s = await spool();
  await s.markSent('нет-такого-письма');
});

test('список ожидающих показывает только свои письма', async () => {
  const s = await spool();
  await put(s, 'ivan@mail.local', 'моё письмо');
  await put(s, 'anna@mail.local', 'чужое письмо');

  const mine = await s.scheduledFor('ivan@mail.local');
  assert.deepEqual(
    mine.map((e) => e.subject),
    ['моё письмо'],
  );
});

test('брошенные письма в списке ожидающих не показываются', async () => {
  /*
   * Они уже не уйдут, и о них человеку сказано отдельным извещением.
   * Показать их как «ожидает отправки» значило бы обещать несбыточное.
   */
  const s = await spool();
  const id = await put(s, 'ivan@mail.local', 'не ушло совсем');
  await s.markGivenUp(id);

  assert.deepEqual(await s.scheduledFor('ivan@mail.local'), []);
});

test('в списке видно, сколько раз отправка срывалась', async () => {
  // Ноль — обычное ожидание; больше — сервер получателя пока не
  // принимает, и человеку лучше знать об этом до срока, а не после.
  const s = await spool();
  const id = await put(s, 'ivan@mail.local', 'упрямое');
  await s.bumpAttempt(id);
  await s.bumpAttempt(id);

  const mine = await s.scheduledFor('ivan@mail.local');
  assert.equal(mine[0]?.attempts, 2);
});

test('пустая очередь даёт пустой список, а не отказ', async () => {
  const s = await spool();
  assert.deepEqual(await s.scheduledFor('ivan@mail.local'), []);
});
