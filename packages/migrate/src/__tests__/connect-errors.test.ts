/**
 * Отказ на подключении обязан говорить, ЧТО не так.
 *
 * Поймано на живом стенде: перенос с неверным паролем заканчивался строкой
 *
 *   ошибка: Command failed
 *
 * и всё. Перенос ящика идёт часами и запускается обычно ночью; человек,
 * увидевший утром такую строку, не знает даже, к какому из двух серверов
 * она относится, — и начинает гадать: сеть? порт? пароль? не тот адрес?
 *
 * Разбор ответа сервера в этом пакете был, но применялся только к операциям
 * с письмами. Вход остался без него — при том что адрес и пароль вводят
 * руками, и это самое частое место отказа.
 *
 * На старом коде падают все проверки: текста «Не удалось подключиться»
 * не существовало.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { migrateMailbox } from '../migrator.js';

/** Поддельный IMAP-сервер: здоровается и отвечает на LOGIN отказом. */
function imapThatRefusesLogin(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] proba ready.\r\n');
      socket.on('data', (chunk) => {
        const line = chunk.toString('utf8');
        const tag = /^(\S+)/.exec(line)?.[1] ?? 'a1';
        if (/LOGIN|AUTHENTICATE/i.test(line)) {
          socket.write(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`);
        } else if (/CAPABILITY/i.test(line)) {
          socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n');
          socket.write(`${tag} OK done\r\n`);
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, server });
    });
  });
}

async function runAgainst(port: number, role: 'source' | 'dest'): Promise<string> {
  const endpoint = { host: '127.0.0.1', port, user: 'kto@example.org', pass: 'nevernyj' };
  // Второй конец должен быть заведомо закрыт, чтобы проверялся именно
  // нужный: незанятый порт даст отказ соединения.
  const closed = { host: '127.0.0.1', port: 1, user: 'kuda@example.org', pass: 'x' };
  const report = await migrateMailbox({
    source: role === 'source' ? endpoint : closed,
    dest: role === 'source' ? closed : endpoint,
  });
  return report.error ?? '';
}

test('неверный пароль на источнике: сказано что, где и почему', async () => {
  const { port, server } = await imapThatRefusesLogin();
  try {
    const text = await runAgainst(port, 'source');
    assert.match(text, /Не удалось подключиться к исходному серверу/, text);
    assert.match(text, /kto@example\.org@127\.0\.0\.1:/, 'не сказано, к какому серверу');
    assert.match(text, /логин или пароль/, 'не названа причина');
    assert.doesNotMatch(text, /^Command failed$/, 'вернулось прежнее пустое сообщение');
  } finally {
    server.close();
  }
});

test('подсказка не повторяется дважды в одной строке', async () => {
  // Часть кодов (AUTHENTICATIONFAILED) объясняет и разбор ответа сервера.
  // Две одинаковые фразы подряд — шум, из-за которого не дочитывают до
  // ответа сервера, а он там и есть самое ценное.
  const { port, server } = await imapThatRefusesLogin();
  try {
    const text = await runAgainst(port, 'source');
    const hits = text.match(/логин или пароль/g) ?? [];
    assert.equal(hits.length, 1, `подсказка повторена ${String(hits.length)} раза: ${text}`);
  } finally {
    server.close();
  }
});

test('закрытый порт назван отказом соединения, а не «Command failed»', async () => {
  const report = await migrateMailbox({
    // Порт 1 на петле заведомо никем не занят
    source: { host: '127.0.0.1', port: 1, user: 'kto@example.org', pass: 'x' },
    dest: { host: '127.0.0.1', port: 1, user: 'kuda@example.org', pass: 'x' },
  });
  const text = report.error ?? '';
  assert.match(text, /Не удалось подключиться к исходному серверу/, text);
  assert.match(text, /порт|соединени/i, `причина не названа: ${text}`);
});
