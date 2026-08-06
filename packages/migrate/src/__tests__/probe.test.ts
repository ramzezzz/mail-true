/**
 * Проверка связи ДО начала переноса.
 *
 * Перенос запускают на ночь. Опечатка в имени сервера, закрытый порт или
 * непринятый сертификат обнаруживались только тогда, когда задание вставало
 * на первом же ящике, — то есть утром, потеряв ночь. Проверка стоит секунду
 * и обязана отвечать словами: «связь есть, папок 12, писем 3400» или
 * «имя сервера не разрешается».
 *
 * На старом коде падают все проверки: функции probeEndpoint не существовало.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { probeEndpoint } from '../probe.js';

/** Поддельный IMAP: пускает всех, отдаёт две папки и числа писем. */
function imapOk(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] proba ready.\r\n');
      socket.on('data', (chunk) => {
        const line = chunk.toString('utf8');
        const tag = /^(\S+)/.exec(line)?.[1] ?? 'a1';
        if (/\bLIST\b/i.test(line)) {
          socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
          socket.write('* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n');
          socket.write('* LIST (\\Noselect \\HasChildren) "/" "Public"\r\n');
          socket.write(`${tag} OK done\r\n`);
        } else if (/\bSTATUS\b/i.test(line)) {
          const path = /STATUS\s+"?([^"\s]+)"?/i.exec(line)?.[1] ?? 'INBOX';
          socket.write(`* STATUS "${path}" (MESSAGES ${path === 'INBOX' ? '10' : '5'})\r\n`);
          socket.write(`${tag} OK done\r\n`);
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

test('связь есть: сказано сколько папок и сколько писем', async () => {
  const { port, server } = await imapOk();
  try {
    const result = await probeEndpoint({ host: '127.0.0.1', port, user: 'kto@x', pass: 'y' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.folders, 3, 'папки считаются все, включая \\Noselect');
    // Носелект-папку открыть нельзя, письма по ней не считаются: 10 + 5
    assert.equal(result.messages, 15, 'письма посчитаны по открываемым папкам');
    assert.equal(result.error, undefined, 'при успехе объяснения отказа быть не должно');
  } finally {
    server.close();
  }
});

test('неразрешимое имя названо неразрешимым именем', async () => {
  const result = await probeEndpoint({
    host: 'takogo-imeni-net.invalid',
    port: 143,
    user: 'kto@x',
    pass: 'y',
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /имя сервера не разрешается|ENOTFOUND/);
});

test('закрытый порт назван отказом в соединении, а не «ошибкой»', async () => {
  const result = await probeEndpoint({ host: '127.0.0.1', port: 1, user: 'kto@x', pass: 'y' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /отказал в соединении|порт/i);
  assert.doesNotMatch(result.error ?? '', /^Command failed$/);
});

test('проверка не бросает: отказ — это результат, а не авария', async () => {
  // Иначе маршрут API отдавал бы 500 вместо внятного «вот что не так».
  const result = await probeEndpoint({ host: '127.0.0.1', port: 1, user: 'kto@x', pass: 'y' });
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(result.loginName, 'kto@x', 'даже при отказе видно, под каким именем входили');
});
