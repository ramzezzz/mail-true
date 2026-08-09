/**
 * Ошибки админки. Наследуются от общего ApiError, поэтому обрабатываются
 * тем же единым обработчиком, что и остальные ошибки API.
 */
import { ApiError } from '../errors.js';

/** Нет прав на действие. Отличается от 401: сессия есть, но роль не позволяет. */
export class ForbiddenError extends ApiError {
  constructor(message = 'Недостаточно прав для этого действия') {
    super(403, 'FORBIDDEN', message);
  }
}

/** Конфликт: адрес занят, домен уже есть и т. п. */
export class ConflictError extends ApiError {
  constructor(message = 'Объект с такими данными уже существует') {
    super(409, 'CONFLICT', message);
  }
}

/** Админка не настроена (нет подключения к базе или мастер-доступа Dovecot). */
export class AdminUnavailableError extends ApiError {
  /**
   * `details` — техническая причина (например, текст отказа Postgres).
   * Нужен разделу «Наблюдение»: 503 говорит «зависимость отвалилась», а
   * что именно, администратор должен прочитать, не идя в журнал сервера.
   */
  constructor(message = 'Админка не настроена', details?: unknown) {
    super(503, 'ADMIN_UNAVAILABLE', message, details);
  }
}

/** Слишком много неудачных попыток входа. */
export class LockedError extends ApiError {
  constructor(message = 'Учётная запись временно заблокирована') {
    super(423, 'LOCKED', message);
  }
}
