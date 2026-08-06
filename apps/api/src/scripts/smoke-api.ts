/**
 * Интеграционная проверка HTTP API (сервер должен быть запущен):
 * вход -> сессия -> папки -> отправка себе -> появление во Входящих -> чтение.
 *
 * Запуск: node dist/scripts/smoke-api.js
 * Переменные: API_URL (по умолчанию http://127.0.0.1:3001),
 *             SMOKE_EMAIL / SMOKE_PASSWORD (test@mail.local / test12345)
 */
const API = process.env['API_URL'] ?? 'http://127.0.0.1:3001';
const email = process.env['SMOKE_EMAIL'] ?? 'test@mail.local';
const password = process.env['SMOKE_PASSWORD'] ?? 'test12345';

let cookie = '';
let failed = false;

function step(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed = true;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const first = setCookie.split(';')[0];
    if (first) cookie = first;
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* пустой ответ */
  }
  return { status: res.status, json };
}

async function main(): Promise<void> {
  const marker = `api-smoke-${Date.now()}`;

  const health = await call('GET', '/healthz');
  step('healthz', health.status === 200);

  const noAuth = await call('GET', '/api/account');
  step('без сессии — 401', noAuth.status === 401, `status=${noAuth.status}`);

  const badLogin = await call('POST', '/api/auth/login', { email, password: 'wrong-password' });
  step('вход с неверным паролем — 401', badLogin.status === 401, `status=${badLogin.status}`);

  const login = await call('POST', '/api/auth/login', { email, password });
  step('вход', login.status === 200 && login.json?.ok === true, JSON.stringify(login.json));

  const session = await call('GET', '/api/auth/session');
  step('сессия жива', session.status === 200 && session.json?.email === email);

  const account = await call('GET', '/api/account');
  step(
    'аккаунт',
    account.status === 200 && account.json?.email === email,
    `quota=${account.json?.quotaUsedBytes}/${account.json?.quotaLimitBytes}`,
  );

  const folders = await call('GET', '/api/folders');
  const folderList: Array<{ id: string; path: string; role: string }> = folders.json?.folders ?? [];
  step(
    'папки',
    folders.status === 200 && folderList.some((f) => f.id === 'inbox'),
    folderList.map((f) => `${f.id}(${f.path})`).join(', '),
  );

  const send = await call('POST', '/api/messages/send', {
    to: [{ name: null, address: email }],
    cc: [],
    bcc: [],
    subject: `Проверка API ${marker}`,
    bodyHtml: `<p>Письмо через API: <b>${marker}</b></p><script>alert(1)</script>`,
    attachmentIds: [],
  });
  step(
    'отправка письма себе',
    send.status === 200 && send.json?.ok === true,
    JSON.stringify(send.json),
  );

  // Ждём появления во Входящих
  let msgId: string | null = null;
  for (let i = 0; i < 30 && !msgId; i += 1) {
    const list = await call(
      'GET',
      `/api/messages?folderId=inbox&limit=10&search=${encodeURIComponent(marker)}`,
    );
    const items: Array<{ id: string; subject: string }> = list.json?.items ?? [];
    const hit = items.find((m) => m.subject.includes(marker));
    if (hit) {
      msgId = hit.id;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  step('письмо появилось во Входящих', msgId !== null, msgId ?? 'не найдено за 30 с');

  if (msgId) {
    const msg = await call('GET', `/api/messages/${encodeURIComponent(msgId)}`);
    const html: string = msg.json?.bodyHtml ?? '';
    step(
      'чтение письма',
      msg.status === 200 && html.includes(marker),
      `subject=${msg.json?.subject}`,
    );
    step('санитизация при чтении', !html.includes('<script'), 'script отсутствует в bodyHtml');

    const flag = await call('POST', '/api/messages/flags', { ids: [msgId], flagged: true });
    step('флаг «важное»', flag.status === 200 && flag.json?.updated === 1);

    const copyInSent = await call(
      'GET',
      `/api/messages?folderId=sent&limit=10&search=${encodeURIComponent(marker)}`,
    );
    const sentItems: Array<{ subject: string }> = copyInSent.json?.items ?? [];
    step(
      'копия в Отправленных',
      sentItems.some((m) => m.subject.includes(marker)),
    );

    const move = await call('POST', '/api/messages/move', {
      ids: [msgId],
      targetFolderId: 'archive',
    });
    step(
      'перемещение в архив',
      move.status === 200 && move.json?.moved === 1,
      JSON.stringify(move.json),
    );
  }

  const draft = await call('POST', '/api/drafts', {
    to: [{ name: null, address: email }],
    cc: [],
    bcc: [],
    subject: `Черновик ${marker}`,
    bodyHtml: '<p>черновик</p>',
    attachmentIds: [],
  });
  step(
    'сохранение черновика',
    draft.status === 200 && Boolean(draft.json?.draftUid),
    JSON.stringify(draft.json),
  );

  const logout = await call('POST', '/api/auth/logout');
  step('выход', logout.status === 200);
  const afterLogout = await call('GET', '/api/account');
  step('после выхода — 401', afterLogout.status === 401, `status=${afterLogout.status}`);

  console.log(failed ? '\nЕсть проваленные проверки.' : '\nВсе проверки пройдены.');
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
