/**
 * Отправка сообщения службе доставки браузера.
 *
 * Один HTTP-запрос: зашифрованное тело, подпись VAPID и время жизни.
 * Всё остальное — разбор ответа, и он важнее самой отправки: служба
 * доставки отвечает 201 и на сообщение, которое браузер потом молча
 * выбросит, поэтому здесь различаются «не дошло сейчас» и «этой подписки
 * больше нет» — второе означает, что строку в базе надо удалить, иначе
 * сервер будет годами стучаться в закрытую дверь.
 */
import type { Logger } from 'pino';
import { encryptPushPayload, vapidAuthorization, type VapidKeys } from './crypto.js';
import { errorInfo } from '../log.js';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSendResult {
  ok: boolean;
  /** Код ответа службы доставки; 0 — до неё не дозвонились вовсе. */
  status: number;
  /**
   * Подписки больше нет: браузер удалён, разрешение отозвано, срок вышел.
   * Такую строку надо забыть — повторять по ней бессмысленно навсегда.
   */
  gone: boolean;
  error: string | null;
}

export interface SendPushOptions {
  target: PushTarget;
  payload: string;
  keys: VapidKeys;
  subject: string;
  /**
   * Сколько служба доставки держит сообщение, если устройство недоступно.
   * Сутки: письмо, о котором узнали через двое суток, — не новость, а шум.
   */
  ttlSeconds?: number;
  timeoutMs?: number;
  /**
   * Срочность. `normal` — доставить, когда устройство проснётся, не будя
   * его специально. Уведомление о письме не стоит того, чтобы сажать
   * батарею телефона; `high` оставляем на будущее для важных отправителей.
   */
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  logger?: Logger;
  /** Подмена для проверок: по умолчанию встроенный fetch. */
  fetchImpl?: typeof fetch;
}

export async function sendPush(options: SendPushOptions): Promise<PushSendResult> {
  const { target } = options;
  const doFetch = options.fetchImpl ?? fetch;

  let body: Buffer;
  let authorization: string;
  try {
    body = encryptPushPayload({
      keys: { p256dh: target.p256dh, auth: target.auth },
      payload: options.payload,
    });
    authorization = await vapidAuthorization({
      endpoint: target.endpoint,
      keys: options.keys,
      subject: options.subject,
    });
  } catch (err) {
    // Битые ключи подписки — это её конец: чинить нечего, и повторять
    // тоже. Обращаемся с ней так же, как с отозванной.
    options.logger?.warn(errorInfo(err), 'Подписку на уведомления не удалось зашифровать');
    return { ok: false, status: 0, gone: true, error: 'Подписка непригодна' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await doFetch(target.endpoint, {
      method: 'POST',
      headers: {
        // Формат тела. Устаревший aesgcm намеренно не поддерживаем:
        // его принимают ради браузеров до 2017 года.
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        TTL: String(options.ttlSeconds ?? 24 * 3600),
        Urgency: options.urgency ?? 'normal',
        Authorization: authorization,
      },
      body: new Uint8Array(body),
      signal: controller.signal,
    });

    if (response.ok) return { ok: true, status: response.status, gone: false, error: null };

    // 404 — подписки не существует, 410 — существовала и отозвана.
    // И то и другое навсегда; всё остальное имеет смысл повторить позже.
    const gone = response.status === 404 || response.status === 410;
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      status: response.status,
      gone,
      error: text.slice(0, 300) || `Служба доставки ответила ${String(response.status)}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Сеть или таймаут: сервер мог остаться без интернета, а служба
    // доставки — лежать. Подписка при этом цела.
    return { ok: false, status: 0, gone: false, error: message.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
