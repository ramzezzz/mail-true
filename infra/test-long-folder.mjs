/**
 * Живая проверка: длинные имена папок, кодировка тела и выход из ящика.
 *
 * Что закрепляется:
 *
 * 1. Папка с длинным русским названием не должна быть ловушкой. Раньше была:
 *    идентификатор папки несёт в себе её путь, кодирование удлиняет путь в
 *    1,34 раза, русская буква занимает два байта — и на 37 буквах
 *    идентификатор перерастал предел маршрутизатора. Список писем в такой
 *    папке открывался, а письмо нельзя было ни прочитать, ни пометить, ни
 *    ВЫНЕСТИ ОБРАТНО. Папку тоже нельзя было ни переименовать, ни удалить.
 *
 * 2. Слишком длинное название всё же отвергается — но внятно, до создания
 *    папки, а не после потери письма.
 *
 * 3. Тело не в кодировке UTF-8 отвергается сообщением, называющим кодировку.
 *    Прежний текст говорил только про длину и уводил разбирающегося не туда.
 *
 * 4. Выход из ящика действительно прекращает сессию. Раньше запрос выхода
 *    отвергался сервером, ошибка глоталась, показывался экран входа — а
 *    сессия продолжала действовать. На общем компьютере это значит, что
 *    почта остаётся доступна следующему.
 *
 * Запросы шлются ровно так, как их шлёт браузер: выход — без тела.
 *
 * Запуск:  node infra/test-long-folder.mjs
 * Нужен поднятый стенд и показательный ящик (docs/manual/seed-demo.sh).
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:8080';
const MAIL = process.env.TEST_EMAIL ?? 'demo@mail.local';
const PASS = process.env.TEST_PASSWORD ?? 'demo12345';

let cookie = '';
let ok = 0;
let bad = 0;
const pass = (m) => { console.log(`  [OK] ${m}`); ok++; };
const fail = (m) => { console.log(`  [ПЛОХО] ${m}`); bad++; };

async function req(path, init = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

const json = (path, method, payload) =>
  req(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

console.log('=== вход ===');
const login = await json('/api/auth/login', 'POST', { email: MAIL, password: PASS });
if (login.status !== 200) { console.log('вход не удался', login); process.exit(1); }
pass('вошли');

console.log('\n=== 1. Папка с длинным русским названием ===');
// 37 русских букв — прежний порог, за которым папка становилась ловушкой.
// Сплошная кириллица: по два байта на букву — так порог достигается на том
// же числе букв, что человек и напишет в названии папки.
const LONG = 'Договорысподрядчикаминадветысячидвадцатьшестойгод';
console.log(`  название: «${LONG}» (${LONG.length} букв, ${Buffer.byteLength(LONG)} байт)`);

const created = await json('/api/folders', 'POST', { name: LONG, parentId: null });
if (created.status !== 200) { fail(`папка не создалась: ${JSON.stringify(created.body)}`); }
else {
  const folderId = created.body.id;
  console.log(`  идентификатор: ${folderId.length} символов`);
  if (folderId.length > 100) pass('идентификатор длиннее прежнего предела в сто символов');

  // Кладём письмо в эту папку, перенеся из «Входящих»
  const list = await req('/api/messages?folderId=inbox&limit=1');
  const msgId = list.body.items?.[0]?.id;
  if (!msgId) fail('нет письма для переноса');
  else {
    const moved = await json('/api/messages/move', 'POST', { ids: [msgId], targetFolderId: folderId });
    moved.status === 200 ? pass('письмо перенесено в длинную папку') : fail(`перенос: ${moved.status} ${JSON.stringify(moved.body)}`);

    const inFolder = await req(`/api/messages?folderId=${encodeURIComponent(folderId)}&limit=5`);
    const moovedId = inFolder.body.items?.[0]?.id;
    if (!moovedId) fail('письмо в папке не видно');
    else {
      console.log(`  идентификатор письма: ${moovedId.length} символов`);

      const opened = await req(`/api/messages/${encodeURIComponent(moovedId)}`);
      opened.status === 200 ? pass('письмо ОТКРЫВАЕТСЯ') : fail(`открыть письмо: ${opened.status} ${JSON.stringify(opened.body)}`);

      const flagged = await json('/api/messages/flags', 'POST', { ids: [moovedId], flagged: true });
      flagged.status === 200 ? pass('письмо помечается') : fail(`пометить: ${flagged.status} ${JSON.stringify(flagged.body)}`);

      const back = await json('/api/messages/move', 'POST', { ids: [moovedId], targetFolderId: 'inbox' });
      back.status === 200 ? pass('письмо ВЫНОСИТСЯ обратно — главное, чего раньше было нельзя')
                          : fail(`вынести обратно: ${back.status} ${JSON.stringify(back.body)}`);
    }
  }

  const renamed = await json(`/api/folders/${encodeURIComponent(folderId)}`, 'PATCH', {
    name: LONG + ' году',
  });
  renamed.status === 200 ? pass('папка переименовывается') : fail(`переименовать: ${renamed.status} ${JSON.stringify(renamed.body)}`);

  const finalId = renamed.status === 200 ? renamed.body.id : folderId;
  const removed = await req(`/api/folders/${encodeURIComponent(finalId)}`, { method: 'DELETE' });
  [200, 204].includes(removed.status) ? pass('папка удаляется') : fail(`удалить: ${removed.status} ${JSON.stringify(removed.body)}`);
}

console.log('\n=== 2. Слишком длинное название всё же отвергается, и внятно ===');
const tooLong = 'я'.repeat(200); // 400 байт при пределе 255
const rejected = await json('/api/folders', 'POST', { name: tooLong, parentId: null });
if (rejected.status === 400 && /байт/.test(String(rejected.body.message))) {
  pass(`отказ по-русски: «${String(rejected.body.message).slice(0, 90)}…»`);
} else {
  fail(`ожидался внятный отказ, получено ${rejected.status}: ${JSON.stringify(rejected.body).slice(0, 160)}`);
}

console.log('\n=== 3. Тело не в UTF-8: сообщение называет кодировку ===');
const badBytes = Buffer.concat([
  Buffer.from('{"name":"'),
  Buffer.from([0xe4]), // «д» в однобайтовой кодировке — недопустимый байт в UTF-8
  Buffer.from('","parentId":null}'),
]);
const r = await fetch(API + '/api/folders', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: badBytes,
});
const msg = String((await r.json()).message ?? '');
if (/UTF-8/.test(msg)) pass(`сообщение называет кодировку: «${msg}»`);
else fail(`сообщение по-прежнему уводит не туда: «${msg}»`);

console.log('\n=== 4. Выход из ящика действительно выходит ===');
const before = await req('/api/auth/session');
if (before.body.authenticated !== true) fail('сессии не было до выхода');
else pass('до выхода сессия есть');

// Ровно так, как шлёт браузер: без тела
const out = await req('/api/auth/logout', { method: 'POST' });
out.status === 200 ? pass('выход принят сервером') : fail(`выход: ${out.status} ${JSON.stringify(out.body)}`);

const after = await req('/api/auth/session');
// Договор (docs/api.md) обещает {authenticated, email}; фактически при
// отсутствии сессии приходит 401. Для этой проверки важно одно: сессия
// больше не действует. Расхождение с договором отмечено отдельно.
if (after.body.authenticated === false || after.status === 401) {
  pass(`после выхода сессия НЕДЕЙСТВИТЕЛЬНА (ответ ${after.status})`);
  if (after.status === 401) {
    console.log('  [!] договор обещает {authenticated:false}, приходит 401 — расхождение');
  }
} else {
  fail(`после выхода сессия жива: ${JSON.stringify(after.body)}`);
}

const mail = await req('/api/messages?folderId=inbox&limit=1');
mail.status === 401 ? pass('почта после выхода не отдаётся') : fail(`почта отдаётся после выхода: ${mail.status}`);

console.log(`\n=== ИТОГ: хорошо ${ok}, плохо ${bad} ===`);
process.exit(bad === 0 ? 0 : 1);
