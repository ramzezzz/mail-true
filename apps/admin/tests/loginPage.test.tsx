/// <reference types="node" />
/**
 * Страница входа в панель управления: подписи, значки глобуса и те два
 * правила в стилях, без которых страница уже ломалась.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionProvider } from '../src/app/session';
import { LoginPage } from '../src/pages/LoginPage';
import { LoginGlobe } from '../src/pages/login/LoginGlobe';
import { ADMIN_ORBIT_ICONS, AdminIconSprite, ICON_PREFIX } from '../src/pages/login/adminIcons';

/**
 * Таблицу стилей читаем текстом с диска: правила ниже — про сам CSS, а
 * импорт модуля стилей отдаёт только имена классов.
 */
const css = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/pages/${name}`, import.meta.url)), 'utf8')
    // Концы строк приводим к одному виду: на Windows файл может лежать с CRLF,
    // и поиск по тексту иначе зависел бы от машины.
    .replace(/\r\n/gu, '\n');

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

  it('каждый значок орбиты действительно выведен на глобусе', () => {
    const html = renderToStaticMarkup(<LoginGlobe />);
    for (const icon of ADMIN_ORBIT_ICONS) {
      expect(html).toContain(`#${ICON_PREFIX}${icon.id}`);
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

  it('движение гасится, но картинка остаётся', () => {
    const backdrop = css('login/LoginBackdrop.module.css');
    const start = backdrop.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start).toBeGreaterThan(-1);
    // Блок тянется до следующего @media — дальше идут правила узкого экрана.
    const rest = backdrop.slice(start);
    const next = rest.indexOf('@media', 1);
    const quiet = next === -1 ? rest : rest.slice(0, next);
    expect(quiet).toContain('animation: none');
    // Именно animation, а не display: скрывать глобус при выключенном
    // движении значило бы оставить человека с пустым фоном.
    expect(quiet).not.toContain('display: none');
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
