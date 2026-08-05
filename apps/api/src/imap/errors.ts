/**
 * Разбор ошибок IMAP: отличаем отказ по паролю от временной недоступности.
 *
 * Зачем отдельный модуль. Раньше признаком «неверный пароль» считалось само
 * наличие поля `authenticationFailed` у ошибки. Но imapflow ставит это поле на
 * ЛЮБУЮ неудачу команды LOGIN — в том числе когда Dovecot обрывает соединение
 * ответом `* BYE ... Maximum number of connections from user+IP exceeded`.
 * В результате при упоре в предел соединений вход становился невозможен вовсе:
 * на верный пароль приходило «Неверный адрес или пароль», пользователь начинал
 * перебирать пароли и упирался ещё и в ограничение попыток.
 *
 * Правило теперь обратное по умолчанию: ошибка считается отказом по паролю,
 * только если сервер прямо это сказал (код ответа `AUTHENTICATIONFAILED` и
 * родственные либо соответствующий текст). Всё остальное — временная
 * недоступность, то есть 503, которая никого не запирает снаружи.
 */
import { AuthFailedError, UpstreamUnavailableError, type ApiError } from '../errors.js';

/** Что произошло с IMAP-соединением. */
export type ImapFailureKind = 'auth' | 'unavailable';

interface ImapErrorLike {
  authenticationFailed?: unknown;
  serverResponseCode?: unknown;
  responseText?: unknown;
  response?: unknown;
  code?: unknown;
  message?: unknown;
}

/** Коды ответа IMAP, которые действительно означают отказ по учётным данным. */
const AUTH_RESPONSE_CODES = new Set([
  'AUTHENTICATIONFAILED',
  'AUTHORIZATIONFAILED',
  'EXPIRED',
  'PRIVACYREQUIRED',
]);

/** Коды ответа IMAP, означающие «сервер сейчас не может», а не «пароль не тот». */
const TRANSIENT_RESPONSE_CODES = new Set([
  'UNAVAILABLE',
  'LIMIT',
  'SERVERBUG',
  'INUSE',
  'CONTACTADMIN',
  'OVERQUOTA',
  'ALERT',
]);

/** Коды ошибок самого imapflow/сокета — это всегда про связь, не про пароль. */
const CONNECTION_ERROR_CODES = new Set([
  'NoConnection',
  'EConnectionClosed',
  'ClosedAfterConnectTLS',
  'ClosedAfterConnectText',
  'StateLogout',
  'ETIMEOUT',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ETHROTTLE',
  'ProxyError',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/** Отказ по пределу числа соединений — самая вредная маскировка под пароль. */
const CONNECTION_LIMIT_RE =
  /maximum number of connections|too many connections|connection limit|too many simultaneous/i;

/** Текст, которым сервер говорит именно про учётные данные. */
const AUTH_TEXT_RE = /authentication failed|invalid credentials|login failed|authentication failure/i;

function textOf(err: ImapErrorLike): string {
  return [err.response, err.responseText, err.message]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
}

function codeOf(err: ImapErrorLike): string {
  return typeof err.code === 'string' ? err.code : '';
}

/** Разорвано ли соединение (в том числе «Connection not available» из очереди). */
export function isConnectionLost(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as ImapErrorLike;
  if (CONNECTION_ERROR_CODES.has(codeOf(e))) return true;
  const text = textOf(e);
  return /connection not available|connection closed|socket (?:closed|hang up)|read ECONNRESET/i.test(
    text
  );
}

/**
 * Что за отказ: пароль или недоступность.
 * По умолчанию — недоступность: ошибочно объявить пароль неверным дороже,
 * чем ошибочно сказать «сервер недоступен».
 */
export function classifyImapError(err: unknown): ImapFailureKind {
  if (!err || typeof err !== 'object') return 'unavailable';
  const e = err as ImapErrorLike;
  const text = textOf(e);

  // Предел соединений Dovecot приходит вместе с authenticationFailed — и это
  // первое, что нужно отсечь: иначе вход блокируется до истечения таймаутов.
  if (CONNECTION_LIMIT_RE.test(text)) return 'unavailable';

  const responseCode =
    typeof e.serverResponseCode === 'string' ? e.serverResponseCode.toUpperCase() : '';
  if (responseCode && TRANSIENT_RESPONSE_CODES.has(responseCode)) return 'unavailable';
  if (responseCode && AUTH_RESPONSE_CODES.has(responseCode)) return 'auth';

  if (CONNECTION_ERROR_CODES.has(codeOf(e))) return 'unavailable';
  if (isConnectionLost(e)) return 'unavailable';

  // Поле authenticationFailed само по себе ничего не доказывает: нужен ещё
  // внятный текст сервера про учётные данные.
  if (e.authenticationFailed && AUTH_TEXT_RE.test(text)) return 'auth';

  return 'unavailable';
}

/** Переводит ошибку IMAP в ошибку API по контракту (401 AUTH_FAILED / 503). */
export function toApiError(err: unknown): ApiError {
  return classifyImapError(err) === 'auth' ? new AuthFailedError() : new UpstreamUnavailableError();
}
