/**
 * Маршруты логотипов отправителей.
 *
 * ------------------------------------------------------------------
 * Почему картинка отдаётся С НАШЕГО адреса, а не ссылкой на чужой сайт
 * ------------------------------------------------------------------
 * Поставить в разметку `<img src="https://sberbank.ru/favicon.ico">` было бы
 * втрое короче и совершенно неприемлемо. Такая ссылка означает, что БРАУЗЕР
 * человека сам стучится к отправителю, стоит открыть список писем. Владелец
 * того сайта немедленно узнаёт:
 *
 *   * что его письмо сейчас читают (точное время, вплоть до «открыл и
 *     закрыл»);
 *   * с какого IP-адреса — то есть примерное местоположение читателя;
 *   * какой у него браузер и какие настройки — это готовый отпечаток;
 *   * а по заголовку Referer — и адрес страницы нашей почты.
 *
 * Ровно этим занимаются «пиксели слежения» в письмах, от которых почта
 * защищает: показывать содержимое только по кнопке. Ставить рядом такой же
 * маячок своими руками — значит открыть чёрный ход в собственной защите.
 *
 * Поэтому наружу ходит СЕРВЕР, кладёт картинку в общий кэш и отдаёт её со
 * своего адреса. Отправитель не узнаёт ни кто читает, ни когда, ни сколько
 * у нас пользователей: он видит один запрос от одного сервера раз в месяц.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../errors.js';
import { MAX_DOMAINS_PER_REQUEST, SenderLogoService } from './service.js';

const bodySchema = z.object({
  domains: z.array(z.unknown()).max(500),
});

/** Адрес картинки с отпечатком: смена логотипа меняет адрес, кэш не врёт. */
export function logoImageUrl(domain: string, version: string): string {
  return `/api/sender-logos/${encodeURIComponent(domain)}/image?v=${version}`;
}

export async function senderLogoRoutes(
  app: FastifyInstance,
  service: SenderLogoService,
): Promise<void> {
  /**
   * Состояние логотипов для списка доменов.
   *
   * POST, а не GET, намеренно: доменов бывает под шесть десятков, и в
   * строке адреса они и не помещаются, и попадают в журналы прокси — то
   * есть в чужой журнал попадал бы список тех, с кем человек переписывается.
   */
  app.post(
    '/sender-logos',
    {
      preHandler: app.requireSession,
      // Предел выше общего: интерфейс переспрашивает про домены, которые
      // ещё ищутся, и упереться в ограничитель на собственной странице
      // списка писем было бы стыдно.
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request) => {
      const session = request.mailSession;
      if (!session) throw new BadRequestError('Нет сессии');

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new BadRequestError(
          'Ожидался объект вида {"domains": ["example.com", …]} — не более ' +
            `${String(MAX_DOMAINS_PER_REQUEST)} доменов за раз.`,
        );
      }

      if (!service.enabled) {
        // Честный ответ вместо тишины: интерфейс должен знать, что искать
        // бесполезно, и не переспрашивать по кругу.
        return { enabled: false, logos: {} };
      }

      // Настройка человека: сервер не ходит наружу, пока он этого не
      // разрешил. Проверяется ЗДЕСЬ, а не только в интерфейсе, — иначе
      // достаточно было бы обратиться к маршруту напрямую.
      if (!(await userWantsLogos(app, session.email))) {
        return { enabled: false, logos: {} };
      }

      const domains = SenderLogoService.normalizeDomains(parsed.data.domains);
      const states = await service.resolve(domains, session.email);

      const logos: Record<string, unknown> = {};
      for (const [domain, state] of states) {
        logos[domain] =
          state.status === 'ready'
            ? {
                status: 'ready',
                url: logoImageUrl(domain, state.version),
                width: state.width,
                height: state.height,
                source: state.source,
              }
            : state;
      }
      return { enabled: true, logos };
    },
  );

  /**
   * Сама картинка. Заголовки — те же, что у логотипа входа
   * (admin/routes/branding.ts), и по тем же причинам, только строже:
   * здесь файл ЧУЖОЙ, скачанный с постороннего сервера.
   */
  app.get<{ Params: { domain: string }; Querystring: { v?: string } }>(
    '/sender-logos/:domain/image',
    {
      preHandler: app.requireSession,
      config: { rateLimit: { max: 300, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const [domain] = SenderLogoService.normalizeDomains([request.params.domain]);
      if (domain === undefined) throw new NotFoundError('Логотип не найден');

      const entry = await service.image(domain);
      if (!entry?.bytes || !entry.mime) throw new NotFoundError('Логотип не найден');

      void reply
        .header('Content-Type', entry.mime)
        // Тип содержимого угадывать нельзя: SVG, названный PNG, в режиме
        // угадывания стал бы документом с доступом к нашим cookie.
        .header('X-Content-Type-Options', 'nosniff')
        // Даже если файл откроют по прямому адресу отдельной вкладкой,
        // выполнять внутри него нечего: ни скриптов, ни внешних загрузок.
        // Для SVG это главная защита: содержимое пришло с чужого сервера.
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        // Скачано у постороннего — пусть и остаётся картинкой в кружке,
        // а не файлом, который куда-то встраивают.
        .header('Content-Disposition', 'inline')
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        // Адрес несёт отпечаток содержимого — ответ можно кэшировать
        // надолго, но ТОЛЬКО в браузере этого человека: `private` не даёт
        // общему прокси сложить у себя карту чужой переписки.
        .header('ETag', `"${entry.version}"`)
        .header(
          'Cache-Control',
          request.query.v === entry.version
            ? 'private, max-age=604800, immutable'
            : 'private, max-age=300',
        );

      if (request.headers['if-none-match'] === `"${entry.version}"`) {
        return reply.status(304).send();
      }
      return reply.send(entry.bytes);
    },
  );
}

/**
 * Разрешил ли человек показывать логотипы.
 *
 * Недоступная база настроек означает «не разрешал»: молчаливое включение
 * похода в интернет по умолчанию — ровно то, чего эта настройка не должна
 * допускать ни при каких сбоях.
 */
async function userWantsLogos(app: FastifyInstance, email: string): Promise<boolean> {
  const settings = app.settingsService;
  if (!settings.available) return false;
  try {
    return (await settings.requireDb().getSettings(email)).senderLogos;
  } catch {
    return false;
  }
}
