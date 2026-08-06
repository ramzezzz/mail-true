/**
 * Ошибки помощника на основе ИИ.
 *
 * Наследуются от общего ApiError, поэтому обрабатываются тем же единым
 * обработчиком, что и остальные ошибки API (см. app.ts).
 *
 * Отдельные коды нужны интерфейсу: «выключено администратором» и
 * «исчерпан предел расходов» — разные истории, и показывать их надо
 * по-разному. Первую вообще показывать не надо: кнопок быть не должно.
 */
import { ApiError } from '../errors.js';
import type { AiError } from '@mail-true/ai';

/** Администратор домена запретил ИИ. Интерфейс не должен показывать кнопки. */
export class AiDisabledError extends ApiError {
  constructor(message = 'Помощник на основе ИИ выключен администратором домена') {
    super(403, 'AI_DISABLED', message);
  }
}

/** Пользователь ещё не дал согласие — надо показать экран согласия. */
export class AiConsentRequiredError extends ApiError {
  constructor(message = 'Нужно ваше согласие: помощник отправляет текст письма сервису ИИ') {
    super(403, 'AI_CONSENT_REQUIRED', message);
  }
}

/** Возможность выключена самим пользователем или запрещена по домену. */
export class AiFeatureOffError extends ApiError {
  constructor(message = 'Эта возможность помощника выключена') {
    super(403, 'AI_FEATURE_OFF', message);
  }
}

/** Настройки есть, но неполные или база недоступна. */
export class AiUnavailableError extends ApiError {
  constructor(message = 'Помощник на основе ИИ не настроен') {
    super(503, 'AI_UNAVAILABLE', message);
  }
}

/** Исчерпан предел расходов или частоты. */
export class AiBudgetExceededError extends ApiError {
  constructor(message: string) {
    super(429, 'AI_BUDGET_EXCEEDED', message);
  }
}

/** Сервис ИИ не ответил или ответил невнятно. Почта при этом работает. */
export class AiUpstreamError extends ApiError {
  constructor(message: string) {
    super(502, 'AI_UPSTREAM', message);
  }
}

/**
 * Превращает отказ помощника в ошибку HTTP.
 *
 * Пакет @mail-true/ai не бросает исключений — он возвращает описание
 * причины. Здесь это описание один раз переводится в язык HTTP,
 * чтобы маршруты не повторяли одно и то же.
 */
export function aiErrorToHttp(error: AiError): ApiError {
  switch (error.kind) {
    case 'disabled':
      return new AiDisabledError(error.message);
    case 'not-configured':
      return new AiUnavailableError(error.message);
    case 'invalid-input':
      return new ApiError(400, 'AI_INVALID_INPUT', error.message);
    case 'budget-exceeded':
    case 'rate-limited':
      return new AiBudgetExceededError(error.message);
    case 'aborted':
      return new ApiError(499, 'AI_ABORTED', error.message);
    case 'timeout':
    case 'network':
    case 'http':
    case 'bad-response':
      return new AiUpstreamError(error.message);
    default:
      return new AiUpstreamError(error.message);
  }
}
