/** Прикладные ошибки API с HTTP-статусами. */

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Необязательные подробности — уходят в поле `details` ответа. */
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Требуется вход в систему') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class AuthFailedError extends ApiError {
  constructor(message = 'Неверный адрес или пароль') {
    super(401, 'AUTH_FAILED', message);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Не найдено') {
    super(404, 'NOT_FOUND', message);
  }
}

export class BadRequestError extends ApiError {
  /**
   * `details` — не украшение. По ним окно написания чинит письмо само:
   * так приезжают, например, номера картинок, которых уже нет на сервере,
   * и окно убирает их из тела, а не оставляет человека с отказом, из
   * которого нет выхода.
   */
  constructor(message = 'Некорректный запрос', details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class UpstreamUnavailableError extends ApiError {
  /**
   * `details` нужен отправке: при временном отказе письмо сохраняется
   * в черновиках, и его идентификатор должен дойти до интерфейса — иначе
   * человек не найдёт свой текст (см. routes/compose.ts).
   */
  constructor(message = 'Почтовый сервер недоступен', details?: unknown) {
    super(503, 'UPSTREAM_UNAVAILABLE', message, details);
  }
}

/** Тело запроса больше допустимого (в том числе HTML письма со вставками). */
export class PayloadTooLargeError extends ApiError {
  constructor(message = 'Запрос слишком большой', details?: unknown) {
    super(413, 'PAYLOAD_TOO_LARGE', message, details);
  }
}

/** Загружаемый файл больше UPLOAD_MAX_BYTES. */
export class FileTooLargeError extends ApiError {
  constructor(message = 'Файл слишком большой', details?: unknown) {
    super(413, 'FILE_TOO_LARGE', message, details);
  }
}

/** Собранное письмо не пройдёт через почтовый сервер по размеру. */
export class MessageTooLargeError extends ApiError {
  constructor(message = 'Письмо слишком большое', details?: unknown) {
    super(413, 'MESSAGE_TOO_LARGE', message, details);
  }
}

/**
 * Постоянный отказ SMTP: получатель не существует, письмо слишком велико и
 * тому подобное. Это НЕ недоступность сервера: повторять бессмысленно,
 * поэтому и код не 503.
 */
export class SendRejectedError extends ApiError {
  constructor(message = 'Письмо не принято почтовым сервером', details?: unknown) {
    super(400, 'SEND_REJECTED', message, details);
  }
}

/** Превышено ограничение частоты запросов. */
export class RateLimitedError extends ApiError {
  constructor(message = 'Слишком много запросов, попробуйте позже') {
    super(429, 'RATE_LIMITED', message);
  }
}

/** Неподдерживаемый тип содержимого запроса. */
export class UnsupportedMediaTypeError extends ApiError {
  constructor(message = 'Неподдерживаемый тип содержимого') {
    super(415, 'UNSUPPORTED_MEDIA_TYPE', message);
  }
}
