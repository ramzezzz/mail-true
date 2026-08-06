/**
 * Срок действия TLS-сертификатов почтовых служб.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ ЭТО НА ДАШБОРДЕ
 * ------------------------------------------------------------------
 * Истёкший сертификат ломает всё разом и без предупреждения: почтовые
 * программы перестают подключаться к IMAP и к отправке, браузер закрывает
 * доступ к панели, а чужие серверы прекращают принимать почту по STARTTLS.
 * При этом ни один из показателей загрузки не шелохнётся — сервер жив,
 * диск свободен, очередь пуста. Узнают об этом обычно от пользователей,
 * причём все сразу.
 *
 * Продление занимает минуты, а простой — часы, и разница между ними ровно
 * в том, знал ли администратор заранее. Поэтому срок стоит на дашборде.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ СЕРТИФИКАТ БЕРЁТСЯ ИЗ СОЕДИНЕНИЯ, А НЕ ИЗ ФАЙЛА
 * ------------------------------------------------------------------
 * Каталог сертификатов (infra/data/certs) в контейнер api не смонтирован,
 * и это к лучшему. Файл на диске отвечает на вопрос «что мы положили»,
 * а нужен ответ на вопрос «что служба ОТДАЁТ клиенту». Это разные вещи:
 * после обновления файла Postfix и Dovecot продолжают отдавать старый
 * сертификат, пока их не перезапустят, — и именно эта ситуация приводит
 * к «сертификат же продлён, а почта не работает».
 *
 * Поэтому подключаемся к службе как обычный клиент и смотрим, что она
 * предъявила. Заодно так проверяется, что TLS вообще поднимается.
 *
 * Проверка сертификата НЕ ТРЕБУЕТСЯ (rejectUnauthorized: false), и это
 * осознанно: на стенде и в первые минуты после установки сертификат
 * самоподписанный, а узнать его срок надо и тогда — истечение
 * самоподписанного ломает почту ничуть не меньше. Доверие здесь не
 * проверяется, читается только дата; чтобы это не выглядело как «мы
 * ослабили TLS», самоподписанность отдельно показывается на экране.
 */
import { connect, type PeerCertificate } from 'node:tls';

export interface TlsCertificate {
  /** Что проверяли: «Отправка (submission)», «IMAP» и т. п. */
  title: string;
  host: string;
  port: number;
  /** Соединение поднялось и сертификат прочитан. */
  available: boolean;
  subject: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** Сколько суток осталось; отрицательное — уже истёк. */
  daysLeft: number | null;
  /** Издатель совпадает с владельцем — сертификат самоподписанный. */
  selfSigned: boolean;
  /** Имена, на которые он выписан (CN и SAN). */
  names: string[];
  /** Почему не вышло — показывается вместо даты. */
  error: string | null;
}

export interface TlsTarget {
  title: string;
  host: string;
  port: number;
  /**
   * Порт, где TLS начинается сразу (465, 993), или порт со STARTTLS (587).
   *
   * На порт STARTTLS нельзя просто открыть TLS-соединение: сервер ждёт
   * приветствия и команды STARTTLS обычным текстом, и попытка сразу начать
   * рукопожатие висит до таймаута. Такие порты мы не трогаем вовсе —
   * сертификат там тот же, что на 465, и второй раз спрашивать незачем.
   */
  implicitTls: boolean;
}

/** Сколько суток до истечения считаем поводом для тревоги на экране. */
export const TLS_WARN_DAYS = 21;

/**
 * Разбор сертификата, уже полученного из соединения.
 *
 * Вынесен отдельно от сети, чтобы проверять на подставных данных: поднять
 * настоящий TLS в тесте можно, но тогда проверялся бы Node, а не наш разбор.
 */
export function describeCertificate(
  target: Pick<TlsTarget, 'title' | 'host' | 'port'>,
  cert: PeerCertificate,
  now = Date.now(),
): TlsCertificate {
  const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
  const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
  const okTo = validTo && !Number.isNaN(validTo.getTime()) ? validTo : null;
  // CN в разборе Node — это string, но у сертификата с ДВУМЯ полями CN
  // (так бывает у выписанных вручную) сюда приезжает массив. Без сведения
  // к строке в интерфейс попало бы «[object Array]» вместо имени узла.
  const cn = (value: string | string[] | undefined): string | null => {
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };
  const names = new Set<string>();
  const subject = cn(cert.subject?.CN);
  const issuer = cn(cert.issuer?.CN);
  if (subject) names.add(subject);
  for (const item of (cert.subjectaltname ?? '').split(',')) {
    const value = item.trim().replace(/^DNS:/u, '').replace(/^IP Address:/u, '');
    if (value !== '') names.add(value);
  }
  return {
    title: target.title,
    host: target.host,
    port: target.port,
    available: true,
    subject,
    issuer,
    validFrom: validFrom && !Number.isNaN(validFrom.getTime()) ? validFrom.toISOString() : null,
    validTo: okTo ? okTo.toISOString() : null,
    // Округляем ВНИЗ: «осталось 0 суток» у сертификата, который истекает
    // через двадцать часов, честнее бодрого «остался 1 день».
    daysLeft: okTo ? Math.floor((okTo.getTime() - now) / 86_400_000) : null,
    selfSigned: subject !== null && issuer !== null && subject === issuer,
    names: [...names],
    error: null,
  };
}

function failed(target: TlsTarget, error: string): TlsCertificate {
  return {
    title: target.title,
    host: target.host,
    port: target.port,
    available: false,
    subject: null,
    issuer: null,
    validFrom: null,
    validTo: null,
    daysLeft: null,
    selfSigned: false,
    names: [],
    error,
  };
}

/** Сертификат, который служба предъявляет на этом порту. */
export async function readCertificate(
  target: TlsTarget,
  timeoutMs = 4000,
): Promise<TlsCertificate> {
  if (!target.implicitTls) {
    return failed(
      target,
      'Порт со STARTTLS: сертификат читается на соседнем порту с постоянным TLS',
    );
  }
  return new Promise<TlsCertificate>((resolve) => {
    let settled = false;
    const done = (value: TlsCertificate): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = connect({
      host: target.host,
      port: target.port,
      servername: target.host,
      // См. пояснение вверху файла: читаем дату, доверие не проверяем.
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert || Object.keys(cert).length === 0) {
        done(failed(target, 'Соединение поднялось, но сертификат не предъявлен'));
        return;
      }
      done(describeCertificate(target, cert));
    });
    socket.once('timeout', () =>
      done(failed(target, `Порт ${target.host}:${target.port} не ответил за ${timeoutMs} мс`)),
    );
    socket.once('error', (err: Error) =>
      done(failed(target, `Не удалось прочитать сертификат: ${err.message}`)),
    );
  });
}

/**
 * Все сертификаты разом.
 *
 * Параллельно, а не по очереди: четыре недоступных порта по таймауту в
 * четыре секунды складывались бы в шестнадцать секунд ожидания на экране,
 * который открывают как раз при аварии.
 */
export async function readCertificates(
  targets: readonly TlsTarget[],
  timeoutMs = 4000,
): Promise<TlsCertificate[]> {
  return Promise.all(targets.map((t) => readCertificate(t, timeoutMs)));
}
