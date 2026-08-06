/**
 * Снимки экрана для инструкции.
 *
 * Управляет обычным Chrome по протоколу отладки. Зависимостей нет: в Node 24
 * есть встроенный клиент WebSocket, а больше для этого ничего не нужно.
 * Ставить Playwright ради десятка снимков в сборку инструкции незачем — это
 * лишние полгигабайта в окружении, которое собирает документацию.
 *
 * Вход в ящик делается настоящим запросом к API, а cookie переносится в
 * браузер. Через форму входа было бы нагляднее, но снимок формы всё равно
 * делается отдельно, а прогонять форму перед каждым снимком — это лишние
 * секунды и лишний повод для мигания.
 *
 * Запуск:  node docs/manual/shoot.mjs
 * Итог:    docs/manual/img/*.png
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'img');

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:8080';
/*
 * Админка живёт на отдельном виртуальном хосте (`admin.<домен>`), а не на
 * отдельном порту: так же она будет стоять и на боевом сервере. Чтобы снять
 * её локально, имя подменяется на адрес стенда флагом браузера ниже — иначе
 * пришлось бы править файл hosts машины, собирающей документацию.
 */
const ADMIN_HOST = process.env.ADMIN_HOST ?? 'admin.mail.local';
const ADMIN = `http://${ADMIN_HOST}`;
const STAND = process.env.STAND_ADDR ?? '127.0.0.1:8080';
/*
 * Снимки делаются с ОТДЕЛЬНОГО показательного ящика (docs/manual/seed-demo.sh),
 * а не с тестового. Тестовый забит служебными письмами вида
 * «outbound t178592812012296», и на картинках в руководстве это выглядит так,
 * будто продукт ими и занимается.
 */
const MAIL = process.env.SHOT_EMAIL ?? 'demo@mail.local';
const PASS = process.env.SHOT_PASSWORD ?? 'demo12345';

/*
 * Отдельная учётная запись администратора только для снимков: пароль
 * администратора стенда неизвестен и не должен попадать в сборку документации.
 * Заводится вручную, см. docs/manual/README.md.
 */
const ADM_LOGIN = process.env.SHOT_ADMIN_LOGIN ?? 'rukovodstvo';
const ADM_PASS = process.env.SHOT_ADMIN_PASSWORD ?? 'manual12345';

const CHROME =
  process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const VIEWPORT = { width: 1440, height: 900 };

/* ---------------------------------------------------------------- */
/* Протокол отладки: минимальный клиент                              */
/* ---------------------------------------------------------------- */

class Chrome {
  #ws;
  #next = 1;
  #waiting = new Map();
  #events = new Map();

  static async launch(profileDir) {
    const port = 9333;
    const proc = spawn(
      CHROME,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        // Локальный стенд ходит по http и самоподписанным сертификатам:
        // ругань на них здесь не помогает, а снимок портит.
        '--ignore-certificate-errors',
        '--no-first-run',
        '--no-default-browser-check',
        `--host-resolver-rules=MAP ${ADMIN_HOST} ${STAND}`,
        '--disable-gpu',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    const target = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
      if (!r?.ok) return null;
      const list = await r.json();
      return list.find((t) => t.type === 'page') ?? null;
    }, 'браузер не поднялся');

    const chrome = new Chrome();
    await chrome.#connect(target.webSocketDebuggerUrl);
    chrome.proc = proc;
    return chrome;
  }

  async #connect(url) {
    this.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', resolve, { once: true });
      this.#ws.addEventListener('error', reject, { once: true });
    });
    this.#ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id) {
        const pending = this.#waiting.get(msg.id);
        this.#waiting.delete(msg.id);
        if (!pending) return;
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
        return;
      }
      const handlers = this.#events.get(msg.method);
      if (handlers) for (const h of handlers) h(msg.params);
    });
  }

  send(method, params = {}) {
    const id = this.#next++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#waiting.delete(id)) reject(new Error(`нет ответа на ${method}`));
      }, 30_000);
    });
  }

  on(method, handler) {
    if (!this.#events.has(method)) this.#events.set(method, []);
    this.#events.get(method).push(handler);
  }

  close() {
    this.#ws?.close();
    this.proc?.kill();
  }
}

