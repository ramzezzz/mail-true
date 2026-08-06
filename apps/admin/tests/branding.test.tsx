/**
 * Оформление входа (OEM) в панели управления.
 *
 * Проверки закрывают требования заказчика и падают на прежнем коде, где
 * раздела не было вовсе, а знак на входе в панель был вшит в разметку:
 *
 *   1. Логотип берётся из настроек — тем же модулем, что и на входе в
 *      почту: два независимых куска кода рано или поздно разъезжаются, и
 *      половина людей видит новое лицо продукта, а половина старое.
 *   2. Пока своего логотипа нет, вход в панель остаётся отличимым от входа
 *      в почту (нарисованный знак консоли) — иначе администратор наберёт
 *      почтовый пароль вслепую.
 *   3. Раздел «Оформление входа» есть в меню и в крошках.
 *   4. «Резервные копии» больше не заглушка: раздел работает.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionProvider } from '../src/app/session';
import { LoginPage } from '../src/pages/LoginPage';
import { NAV_ITEMS, visibleNav } from '../src/lib/access';
import { breadcrumbsFor } from '../src/lib/breadcrumbs';
import type { Permission } from '../src/api/types';

const file = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

describe('вход в панель берёт логотип из настроек', () => {
  const markup = renderToStaticMarkup(
    <SessionProvider>
      <LoginPage />
    </SessionProvider>,
  );

  it('логотип и подпись приходят из общего модуля оформления, а не из разметки', () => {
    const source = file('src/pages/LoginPage.tsx');
    expect(source).toContain("from '@web/lib/branding'");
    expect(source).toContain('logoSrc(branding)');
  });

  it('пока своего логотипа нет, вход в панель отличим от входа в почту', () => {
    // Нарисованный знак консоли — ровно то, что отличает панель от почты.
    expect(markup).toContain('console');
    expect(markup).toContain('Mail.True');
    expect(markup).toContain('Вход в панель управления');
  });
});

describe('разделы панели', () => {
  const OWNER: Permission[] = [
    'overview.read',
    'users.read',
    'aliases.read',
    'domains.read',
    'audit.read',
    'branding.read',
    'branding.write',
    'backup.export',
    'backup.restore',
  ];

  it('в меню есть «Оформление входа»', () => {
    expect(visibleNav(OWNER).map((i) => i.title)).toContain('Оформление входа');
  });

  it('раздел копий требует права на копии, а не «кто видит сводку»', () => {
    const backups = NAV_ITEMS.find((i) => i.to === '/backups');
    expect(backups?.requires).toEqual(['backup.export', 'backup.restore']);
    // Внутри файла копии хэши паролей — дежурному «только чтение» его не видеть
    expect(
      visibleNav(['overview.read', 'users.read'] as Permission[]).map((i) => i.to),
    ).not.toContain('/backups');
  });

  it('«Резервные копии» больше не помечены как «скоро»', () => {
    expect(NAV_ITEMS.find((i) => i.to === '/backups')?.stub).toBeFalsy();
  });

  it('в крошках оба новых раздела названы по-русски', () => {
    expect(breadcrumbsFor('/branding').at(-1)?.title).toBe('Оформление входа');
    expect(breadcrumbsFor('/backups').at(-1)?.title).toBe('Резервные копии');
  });

  it('оба раздела заведены в маршрутах настоящими страницами', () => {
    const router = file('src/app/router.tsx');
    expect(router).toContain("{ path: 'branding', element: <BrandingPage /> }");
    expect(router).toContain("{ path: 'backups', element: <BackupPage /> }");
    expect(router).not.toContain('<StubPage id="backups" />');
  });
});

describe('страница оформления', () => {
  const source = file('src/pages/BrandingPage.tsx');

  it('кнопка «вернуть стандартный» есть: OEM не должен быть билетом в один конец', () => {
    expect(source).toContain('Вернуть стандартный');
    expect(source).toContain('api.resetLogo()');
  });

  it('пределы называются ДО загрузки, а не только в тексте отказа', () => {
    expect(source).toContain('limits.maxBytesText');
    expect(source).toContain('limits.maxWidth');
    expect(source).toContain('limits.formats');
  });

  it('маленький логотип показан в байтах, а не как «0 КБ»', () => {
    // Аккуратный знак из плоских фигур весит меньше килобайта, и
    // округление до нуля читалось бы как «файл пустой». Найдено на
    // живом стенде: PNG 240×48 весит 288 байт.
    expect(source).toContain('return `${bytes} Б`');
  });

  it('текст отказа берётся с сервера, а не сочиняется на месте', () => {
    // ErrorNotice показывает message из ответа — там сказано, что именно
    // не так с файлом («это не картинка, а сценарий PHP»).
    expect(source).toContain('<ErrorNotice');
    expect(source).not.toContain('Некорректный запрос');
  });
});

describe('страница резервных копий', () => {
  const source = file('src/pages/BackupPage.tsx');

  it('сказано прямо, что это копия настроек, а не писем', () => {
    expect(source).toContain('install/backup.sh');
    expect(source).toMatch(/копия <b>настроек<\/b>, а не писем/u);
  });

  it('восстановление идёт через план: сначала предпросмотр, потом применение', () => {
    expect(source).toContain('api.backupPreview');
    expect(source).toContain('Будет перезаписано');
    expect(source).toContain('Не тронуто');
  });

  it('версия формата показана человеку', () => {
    expect(source).toContain('formatVersion');
  });
});
