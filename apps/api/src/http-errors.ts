/**
 * Единый вид ошибки API.
 *
 * Контракт (docs/api.md) — `{error: КОД, message: «текст по-русски»}`, и он
 * должен соблюдаться всегда, а не только там, где ошибку бросили мы сами.
 * Раньше ошибки самого Fastify выпадали мимо контракта: наружу уходили
 * английские тексты и коды, которых в документации нет вовсе —
 * `FST_ERR_CTP_BODY_TOO_LARGE`, `FST_REQ_FILE_TOO_LARGE`,
 * `FST_ERR_CTP_EMPTY_JSON_BODY`, ограничение частоты. Отдельно выделялся
 * `FST_ERR_MAX_PARAM_LENGTH`: он вообще не доходил до обработчика ошибок и
 * отдавал другую форму тела (`{statusCode, error, message}`), а интерфейс
 * читает поле `error` как код — то есть показывал пользователю «Not Found»
 * в качестве кода ошибки.
 */
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ApiError, RateLimitedError } from './errors.js';
import { errorForLog } from './log.js';

export interface ErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

export interface MappedError {
  status: number;
  body: ErrorBody;
}

/** Коды Fastify -> коды контракта. */
const FASTIFY_CODES: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: {
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Запрос слишком большой',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'Неподдерживаемый тип содержимого',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    status: 400,
    code: 'BAD_REQUEST',
    message: 'Пустое тело запроса',
  },
  FST_ERR_CTP_INVALID_JSON_BODY: {
    status: 400,
    code: 'BAD_REQUEST',
    message: 'Тело запроса не является корректным JSON',
  },
  /*
   * Эта ошибка возникает по ДВУМ разным причинам, и различить их изнутри
   * нельзя: тело действительно не той длины, что заявлено в заголовке, —
   * или тело не в кодировке UTF-8. Во втором случае разбор превращает
   * недопустимые байты в символ замены, длина в байтах вырастает, и
   * несовпадение находит уже сверка длины.
   *
   * Прежний текст говорил только про длину — и уводил разбирающегося не туда:
   * человек проверяет заголовок Content-Length, тот в порядке, и дальше
   * искать негде. На этом потерялось время дважды за один день, у двоих
   * независимо. Поэтому текст называет обе причины, а вторую — первой:
   * длину клиенты считают сами и ошибаются в ней почти никогда, а вот
   * прислать текст не в UTF-8 — обычное дело.
   */
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    status: 400,
    code: 'BAD_REQUEST',
    message:
      'Тело запроса не удалось прочитать: оно должно быть в кодировке UTF-8, ' +
      'а его длина — совпадать с заголовком Content-Length',
  },
  FST_ERR_BAD_URL: { status: 400, code: 'BAD_REQUEST', message: 'Некорректный адрес запроса' },
  FST_ERR_MAX_PARAM_LENGTH: {
    status: 400,
    code: 'BAD_REQUEST',
    message: 'Слишком длинный параметр в адресе запроса',
  },
  FST_ERR_VALIDATION: {
    status: 400,
    code: 'VALIDATION',
    message: 'Некорректные данные запроса',
  },
  FST_REQ_FILE_TOO_LARGE: {
    status: 413,
    code: 'FILE_TOO_LARGE',
    message: 'Файл слишком большой',
  },
  FST_PARTS_LIMIT: { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Слишком много частей формы' },
  FST_FILES_LIMIT: { status: 413, code: 'FILE_TOO_LARGE', message: 'Слишком много файлов' },
  FST_FIELDS_LIMIT: { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Слишком много полей формы' },
  FST_INVALID_MULTIPART_CONTENT_TYPE: {
    status: 415,
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'Ожидается multipart/form-data',
  },
  FST_ERR_ROUTE_METHOD_NOT_SUPPORTED: {
    status: 405,
    code: 'METHOD_NOT_ALLOWED',
    message: 'Метод не поддерживается',
  },
};

/**
 * Русский текст ожидания для ограничения частоты запросов.
 *
 * `@fastify/rate-limit` подставляет в `context.after` строку из пакета `ms`,
 * то есть по-английски. Получалось наполовину переведённое сообщение:
 * «Слишком много запросов, попробуйте через 32 seconds». Берём численное
 * `context.ttl` (миллисекунды) и склоняем сами.
 */
export function retryAfterRu(ttlMs: number): string {
  const seconds = Math.max(1, Math.ceil((Number.isFinite(ttlMs) ? ttlMs : 0) / 1000));
  const plural = (n: number, one: string, few: string, many: string): string => {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return many;
    const mod10 = n % 10;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  };
  if (seconds < 60) {
    return `${String(seconds)} ${plural(seconds, 'секунду', 'секунды', 'секунд')}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${String(minutes)} ${plural(minutes, 'минуту', 'минуты', 'минут')}`;
}

/**
 * Ошибка ограничения частоты для `errorResponseBuilder` плагина.
 * Живёт здесь, а не в app.ts, чтобы текст можно было проверить тестом.
 */
export function rateLimitedError(context: { ttl: number }): RateLimitedError {
  return new RateLimitedError(
    `Слишком много запросов, попробуйте через ${retryAfterRu(context.ttl)}`
  );
}

/** Тело ответа «не найдено» — им же отвечает и обработчик несуществующих путей. */
export function notFoundBody(): ErrorBody {
  return { error: 'NOT_FOUND', message: 'Ресурс не найден' };
}

/** Приводит любую ошибку к контракту `{error, message, details?}`. */
export function mapFrameworkError(error: unknown): MappedError {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: 'VALIDATION',
        message: 'Некорректные данные запроса',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  }

  if (error instanceof ApiError) {
    const body: ErrorBody = { error: error.code, message: error.message };
    if (error.details !== undefined) body.details = error.details;
    return { status: error.statusCode, body };
  }

  const err = (error ?? {}) as { statusCode?: unknown; code?: unknown; message?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  const known = FASTIFY_CODES[code];
  if (known) {
    return { status: known.status, body: { error: known.code, message: known.message } };
  }

  const status = typeof err.statusCode === 'number' ? err.statusCode : 500;

  // Ограничение частоты запросов: @fastify/rate-limit не даёт стабильного
  // кода ошибки, зато статус у него всегда 429
  if (status === 429) {
    return {
      status,
      body: { error: 'RATE_LIMITED', message: 'Слишком много запросов, попробуйте позже' },
    };
  }
  if (status === 404) {
    return { status, body: notFoundBody() };
  }
  if (status >= 500) {
    // Наружу — ничего о внутренностях
    return { status: 500, body: { error: 'INTERNAL', message: 'Внутренняя ошибка сервера' } };
  }

  return {
    status,
    body: {
      error: 'BAD_REQUEST',
      message: typeof err.message === 'string' && err.message ? err.message : 'Ошибка запроса',
    },
  };
}

/**
 * Вешает на приложение единый обработчик ошибок и обработчик несуществующих
 * путей. Вынесено сюда, чтобы маршруты можно было проверять тестами вместе
 * с тем же самым переводом ошибок, который работает в бою.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const { status, body } = mapFrameworkError(error);
    if (status >= 500) {
      // Не `{err: error}`: стандартный сериализатор pino выложил бы в строку
      // все поля объекта ошибки. У imapflow среди них лежит текст команды —
      // и одна запись про «Too long argument» весила 225 КБ.
      request.log.error(errorForLog(error), 'Внутренняя ошибка сервера');
    }
    return reply.status(status).send(body);
  });

  // Несуществующий путь тоже отвечает по контракту. Отдельно это важно для
  // FST_ERR_MAX_PARAM_LENGTH: слишком длинный параметр в адресе до маршрута
  // не доходит, и раньше клиент получал совсем другую форму тела
  // (`{statusCode, error: 'Not Found', message}`), а интерфейс читает поле
  // `error` как код ошибки.
  app.setNotFoundHandler((_request, reply) => reply.status(404).send(notFoundBody()));
}
