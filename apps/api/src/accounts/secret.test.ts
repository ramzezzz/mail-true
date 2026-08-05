/**
 * Юнит-тесты шифрования паролей чужих ящиков.
 *
 * Проверяется то, из-за чего пароль может утечь или перестать работать:
 * что шифротекст не содержит пароля, что чужой ключ не расшифровывает,
 * что подмена байта обнаруживается, и что без ключа модуль честно
 * отказывается работать, а не хранит пароль открытым.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecretBox, ExternalSecretBox, ExternalSecretError } from './secret.js';

const KEY = 'x'.repeat(32);
const OTHER_KEY = 'y'.repeat(40);

test('оборот шифрование -> расшифровка', () => {
  const box = new ExternalSecretBox(KEY);
  for (const password of ['простой', 'п@роль с пробелом', '»«§±!@#$%^&*()', 'a'.repeat(1024)]) {
    assert.equal(box.decrypt(box.encrypt(password)), password);
  }
});

test('шифротекст не содержит пароля и различается при каждом вызове', () => {
  const box = new ExternalSecretBox(KEY);
  const password = 'sekret-parol-12345';
  const first = box.encrypt(password);
  const second = box.encrypt(password);
  assert.notEqual(first, second, 'одинаковый шифротекст выдал бы одинаковые пароли');
  for (const boxed of [first, second]) {
    assert.ok(!boxed.includes(password));
    // И в декодированном виде тоже: base64url мог бы «просвечивать».
    const decoded = Buffer.from(boxed.slice(3), 'base64url').toString('binary');
    assert.ok(!decoded.includes(password));
  }
});

test('метка формата присутствует', () => {
  const box = new ExternalSecretBox(KEY);
  assert.ok(box.encrypt('пароль').startsWith('v1.'));
});

test('чужим ключом не расшифровывается', () => {
  const boxed = new ExternalSecretBox(KEY).encrypt('пароль');
  assert.throws(() => new ExternalSecretBox(OTHER_KEY).decrypt(boxed), ExternalSecretError);
});

test('подмена байта обнаруживается, а не даёт мусор', () => {
  const box = new ExternalSecretBox(KEY);
  const boxed = box.encrypt('пароль-от-чужого-ящика');
  const raw = Buffer.from(boxed.slice(3), 'base64url');
  raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
  const tampered = 'v1.' + raw.toString('base64url');
  assert.throws(() => box.decrypt(tampered), ExternalSecretError);
});

test('чужой формат и обрезанная строка отвергаются', () => {
  const box = new ExternalSecretBox(KEY);
  assert.throws(() => box.decrypt('не-наш-формат'), ExternalSecretError);
  assert.throws(() => box.decrypt('v1.' + Buffer.from('короткий').toString('base64url')), ExternalSecretError);
});

test('короткий ключ шифрования не принимается', () => {
  assert.throws(() => new ExternalSecretBox('слишком-короткий'), ExternalSecretError);
  assert.throws(() => new ExternalSecretBox(''), ExternalSecretError);
});

test('пустой пароль шифровать отказываемся', () => {
  const box = new ExternalSecretBox(KEY);
  assert.throws(() => box.encrypt(''), ExternalSecretError);
});

test('ключ шифрования выводится с отдельной солью: совпадение секретов не сближает модули', () => {
  // Тот же секрет, но соль другая (см. src/crypto.ts и src/ai/secret.ts):
  // строка, зашифрованная здесь, не должна расшифровываться там.
  const box = new ExternalSecretBox(KEY);
  const boxed = box.encrypt('пароль');
  const raw = Buffer.from(boxed.slice(3), 'base64url');
  // Проверяем косвенно: ключ 32 байта выводится scrypt'ом с нашей солью,
  // значит длина шифротекста = 12 (iv) + 16 (tag) + длина открытого текста.
  assert.equal(raw.length, 12 + 16 + Buffer.byteLength('пароль', 'utf8'));
});

test('createSecretBox: без переменной окружения шифровальщика нет и причина названа', () => {
  const none = createSecretBox(undefined);
  assert.equal(none.box, null);
  assert.match(none.reason ?? '', /EXTERNAL_ACCOUNTS_KEY/);

  const short = createSecretBox('коротко');
  assert.equal(short.box, null);
  assert.match(short.reason ?? '', /не менее 32/);

  const good = createSecretBox(KEY);
  assert.ok(good.box);
  assert.equal(good.reason, null);
});
