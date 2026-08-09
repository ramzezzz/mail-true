/**
 * Тексты ошибок.
 *
 * Раньше в списке писем на экран попадало `String(error)` — пользователь
 * видел «ApiError: Не найдено» вместе с именем класса, а на странице письма
 * любая беда объявлялась «Письмо не найдено», хотя причина могла быть совсем
 * другой (сеть, 500, истёкшая сессия).
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/http';
import {
  actionErrorText,
  errorText,
  isNotFoundError,
  isUnauthorizedError,
  loginErrorText,
} from '../src/lib/errorText';

describe('errorText', () => {
  it('не показывает имя класса исключения', () => {
    const error = new ApiError(404, '/api/messages/inbox:9', 'Письмо не найдено', 'NOT_FOUND');
    expect(String(error)).toContain('ApiError'); // так было на экране
    expect(errorText(error)).not.toContain('ApiError');
  });

  it('объясняет отказы понятными словами', () => {
    expect(errorText(new ApiError(401, '/api/folders', 'Unauthorized'))).toBe(
      'Сессия закончилась — войдите заново',
    );
    expect(errorText(new ApiError(403, '/api/folders', 'Forbidden'))).toBe(
      'Недостаточно прав для этого действия',
    );
    expect(errorText(new ApiError(500, '/api/folders', 'Boom'))).toBe(
      'Сервер не отвечает. Попробуйте позже',
    );
    expect(errorText(new ApiError(429, '/api/auth/login', 'Too many'))).toBe(
      'Слишком много запросов, подождите немного',
    );
  });

  it('сообщение сервера показывается как есть', () => {
    const error = new ApiError(
      400,
      '/api/messages/flags',
      'Не указано ни одного флага',
      'BAD_REQUEST',
    );
    expect(errorText(error)).toBe('Не указано ни одного флага');
  });

  it('401 от ЧУЖОГО сервера — не про нашу сессию, и говорит он своё', () => {
    /*
     * Отправка с подключённого чужого адреса: его SMTP не принял пароль
     * подключения (у почтовых служб он протухает сам, стоит включить
     * двухшаговый вход). Сервер отвечает 401 AUTH_FAILED и словами
     * говорит, что чинить. Заглушка «Сессия закончилась — войдите заново»
     * здесь врёт дважды: своя сессия цела (http.ts по этому же коду не
     * уводит на экран входа), а выходить и входить заново — бесполезно.
     */
    const error = new ApiError(
      401,
      '/api/accounts/external/7/send',
      'smtp.example не принял логин или пароль подключения — подключите ящик заново',
      'AUTH_FAILED',
    );
    expect(errorText(error)).toContain('подключите ящик заново');
    expect(errorText(error)).not.toContain('Сессия');
  });

  it('обрыв связи объясняется по-человечески', () => {
    expect(errorText(new TypeError('Failed to fetch'))).toBe('Нет связи с сервером');
  });

  it('о неизвестной ошибке говорит хоть что-то осмысленное', () => {
    expect(errorText(null)).toBe('Что-то пошло не так. Попробуйте ещё раз');
    expect(errorText(undefined, 'Не удалось войти')).toBe('Не удалось войти');
  });
});

describe('различение бед', () => {
  it('«нет письма» и «не смогли загрузить» — разные случаи', () => {
    expect(isNotFoundError(new ApiError(404, '/x', 'нет'))).toBe(true);
    expect(isNotFoundError(new ApiError(500, '/x', 'сбой'))).toBe(false);
    expect(isNotFoundError(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('отказ в доступе виден отдельно — его нет смысла повторять', () => {
    expect(isUnauthorizedError(new ApiError(401, '/x', 'войдите'))).toBe(true);
    expect(isUnauthorizedError(new ApiError(403, '/x', 'нельзя'))).toBe(true);
    expect(isUnauthorizedError(new ApiError(404, '/x', 'нет'))).toBe(false);
  });
});

describe('actionErrorText', () => {
  it('называет действие и причину', () => {
    // Причина — своими словами сервера: 5xx с человеческим текстом больше
    // не подменяется общей заглушкой (см. tests/serverErrorText.test.ts).
    const error = new ApiError(500, '/api/messages/move', 'Сервер недоступен');
    expect(actionErrorText('Не удалось переместить письма', error)).toBe(
      'Не удалось переместить письма: Сервер недоступен',
    );
  });

  it('а когда своих слов у сервера нет — общей заглушкой', () => {
    const error = new ApiError(500, '/api/messages/move', 'Internal Server Error');
    expect(actionErrorText('Не удалось переместить письма', error)).toBe(
      'Не удалось переместить письма: Сервер не отвечает. Попробуйте позже',
    );
  });
});

describe('loginErrorText', () => {
  it('401 на входе — это неверный пароль, а не истёкшая сессия', () => {
    expect(loginErrorText(new ApiError(401, '/api/auth/login', 'Unauthorized'))).toBe(
      'Неверный адрес или пароль',
    );
  });

  it('остальное объясняется как обычно', () => {
    expect(loginErrorText(new TypeError('Failed to fetch'))).toBe('Нет связи с сервером');
    expect(loginErrorText(new ApiError(429, '/api/auth/login', 'Too many'))).toBe(
      'Слишком много запросов, подождите немного',
    );
  });
});
