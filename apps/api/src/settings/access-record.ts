/**
 * Запись событий в историю ящика — сторона тех, кто пишет.
 *
 * Крошечный отдельный модуль намеренно: писать в историю должны маршруты,
 * которые к разделу настроек отношения не имеют (вход и выход из почты
 * живут в routes/auth.ts), а тянуть ради этого весь раздел настроек с его
 * подключением к базе и хранилищем Sieve они не должны.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЗАПИСЬ НИКОГДА НЕ МЕШАЕТ ДЕЙСТВИЮ
 * ------------------------------------------------------------------
 * `record` ничего не возвращает и ничего не бросает. Это не небрежность,
 * а требование: история — вещь полезная, но не та, ради которой человек
 * не должен войти в почту. Лежащий Postgres обязан стоить строки в
 * журнале сервера, а не отказа во входе.
 */
import type { AccessChannel } from './access-log.js';
import type { AccessKind } from './owner-db.js';

export interface AccessRecordInput {
  accountEmail: string;
  kind: AccessKind;
  /** Удачно или нет. По умолчанию — удачно. */
  success?: boolean;
  channel?: AccessChannel;
  ip: string | null;
  userAgent: string | null;
  /** Короткое пояснение по-русски; пишет код, а не пользователь. */
  detail: string;
}

export interface AccessRecorder {
  /** Пишет событие. Никогда не бросает и никого не ждёт. */
  record(input: AccessRecordInput): void;
}

/** Откуда пришёл запрос — в том виде, в каком это ложится в историю. */
export interface RequestOrigin {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Адрес и программа из запроса.
 *
 * `request.ip` у Fastify — это уже разобранный X-Forwarded-For, но ТОЛЬКО
 * если заголовок пришёл от доверенного прокси (TRUSTED_PROXIES, см.
 * app.ts). Именно поэтому здесь ничего не разбирается вручную: своя
 * разборка заголовка означала бы, что в историю ложится любой адрес,
 * какой пожелает написать клиент, — то есть журнал, который ничего
 * не доказывает.
 */
export function originOf(request: {
  ip?: string;
  headers: Record<string, unknown>;
}): RequestOrigin {
  const agent = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    userAgent: typeof agent === 'string' ? agent.slice(0, 512) : null,
  };
}
