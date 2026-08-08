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
 * Мастер первого запуска живёт отдельной службой под профилем `installer` и
 * на боевом сервере выключается сам после установки. Поэтому его снимки
 * делаются, только если стенд с ним поднят и в SHOT_INSTALLER_KEY положен
 * ключ доступа из журнала контейнера, — иначе они пропускаются, а остальные
 * снимаются как обычно. Класть ключ в файл нельзя: он одноразовый и в
 * продукте намеренно нигде не сохраняется.
 */
const INSTALLER = process.env.INSTALLER_URL ?? 'http://127.0.0.1:8099';
const INSTALLER_KEY = process.env.SHOT_INSTALLER_KEY ?? '';
/** Домен, на который составляется показательный план смены домена. */
const SHOT_NEW_DOMAIN = process.env.SHOT_NEW_DOMAIN ?? 'example.ru';
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

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

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
  return login(
    `${WEB}/api/admin/auth/login`,
    { login: ADM_LOGIN, password: ADM_PASS },
    {
      host: ADMIN_HOST,
    },
  );
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

async function shoot(chrome, { name, url, wait, act, settle = 1200, hide = [], viewport }) {
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
  /*
   * Часть экранов не открывается по адресу: диалог перезапуска висит над
   * страницей, а шаг мастера достигается только после предыдущих. Такие
   * снимки доводят страницу до нужного состояния своим кодом — нажатиями
   * по тем же кнопкам, что нажал бы человек. Ни один из этих сценариев не
   * доходит до подтверждающей кнопки: снимок нужен именно с вопросом на
   * экране, а не с последствиями ответа.
   */
  if (act) {
    const { result, exceptionDetails } = await chrome.send('Runtime.evaluate', {
      expression: act,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(
        `${name}: ${exceptionDetails.exception?.description ?? 'сценарий не прошёл'}`,
      );
    }
    if (result?.value === false)
      throw new Error(`${name}: сценарий не довёл экран до нужного вида`);
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

/**
 * Начало сценариев `act`. Код выполняется внутри страницы, поэтому ничего
 * из этого файла ему не видно, и мелкие помощники приходится приносить с
 * собой. `till` ждёт условия, а не спит фиксированное время: страница
 * ходит на сервер, и «подождать секунду» — это либо лишняя секунда на
 * каждом снимке, либо мигающий снимок в неудачный день.
 */
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const till = async (fn, what) => {
    for (let i = 0; i < 160; i++) {
      const value = fn();
      if (value) return value;
      await sleep(250);
    }
    throw new Error('не дождались: ' + what);
  };
`;

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
  // Возможности, появившиеся после первой сборки руководства. Порядок
  // номеров продолжает прежний: снимки подставляются в главы по имени, и
  // перенумеровать старые значило бы переписать половину ссылок в тексте.
  { name: '20-templates', url: `${WEB}/settings/templates`, wait: 'main' },
  { name: '21-access-log', url: `${WEB}/settings/access-log`, wait: 'main' },
  { name: '22-export', url: `${WEB}/settings/export`, wait: 'main' },
  { name: '23-recovery', url: `${WEB}/settings/recovery`, wait: 'main' },
  { name: '24-labels', url: `${WEB}/settings/labels`, wait: 'main' },
  // Поиск снимается с настоящим запросом: пустая страница поиска показывает
  // только подсказку, а объяснять надо как раз разбор запроса на условия.
  {
    name: '25-search',
    url: `${WEB}/search/?q=${encodeURIComponent('от:волкова')}`,
    wait: 'main',
  },
  { name: '28-disposable', url: `${WEB}/settings/disposable`, wait: 'main' },
  { name: '29-muted', url: `${WEB}/muted/`, wait: 'main' },
  { name: '30-awaiting', url: `${WEB}/sent/`, wait: 'main' },
  { name: '26-admin-spam', url: `${ADMIN}/spam`, wait: 'main', admin: true },
  { name: '27-admin-monitoring', url: `${ADMIN}/monitoring`, wait: 'main', admin: true },

  /* --- Мастер первого запуска в браузере -------------------------- */
  // Снимается только при поднятом стенде установщика (см. INSTALLER_KEY).
  {
    name: '31-installer-key',
    url: `${INSTALLER}/`,
    wait: '#key-input',
    installer: true,
    auth: false,
  },
  {
    name: '32-installer-checks',
    url: `${INSTALLER}/`,
    wait: '.rail',
    installer: true,
    // Проверки система запускает сама при входе; ждём, пока они кончатся.
    act: `(async () => {${HELPERS}
      await till(() => document.querySelector('.check'), 'результаты проверок');
      await till(() => {
        const next = document.querySelector('.btn--main');
        return next && !next.disabled;
      }, 'окончание проверок');
      return true;
    })()`,
  },
  {
    name: '33-installer-tls',
    url: `${INSTALLER}/`,
    wait: '.rail',
    settle: 1800,
    installer: true,
    /*
     * Шаг «Сертификат» — четвёртый, и открыть его по адресу нельзя: мастер
     * держит ответы в памяти вкладки. Проходим три шага так же, как прошёл
     * бы человек. Домен здесь показательный: снимок делается на стенде, где
     * настоящего имени нет, и выдуманное честнее чужого.
     */
    act: `(async () => {${HELPERS}
      const next = () => document.querySelector('.btn--main');
      const title = () => document.querySelector('.card h1')?.textContent.trim();
      const fields = () => document.querySelectorAll('.card .field input');
      const set = (node, value) => {
        node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
      };

      await till(() => next() && !next().disabled, 'окончание проверок системы');
      next().click();

      await till(() => title() === 'Домен', 'шаг «Домен»');
      const domain = fields();
      set(domain[0], ${JSON.stringify(SHOT_NEW_DOMAIN)});
      set(domain[1], 'mail.' + ${JSON.stringify(SHOT_NEW_DOMAIN)});
      next().click();

      await till(() => title() === 'Администратор', 'шаг «Администратор»');
      const admin = fields();
      set(admin[2], 'Parol-tolko-dlya-snimka-2026');
      set(admin[3], 'Parol-tolko-dlya-snimka-2026');
      next().click();

      await till(() => title() === 'Сертификат', 'шаг «Сертификат»');
      // Мастер сам проверяет, годится ли имя для Let's Encrypt: ждём ответа.
      await till(() => document.querySelector('.check'), 'проверку имени сервера');
      return true;
    })()`,
  },

  /* --- Настройки сервера, перезапуск, сертификат, смена домена ----- */
  { name: '34-admin-server-settings', url: `${ADMIN}/server-settings`, wait: 'main', admin: true },
  {
    name: '35-admin-restart',
    url: `${ADMIN}/server-settings`,
    wait: 'main',
    admin: true,
    /*
     * Диалог перезапуска: он и есть то место, где написано, что перестанет
     * работать. Открываем его у сервера приложения — его перезапуск не
     * требует посредника, поэтому на стенде диалог виден целиком, а не в
     * виде отказа «из панели сейчас нельзя». Подтверждение не нажимается.
     */
    act: `(async () => {${HELPERS}
      const button = await till(
        () => document.querySelector('button[aria-label^="Перезапустить: сервер приложения"]'),
        'кнопку перезапуска сервера приложения',
      );
      button.scrollIntoView({ block: 'center' });
      button.click();
      await till(() => document.querySelector('[role="dialog"]'), 'диалог перезапуска');
      return true;
    })()`,
  },
  {
    name: '36-admin-tls',
    url: `${ADMIN}/tls`,
    wait: 'main',
    admin: true,
    /*
     * Прокручиваем к выпуску Let's Encrypt.
     *
     * Верх страницы — «что стоит сейчас», и он одинаков во всех
     * установках. Новизна раздела в другом: сертификат теперь
     * выпускается кнопкой отсюда, и руководство про это пишет. Снимок,
     * на котором этой кнопки не видно, спорил бы с текстом рядом.
     */
    act: `(async () => {${HELPERS}
      const heading = await till(
        () => [...document.querySelectorAll('h2, h3')].find((h) => /Let's Encrypt|Lets Encrypt/i.test(h.textContent || '')),
        'заголовок выпуска Let\\'s Encrypt',
      );
      heading.scrollIntoView({ block: 'start' });
      return true;
    })()`,
  },
  { name: '37-admin-domain-change', url: `${ADMIN}/domain-change`, wait: 'main', admin: true },
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

/**
 * Снимки мастера первого запуска.
 *
 * Мастер живёт отдельной службой под профилем `installer`, поэтому на стенде
 * его надо поднять руками, а ключ доступа взять из журнала контейнера (см.
 * README). Если ключа нет — снимки пропускаются, а не роняют сборку: на
 * установленном сервере мастер выключен намеренно, и это нормальное
 * состояние, а не поломка.
 */
async function shootInstaller(chrome) {
  const shots = SHOTS.filter((s) => s.installer);
  if (!INSTALLER_KEY) {
    console.log(`  (пропущено: ${shots.length} снимка мастера — не задан SHOT_INSTALLER_KEY)`);
    return;
  }

  // Экран ввода ключа снимается ДО того, как ключ положен во вкладку: с
  // ключом мастер уходит на первый шаг и форму ввода больше не показывает.
  for (const shot of shots.filter((s) => s.auth === false)) {
    await shoot(chrome, shot);
  }

  // Ключ живёт в sessionStorage вкладки — так же, как после ввода руками.
  await chrome.send('Page.navigate', { url: `${INSTALLER}/` });
  await waitFor(async () => {
    const { result } = await chrome.send('Runtime.evaluate', {
      expression: `!!document.getElementById('key-input')`,
      returnByValue: true,
    });
    return result.value === true;
  }, 'мастер первого запуска не открылся');
  await chrome.send('Runtime.evaluate', {
    expression: `sessionStorage.setItem('mailtrue.installer.key', ${JSON.stringify(INSTALLER_KEY)})`,
  });

  for (const shot of shots.filter((s) => s.auth !== false)) {
    await shoot(chrome, shot);
  }
}

/**
 * Показательный план смены домена — на время снимков и не дольше.
 *
 * Пустая страница «Смены домена» показывает одно поле ввода, тогда как
 * объяснять надо ровно то, что появляется после расчёта: что переедет, что
 * перестанет работать у людей и где точка невозврата. План при этом ничего
 * не меняет на сервере (он только считает и выпускает ключ DKIM), а по
 * окончании снимается — иначе стенд остался бы с чужим заданием, и
 * следующий запуск отказался бы составлять новый план.
 */
async function withDomainChangePlan(cookieHeader, body) {
  const headers = { 'content-type': 'application/json', cookie: cookieHeader, host: ADMIN_HOST };
  const url = `${WEB}/api/admin/domain-change`;
  let planned = null;

  const created = await fetch(`${url}/plan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ newDomain: SHOT_NEW_DOMAIN }),
  });
  if (created.ok) {
    planned = (await created.json()).id;
    console.log(`показательный план смены домена: → ${SHOT_NEW_DOMAIN}`);
  } else {
    console.log(
      `план смены домена не составился (${created.status}) — снимок будет с пустой формой`,
    );
  }

  try {
    await body();
  } finally {
    if (planned !== null) {
      // Тело обязательно: без него fastify отвечает «Пустое тело запроса».
      const dropped = await fetch(`${url}/${planned}`, { method: 'DELETE', headers, body: '{}' });
      console.log(dropped.ok ? 'план смены домена отменён' : `план НЕ отменён: ${dropped.status}`);
    }
  }
}

