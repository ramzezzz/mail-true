/**
 * Живая проверка: список писем показывает только что пришедшее письмо.
 *
 * Что закрепляется. Соединение с почтовым сервером берётся из пула и живёт
 * между запросами с уже выбранной папкой. Поиск по такой папке идёт по
 * индексу, а новые письма индекс подхватывает не сразу. Из-за этого список
 * отставал ровно на одно письмо: счётчик непрочитанных рос, а самого письма
 * в списке не было, пока человек не перезагрузит страницу.
 *
 * Симптом был приметный и сам объяснял причину: счётчик считается отдельной
 * командой, которая открывает папку заново и потому всегда свежа, — а список
 * берётся поиском по уже открытой.
 *
 * Лечится командой NOOP перед поиском: она для того в протоколе и есть —
 * просит сервер досказать всё, что накопилось.
 *
 * ВАЖНО про саму проверку. Первая её version опрашивала список раз в секунду
 * — и каждый такой опрос сам заставлял сервер пересмотреть папку. Проверка
 * чинила то, что измеряла, и показывала 1,3 секунды вместо настоящих
 * двадцати. Поэтому здесь делается РОВНО ОДИН запрос — ровно так, как делает
 * браузер, получив событие о новом письме.
 *
 * Запуск:  node infra/test-list-freshness.mjs
 * Нужен поднятый стенд.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const API = process.env.API_URL ?? 'http://127.0.0.1:8080';
const MAIL = process.env.TEST_EMAIL ?? 'demo@mail.local';
const PASS = process.env.TEST_PASSWORD ?? 'demo12345';
const MARK = `FRESH-${Date.now()}`;

let cookie = '';
const req = async (path, init = {}) => {
  const r = await fetch(API + path, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return r.json();
};

const login = await req('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: MAIL, password: PASS }),
});
if (!login.ok && !login.email) {
  console.log(`вход не удался: ${JSON.stringify(login)}`);
  process.exit(1);
}

// Прогрев обязателен: дефект живёт именно в переиспользуемом соединении,
// у которого папка уже выбрана. На свежем соединении его не увидеть.
await req('/api/messages?folderId=inbox&limit=5');
console.log('  пул прогрет: папка «Входящие» выбрана');

const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws`, { headers: { cookie } });
let eventAt = null;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'new-message' && eventAt === null) eventAt = Date.now();
});
await new Promise((resolveOpen, reject) => {
  ws.addEventListener('open', resolveOpen, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

await run(
  'docker',
  [
    'compose',
    '-f',
    'infra/docker-compose.yml',
    'exec',
    '-T',
    'postfix',
    'swaks',
    '--server',
    'postfix:25',
    '--helo',
    'client.example.com',
    '--from',
    'freshness@example.com',
    '--to',
    MAIL,
    '--header',
    `Subject: ${MARK}`,
    '--header',
    'Content-Type: text/plain; charset=UTF-8',
    '--body',
    'проверка свежести списка',
  ],
  { cwd: ROOT },
);
const sent = Date.now();
console.log(`  письмо ${MARK} отправлено`);

for (let i = 0; i < 80 && eventAt === null; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
}
ws.close();

if (eventAt === null) {
  console.log('  [FAIL] событие о новом письме не пришло за 40 секунд');
  process.exit(1);
}
console.log(`  событие пришло через ${((eventAt - sent) / 1000).toFixed(1)} с`);

// Единственный запрос — ровно как делает браузер по событию
const page = await req('/api/messages?folderId=inbox&limit=10');
const found = (page.items ?? []).some((m) => m.subject?.includes(MARK));

if (found) {
  console.log('  [OK] список по событию показывает новое письмо');
  process.exit(0);
}

console.log('  [FAIL] список по событию НЕ показывает новое письмо —');
console.log('         значит, человек его не увидит до перезагрузки страницы');
process.exit(1);
