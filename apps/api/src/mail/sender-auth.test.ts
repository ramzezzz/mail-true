/**
 * Тесты допуска отправителя к логотипу.
 *
 * Здесь проверяется не разбор ради разбора, а ровно одно свойство: чужой
 * логотип нельзя получить, написав себе «dkim=pass». Поэтому больше половины
 * проверок — про ОТКАЗ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  domainOfAddress,
  domainsAligned,
  parseAuthenticationResults,
  senderLogoDomain,
  senderVerified,
} from './sender-auth.js';

/** Собирает блок заголовков письма так, как его отдаёт IMAP. */
function headerBlock(...lines: string[]): Buffer {
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf8');
}

const OURS = 'mail.local';

/* ------------------------------------------------------------------ */
/* Разбор заголовка                                                     */
/* ------------------------------------------------------------------ */

test('parseAuthenticationResults: имя сервера и методы со свойствами', () => {
  const parsed = parseAuthenticationResults(
    'mail.local; spf=pass smtp.mailfrom=github.com; dkim=pass header.d=github.com; dmarc=pass header.from=github.com',
  );
  assert.ok(parsed);
  assert.equal(parsed.authservId, 'mail.local');
  assert.equal(parsed.methods.length, 3);
  assert.deepEqual(
    parsed.methods.map((m) => `${m.method}=${m.result}`),
    ['spf=pass', 'dkim=pass', 'dmarc=pass'],
  );
  assert.equal(parsed.methods[1]?.props['header.d'], 'github.com');
});

test('parseAuthenticationResults: номер версии после имени сервера не мешает', () => {
  const parsed = parseAuthenticationResults('mail.local 1; dkim=pass header.d=example.com');
  assert.equal(parsed?.authservId, 'mail.local');
  assert.equal(parsed?.methods[0]?.result, 'pass');
});

test('parseAuthenticationResults: точка с запятой внутри кавычек не режет запись', () => {
  // Без учёта кавычек обломок `; тут» dkim=pass` разобрался бы как ещё один
  // метод — то есть отправитель дописывал бы результаты внутрь reason.
  const parsed = parseAuthenticationResults(
    'mail.local; dmarc=fail reason="policy; dkim=pass header.d=bank.example" header.from=evil.example',
  );
  assert.equal(parsed?.methods.length, 1);
  assert.equal(parsed?.methods[0]?.result, 'fail');
});

test('parseAuthenticationResults: «none» без методов разбирается без падения', () => {
  // Ровно так пишет наш rspamd письмам, по которым проверять нечего.
  const parsed = parseAuthenticationResults('mail.local; none');
  assert.equal(parsed?.authservId, 'mail.local');
  assert.deepEqual(parsed?.methods, []);
});

/* ------------------------------------------------------------------ */
/* Домены и согласованность                                             */
/* ------------------------------------------------------------------ */

test('domainOfAddress: приводит к нижнему регистру и снимает точку на конце', () => {
  assert.equal(domainOfAddress('Ivan <ivan@Example.COM.>'), 'example.com');
  assert.equal(domainOfAddress('a@sub.example.co.uk'), 'sub.example.co.uk');
});

test('domainOfAddress: адрес-литерал и мусор доменом не считаются', () => {
  assert.equal(domainOfAddress('user@[192.0.2.1]'), null);
  assert.equal(domainOfAddress('user@localhost'), null);
  assert.equal(domainOfAddress(''), null);
  assert.equal(domainOfAddress(undefined), null);
});

test('domainsAligned: поддомен согласован, похожее имя — нет', () => {
  assert.equal(domainsAligned('news.example.com', 'example.com'), true);
  assert.equal(domainsAligned('example.com', 'news.example.com'), true);
  // Самая частая подделка: настоящее имя как ПРИСТАВКА чужого домена.
  assert.equal(domainsAligned('example.com.evil.net', 'example.com'), false);
  assert.equal(domainsAligned('notexample.com', 'example.com'), false);
});

/* ------------------------------------------------------------------ */
/* Решение о допуске                                                    */
/* ------------------------------------------------------------------ */

