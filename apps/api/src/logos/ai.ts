/**
 * Помощник ИИ как ТРЕТИЙ источник логотипа.
 *
 * ------------------------------------------------------------------
 * Почему не первый, хотя заказчик просил «чтобы ИИ искал логотипы»
 * ------------------------------------------------------------------
 * Просьба понятна и выполнена, но порядок источников выбран обратный, и вот
 * почему.
 *
 * BIMI — это запись, которую владелец домена сделал В СВОЕЙ ЗОНЕ DNS сам,
 * специально для почты. Она даёт ТОЧНЫЙ ответ за один запрос и бесплатно.
 * Значок сайта — тот же фирменный знак, взятый с САМОГО домена. Оба ответа
 * проверяемы: при разборе жалобы видно, откуда картинка.
 *
 * Модель же не «знает» логотипы — она порождает правдоподобный текст. На
 * вопрос «где логотип домена sberbank-security.xyz» она с высокой
 * вероятностью назовёт настоящий Сбербанк, потому что так похоже. Ответ
 * будет уверенным, красивым и приведёт ровно к тому, от чего эта задача
 * защищается: чужой логотип рядом с письмом мошенника. Плюс это деньги и
 * секунды на каждый незнакомый домен, которых у BIMI не стоит.
 *
 * ------------------------------------------------------------------
 * Чем ИИ здесь всё-таки полезен и как он ограничен
 * ------------------------------------------------------------------
 * Есть настоящий случай, где первые два источника молчат, а логотип есть:
 * сайт собран на JavaScript, и в HTML, который приходит с сервера, тегов
 * <link rel="icon"> нет — они появляются позже, уже в браузере. Модель,
 * видевшая устройство таких сайтов, часто знает обычные адреса
 * (`/static/logo.png`, `/assets/img/logo.svg`).
 *
 * Поэтому ответ модели принимается ТОЛЬКО если он указывает внутрь ТОГО ЖЕ
 * домена (или его поддомена). Назвала чужой сайт — ответ отбрасывается
 * молча. Это ограничение снимает главный риск целиком: что бы модель ни
 * выдумала, картинка всё равно приедет с сервера самого отправителя.
 *
 * Источник включается, только когда помощник ИИ включён администратором
 * домена (AiService.availability) — как и все прочие его возможности.
 */
import { CompatibleChatProvider, parseProviderConfig } from '@mail-true/ai';
import type { Logger } from 'pino';
import type { AiService } from '../ai/service.js';
import { domainsAligned } from '../mail/sender-auth.js';
import type { LogoHintProvider } from './sources.js';

/** Предел ответа. Нам нужен один адрес, а не рассказ о компании. */
const MAX_ANSWER_TOKENS = 60;

const SYSTEM_PROMPT =
  'Ты помогаешь почтовому серверу найти файл логотипа компании на её собственном сайте. ' +
  'Отвечай ОДНОЙ строкой — полным адресом https, ведущим на файл картинки ' +
  '(png, svg, jpg, webp, ico) ВНУТРИ указанного домена или его поддомена. ' +
  'Если не знаешь точного адреса, ответь одним словом: НЕТ. ' +
  'Не придумывай адреса на других доменах и ничего не поясняй.';

export class AiLogoHints implements LogoHintProvider {
  readonly #ai: AiService;
  readonly #email: string;
  readonly #logger: Logger;

  /**
   * @param email ящик, от имени которого спрашиваем: настройки и ключ ИИ
   *              заданы на его домен, а не глобально
   */
  constructor(init: { ai: AiService; email: string; logger: Logger }) {
    this.#ai = init.ai;
    this.#email = init.email;
    this.#logger = init.logger;
  }

  async hint(domain: string): Promise<string | null> {
    let availability;
    try {
      availability = await this.#ai.availability(this.#email);
    } catch {
      return null;
    }
    if (!availability.available || !availability.domain) return null;

    const settings = availability.domain;
    if (!settings.baseUrl || !settings.model) return null;

    let apiKey: string | null = null;
    if (settings.apiKeyEnc) {
      const box = this.#ai.keyBox;
      if (!box) return null;
      try {
        apiKey = box.decrypt(settings.apiKeyEnc);
      } catch {
        return null;
      }
    }

    const parsed = parseProviderConfig({
      enabled: true,
      baseUrl: settings.baseUrl,
      chatPath: settings.chatPath,
      model: settings.model,
      providerLabel: settings.providerLabel,
      local: settings.local,
      timeoutMs: settings.timeoutMs,
      maxOutputTokens: settings.maxOutputTokens,
      ...(apiKey === null ? {} : { apiKey }),
    });
    if (!parsed.ok) return null;

    const provider = new CompatibleChatProvider(parsed.config);
    const outcome = await provider.chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Домен: ${domain}` },
      ],
      // Ноль намеренно: гадание здесь не нужно, нужен либо известный
      // адрес, либо честное «НЕТ».
      temperature: 0,
      maxTokens: MAX_ANSWER_TOKENS,
    });
    if (!outcome.ok) return null;

    const url = sameDomainImageUrl(outcome.value.text, domain);
    if (url === null) {
      this.#logger.debug({ domain }, 'Подсказка ИИ по логотипу отброшена');
    }
    return url;
  }
}

/**
 * Достаёт из ответа модели адрес, которому можно верить.
 *
 * Отбрасывается всё, что не является ссылкой https внутрь того же домена.
 * Вынесено отдельно и покрыто тестами: это единственное место, где решение
 * принимается по тексту, порождённому моделью.
 */
export function sameDomainImageUrl(answer: string, domain: string): string | null {
  const found = /https:\/\/[^\s"'<>)\]]+/iu.exec(answer.trim());
  if (!found) return null;

  let url: URL;
  try {
    url = new URL(found[0]);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase().replace(/\.+$/u, '');
  // Главное ограничение: картинка обязана лежать у САМОГО отправителя.
  if (!domainsAligned(host, domain.toLowerCase())) return null;

  return url.toString();
}
