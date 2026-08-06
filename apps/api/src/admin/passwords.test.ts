/**
 * Проверка хэширования паролей.
 *
 * Контрольные примеры SHA512-CRYPT взяты из спецификации
 * https://www.akkadia.org/drepper/SHA-crypt.txt — те же значения выдаёт
 * `doveadm pw -s SHA512-CRYPT`, которым пользуется create-mailbox.sh.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  dovecotHash,
  generateCryptSalt,
  generatePassword,
  hashAdminPassword,
  parseCryptHash,
  sha512Crypt,
  verifyAdminPassword,
  verifyDovecotHash,
} from './passwords.js';

test('sha512Crypt повторяет контрольные примеры спецификации', () => {
  const vectors: Array<{ password: string; salt: string; rounds: number; expected: string }> = [
    {
      password: 'Hello world!',
      salt: 'saltstring',
      rounds: 5000,
      expected:
        '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1',
    },
    {
      password: 'Hello world!',
      salt: 'saltstringsaltstring',
      rounds: 10000,
      expected:
        '$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.',
    },
    {
      password: 'This is just a test',
      salt: 'toolongsaltstring',
      rounds: 5000,
      expected:
        '$6$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0',
    },
    {
      // Длинный пароль (> 64 байт) — проверяет повтор дайджеста в шагах 9-10.
      // Эталон снят с `openssl passwd -6` в контейнере dovecot.
      password:
        'a very much longer text to encrypt.  This one even stretches over morethan one line.',
      salt: 'anotherlongsalts',
      rounds: 5000,
      expected:
        '$6$anotherlongsalts$zCB2J77iwc/56nB80mcnR6gCDELuiqcwDzPCm3OZnzRQyxT9pVMJ2vfOf0YI0AvrvfVu.AqASga4nxwhEPO7Z0',
    },
    {
      password: 'we have a short salt string but not a short password',
      salt: 'short',
      rounds: 77777,
      expected:
        '$6$rounds=77777$short$WuQyW2YR.hBNpjjRhpYD/ifIw05xdfeEyQoMxIXbkvr0gge1a1x3yRULJ5CCaUeOxFmtlcGZelFl5CxtgfiAc0',
    },
  ];

  for (const v of vectors) {
    assert.equal(sha512Crypt(v.password, v.salt, v.rounds), v.expected, `пароль: ${v.password}`);
  }
});

test('dovecotHash даёт формат с префиксом схемы и проверяется обратно', () => {
  const hash = dovecotHash('test12345');
  assert.match(hash, /^\{SHA512-CRYPT\}\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/);
  assert.equal(verifyDovecotHash('test12345', hash), true);
  assert.equal(verifyDovecotHash('test12346', hash), false);
});

test('verifyDovecotHash понимает хэш и без префикса схемы, и с rounds=', () => {
  assert.equal(
    verifyDovecotHash(
      'Hello world!',
      '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1',
    ),
    true,
  );
  assert.equal(
    verifyDovecotHash(
      'Hello world!',
      '{SHA512-CRYPT}$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.',
    ),
    true,
  );
  assert.equal(verifyDovecotHash('x', 'не-хэш'), false);
  assert.equal(verifyDovecotHash('x', '{PLAIN}x'), false);
});

test('parseCryptHash разбирает соль и раунды', () => {
  assert.deepEqual(parseCryptHash('$6$abc$def'), { rounds: 5000, salt: 'abc', digest: 'def' });
  assert.deepEqual(parseCryptHash('{SHA512-CRYPT}$6$rounds=9000$abc$def'), {
    rounds: 9000,
    salt: 'abc',
    digest: 'def',
  });
  assert.equal(parseCryptHash('$5$abc$def'), null);
});

test('generateCryptSalt даёт 16 символов из алфавита crypt(3)', () => {
  for (let i = 0; i < 20; i += 1) {
    assert.match(generateCryptSalt(), /^[./0-9A-Za-z]{16}$/);
  }
});

test('unicode-пароль хэшируется и проверяется', () => {
  const hash = dovecotHash('парольПароль-Ω');
  assert.equal(verifyDovecotHash('парольПароль-Ω', hash), true);
  assert.equal(verifyDovecotHash('парольПароль-ω', hash), false);
});

test('пароль администратора: scrypt, соль каждый раз новая', () => {
  const a = hashAdminPassword('очень-секретно-42');
  const b = hashAdminPassword('очень-секретно-42');
  assert.notEqual(a, b, 'соль должна отличаться');
  assert.match(a, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.equal(verifyAdminPassword('очень-секретно-42', a), true);
  assert.equal(verifyAdminPassword('очень-секретно-42', b), true);
  assert.equal(verifyAdminPassword('очень-секретно-43', a), false);
});

test('verifyAdminPassword не падает на мусоре', () => {
  for (const junk of ['', 'scrypt$', 'scrypt$a$b$c$d$e', 'bcrypt$1$2$3$4$5', '$6$abc$def']) {
    assert.equal(verifyAdminPassword('x', junk), false);
  }
});

test('generatePassword: заданная длина, только безопасные символы', () => {
  const pw = generatePassword(24);
  assert.equal(pw.length, 24);
  assert.match(pw, /^[a-zA-Z2-9]+$/);
  assert.notEqual(generatePassword(24), pw);
});