test('senderVerified: DMARC=pass с тем же доменом — допуск', () => {
  const parsed = parseAuthenticationResults('mail.local; dmarc=pass header.from=github.com');
  assert.ok(parsed);
  assert.equal(senderVerified('github.com', parsed), true);
});

test('senderVerified: одного SPF=pass недостаточно', () => {
  // SPF проверяет адрес конверта, а логотип ставится к заголовку From:
  // письмо с чужим From и своим конвертом проходит SPF на отлично.
  const parsed = parseAuthenticationResults('mail.local; spf=pass smtp.mailfrom=evil.example');
  assert.ok(parsed);
  assert.equal(senderVerified('sberbank.ru', parsed), false);
});

test('senderVerified: DKIM=pass подписью ЧУЖОГО домена — отказ', () => {
  const parsed = parseAuthenticationResults('mail.local; dkim=pass header.d=evil.example');
  assert.ok(parsed);
  assert.equal(senderVerified('sberbank.ru', parsed), false);
});

test('senderVerified: DKIM=pass подписью своего домена — допуск', () => {
  const parsed = parseAuthenticationResults('mail.local; dkim=pass header.d=example.com');
  assert.ok(parsed);
  assert.equal(senderVerified('news.example.com', parsed), true);
});

test('senderVerified: DMARC=fail при DKIM=pass чужого домена — отказ', () => {
  const parsed = parseAuthenticationResults(
    'mail.local; dkim=pass header.d=evil.example; dmarc=fail header.from=sberbank.ru',
  );
  assert.ok(parsed);
  assert.equal(senderVerified('sberbank.ru', parsed), false);
});

/* ------------------------------------------------------------------ */
/* Доверие к заголовку целиком                                          */
/* ------------------------------------------------------------------ */

test('senderLogoDomain: заголовок нашего сервера с DMARC=pass даёт домен', () => {
  const block = headerBlock(
    'Authentication-Results: mail.local;',
    '\tdkim=pass header.d=github.com; dmarc=pass header.from=github.com',
    'Subject: hello',
  );
  assert.equal(senderLogoDomain('noreply@github.com', block, OURS), 'github.com');
});

test('senderLogoDomain: подделанный заголовок с ЧУЖИМ именем сервера отвергается', () => {
  // Отправитель написал себе проверку сам и подписался посторонним именем.
  const block = headerBlock(
    'Authentication-Results: evil.example; dkim=pass header.d=sberbank.ru; dmarc=pass header.from=sberbank.ru',
    'Subject: hello',
  );
  assert.equal(senderLogoDomain('security@sberbank.ru', block, OURS), null);
});

test('senderLogoDomain: подделка НАШИМ именем ниже настоящего заголовка не проходит', () => {
  /*
   * Главный случай ради которого всё затевалось. Отправитель вписал в письмо
   * `Authentication-Results: mail.local; dmarc=pass` — то есть попал и в наше
   * имя тоже. Но наш сервер приписывает свой заголовок СВЕРХУ, и он говорит
   * «none». Берём только первый — подделка не видна.
   */
  const block = headerBlock(
    'Authentication-Results: mail.local;',
    '\tnone',
    'Authentication-Results: mail.local; dkim=pass header.d=sberbank.ru; dmarc=pass header.from=sberbank.ru',
    'Subject: Ваша карта заблокирована',
  );
  assert.equal(senderLogoDomain('security@sberbank.ru', block, OURS), null);
});

test('senderLogoDomain: без заголовка проверки — отказ', () => {
  const block = headerBlock('Subject: hello');
  assert.equal(senderLogoDomain('noreply@github.com', block, OURS), null);
  assert.equal(senderLogoDomain('noreply@github.com', undefined, OURS), null);
});

test('senderLogoDomain: проверка прошла, но домен From другой — отказ', () => {
  // Письмо переупаковано по дороге: проверяли одно, показываем другое.
  const block = headerBlock(
    'Authentication-Results: mail.local; dmarc=pass header.from=list.example.org',
    'Subject: hello',
  );
  assert.equal(senderLogoDomain('noreply@github.com', block, OURS), null);
});
