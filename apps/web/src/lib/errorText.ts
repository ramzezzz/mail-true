/**
 * Человеческий текст ошибки.
 *
 * Раньше ошибки либо терялись совсем (мутации не имели обработчика отказа),
 * либо попадали на экран через `String(error)` — пользователь видел строку
 * вида «ApiError: Не найдено» с именем класса. Здесь одно место, которое
 * превращает любую ошибку в текст, который не стыдно показать.
 */

import { isApiError, type ApiError } from '../api/http';

/** Сообщение по умолчанию, если о причине ничего не известно. */
const FALLBACK = 'Что-то пошло не так. Попробуйте ещё раз';

/** Заглушка на случай, когда сервер о причине ничего внятного не сказал. */
const SERVER_FALLBACK = 'Сервер не отвечает. Попробуйте позже';

/**
 * Написан ли этот текст для человека — или это служебная строка.
 *
 * Нужно ради 5xx. Раньше ЛЮБОЙ ответ 500 и выше подменялся общей заглушкой
 * «Сервер не отвечает», хотя по 503 сервер присылает самое важное, что
 * человеку сейчас нужно знать: «Почтовый сервер сейчас недоступен, письмо
 * не отправлено. Текст сохранён в черновиках — попробуйте отправить ещё
 * раз» (apps/api/src/routes/compose.ts). Из заглушки не следует ни что
 * письмо цело, ни что его не надо набирать заново, — и человек отправлял
 * его повторно, а у получателя оказывался дубль.
 *
 * Показывать при этом можно не всё подряд. В `message` ошибки, когда своего
 * текста у сервера нет, оказывается либо машинный код (`INTERNAL_ERROR`),
 * либо `statusText` от fetch («Internal Server Error», «Bad Gateway») —
 * то есть строки, которые человеку не говорят ничего. Наши же тексты
 * написаны по-русски все до одного, поэтому русские буквы здесь и есть
 * признак «это писали для человека».
 */
function looksHuman(error: ApiError): boolean {
  const text = error.message.trim();
  if (text === '') return false;
  // Сервер прислал только код — http.ts подставляет его в message
  if (error.code !== null && text === error.code) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(text)) return false;
  return /[а-яё]/i.test(text);
}

/** Текст ошибки для пользователя — без имени класса и служебных кодов. */
export function errorText(error: unknown, fallback = FALLBACK): string {
  if (isApiError(error)) {
    if (error.status === 401) return 'Сессия закончилась — войдите заново';
    if (error.status === 403) return 'Недостаточно прав для этого действия';
    if (error.status === 404) return 'Не найдено на сервере';
    if (error.status === 429) return 'Слишком много запросов, подождите немного';
    // Свой текст сервера важнее общей заглушки — см. looksHuman
    if (error.status >= 500) return looksHuman(error) ? error.message.trim() : SERVER_FALLBACK;
    return error.message || fallback;
  }
  // fetch бросает TypeError, когда сети нет вовсе
  if (error instanceof TypeError) return 'Нет связи с сервером';
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** Отказ именно из-за отсутствия объекта, а не из-за сбоя. */
export function isNotFoundError(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

/** Отказ из-за незалогиненности: повторять запрос бессмысленно. */
export function isUnauthorizedError(error: unknown): boolean {
  return isApiError(error) && (error.status === 401 || error.status === 403);
}

/**
 * Текст отказа на экране входа.
 *
 * Здесь 401 значит не «сессия закончилась», а «не тот адрес или пароль»:
 * сессии ещё и не было.
 */
export function loginErrorText(error: unknown): string {
  if (isApiError(error) && error.status === 401) return 'Неверный адрес или пароль';
  return errorText(error, 'Не удалось войти');
}

/**
 * Текст отказа при добавлении второго ящика.
 *
 * Здесь 401 — тоже не «сессия закончилась»: сервер проверяет введённый
 * пароль настоящим IMAP-логином и отвечает
 * `401 {"error":"AUTH_FAILED","message":"Неверный адрес или пароль"}`.
 * Показываем ровно то, что сказал сервер, а не «что-то пошло не так».
 */
export function linkErrorText(error: unknown): string {
  if (isApiError(error) && error.status === 401) {
    return error.message || 'Неверный адрес или пароль';
  }
  return errorText(error, 'Не удалось добавить ящик');
}

/** Текст отказа мутации: «Не удалось …: причина». */
export function actionErrorText(action: string, error: unknown): string {
  return `${action}: ${errorText(error)}`;
}
