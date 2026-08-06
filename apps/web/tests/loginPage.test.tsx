// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Страница входа в почту после переноса нового прототипа: форма, доступность,
 * поведение сцены и те правила стилей, без которых страница уже ломалась.
 *
 * Сцена (вращающаяся сфера, светящиеся шары, дышащие значки) — украшение, и
 * проверяем мы у неё ровно то, что человеку важно: она не заслоняет форму,
 * останавливается по просьбе не двигать картинку и замирает на спрятанной
 * вкладке. Красоту проверками не поймать, а перечисленное — легко.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from '../src/app/session';
import { LoginPage } from '../src/pages/LoginPage';
import { LoginGlobe, MAIL_GLOBE_ICONS } from '../src/pages/login/LoginGlobe';
import { DEFAULT_LOGO_SRC } from '../src/lib/branding';

/**
 * Таблицы стилей читаем текстом с диска: правила ниже — про сам CSS, а
 * импорт модуля стилей отдаёт только имена классов.
 */
const css = (name: string): string =>
  // Путь считаем от корня приложения: в jsdom import.meta.url не файловый.
  readFileSync(`src/pages/${name}`, 'utf8')
    // Концы строк приводим к одному виду: на Windows файл может лежать с
    // CRLF, и поиск по тексту иначе зависел бы от машины.
    .replace(/\r\n/gu, '\n');

const backdrop = css('login/LoginBackdrop.module.css');
const page = css('LoginPage.module.css');

