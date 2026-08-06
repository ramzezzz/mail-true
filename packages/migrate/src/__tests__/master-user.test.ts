/**
 * Служебный доступ (master user): один пароль вместо сотни.
 *
 * Перенос сотни ящиков без служебного доступа требует сотни чужих паролей.
 * Их надо где-то взять, положить на всё время переноса (часы) и потом
 * отовсюду убрать — каждый из них отдельный секрет в обороте. Служебный
 * пользователь заменяет их одним: вход выполняется под именем
 * `ящик<разделитель>служебный` с паролем СЛУЖЕБНОГО пользователя.
 *
 * На старом коде падают все проверки: полей masterUser/masterSeparator
 * не существовало, и в IMAP уходило голое имя ящика.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { loginNameOf } from '../types.js';
import { probeEndpoint } from '../probe.js';

test('имя входа склеивается из ящика, разделителя и служебного пользователя', () => {
  assert.equal(
    loginNameOf({ host: 'h', user: 'ivan@example.org', pass: 'x', masterUser: 'sluzhebnyj' }),
    'ivan@example.org*sluzhebnyj',
    'по умолчанию разделитель «*» — как auth_master_user_separator у Dovecot',
  );
  assert.equal(
    loginNameOf({
      host: 'h',
      user: 'ivan@example.org',
      pass: 'x',
      masterUser: 'sluzhebnyj',
      masterSeparator: '%',
    }),
    'ivan@example.org%sluzhebnyj',
  );
});

test('без служебного пользователя имя входа — сам ящик, ничего не приклеивается', () => {
  assert.equal(loginNameOf({ host: 'h', user: 'ivan@example.org', pass: 'x' }), 'ivan@example.org');
  // Обратный ход: пустая строка — это «режим не включён», а не разделитель в никуда
  assert.equal(
    loginNameOf({ host: 'h', user: 'ivan@example.org', pass: 'x', masterUser: '' }),
    'ivan@example.org',
  );
});

/**
 * Поддельный IMAP-сервер, принимающий ТОЛЬКО служебное имя входа.
 * Так проверяется, что в сеть уходит именно склеенное имя, а не ящик.
 */
function imapExpectingLogin(expected: string): Promise<{ port: number; server: Server; seen: string[] }> {
  const seen: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      // AUTH=PLAIN намеренно НЕ объявляем: тогда imapflow шлёт команду LOGIN
      // открытым текстом, и в перехвате видно ИМЯ, под которым он входит, —
      // а проверяется здесь именно оно.
      socket.write('* OK [CAPABILITY IMAP4rev1] proba ready.\r\n');
      socket.on('data', (chunk) => {
        const line = chunk.toString('utf8');
        const tag = /^(\S+)/.exec(line)?.[1] ?? 'a1';
        const login = /LOGIN\s+"?([^"\s]+)"?\s/i.exec(line);
        if (login?.[1] !== undefined) {
          seen.push(login[1]);
          if (login[1] === expected) socket.write(`${tag} OK Logged in\r\n`);
          else socket.write(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`);
        } else if (/CAPABILITY/i.test(line)) {
          socket.write('* CAPABILITY IMAP4rev1\r\n');
          socket.write(`${tag} OK done\r\n`);
        } else if (/\bLIST\b/i.test(line)) {
          socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
          socket.write(`${tag} OK done\r\n`);
        } else if (/\bSTATUS\b/i.test(line)) {
          socket.write('* STATUS "INBOX" (MESSAGES 7)\r\n');
          socket.write(`${tag} OK done\r\n`);
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, server, seen });
    });
  });
}

test('в IMAP уходит служебное имя, а не имя ящика', async () => {
  const { port, server, seen } = await imapExpectingLogin('ivan@example.org*sluzhebnyj');
  try {
    const result = await probeEndpoint({
      host: '127.0.0.1',
      port,
      user: 'ivan@example.org',
      pass: 'parol-sluzhebnogo',
      masterUser: 'sluzhebnyj',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.loginName, 'ivan@example.org*sluzhebnyj');
    assert.deepEqual(seen, ['ivan@example.org*sluzhebnyj']);
    assert.equal(result.folders, 1);
    assert.equal(result.messages, 7);
  } finally {
    server.close();
  }
});

test('обратный ход: без служебного режима тот же сервер вход не принимает', async () => {
  // Проверка не «работает ли вообще», а «работает ли ИМЕННО из-за склейки»:
  // сервер ждёт служебное имя, обычное имя ящика он отвергает.
  const { port, server } = await imapExpectingLogin('ivan@example.org*sluzhebnyj');
  try {
    const result = await probeEndpoint({
      host: '127.0.0.1',
      port,
      user: 'ivan@example.org',
      pass: 'parol-sluzhebnogo',
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /логин или пароль/);
  } finally {
    server.close();
  }
});

test('отказ служебного входа объясняется служебным доступом, а не паролем ящика', async () => {
  // Самая дорогая ошибка в этом режиме — пойти менять пароль ящика,
  // когда дело в невключённом служебном доступе или другом разделителе.
  const { port, server } = await imapExpectingLogin('nikto');
  try {
    const result = await probeEndpoint({
      host: '127.0.0.1',
      port,
      user: 'ivan@example.org',
      pass: 'ne-tot',
      masterUser: 'sluzhebnyj',
    });
    assert.equal(result.ok, false);
    const text = result.error ?? '';
    assert.match(text, /служебн/i, `причина не названа служебной: ${text}`);
    assert.match(text, /ivan@example\.org\*sluzhebnyj/, 'не показано имя, под которым входили');
    assert.doesNotMatch(
      text,
      /сервер не принял логин или пароль/,
      `общая фраза сбивает на пароль ящика: ${text}`,
    );
  } finally {
    server.close();
  }
});
