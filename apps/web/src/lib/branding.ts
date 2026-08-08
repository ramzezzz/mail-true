/**
 * Своё оформление входа (OEM): логотип и подписи, загруженные в панели
 * управления.
 *
 * Один модуль на оба приложения: страница входа в почту и страница входа
 * в панель обязаны показывать ОДИН логотип. Два независимых куска кода
 * рано или поздно разъезжаются, и половина людей видит новое лицо
 * продукта, а половина — старое.
 *
 * Почему адрес начинается с /api/admin, хотя это открытые данные:
 * на имени хоста панели nginx пробрасывает наверх только /api/admin/,
 * всё прочее из /api/ отвечает 404 (infra/nginx/templates/app.conf.template).
 * Отдельный путь /api/branding работал бы в почте и молча ломался бы на
 * входе в панель — то есть ровно там, где логотип и заказан.
 */
import { useEffect, useState } from 'react';

/** Логотип продукта по умолчанию — файл сборки, не сеть. */
export const DEFAULT_LOGO_SRC = '/brand/logo-full.svg';
export const DEFAULT_PRODUCT_NAME = 'Mail.True';

export interface BrandingLogo {
  url: string;
  width: number;
  height: number;
}

export interface Branding {
  companyName: string | null;
  productName: string | null;
  /** Свой текст в подвале страницы входа. null — строки продукта. */
  loginFooter: string | null;
  logo: BrandingLogo | null;
}

export const DEFAULT_BRANDING: Branding = {
  companyName: null,
  productName: null,
  loginFooter: null,
  logo: null,
};

const ENDPOINT = '/api/admin/branding';

/** Читает оформление. Любая беда — стандартное: страница входа обязана открыться. */
export async function fetchBranding(signal?: AbortSignal): Promise<Branding> {
  try {
    const response = await fetch(ENDPOINT, {
      credentials: 'include',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return DEFAULT_BRANDING;
    const body = (await response.json()) as Partial<Branding>;
    return {
      companyName: typeof body.companyName === 'string' ? body.companyName : null,
      productName: typeof body.productName === 'string' ? body.productName : null,
      loginFooter: typeof body.loginFooter === 'string' ? body.loginFooter : null,
      logo:
        body.logo && typeof body.logo.url === 'string'
          ? {
              url: body.logo.url,
              width: Number(body.logo.width) || 0,
              height: Number(body.logo.height) || 0,
            }
          : null,
    };
  } catch {
    // Сервер приложения лежит — на странице входа это и так будет видно
    // по отказу входа. Своего сообщения тут не нужно: логотип не главное.
    return DEFAULT_BRANDING;
  }
}

/**
 * Оформление для страницы входа.
 *
 * До ответа отдаёт стандартное, а не пустоту: пустое место на месте
 * логотипа читается как «страница сломалась», а стандартный логотип —
 * это ровно то, что и должно быть, пока своего не загрузили.
 */
export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);

  useEffect(() => {
    // В окружении проверок fetch может отсутствовать вовсе — это не повод
    // ронять страницу входа.
    if (typeof fetch !== 'function') return;
    const controller = new AbortController();
    void fetchBranding(controller.signal).then((next) => {
      if (!controller.signal.aborted) setBranding(next);
    });
    return () => controller.abort();
  }, []);

  return branding;
}

/** Адрес картинки логотипа: свой, если загружен, иначе стандартный. */
export function logoSrc(branding: Branding): string {
  return branding.logo?.url ?? DEFAULT_LOGO_SRC;
}

/** Подпись к логотипу: название компании важнее названия продукта. */
export function logoAlt(branding: Branding): string {
  return branding.companyName ?? branding.productName ?? DEFAULT_PRODUCT_NAME;
}