function markup(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SessionProvider>
        <LoginPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

/**
 * Тело блока `@media (...)` — от его начала до следующего `@media`.
 * Вложенных `@media` в этих файлах нет.
 */
function mediaBlock(source: string, head: string): string {
  const at = source.indexOf(head);
  expect(at, `нет блока ${head}`).toBeGreaterThan(-1);
  const rest = source.slice(at);
  const next = rest.indexOf('@media', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('своё оформление входа (OEM)', () => {
  it('логотип показывается, а до ответа сервера — стандартный, а не пустота', () => {
    const html = markup();
    expect(html).toContain('<img');
    expect(html).toContain(`src="${DEFAULT_LOGO_SRC}"`);
    expect(html).toContain('alt="Mail.True"');
  });

  it('адрес логотипа приходит из настроек панели, а не вшит в разметку', () => {
    const source = readFileSync('src/pages/LoginPage.tsx', 'utf8');
    expect(source).toContain('logoSrc(branding)');
    expect(source).toContain('branding.companyName');
    expect(source).not.toContain('src="/brand/logo-full.svg"');
  });
});

describe('форма входа цела', () => {
  const html = markup();

  it('оба поля на месте, у каждого своя подпись', () => {
    expect(html).toContain('id="login-email"');
    expect(html).toContain('id="login-password"');
    expect(html).toContain('for="login-email"');
    expect(html).toContain('for="login-password"');
    expect(html).toContain('Почтовый адрес');
  });

  it('у страницы есть заголовок первого уровня — по нему понятно, куда попал', () => {
    expect(html).toContain('<h1');
    expect(html).toContain('Вход в почту');
  });

  it('кнопка отправляет форму и заперта, пока поля пусты', () => {
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled');
    expect(html).toContain('Войти');
  });

  it('пароль по умолчанию скрыт, а показать его есть чем', () => {
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="Показать пароль"');
  });

  it('украшение не ловит клавиатуру: вся сцена скрыта от чтения с экрана', () => {
    // Ни одного элемента сцены нет в порядке обхода — она вся aria-hidden
    // и не содержит ничего фокусируемого.
    const scene = renderToStaticMarkup(<LoginGlobe />);
    expect(scene.startsWith('<div')).toBe(true);
    expect(scene).toContain('aria-hidden="true"');
    expect(scene).not.toContain('tabindex');
    expect(scene).not.toContain('<button');
    expect(scene).not.toContain('<a ');
  });

  it('видимый фокус рисуется общей рамкой, а не своей выдумкой', () => {
    for (const [line] of page.matchAll(/^\s*outline:.*solid.*$/gmu)) {
      expect(line).toContain('--mt-focus-ring-width');
      expect(line).toContain('--mt-focus-ring-color');
    }
  });
});

describe('сцена: вращение, шары, значки', () => {
  it('сфера наклонена правилом, а не только кадрами анимации', () => {
    // Наклон обязан жить в самом правиле: когда анимацию гасят, остаётся
    // ровно то, что записано правилом. Будь наклон только в кадрах —
    // остановленная сфера завалилась бы плашмя.
    const globe = backdrop.slice(backdrop.indexOf('.globe {'), backdrop.indexOf('.rings {'));
    expect(globe).toContain('transform: rotateX(61deg) rotateY(-16deg)');
    expect(globe).toContain('animation: mtGlobeSpin');
    expect(backdrop).toContain('@keyframes mtGlobeSpin');
  });

  it('шары живут внутри вращающейся сферы, а значки — снаружи', () => {
    const source = readFileSync('src/pages/login/LoginGlobe.tsx', 'utf8');
    const globeStart = source.indexOf('styles.globe}');
    const fxStart = source.indexOf('styles.fxLayer}');
    expect(globeStart).toBeGreaterThan(-1);
    expect(fxStart).toBeGreaterThan(globeStart);
    // Шары — внутри вращающейся части, значки — в неподвижной, которая
    // идёт после неё. Иначе значки крутились бы вместе со сферой и вставали
    // бы вверх ногами.
    expect(source.indexOf('styles.balls}')).toBeGreaterThan(globeStart);
    expect(source.indexOf('styles.balls}')).toBeLessThan(fxStart);
    expect(source.indexOf('styles.orbit}')).toBeGreaterThan(fxStart);
  });

  it('плоскость шара повторяет угол кольца — иначе шар летит мимо проволоки', () => {
    const plane = backdrop.slice(
      backdrop.indexOf('.ballPlane {'),
      backdrop.indexOf('.ballOrbit {'),
    );
    const ring = backdrop.slice(backdrop.indexOf('.ring {'), backdrop.indexOf('.ringBright'));
    const turn = 'rotateX(var(--mt-ring-x, 0deg)) rotateY(var(--mt-ring-y, 0deg))';
    expect(ring).toContain(turn);
    expect(plane).toContain(turn);
  });

  it('значки дышат вразнобой: у каждого своя задержка и своя длительность', () => {
    const html = renderToStaticMarkup(<LoginGlobe />);
    const delays = [...html.matchAll(/--mt-node-delay:\s*([\d.]+)s/gu)].map((m) => m[1]);
    const durations = [...html.matchAll(/--mt-node-duration:\s*([\d.]+)s/gu)].map((m) => m[1]);
    expect(delays.length).toBe(MAIL_GLOBE_ICONS.length);
    expect(new Set(delays).size).toBe(delays.length);
    expect(new Set(durations).size).toBeGreaterThan(1);
  });

  it('увеличение при наведении ведёт переход на обёртке, а не анимация значка', () => {
    // Переход разгоняется и тормозит сам и работает в обе стороны — значок
    // так же плавно возвращается к прежнему размеру. Анимацией это было бы
    // рывком при уходе курсора.
    const wrap = backdrop.slice(backdrop.indexOf('.nodeWrap {'), backdrop.indexOf('@media (hover'));
    expect(wrap).toMatch(/transition:\s*transform\s+[\d.]+s\s+cubic-bezier/u);
    expect(wrap).not.toContain('animation:');
  });
});

describe('просьбу не двигать картинку выполняем целиком', () => {
  const quiet = mediaBlock(backdrop, '@media (prefers-reduced-motion: reduce)');

  it('останавливается всё: вращение, дыхание значков и бег шаров', () => {
    for (const selector of ['.globe', '.nodeCenter', '.ballOrbit', '.node']) {
      expect(quiet, `${selector} продолжает двигаться`).toContain(selector);
    }
    expect(quiet).toContain('animation: none');
    expect(quiet).toContain('transition: none');
  });

  it('именно останавливается, а не замедляется', () => {
    // Бесконечную анимацию нельзя «ускорить до 1мс»: она продолжит
    // крутиться по кругу, просто быстрее.
    const stop = quiet.slice(quiet.indexOf('.globe'), quiet.indexOf('.stage {'));
    expect(stop).toContain('animation: none');
    expect(stop).not.toMatch(/animation-duration/u);
  });

  it('картинка остаётся: сцену не прячут', () => {
    expect(quiet).not.toContain('display: none');
    expect(quiet).not.toContain('visibility: hidden');
  });
});

describe('невидимая вкладка', () => {
  it('сцена встаёт на паузу, а не крутится вхолостую', () => {
    expect(backdrop).toContain("[data-paused='true']");
    const pause = backdrop.slice(backdrop.indexOf("[data-paused='true']"));
    expect(pause).toContain('animation-play-state: paused');
    for (const selector of ['.globe', '.ballOrbit', '.node', '.nodeCenter']) {
      expect(pause.slice(0, pause.indexOf('}'))).toContain(selector);
    }
  });

  it('замирает и то, что живёт вне сцены: размытые пятна фона', () => {
    // Пятна рисует сама страница входа, а не сцена. Пока их не включили в
    // паузу, они оставались единственным, что продолжало двигаться на
    // спрятанной вкладке.
    expect(page).toContain("[data-paused='true']");
    const pause = page.slice(page.indexOf("[data-paused='true']"));
    expect(pause).toContain('animation-play-state: paused');
    expect(pause.slice(0, pause.indexOf('}'))).toContain('.bokeh');
  });

  it('признак ставится по событию видимости страницы, а не гадается', () => {
    const source = readFileSync('src/pages/login/usePageVisible.ts', 'utf8');
    expect(source).toContain("addEventListener('visibilitychange'");
    expect(source).toContain("removeEventListener('visibilitychange'");
    expect(source).toContain('document.hidden');
    // Признак один на сцену и на страницу — иначе половина украшений
    // замрёт, а половина продолжит крутиться.
    for (const user of ['src/pages/login/LoginGlobe.tsx', 'src/pages/LoginPage.tsx']) {
      expect(readFileSync(user, 'utf8'), user).toContain('usePageVisible');
    }
  });
});

describe('на телефоне карточка главнее фона', () => {
  const phone = mediaBlock(page, '@media (max-width: 680px)');

  it('карточка позиционирована: иначе точки фона рисуются по полям ввода', () => {
    const panel = phone.slice(phone.indexOf('.panel'), phone.indexOf('.card'));
    expect(panel).toContain('position: relative');
    expect(panel).not.toContain('position: static');
  });

  it('слой карточки выше слоя холста', () => {
    const panelRule = page.slice(page.indexOf('.panel {'), page.indexOf('.card {'));
    const fxRule = backdrop.slice(backdrop.indexOf('.fx {'), backdrop.indexOf('.stage {'));
    const layer = (rule: string): number => Number(/z-index:\s*(\d+)/u.exec(rule)?.[1] ?? 0);
    expect(layer(panelRule)).toBeGreaterThan(layer(fxRule));
  });

  it('приезд карточки не сдвигает её: центрирует только панель', () => {
    /*
     * В прототипе кадры приезда несли ещё и `translateY(-50%)`, и вместе с
     * центрированием на `.panel` это поднимало карточку на половину её
     * высоты: на окне 1310×818 верх карточки с логотипом уходил за край.
     * Центрирование — дело панели, кадрам приезда его повторять нельзя.
     */
    const frames = page.slice(page.indexOf('@keyframes mtCardIn'));
    for (const [, body] of frames.matchAll(/@keyframes mtCardIn\s*\{([\s\S]*?)\n\s*\}\n/gu)) {
      expect(body).not.toMatch(/translate\([^)]*-?50%/u);
      expect(body).not.toContain('translateY(-50%)');
    }
  });

  it('сцену со сферой на телефоне убирают совсем — она там только мешает', () => {
    const small = mediaBlock(backdrop, '@media (max-width: 680px)');
    expect(small).toContain('.stage');
    expect(small).toContain('display: none');
  });
});
