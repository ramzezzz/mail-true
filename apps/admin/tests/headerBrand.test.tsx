/**
 * Шапка панели управления: фирменный логотип вместо надписи, подпись
 * «панель управления», блок администратора справа и фирменные шрифты.
 *
 * Разметку берём отрисовкой настоящего каркаса, а не чтением исходника:
 * так проверяется то, что увидит браузер. Правила вёрстки — чтением CSS,
 * потому что в node стили модулей не считаются.
 *
 * На прежнем коде падало всё: в шапке стояла строка «Mail.True ·
 * администрирование», картинок не было вовсе, а index.html не подключал
 * шрифты — админка набиралась Arial, тогда как почта Golos Text.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../src/app/session';
import { AdminLayout } from '../src/app/AdminLayout';

const file = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

function header(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SessionProvider>
        <AdminLayout />
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('в шапке фирменный логотип, а не набранная строка', () => {
  const markup = header();

  it('логотип — картинка из фирменного каталога', () => {
    expect(markup).toContain('src="/brand/logo-full.svg"');
    // Знак для узкого экрана: там полное написание не помещается
    expect(markup).toContain('src="/brand/mark.svg"');
  });

  it('у тёмного фона своё начертание — переключает CSS, а не код', () => {
    expect(markup).toContain('src="/brand/logo-full-dark.svg"');
    const css = file('src/app/AdminLayout.module.css');
    expect(css).toContain("[data-theme='dark']");
  });

  it('прежней надписи «Mail.True · администрирование» в шапке больше нет', () => {
    expect(markup).not.toContain('· администрирование');
  });

  it('рядом с логотипом сказано, что это панель управления, а не почта', () => {
    expect(markup).toContain('Панель управления');
    // И то же самое — доступным именем ссылки, для скринридера
    expect(markup).toContain('aria-label="Mail.True — панель управления"');
  });

  it('логотип ведёт на главную панели', () => {
    expect(markup).toMatch(/<a[^>]+href="\/"[^>]*>\s*<img[^>]+brand\/logo-full\.svg/);
  });

  it('файлы логотипа лежат в своей сборке: чужой каталог админка не видит', () => {
    for (const name of ['logo-full.svg', 'logo-full-dark.svg', 'mark.svg']) {
      expect(() => file(`public/brand/${name}`)).not.toThrow();
    }
  });
});

describe('блок администратора справа', () => {
  const markup = header();
  const css = file('src/app/AdminLayout.module.css');

  it('имя и роль стоят отдельными строками, а не слеплены точкой', () => {
    expect(markup).toMatch(/class="[^"]*accountLogin/);
    expect(markup).toMatch(/class="[^"]*accountRole/);
    // Прежняя разметка склеивала их разделителем «· »
    expect(markup).not.toContain('· </span>');
  });

  it('у блока есть значок с буквой имени и он спрятан от скринридера', () => {
    expect(markup).toMatch(/class="[^"]*accountAvatar[^"]*"[^>]*aria-hidden="true"/);
  });

  it('выход отделён от имени разделителем, а не просто придвинут', () => {
    expect(markup).toMatch(/class="[^"]*headerSep/);
    expect(ruleOf(css, '.headerSep')).toMatch(/width:\s*1px/);
  });
});

describe('геометрия шапки', () => {
  const css = file('src/app/AdminLayout.module.css');
  const admin = file('src/styles/admin.css');

  it('шапка выросла: в 48px логотип с подписью не помещался', () => {
    expect(admin).toMatch(/--mt-admin-header-height:\s*56px/);
  });

  it('зона логотипа шириной с меню — линия идёт от шапки донизу одной чертой', () => {
    const brand = ruleOf(css, '.brand');
    expect(brand).toContain('width: var(--mt-admin-sidebar-width)');
    expect(brand).toContain('border-right');
  });

  it('логотип не растягивается на всю ширину зоны', () => {
    // flex-колонка по умолчанию тянет картинку в ширину, а высота остаётся
    // 22px — логотип расплющивало по горизонтали
    expect(ruleOf(css, '.brand')).toContain('align-items: flex-start');
  });

  it('на узком экране полное написание уступает знаку, а роль прячется', () => {
    // Порог узкого экрана — 900px: на 768 боковое меню не давало
    // поместиться колонке действий в таблице ящиков (Table.module.css).
    const narrow = css.slice(css.indexOf('@media (max-width: 900px)'));
    expect(narrow).toContain('.brandMark');
    expect(narrow).toContain('.brandKicker');
    expect(narrow).toContain('.accountRole');
  });

  it('на телефоне у кнопки выхода палец попадает в цель', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 480px)'));
    expect(phone).toMatch(/height:\s*44px/);
  });
});

describe('фирменные шрифты подключены', () => {
  it('index.html подключает fonts.css — иначе админка набирается Arial', () => {
    expect(file('index.html')).toContain('/brand/fonts/fonts.css');
  });

  it('шрифтовые файлы лежат в своей сборке', () => {
    for (const name of ['fonts.css', 'golos-text-cyrillic-wght.woff2']) {
      expect(() => file(`public/brand/fonts/${name}`)).not.toThrow();
    }
  });

  it('в стилях названа та же гарнитура, что в почте, а не несуществующая', () => {
    // Смотрим сам набор шрифтов у body, а не весь файл: в пояснениях рядом
    // прежние гарнитуры названы по именам, и это правильно
    const admin = file('src/styles/admin.css');
    const body = admin.slice(admin.indexOf('body {'));
    const fontFamily = body.slice(body.indexOf('font-family'), body.indexOf(');'));
    expect(fontFamily).toContain('--mt-font-ui');
    expect(fontFamily).toContain('Golos Text');
    // Этих гарнитур нет ни на одной машине — с ними и получался Arial
    expect(fontFamily).not.toContain('VKSansDisplay');
    expect(fontFamily).not.toContain('MailSans');
  });
});

/** Тело правила по селектору — вложенных фигурных скобок в правилах нет. */
function ruleOf(source: string, selector: string): string {
  const at = source.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`нет правила ${selector}`);
  const open = source.indexOf('{', at);
  return source.slice(open + 1, source.indexOf('}', open));
}
