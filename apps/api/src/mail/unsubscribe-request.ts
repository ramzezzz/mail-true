/**
 * ВЫПОЛНЕНИЕ отписки от рассылки.
 *
 * Разбор заголовков живёт рядом (unsubscribe.ts) и не знает ни про сеть,
 * ни про SMTP. Здесь — вторая половина: сам запрос наружу.
 *
 * Отдельным файлом это стало, когда отписка понадобилась в двух местах:
 * из открытого письма (`POST /api/messages/:id/unsubscribe`) и пачкой из
 * разбора рассылок (`POST /api/mailings/unsubscribe`). Копия здесь была
 * бы худшим из возможных решений: в этом коде живут проверки от SSRF, и
 * разойдись две копии — вторая точка входа однажды осталась бы без них.
 */
import { lookup } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { ApiError, BadRequestError, UpstreamUnavailableError } from '../errors.js';
import { errorInfo } from '../log.js';
import {
  isPrivateAddress,
  isSafeUnsubscribeUrl,
  parseUnsubscribe,
  type MailtoUnsubscribe,
} from './unsubscribe.js';

/** Сколько ждём ответа от адреса отписки. */
export const UNSUBSCRIBE_TIMEOUT_MS = 8000;

export interface UnsubscribeLog {
  warn: (obj: unknown, msg: string) => void;
}

/**
 * Шлёт POST по адресу отписки (RFC 8058).
 *
 * Адрес пришёл из письма, то есть от кого угодно, а сервер стоит внутри
 * стека рядом с Dovecot, Postgres и Redis. Поэтому перед запросом адрес
 * проверяется дважды: по виду (только https, без учётных данных и
 * нестандартных портов) и по тому, куда разрешается имя, — во внутреннюю
 * сеть не ходим. Перенаправления не выполняются: они увели бы куда угодно.
 */
export async function requestOneClickUnsubscribe(
  url: string,
  log: UnsubscribeLog,
): Promise<void> {
  if (!isSafeUnsubscribeUrl(url)) {
    throw new BadRequestError('Адрес отписки выглядит небезопасно');
  }
  const hostname = new URL(url).hostname;
  let addresses: Array<{ address: string }> = [];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new UpstreamUnavailableError('Не удалось найти адрес отписки');
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new BadRequestError('Адрес отписки ведёт во внутреннюю сеть');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UNSUBSCRIBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
      signal: controller.signal,
    });
    // 3xx тоже считается принятым: многие рассылки отвечают перенаправлением
    if (response.status >= 400) {
      log.warn({ status: response.status, url }, 'Адрес отписки ответил ошибкой');
      throw new UpstreamUnavailableError('Служба отписки ответила ошибкой');
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    log.warn(errorInfo(err, { url }), 'Не удалось выполнить отписку');
    throw new UpstreamUnavailableError('Не удалось связаться со службой отписки');
  } finally {
    clearTimeout(timer);
  }
}

/** Настройки исходящей почты — ровно то, что нужно письму отписки. */
export interface UnsubscribeSmtp {
  host: string;
  port: number;
  secure: boolean;
  rejectUnauthorized: boolean;
}

/** Отправляет письмо отписки на адрес из `mailto:`. */
export async function sendUnsubscribeMail(
  smtp: UnsubscribeSmtp,
  session: { email: string; password: string },
  mailto: MailtoUnsubscribe,
): Promise<void> {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: session.email, pass: session.password },
    tls: { rejectUnauthorized: smtp.rejectUnauthorized },
  });
  try {
    await transport.sendMail({
      from: session.email,
      to: mailto.address,
      subject: mailto.subject ?? 'unsubscribe',
      text: mailto.body ?? 'unsubscribe',
    });
  } finally {
    transport.close();
  }
}

/**
 * Чем закончилась отписка.
 *
 * `ok: false` вместе с `method: 'link'` — это не отказ, а честный ответ
 * «сами мы отписаться не можем, вот страница». Открывает её интерфейс,
 * потому что дальше нужен человек: там форма с вопросами.
 */
export type UnsubscribeOutcome =
  | { ok: true; method: 'one-click'; url: string }
  | { ok: true; method: 'mailto'; address: string }
  | { ok: false; method: 'link'; url: string | null };

export interface PerformUnsubscribeArgs {
  headers: Record<string, string>;
  session: { email: string; password: string };
  smtp: UnsubscribeSmtp;
  log: UnsubscribeLog;
}

/**
 * Отписка по заголовкам одного письма.
 *
 * Порядок способов не случаен. Запрос в один клик (RFC 8058) — лучший:
 * его делает сервер, и адрес отписки не узнаёт ни адреса читающего, ни
 * его cookie. Письмо на `mailto:` — второй по надёжности. Ссылка —
 * последний: она требует человека и открывает ему чужую страницу.
 *
 * Возвращает null, если отписаться нечем вовсе: решение, что с этим
 * делать (404 на одном письме, «пропустили» в пачке), принимает
 * вызывающий — оно в этих двух случаях разное.
 */
export async function performUnsubscribe(
  args: PerformUnsubscribeArgs,
): Promise<UnsubscribeOutcome | null> {
  const info = parseUnsubscribe(args.headers);
  if (!info.url && !info.mailto) return null;

  if (info.oneClick && info.url) {
    await requestOneClickUnsubscribe(info.url, args.log);
    return { ok: true, method: 'one-click', url: info.url };
  }
  if (info.mailto) {
    await sendUnsubscribeMail(args.smtp, args.session, info.mailto);
    return { ok: true, method: 'mailto', address: info.mailto.address };
  }
  return { ok: false, method: 'link', url: info.url };
}
