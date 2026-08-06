/**
 * Раздел панели управления: логотипы доменов отправителей.
 *
 * ------------------------------------------------------------------
 * Почему это решение уровня сервера, а не пользователя
 * ------------------------------------------------------------------
 * Логотип домена видят ВСЕ, кому приходят письма с этого домена. «Этот знак
 * вводит в заблуждение» или «вот настоящий логотип нашего клиента» — суждение
 * одно на весь сервер, а не личный вкус каждого. Поэтому раздел живёт в
 * панели, а в почте у человека остаётся только выключатель «показывать
 * логотипы вообще».
 *
 * ------------------------------------------------------------------
 * Право доступа
 * ------------------------------------------------------------------
 * Берётся `branding.write` — то же, что у оформления страницы входа, и по
 * той же причине: и там и здесь речь о картинках, которые продукт показывает
 * от своего имени. Заводить своё право значило бы добавить строку в роли,
 * миграцию и экран прав ради ровно того же круга людей: тот, кому доверили
 * логотип входа, справится и с логотипом домена.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../errors.js';
import { audit, requireAdmin } from '../admin/guard.js';
import { humanBytes, inspectLogo, type LogoLimits } from '../admin/branding-image.js';
import { SENDER_LOGO_MAX_BYTES } from './image.js';
import { SenderLogoService } from './service.js';

/**
 * Пределы ручной картинки.
 *
 * Проверку выполняет ТОТ ЖЕ модуль, что проверяет логотип страницы входа
 * (admin/branding-image.ts): опознание формата по содержимому, разбор SVG на
 * скрипты и ссылки наружу, внятный отказ с названной причиной. Меняются
 * только числа, и меняются осмысленно: картинка ложится в кружок 32 точки,
 * поэтому 16×16 здесь норма (значок сайта именно такой и бывает), а верхняя
 * граница ниже — держать в базе иллюстрацию 2000×1000 ради кружка незачем.
 */
export const MANUAL_LOGO_LIMITS: LogoLimits = {
  maxBytes: SENDER_LOGO_MAX_BYTES,
  minWidth: 16,
  minHeight: 16,
  maxWidth: 1024,
  maxHeight: 1024,
};

