/**
 * Разбор результата и ошибок отправки через SMTP submission.
 *
 * Два разобранных дефекта живут здесь:
 *
 *  1. Частичный отказ получателей проглатывался. Маршрут отправки не смотрел
 *     поле `rejected` результата: письмо на два адреса, один из которых не
 *     существует, отвечало `{"ok":true}` — при том, что Postfix отверг
 *     получателя с `550 User unknown`. Пользователю сказано, что письмо ушло
 *     всем; узнать правду ему неоткуда.
 *
 *  2. Постоянный отказ SMTP (550/552) выдавался как `503 UPSTREAM_UNAVAILABLE`
 *     «почтовый сервер недоступен». Это неправда дважды: сервер доступен и
 *     ответил, а повтор не поможет никогда. Письмо при этом терялось целиком.
 */

/** Отклонённый получатель с причиной от сервера. */
export interface RejectedRecipient {
  address: string;
  /** Код ответа SMTP, если сервер его сообщил (550, 552, ...). */
  code: number | null;
  message: string;
}

export interface SendOutcome {
  accepted: string[];
  rejected: RejectedRecipient[];
}

interface RejectedErrorLike {
  recipient?: unknown;
  responseCode?: unknown;
  response?: unknown;
  message?: unknown;
}

function addressOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const address = (value as { address?: unknown }).address;
    if (typeof address === 'string') return address;
  }
  return '';
}

function textOf(err: RejectedErrorLike): string {
  if (typeof err.response === 'string' && err.response.trim()) return err.response.trim();
  if (typeof err.message === 'string' && err.message.trim()) return err.message.trim();
  return 'Получатель отклонён почтовым сервером';
}

/** Разбирает ответ nodemailer: кого приняли, кого отвергли и почему. */
export function readSendOutcome(info: unknown): SendOutcome {
  const src = (info ?? {}) as {
    accepted?: unknown;
    rejected?: unknown;
    rejectedErrors?: unknown;
  };
  const accepted = Array.isArray(src.accepted) ? src.accepted.map(addressOf).filter(Boolean) : [];
  const rejectedAddresses = Array.isArray(src.rejected)
    ? src.rejected.map(addressOf).filter(Boolean)
    : [];
  const errors = Array.isArray(src.rejectedErrors)
    ? (src.rejectedErrors as RejectedErrorLike[])
    : [];

  const byAddress = new Map<string, RejectedErrorLike>();
  for (const err of errors) {
    const address = addressOf(err.recipient);
    if (address) byAddress.set(address.toLowerCase(), err);
  }

  const rejected: RejectedRecipient[] = rejectedAddresses.map((address) => {
    const err = byAddress.get(address.toLowerCase());
    return {
      address,
      code: err && typeof err.responseCode === 'number' ? err.responseCode : null,
      message: err ? textOf(err) : 'Получатель отклонён почтовым сервером',
    };
  });

  // Отказ мог прийти и без перечисления адресов в `rejected`
  for (const err of errors) {
    const address = addressOf(err.recipient);
    if (!address) continue;
    if (rejected.some((r) => r.address.toLowerCase() === address.toLowerCase())) continue;
    rejected.push({
      address,
      code: typeof err.responseCode === 'number' ? err.responseCode : null,
      message: textOf(err),
    });
  }

  return { accepted, rejected };
}

export interface SmtpFailure {
  /** Повтор не поможет: сервер ответил постоянным отказом. */
  permanent: boolean;
  /** Отказ именно из-за размера письма. */
  tooLarge: boolean;
  code: number | null;
  message: string;
  rejected: RejectedRecipient[];
}

/** Коды ошибок nodemailer, означающие проблему со связью, а не отказ сервера. */
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENOTFOUND',
]);

/** Разбирает ошибку отправки: постоянный отказ или временная недоступность. */
export function classifySmtpError(err: unknown): SmtpFailure {
  const e = (err ?? {}) as {
    responseCode?: unknown;
    response?: unknown;
    message?: unknown;
    code?: unknown;
  };
  const code = typeof e.responseCode === 'number' ? e.responseCode : null;
  const response = typeof e.response === 'string' ? e.response : '';
  const message = typeof e.message === 'string' ? e.message : '';
  const text = `${response} ${message}`;
  const transport = typeof e.code === 'string' && TRANSPORT_ERROR_CODES.has(e.code);

  const permanent = !transport && code !== null && code >= 500 && code < 600;
  const tooLarge =
    permanent &&
    (code === 552 ||
      code === 523 ||
      /message (?:file )?too (?:big|large)|size limit exceeded|exceeds .* size/i.test(text));

  const { rejected } = readSendOutcome(err);

  let humanMessage: string;
  if (tooLarge) {
    humanMessage = 'Письмо слишком большое для почтового сервера';
  } else if (rejected.length > 0) {
    humanMessage = `Почтовый сервер отклонил получателей: ${rejected
      .map((r) => r.address)
      .join(', ')}`;
  } else if (permanent) {
    humanMessage = `Почтовый сервер отклонил письмо${code ? ` (код ${code})` : ''}`;
  } else {
    humanMessage = 'Не удалось отправить письмо';
  }

  return { permanent, tooLarge, code, message: humanMessage, rejected };
}
