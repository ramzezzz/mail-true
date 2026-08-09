/**
 * Отказ сервера показывается СВОИМИ словами, когда они у сервера есть.
 *
 * Дефект, ради которого написано. Любой ответ 500 и выше подменялся общей
 * заглушкой «Сервер не отвечает. Попробуйте позже». А по 503 при отправке
 * письма сервер присылает ровно то, что человеку в эту секунду важнее
 * всего: «Почтовый сервер сейчас недоступен, письмо не отправлено. Текст
 * сохранён в черновиках — попробуйте отправить ещё раз»
 * (apps/api/src/routes/compose.ts).
 *
 * Из заглушки не следует ни того, что письмо цело, ни того, что набирать
 * его заново не нужно. Человек, потерявший, как ему кажется, письмо,
 * пишет и отправляет его второй раз — и у получателя оказывается дубль,
 * а в «Черновиках» лежит спасённый первый экземпляр.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/http';
import { actionErrorText, errorText } from '../src/lib/errorText';

const UNAVAILABLE =
  'Почтовый сервер сейчас недоступен, письмо не отправлено. ' +
  'Текст сохранён в черновиках — попробуйте отправить ещё раз.';

describe('5xx с осмысленным текстом', () => {
  it('503 при отправке письма говорит про спасённый черновик, а не «сервер не отвечает»', () => {
    const error = new ApiError(503, '/api/messages/send', UNAVAILABLE, 'UPSTREAM_UNAVAILABLE');
    expect(errorText(error)).toBe(UNAVAILABLE);
  });

  it('текст сервера доезжает и до подписи мутации', () => {
    const error = new ApiError(503, '/api/messages/send', UNAVAILABLE, 'UPSTREAM_UNAVAILABLE');
    expect(actionErrorText('Не удалось отправить письмо', error)).toContain('в черновиках');
  });

  it('500 с собственным объяснением тоже показывается как есть', () => {
    const error = new ApiError(
      500,
      '/api/settings',
      'Не удалось прочитать настройки: база данных недоступна',
      'INTERNAL_ERROR',
    );
    expect(errorText(error)).toBe('Не удалось прочитать настройки: база данных недоступна');
  });
});

describe('5xx без своих слов — общая заглушка', () => {
  const FALLBACK = 'Сервер не отвечает. Попробуйте позже';

  it('машинный код вместо текста человеку ничего не говорит', () => {
    // Так `http.ts` заполняет message, когда сервер прислал только код
    expect(errorText(new ApiError(500, '/api/folders', 'INTERNAL_ERROR', 'INTERNAL_ERROR'))).toBe(
      FALLBACK,
    );
  });

  it('statusText от fetch — тоже не текст для человека', () => {
    expect(errorText(new ApiError(502, '/api/folders', 'Bad Gateway'))).toBe(FALLBACK);
    expect(errorText(new ApiError(500, '/api/folders', 'Internal Server Error'))).toBe(FALLBACK);
  });

  it('пустое сообщение заменяется заглушкой', () => {
    expect(errorText(new ApiError(500, '/api/folders', '   '))).toBe(FALLBACK);
  });
});
