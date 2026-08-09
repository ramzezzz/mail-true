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
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
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

test('старые извещения убираются, свежие остаются', async () => {
  /*
   * Извещение о неотправленном письме исчезало ТОЛЬКО по нажатию
   * «Понятно». Уволился, ушёл в отпуск, не заметил плашку — файл
   * оставался навсегда. Каталог очереди один на всех, и список
   * извещений читается целиком при КАЖДОМ открытии почты любым
   * человеком: на сотне ящиков за пару лет это тысячи файлов на вход.
   */
  const s = await spool();
  const notice = {
    owner: 'ivan@mail.local',
    subject: 'письмо',
    envelopeTo: ['kto@mail.local'],
    reason: 'сервер не ответил',
    rejected: [],
    attempts: 5,
    lastAttemptAt: new Date().toISOString(),
    draftUid: null,
  };
  const old = await s.addFailure({ ...notice, subject: 'давнее' });
  await s.addFailure({ ...notice, subject: 'вчерашнее' });

  // Состарим первое извещение: время ставит сама очередь, поэтому
  // правим файл — так же, как его состарила бы пара месяцев.
  const dir = s.directory;
  const path2 = join(dir, `${old.id}.fail`);
  const stored = JSON.parse(await readFile(path2, 'utf8')) as { createdAt: string };
  stored.createdAt = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
  await writeFile(path2, JSON.stringify(stored), 'utf8');

  const removed = await s.purgeStale(new Date(Date.now() - 30 * 24 * 3600_000));
  assert.equal(removed, 1, 'убрано не то количество');

  const left = await s.failures('ivan@mail.local');
  assert.deepEqual(
    left.map((n) => n.subject),
    ['вчерашнее'],
    'убрано свежее извещение — человек не узнает, что письмо не ушло',
  );
});

test('уборка не трогает письмо, которое ещё уйдёт', async () => {
  // Живое письмо в очереди — это ненаписанная почта человека, и цена
  // ошибки здесь несоизмерима с местом на диске.
  const s = await spool();
  const id = await put(s, 'ivan@mail.local', 'ждёт своего часа');

  await s.purgeStale(new Date(Date.now() + 24 * 3600_000));
  assert.ok(await s.get(id), 'уборка снесла живое письмо из очереди');
});

test('брошенное письмо убирается, когда о нём давно сказано', async () => {
  const s = await spool();
  const id = await put(s, 'ivan@mail.local', 'не ушло совсем');
  await s.markGivenUp(id);

  // Крест поставлен только что — рано.
  await s.purgeStale(new Date(Date.now() - 30 * 24 * 3600_000));
  assert.ok(await s.get(id), 'свежее брошенное письмо убрано слишком рано');

  // А через месяц — пора.
  const removed = await s.purgeStale(new Date(Date.now() + 24 * 3600_000));
  assert.equal(removed, 1);
  assert.equal(await s.get(id), null);
});

test('пустой каталог уборку не роняет', async () => {
  const s = await spool();
  assert.equal(await s.purgeStale(new Date()), 0);
});
