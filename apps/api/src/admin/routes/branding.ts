/**
 * Своё оформление входа (OEM): логотип и подписи на страницах входа.
 *
 * ------------------------------------------------------------------
 * Почему маршруты живут под /api/admin, хотя два из них ОТКРЫТЫЕ
 * ------------------------------------------------------------------
 * Страницу входа видит тот, кто ещё не вошёл, — значит и логотип обязан
 * отдаваться без сессии. Но адрес у него должен быть один на оба входа:
 * почта живёт на mail.<домен>, панель — на admin.<домен>, и на имени
 * админки nginx пробрасывает наверх ТОЛЬКО /api/admin/ (см.
 * infra/nginx/templates/app.conf.template), всё прочее из /api/ отвечает
 * 404. Отдельный путь /api/branding работал бы в почте и молча ломался
 * бы на входе в панель — то есть ровно там, где логотип и заказан.
 *
 * Открытость здесь не даёт доступа к чужим файлам: отдаётся ровно один
 * файл с именем, которое выбрали мы сами (logo.<формат>), никакая часть
 * пути из запроса не берётся, а перебирать в каталоге нечего.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../../errors.js';
import { audit, requireAdmin } from '../guard.js';
import {
  humanBytes,
  LOGO_FORMATS,
  LOGO_MAX_BYTES,
  LOGO_MAX_HEIGHT,
  LOGO_MAX_WIDTH,
  LOGO_MIN_HEIGHT,
  LOGO_MIN_WIDTH,
} from '../branding-image.js';
import { BRANDING_NAME_MAX, type BrandingState } from '../branding.js';

/** Адрес логотипа с отпечатком: смена файла меняет адрес, кэш не врёт. */
export function logoUrl(state: BrandingState): string | null {
  return state.logo ? `/api/admin/branding/logo?v=${state.logo.version}` : null;
}

function toDto(state: BrandingState): Record<string, unknown> {
  return {
    companyName: state.companyName,
    productName: state.productName,
    logo: state.logo
      ? {
          url: logoUrl(state),
          mime: state.logo.mime,
          width: state.logo.width,
          height: state.logo.height,
          size: state.logo.size,
          version: state.logo.version,
          updatedAt: state.logo.updatedAt,
        }
      : null,
    /** Пределы отдаём наружу, чтобы интерфейс называл их ДО загрузки. */
    limits: {
      maxBytes: LOGO_MAX_BYTES,
      maxBytesText: humanBytes(LOGO_MAX_BYTES),
      minWidth: LOGO_MIN_WIDTH,
      minHeight: LOGO_MIN_HEIGHT,
      maxWidth: LOGO_MAX_WIDTH,
      maxHeight: LOGO_MAX_HEIGHT,
      formats: Object.values(LOGO_FORMATS).map((f) => f.title),
      nameMax: BRANDING_NAME_MAX,
    },
  };
}

const textsSchema = z.object({
  companyName: z.string().max(200).nullable().optional(),
  productName: z.string().max(200).nullable().optional(),
});

