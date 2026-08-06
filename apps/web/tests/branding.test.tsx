// @vitest-environment jsdom
/**
 * Своё оформление входа (OEM) на странице входа в почту.
 *
 * Проверки закрывают требование «изменять логотип логин страницы на свой,
 * из админки» и падают на прежнем коде, где логотип был вшит в разметку
 * строкой `src="/brand/logo-full.svg"`:
 *
 *   1. Логотип берётся из настроек, а не из сборки.
 *   2. Пока настройки не приехали (и если сервер приложения лежит),
 *      страница входа показывает стандартный знак, а не пустое место:
 *      дыра на месте логотипа читается как «страница сломалась».
 *   3. Адрес логотипа один на почту и панель — иначе половина людей
 *      увидит новое лицо продукта, а половина старое.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  DEFAULT_BRANDING,
  DEFAULT_LOGO_SRC,
  fetchBranding,
  logoAlt,
  logoSrc,
} from '../src/lib/branding';
import { LoginPage } from '../src/pages/LoginPage';
import { SessionProvider } from '../src/app/session';

describe('выбор логотипа', () => {
  it('без своего логотипа берётся знак продукта из сборки', () => {
    expect(logoSrc(DEFAULT_BRANDING)).toBe(DEFAULT_LOGO_SRC);
    expect(logoAlt(DEFAULT_BRANDING)).toBe('Mail.True');
  });

  it('свой логотип вытесняет стандартный', () => {
    const branding = {
      companyName: 'ООО «Ромашка»',
      productName: null,
      logo: { url: '/api/admin/branding/logo?v=abc123', width: 200, height: 40 },
    };
    expect(logoSrc(branding)).toBe('/api/admin/branding/logo?v=abc123');
    // Подпись к картинке — название компании: логотип чужой, и «Mail.True»
    // в alt читалось бы вслух неверно.
    expect(logoAlt(branding)).toBe('ООО «Ромашка»');
  });
});

describe('чтение настроек оформления', () => {
  it('адрес начинается с /api/admin: на имени хоста панели другой путь не проброшен', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ companyName: null, productName: null, logo: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchBranding();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/branding', expect.anything());
    vi.unstubAllGlobals();
  });

  it('отказ сервера не ломает страницу входа: остаётся стандартное оформление', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('сервер приложения лежит');
      }),
    );
    expect(await fetchBranding()).toEqual(DEFAULT_BRANDING);
    vi.unstubAllGlobals();
  });

  it('ответ 503 тоже даёт стандартное оформление, а не мусор в разметке', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    expect(await fetchBranding()).toEqual(DEFAULT_BRANDING);
    vi.unstubAllGlobals();
  });

  it('битое поле logo не превращается в сломанную картинку', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ companyName: 42, logo: { width: 10 } }),
      })),
    );
    const branding = await fetchBranding();
    expect(branding.logo).toBeNull();
    expect(branding.companyName).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('страница входа', () => {
  // Оба поставщика настоящие: страница входа читает сессию, а та —
  // общий клиент запросов. Эффекты при отрисовке в строку не выполняются,
  // поэтому видим ровно первый кадр — тот, что человек застаёт до ответа.
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SessionProvider>
        <LoginPage />
      </SessionProvider>
    </QueryClientProvider>,
  );

  it('до ответа сервера показывает стандартный логотип, а не пустоту', () => {
    expect(markup).toContain(`src="${DEFAULT_LOGO_SRC}"`);
    expect(markup).toContain('<img');
  });

  it('логотип больше не вшит в разметку жёстко — он проходит через настройки', () => {
    // Читаем исходник текстом: в собранной разметке видно только первый
    // кадр, а требование — про то, ОТКУДА берётся адрес картинки.
    // Путь считаем от корня проекта: в jsdom import.meta.url не файловый.
    const source = readFileSync('src/pages/LoginPage.tsx', 'utf8');
    expect(source).toContain('logoSrc(branding)');
    expect(source).not.toContain('src="/brand/logo-full.svg"');
  });
});
