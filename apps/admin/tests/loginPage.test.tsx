/// <reference types="node" />
/**
 * Страница входа в панель управления: подписи, значки глобуса и те два
 * правила в стилях, без которых страница уже ломалась.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionProvider } from '../src/app/session';
import { LoginPage } from '../src/pages/LoginPage';
import { ADMIN_ORBIT_ICONS, AdminIconSprite, ICON_PREFIX } from '../src/pages/login/adminIcons';
import { paletteVars } from '../src/pages/login/loginPalette';

/**
 * Таблицу стилей читаем текстом с диска: правила ниже — про сам CSS, а
 * импорт модуля стилей отдаёт только имена классов.
 */
const css = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/pages/${name}`, import.meta.url)), 'utf8')
    // Концы строк приводим к одному виду: на Windows файл может лежать с CRLF,
    // и поиск по тексту иначе зависел бы от машины.
    .replace(/\r\n/gu, '\n');

/** Файл из веб-интерфейса — там живёт общая сцена входа. */
const webFile = (name: string): string =>
  fileURLToPath(new URL(`../../web/src/pages/login/${name}`, import.meta.url));

function page(): string {
  return renderToStaticMarkup(
    <SessionProvider>
      <LoginPage />
    </SessionProvider>,
  );
}

describe('подписи говорят про панель управления, а не про почту', () => {
  it('заголовок первого уровня — про вход в панель', () => {
    const html = page();
    expect(html).toContain('<h1');
    expect(html).toContain('Вход в панель управления');
    expect(html).not.toContain('Вход в почту');
  });

  it('подзаголовок объясняет, что почтовый ящик здесь не подойдёт', () => {
    const html = page();
    expect(html).toContain('почтовым сервером');
    expect(html).toContain('не подойдёт');
  });

  it('в подвале то, что нужно администратору, а не обещания про почту', () => {
    const html = page();
    expect(html).toContain('журнал');
    expect(html).not.toContain('Ваша почта хранится');
  });
});

describe('глобус: значки про администрирование', () => {
  it('по орбите летают предметы работы администратора', () => {
    const ids = ADMIN_ORBIT_ICONS.map((i) => i.id);
    for (const need of [
      'mailbox',
      'users',
      'domain',
      'key',
      'health',
      'journal',
      'backup',
      'quota',
      'rules',
    ]) {
      expect(ids).toContain(need);
    }
  });

  it('почтовых действий на орбите нет', () => {
    const ids = ADMIN_ORBIT_ICONS.map((i) => i.id);
    for (const mail of ['compose', 'reply', 'reply-all', 'forward', 'attach', 'folder-sent']) {
      expect(ids).not.toContain(mail);
    }
  });

  it('каждый значок орбиты действительно выведен на сфере', () => {
    const html = page();
    for (const icon of ADMIN_ORBIT_ICONS) {
      // Символ и объявлен в наборе, и взят на сцене — два вхождения.
      expect(html.split(`${ICON_PREFIX}${icon.id}`).length - 1).toBeGreaterThanOrEqual(2);
    }
  });

  it('значки нарисованы кодом: ни растровых картинок, ни внешнего спрайта', () => {
    const html = page();
    expect(html).toContain('<symbol');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('sprite.svg');
    expect(html).not.toContain('.png');
  });

  it('значки в фирменной стилистике: сетка 24×24, штрих 1.8, цвет наследуется', () => {
    const html = renderToStaticMarkup(<AdminIconSprite />);
    const symbols = html.split('<symbol').slice(1);
    expect(symbols.length).toBe(ADMIN_ORBIT_ICONS.length + 1);
    for (const symbol of symbols) {
      const head = symbol.slice(0, symbol.indexOf('>'));
      expect(head).toContain('viewBox="0 0 24 24"');
      expect(head).toContain('stroke-width="1.8"');
      expect(head).toContain('stroke="currentColor"');
      expect(head).toContain('fill="none"');
    }
  });
});

describe('правила стилей, без которых страница уже ломалась', () => {
  it('на телефоне карточка позиционирована: иначе точки фона рисуются по полям ввода', () => {
    const text = css('LoginPage.module.css');
    const phone = text.slice(text.indexOf('@media (max-width: 680px)'));
    expect(phone).not.toBe('');
    const panel = phone.slice(phone.indexOf('.panel'), phone.indexOf('.card'));
    expect(panel).toContain('position: relative');
    expect(panel).not.toContain('position: static');
  });

  it('на телефоне кнопки внутри полей не меньше 44 точек', () => {
    const text = css('LoginPage.module.css');
    const phone = text.slice(text.indexOf('@media (max-width: 680px)'));
    const btn = phone.slice(phone.indexOf('.ulineBtn'));
    // 2.75rem при корне 16px — это ровно 44 точки.
    expect(btn).toContain('width: 2.75rem');
    expect(btn).toContain('height: 2.75rem');
  });
});

/*
 * Сцена входа (холст и вращающаяся сфера) — ОДИН компонент на почту и на
 * панель, он живёт в apps/web/src/pages/login. Её собственные проверки —
 * там же (apps/web/tests/loginPage.test.tsx, loginConstellation.test.ts).
 * Здесь проверяется только стык: панель берёт общую сцену и красит её
 * своей гаммой, а не заводит вторую копию.
 */
describe('сцена входа общая с почтой', () => {
  it('у панели нет своей копии сцены — иначе они разъедутся', () => {
    for (const own of [
      'LoginGlobe.tsx',
      'LoginConstellation.tsx',
      'LoginBackdrop.module.css',
      'constellation.ts',
    ]) {
      const path = fileURLToPath(new URL(`../src/pages/login/${own}`, import.meta.url));
      expect(existsSync(path), `${own} — вторая копия общей сцены`).toBe(false);
    }
  });

  it('страница входа в панель берёт сцену из веб-интерфейса', () => {
    const source = css('LoginPage.tsx');
    expect(source).toContain("from '@web/pages/login/LoginGlobe'");
    expect(source).toContain("from '@web/pages/login/LoginConstellation'");
  });

  it('на спрятанной вкладке замирают и свои украшения панели', () => {
    // Сцена гасит себя сама, а размытые пятна рисует страница панели —
    // без своего правила они продолжали бы двигаться в никуда.
    const source = css('LoginPage.tsx');
    expect(source).toContain('usePageVisible');
    expect(source).toContain('pausedAttr');
    const style = css('LoginPage.module.css');
    const pause = style.slice(style.indexOf("[data-paused='true']"));
    expect(pause).toContain('animation-play-state: paused');
    expect(pause.slice(0, pause.indexOf('}'))).toContain('.haze');
  });

  it('гамма панели доезжает до общей сцены переменными, а не правкой её CSS', () => {
    const vars = paletteVars();
    // Общая сцена читает --mt-login-*; синие значения по умолчанию должны
    // быть перекрыты, иначе на входе в панель окажется сфера цвета почты.
    for (const name of ['--mt-login-ring', '--mt-login-node-bg', '--mt-login-ball-mid']) {
      expect(vars[name], `${name} не подменён`).toBeTruthy();
    }
    const shared = readFileSync(webFile('LoginBackdrop.module.css'), 'utf8');
    expect(shared).toContain('--mt-login-ring');
    // В общей сцене нет ни одного цвета панели, вписанного числом.
    expect(shared).not.toContain('#0f6a72');
  });
});

describe('форма входа цела', () => {
  it('оба поля на месте, у каждого своя подпись', () => {
    const html = page();
    expect(html).toContain('id="admin-login"');
    expect(html).toContain('id="admin-password"');
    expect(html).toContain('for="admin-login"');
    expect(html).toContain('for="admin-password"');
    expect(html).toContain('Логин администратора');
    // Поля свои, с подчёркиванием, а не общие рамки админки.
    expect(html).not.toContain('mt-input');
  });

  it('кнопка отправляет форму и заперта, пока поля пусты', () => {
    const html = page();
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled');
    expect(html).toContain('Войти');
    // Размер l — 44 точки высоты: попасть пальцем с первого раза.
    expect(html).toContain('size_l');
  });

  it('пароль по умолчанию скрыт, а показать его есть чем', () => {
    const html = page();
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="Показать пароль"');
  });
});