export async function adminBrandingRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;
  const branding = ctx.branding;

  /* --- открытая часть: её читают обе страницы входа ----------------- */

  app.get(
    '/branding',
    {
      // Страницу входа открывают часто и подряд (перезагрузка после
      // ошибки пароля). Предел тут выше общего: упереться в него на
      // собственной странице входа было бы стыдно.
      config: { rateLimit: { max: 240, timeWindow: 60_000 } },
    },
    async (_request, reply) => {
      const state = await branding.read();
      // Короткий кэш: смену логотипа видно почти сразу, а шквал
      // одинаковых запросов при перезагрузках гасится.
      void reply.header('Cache-Control', 'public, max-age=60');
      return toDto(state);
    },
  );

  app.get<{ Querystring: { v?: string } }>(
    '/branding/logo',
    { config: { rateLimit: { max: 240, timeWindow: 60_000 } } },
    async (request, reply) => {
      const file = await branding.readLogo();
      if (!file) throw new NotFoundError('Свой логотип не загружен — используется стандартный');

      void reply
        .header('Content-Type', file.logo.mime)
        // Тип содержимого угадывать нельзя: SVG, названный PNG, в режиме
        // угадывания стал бы документом с доступом к нашим cookie.
        .header('X-Content-Type-Options', 'nosniff')
        // Даже если файл откроют по прямому адресу отдельной вкладкой,
        // выполнять внутри него нечего: ни скриптов, ни внешних загрузок.
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .header('ETag', `"${file.logo.version}"`)
        // Адрес несёт отпечаток содержимого — значит ответ можно кэшировать
        // навсегда. Без отпечатка (кто-то зашёл руками) кэшируем на минуту.
        .header(
          'Cache-Control',
          request.query.v === file.logo.version
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=60',
        );
      return reply.send(file.bytes);
    },
  );

  /* --- изменение: только по сессии и праву ------------------------- */

  app.post(
    '/branding/logo',
    {
      preHandler: requireAdmin(app, 'branding.write'),
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    },
    async (request) => {
      if (!request.isMultipart()) {
        throw new BadRequestError(
          'Файл не пришёл: логотип загружается формой multipart/form-data, поле «file».',
        );
      }

      // Свой предел на запрос, а не общий вложенческий (25 МБ): читать
      // в память 25 МБ ради логотипа в полмегабайта незачем. Плюс один
      // байт — чтобы отличить «ровно предел» от «больше предела».
      // throwFileSizeLimit: false — чтобы предел сработал ОБРЕЗАНИЕМ, а не
      // готовым исключением плагина: его текст «Файл слишком большой» не
      // называет ни предела, ни того, сколько принесли, а требование —
      // внятный отказ. Свой текст ниже.
      const part = await request.file({
        limits: { fileSize: LOGO_MAX_BYTES + 1, files: 1 },
        throwFileSizeLimit: false,
      });
      if (!part) throw new BadRequestError('В запросе нет файла.');

      const bytes = await part.toBuffer();
      if (part.file.truncated) {
        throw new BadRequestError(
          `Файл больше ${humanBytes(LOGO_MAX_BYTES)} — столько логотип весить не может. ` +
            'Уменьшите картинку или сохраните её в PNG.',
        );
      }

      const before = await branding.read();
      const state = await branding.saveLogo(bytes);
      await audit(ctx, request, {
        action: 'branding.logo.upload',
        targetType: 'branding',
        targetLabel: part.filename || 'logo',
        before: { logo: before.logo?.version ?? null, size: before.logo?.size ?? null },
        after: { logo: state.logo?.version ?? null, size: state.logo?.size ?? null },
      });
      return toDto(state);
    },
  );

  /** «Вернуть стандартный». Обязательная кнопка: без неё OEM — билет в один конец. */
  app.delete(
    '/branding/logo',
    { preHandler: requireAdmin(app, 'branding.write') },
    async (request) => {
      const before = await branding.read();
      if (!before.logo) {
        // Не ошибка: кнопку могли нажать дважды. Отвечаем текущим состоянием.
        return toDto(before);
      }
      const state = await branding.resetLogo();
      await audit(ctx, request, {
        action: 'branding.logo.reset',
        targetType: 'branding',
        targetLabel: 'стандартный логотип',
        before: { logo: before.logo.version },
        after: { logo: null },
      });
      return toDto(state);
    },
  );

  app.patch(
    '/branding',
    { preHandler: requireAdmin(app, 'branding.write') },
    async (request) => {
      const body = textsSchema.parse(request.body);
      const before = await branding.read();
      // Поле, которого нет в запросе, означает «не менять», поэтому
      // undefined до хранилища доходить не должен вовсе.
      const state = await branding.saveTexts({
        ...(body.companyName !== undefined ? { companyName: body.companyName } : {}),
        ...(body.productName !== undefined ? { productName: body.productName } : {}),
      });
      await audit(ctx, request, {
        action: 'branding.texts',
        targetType: 'branding',
        targetLabel: state.companyName ?? state.productName ?? 'подписи входа',
        before: { companyName: before.companyName, productName: before.productName },
        after: { companyName: state.companyName, productName: state.productName },
      });
      return toDto(state);
    },
  );
}