/**
 * Что снимать в этот раз.
 *
 * Без аргументов — весь набор, как раньше. С аргументами снимается только
 * названное: `node docs/manual/shoot.mjs 26-admin-spam 27-admin-monitoring`.
 *
 * Нужно потому, что пересъёмка ОДНОГО экрана — самая частая работа с этим
 * скриптом: поправили раздел, надо обновить его снимок. Полный прогон ради
 * этого стоит нескольких минут, гоняет браузер по двум десяткам страниц и
 * заодно составляет на стенде показательный план смены домена. Последнее
 * особенно неуместно, когда снимаешь один экран антиспама.
 */
const ONLY = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const wanted = (shot) => ONLY.length === 0 || ONLY.includes(shot.name);

async function main() {
  if (ONLY.length > 0) {
    const unknown = ONLY.filter((name) => !SHOTS.some((s) => s.name === name));
    if (unknown.length > 0) {
      // Опечатка в имени иначе выглядит как «снимок не обновился»: скрипт
      // отработал бы вхолостую и молча сообщил об успехе.
      console.error(`нет таких снимков: ${unknown.join(', ')}`);
      process.exit(1);
    }
    console.log(`снимаем только: ${ONLY.join(', ')}`);
  }
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
    for (const shot of SHOTS.filter((s) => s.auth === false && !s.installer && wanted(s))) {
      await shoot(chrome, shot);
    }

    await shootInstaller(chrome);

    const cookies = await sessionCookies();
    for (const c of cookies) {
      await chrome.send('Network.setCookie', { ...c, domain: '127.0.0.1', path: '/' });
    }
    console.log(`вход выполнен: ${MAIL}`);

    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const messageUrl = await firstMessageUrl(cookieHeader);

    for (const shot of SHOTS.filter((s) => s.auth !== false && !s.admin && !s.installer && wanted(s))) {
      await shoot(chrome, { ...shot, url: shot.url === 'ПЕРВОЕ_ПИСЬМО' ? messageUrl : shot.url });
    }

    // Админка — отдельная сессия на своём имени хоста. Cookie почты ей не
    // подходит и наоборот: разделение сессий здесь намеренное.
    const admin = await adminCookies();
    for (const c of admin) {
      await chrome.send('Network.setCookie', { ...c, domain: ADMIN_HOST, path: '/' });
    }
    console.log(`вход в админку: ${ADM_LOGIN}`);

    const adminHeader = admin.map((c) => `${c.name}=${c.value}`).join('; ');
    const takeAdminShots = async () => {
      for (const shot of SHOTS.filter((s) => s.admin && wanted(s))) {
        await shoot(chrome, shot);
      }
    };
    /*
     * Показательный план смены домена составляется, только если снимок
     * смены домена в этот раз действительно снимается.
     *
     * Он изменяет состояние стенда: заводит задание и выпускает ключ DKIM.
     * Делать это ради снимка антиспама неуместно, а на стенде, где уже
     * есть чужое задание, план вообще не составится — и в журнале появится
     * непонятная строка про отказ.
     */
    if (wanted({ name: '37-admin-domain-change' })) {
      await withDomainChangePlan(adminHeader, takeAdminShots);
    } else {
      await takeAdminShots();
    }
  } finally {
    chrome.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
  console.log(`\nснимки в ${OUT}`);
}

await main();