const listQuery = z.object({
  q: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const blockedBody = z.object({ blocked: z.boolean() });

/** Домен из адреса запроса. Мусор — это 404, а не «покажу что-нибудь». */
function domainParam(raw: string): string {
  const [domain] = SenderLogoService.normalizeDomains([raw]);
  if (domain === undefined) throw new NotFoundError('Неизвестный домен');
  return domain;
}

export async function adminSenderLogoRoutes(
  app: FastifyInstance,
  getService: () => SenderLogoService,
): Promise<void> {
  const ctx = app.adminCtx;

  /** Список доменов и того, что про них известно. */
  app.get('/sender-logos', { preHandler: requireAdmin(app, 'branding.read') }, async (request) => {
    const query = listQuery.parse(request.query);
    const service = getService();
    const found = await service.overrides.list({
      ...(query.q === undefined ? {} : { query: query.q.toLowerCase() }),
      limit: query.limit,
      offset: query.offset,
    });
    return {
      ...found,
      limit: query.limit,
      offset: query.offset,
      /* Пределы отдаём наружу, чтобы панель называла их ДО загрузки файла. */
      limits: {
        maxBytes: MANUAL_LOGO_LIMITS.maxBytes,
        maxBytesText: humanBytes(MANUAL_LOGO_LIMITS.maxBytes),
        minWidth: MANUAL_LOGO_LIMITS.minWidth,
        minHeight: MANUAL_LOGO_LIMITS.minHeight,
        maxWidth: MANUAL_LOGO_LIMITS.maxWidth,
        maxHeight: MANUAL_LOGO_LIMITS.maxHeight,
      },
    };
  });

  /**
   * Предпросмотр действующей картинки домена.
   *
   * Заголовки — те же, что и в почте: файл может оказаться чужим SVG,
   * и в панели он ничуть не безопаснее, чем в списке писем.
   */
  app.get<{ Params: { domain: string }; Querystring: { v?: string } }>(
    '/sender-logos/:domain/image',
    { preHandler: requireAdmin(app, 'branding.read') },
    async (request, reply) => {
      const domain = domainParam(request.params.domain);
      const entry = await getService().image(domain);
      if (!entry?.bytes || !entry.mime) throw new NotFoundError('Логотип не найден');

      void reply
        .header('Content-Type', entry.mime)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .header('Content-Disposition', 'inline')
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .header('ETag', `"${entry.version}"`)
        .header('Cache-Control', 'private, max-age=60');
      return reply.send(entry.bytes);
    },
  );

  /** Загрузка своей картинки для домена (она же — замена). */
  app.post<{ Params: { domain: string } }>(
    '/sender-logos/:domain/image',
    {
      preHandler: requireAdmin(app, 'branding.write'),
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const domain = domainParam(request.params.domain);
      if (!request.isMultipart()) {
        throw new BadRequestError(
          'Файл не пришёл: картинка загружается формой multipart/form-data, поле «file».',
        );
      }

      // Свой предел на запрос плюс один байт — чтобы отличить «ровно предел»
      // от «больше предела» и сказать это человеку словами.
      const part = await request.file({
        limits: { fileSize: MANUAL_LOGO_LIMITS.maxBytes + 1, files: 1 },
        throwFileSizeLimit: false,
      });
      if (!part) throw new BadRequestError('В запросе нет файла.');

      const bytes = await part.toBuffer();
      if (part.file.truncated) {
        throw new BadRequestError(
          `Файл больше ${humanBytes(MANUAL_LOGO_LIMITS.maxBytes)} — столько логотип в кружке ` +
            'весить не может. Уменьшите картинку или сохраните её в PNG.',
        );
      }

      // Та же проверка, что у логотипа страницы входа: формат по содержимому,
      // SVG со скриптом отвергается целиком, отказ называет причину и предел.
      const info = inspectLogo(bytes, MANUAL_LOGO_LIMITS);
      const service = getService();
      await service.overrides.setImage(
        domain,
        { mime: info.mime, bytes, width: info.width, height: info.height },
        request.admin?.login ?? null,
      );
      service.forgetDomain(domain);

      await audit(ctx, request, {
        action: 'sender-logo.upload',
        targetType: 'domain',
        targetLabel: domain,
        before: null,
        after: { format: info.format, size: info.size, width: info.width, height: info.height },
      });
      return getService().adminState(domain);
    },
  );

  /**
   * Удаление ручной картинки: домен возвращается к найденной автоматически,
   * а НЕ к пустоте. Запрет, если он стоял, остаётся — это другое решение.
   */
  app.delete<{ Params: { domain: string } }>(
    '/sender-logos/:domain/image',
    { preHandler: requireAdmin(app, 'branding.write') },
    async (request) => {
      const domain = domainParam(request.params.domain);
      const service = getService();
      const before = await service.overrides.get(domain);
      if (!before?.bytes) {
        // Не ошибка: кнопку могли нажать дважды. Отвечаем состоянием.
        return service.adminState(domain);
      }
      await service.overrides.clearImage(domain, request.admin?.login ?? null);
      service.forgetDomain(domain);

      await audit(ctx, request, {
        action: 'sender-logo.reset',
        targetType: 'domain',
        targetLabel: domain,
        before: { manual: true },
        after: { manual: false },
      });
      return service.adminState(domain);
    },
  );

  /** Запрет логотипа домену — и снятие запрета. */
  app.put<{ Params: { domain: string } }>(
    '/sender-logos/:domain/blocked',
    { preHandler: requireAdmin(app, 'branding.write') },
    async (request) => {
      const domain = domainParam(request.params.domain);
      const { blocked } = blockedBody.parse(request.body);
      const service = getService();
      const before = await service.overrides.get(domain);
      await service.overrides.setBlocked(domain, blocked, request.admin?.login ?? null);
      service.forgetDomain(domain);

      await audit(ctx, request, {
        action: blocked ? 'sender-logo.block' : 'sender-logo.unblock',
        targetType: 'domain',
        targetLabel: domain,
        before: { blocked: before?.blocked ?? false },
        after: { blocked },
      });
      return service.adminState(domain);
    },
  );
}