async function waitFor(probe, message, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(message);
}

/* ---------------------------------------------------------------- */
/* Вход в ящик: cookie берём у настоящего API                        */
/* ---------------------------------------------------------------- */

async function sessionCookies() {
  return login(`${WEB}/api/auth/login`, { email: MAIL, password: PASS }, {});
}

/** Вход в админку: она отвечает на том же адресе, но на своём имени хоста. */
async function adminCookies() {
  return login(`${WEB}/api/admin/auth/login`, { login: ADM_LOGIN, password: ADM_PASS }, {
    host: ADMIN_HOST,
  });
}

async function login(url, body, extraHeaders) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`вход не удался (${url}): ${r.status} ${await r.text()}`);
  const raw = r.headers.getSetCookie?.() ?? [];
  if (!raw.length) throw new Error('сервер не выдал cookie сессии');
  return raw.map((line) => {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
  });
}

/* ---------------------------------------------------------------- */
/* Снимок                                                            */
/* ---------------------------------------------------------------- */

async function shoot(chrome, { name, url, wait, settle = 1200, hide = [], viewport }) {
  // Свой размер окна — для снимков мобильного вида: тот же интерфейс на
  // 390 точках выглядит иначе, и показывать его растянутым на 1440 значит
  // показывать не то, что человек увидит на телефоне.
  if (viewport) {
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      ...viewport,
      deviceScaleFactor: 2,
      mobile: true,
    });
  }
  await chrome.send('Page.navigate', { url });

  // Ждём не «загрузку страницы», а появление того, ради чего снимок:
  // интерфейс дорисовывается после загрузки, и снимок по load показывал бы
  // пустой каркас.
  if (wait) {
    await waitFor(async () => {
      const { result } = await chrome.send('Runtime.evaluate', {
        expression: `!!document.querySelector(${JSON.stringify(wait)})`,
        returnByValue: true,
      });
      return result.value === true;
    }, `не дождались «${wait}» на ${url}`);
  }
  await new Promise((r) => setTimeout(r, settle));

  // Прячем то, что меняется от запуска к запуску: иначе каждая пересборка
  // инструкции даёт другие картинки, и в истории не видно настоящих правок.
  if (hide.length) {
    await chrome.send('Runtime.evaluate', {
      expression: `
        for (const sel of ${JSON.stringify(hide)}) {
          for (const el of document.querySelectorAll(sel)) el.style.visibility = 'hidden';
        }
      `,
    });
  }

  const { data } = await chrome.send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `${name}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  console.log(`  ${name}.png`);

  // Свой размер окна не должен утечь в следующий снимок: иначе один
  // мобильный кадр перекашивает всё, что снимается после него.
  if (viewport) {
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      ...VIEWPORT,
      deviceScaleFactor: 2,
      mobile: false,
    });
  }
}

/* ---------------------------------------------------------------- */

const SHOTS = [
  { name: '01-login', url: `${WEB}/login`, wait: 'input[type="password"]', auth: false },
  { name: '07-admin-login', url: `${ADMIN}/`, wait: 'input[type="password"]', auth: false },
  { name: '02-inbox', url: `${WEB}/inbox`, wait: 'main' },
  { name: '03-message', url: 'ПЕРВОЕ_ПИСЬМО', wait: 'main' },
  { name: '04-settings', url: `${WEB}/settings`, wait: 'main' },
  { name: '05-filters', url: `${WEB}/settings/filters`, wait: 'main' },
  { name: '06-collectors', url: `${WEB}/settings/collector`, wait: 'main' },
  { name: '08-compose', url: `${WEB}/compose`, wait: 'main' },
  { name: '09-admin-users', url: `${ADMIN}/users`, wait: 'main', admin: true },
  { name: '10-admin-domains', url: `${ADMIN}/domains`, wait: 'main', admin: true },
  { name: '11-admin-audit', url: `${ADMIN}/audit`, wait: 'main', admin: true },
  { name: '14-appearance', url: `${WEB}/settings/appearance`, wait: 'main' },
  // Мобильный вид — своим размером окна: тот же экран на 390 точках
  // выглядит иначе, и растянутый на 1440 он показывал бы не то.
  { name: '15-mobile', url: `${WEB}/inbox`, wait: 'main', viewport: { width: 390, height: 780 } },
  { name: '16-notifications', url: `${WEB}/settings/notifications`, wait: 'main' },
  { name: '17-admin-dashboard', url: `${ADMIN}/`, wait: 'main', admin: true },
  { name: '18-admin-migrate', url: `${ADMIN}/migrate`, wait: 'main', admin: true },
  { name: '19-admin-backup', url: `${ADMIN}/backups`, wait: 'main', admin: true },
  { name: '12-admin-flow', url: `${ADMIN}/flow`, wait: 'main', admin: true },
  { name: '13-admin-logs', url: `${ADMIN}/logs`, wait: 'main', admin: true },
];

/**
 * Адрес первого письма во «Входящих». Идентификатор письма несёт в себе путь
 * папки и номер, поэтому его нельзя записать в список снимков заранее — он
 * свой у каждого наполнения ящика.
 */
async function firstMessageUrl(cookieHeader) {
  const r = await fetch(`${WEB}/api/messages?folderId=inbox&limit=1`, {
    headers: { cookie: cookieHeader },
  });
  if (!r.ok) throw new Error(`список писем не отдался: ${r.status}`);
  const page = await r.json();
  // Поле называется items, а не messages: см. docs/api.md.
  const first = page.items?.[0];
  if (!first) throw new Error('во «Входящих» показательного ящика нет писем');
  return `${WEB}/inbox/${encodeURIComponent(first.id)}`;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const profile = join(process.env.TEMP ?? '/tmp', `mailtrue-shots-${process.pid}`);

  const chrome = await Chrome.launch(profile);
  try {
    await chrome.send('Page.enable');
    await chrome.send('Runtime.enable');
    await chrome.send('Network.enable');
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      ...VIEWPORT,
      deviceScaleFactor: 2, // в печати мелкий текст иначе расплывается
      mobile: false,
    });

    // Сначала то, что снимается до входа. Порядок важен: вошедшего продукт
    // уводит с формы входа на «Входящие», и снимок формы получить уже нельзя.
    for (const shot of SHOTS.filter((s) => s.auth === false)) {
      await shoot(chrome, shot);
    }

    const cookies = await sessionCookies();
    for (const c of cookies) {
      await chrome.send('Network.setCookie', { ...c, domain: '127.0.0.1', path: '/' });
    }
    console.log(`вход выполнен: ${MAIL}`);

    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const messageUrl = await firstMessageUrl(cookieHeader);

    for (const shot of SHOTS.filter((s) => s.auth !== false && !s.admin)) {
      await shoot(chrome, { ...shot, url: shot.url === 'ПЕРВОЕ_ПИСЬМО' ? messageUrl : shot.url });
    }

    // Админка — отдельная сессия на своём имени хоста. Cookie почты ей не
    // подходит и наоборот: разделение сессий здесь намеренное.
    for (const c of await adminCookies()) {
      await chrome.send('Network.setCookie', { ...c, domain: ADMIN_HOST, path: '/' });
    }
    console.log(`вход в админку: ${ADM_LOGIN}`);
    for (const shot of SHOTS.filter((s) => s.admin)) {
      await shoot(chrome, shot);
    }
  } finally {
    chrome.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
  console.log(`\nснимки в ${OUT}`);
}

await main();
