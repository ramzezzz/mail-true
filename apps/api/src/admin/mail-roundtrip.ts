/**
 * Сквозная проверка «письмо туда и обратно».
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ, ЕСЛИ ЕСТЬ ДЕСЯТОК ДРУГИХ ПРОВЕРОК
 * ------------------------------------------------------------------
 * Все остальные проверки раздела отвечают на вопросы про части: порт
 * отвечает, контейнер поднят, сертификат жив, очередь пуста. Собранные
 * вместе, они НЕ означают, что письмо дойдёт. Между «Postfix принял» и
 * «письмо лежит в ящике» стоят: правило доставки в Dovecot (LMTP),
 * существование самого ящика, квота, фильтры Sieve, вердикт антиспама и
 * подпись DKIM. Каждое из этих звеньев ломается молча — почта не падает,
 * она просто перестаёт доходить.
 *
 * Эта проверка проходит весь путь целиком: отправляет письмо через тот же
 * порт 587, которым пользуются почтовые программы, и ищет его в ящике
 * через IMAP — то есть глазами получателя.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ КНОПКОЙ, А НЕ В ОБЩЕЙ СВОДКЕ
 * ------------------------------------------------------------------
 * Она отправляет настоящее письмо. Делать это фоном при каждом открытии
 * страницы нельзя: раздел открывают вкладками и держат открытым часами, а
 * почтовый сервер — не место, куда сыплется мусор от чужого мониторинга.
 * Поэтому — отдельная кнопка, осознанное нажатие, и письмо за собой
 * убирается.
 *
 * ------------------------------------------------------------------
 * ЧУЖИЕ ПИСЬМА НЕ ТРОГАЕМ
 * ------------------------------------------------------------------
 * Удаляется РОВНО ОДНО письмо и только то, что отправила сама проверка:
 * поиск идёт по метке в теме, а метка — случайная строка, придуманная в
 * этом же запросе. Ни поиска по дате, ни «удалить всё похожее».
 *
 * Пароль владельца ящика при этом не нужен и нигде не спрашивается: и
 * отправка, и чтение идут служебным (master) пользователем Dovecot —
 * тем же способом, что и сбор почты с чужих серверов.
 */
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

/** Из чего складывается ответ проверки. */
export interface RoundtripStep {
  id: 'send' | 'deliver' | 'dkim' | 'cleanup';
  title: string;
  state: 'ok' | 'warn' | 'fail';
  detail: string;
  hint?: string;
}

export interface RoundtripResult {
  ok: boolean;
  mailbox: string;
  /** Сколько секунд письмо шло от отправки до появления в ящике. */
  seconds: number | null;
  steps: RoundtripStep[];
}

export interface RoundtripDeps {
  smtp: { host: string; port: number; rejectUnauthorized: boolean };
  imap: { host: string; port: number; secure: boolean; rejectUnauthorized: boolean };
  master: { user: string; password: string; separator: string };
  /** Сколько ждать письмо. Больше минуты ждать незачем: столько не идёт даже greylisting внутри сервера. */
  waitMs?: number;
  /** Пауза между опросами ящика. Вынесена ради тестов. */
  pollMs?: number;
}

/**
 * Метка письма. Не время и не счётчик: две проверки, запущенные
 * одновременно из двух вкладок, обязаны искать РАЗНЫЕ письма, иначе одна
 * удалит письмо другой и обе соврут.
 */
export function makeToken(random: () => number = Math.random): string {
  const part = (): string =>
    Math.floor(random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  return `${part()}${part()}`;
}

/** Тема письма проверки: по ней же оно потом ищется и удаляется. */
export function subjectFor(token: string): string {
  return `Mail.True: проверка доставки ${token}`;
}

/**
 * Прогон проверки. Возвращает шаги, а не бросает исключение: «не дошло за
 * 30 секунд» — это результат проверки, а не сбой сервера, и человек
 * должен увидеть, ГДЕ именно оборвалось.
 */
export async function runRoundtrip(
  mailbox: string,
  deps: RoundtripDeps,
  now: () => number = Date.now,
): Promise<RoundtripResult> {
  const steps: RoundtripStep[] = [];
  const token = makeToken();
  const subject = subjectFor(token);
  const waitMs = deps.waitMs ?? 45_000;
  const pollMs = deps.pollMs ?? 1_000;
  const authUser = `${mailbox}${deps.master.separator}${deps.master.user}`;

  /* --- 1. Отправка через submission, как из почтовой программы --- */
  const startedAt = now();
  try {
    const transport = nodemailer.createTransport({
      host: deps.smtp.host,
      port: deps.smtp.port,
      secure: false,
      requireTLS: true,
      auth: { user: authUser, pass: deps.master.password },
      tls: { rejectUnauthorized: deps.smtp.rejectUnauthorized },
    });
    await transport.sendMail({
      from: mailbox,
      to: mailbox,
      subject,
      text:
        'Это письмо отправила проверка доставки из панели управления Mail.True.\n' +
        'Оно удаляется само сразу после проверки. Метка: ' +
        token,
    });
    transport.close();
    steps.push({
      id: 'send',
      title: 'Отправка через порт 587 с паролем',
      state: 'ok',
      detail: `письмо принято сервером отправки, метка ${token}`,
    });
  } catch (err) {
    steps.push({
      id: 'send',
      title: 'Отправка через порт 587 с паролем',
      state: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      hint:
        'Этим же путём отправляют письма почтовые программы. Проверьте служебного ' +
        'пользователя Dovecot (DOVECOT_MASTER_USER и DOVECOT_MASTER_PASSWORD) и журнал Postfix.',
    });
    return { ok: false, mailbox, seconds: null, steps };
  }

  /* --- 2. Дошло ли письмо до ящика --- */
  const client = new ImapFlow({
    host: deps.imap.host,
    port: deps.imap.port,
    secure: deps.imap.secure,
    auth: { user: authUser, pass: deps.master.password },
    logger: false,
    ...(deps.imap.rejectUnauthorized ? {} : { tls: { rejectUnauthorized: false } }),
  });
  client.on('error', () => undefined);

  let seconds: number | null = null;
  let headers = '';
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      let uid: number | undefined;
      const deadline = now() + waitMs;
      // Опрашиваем, а не ждём события: письмо может прийти и до того, как
      // мы успели подписаться, и тогда ожидание события зависло бы до
      // таймаута на уже доставленном письме.
      for (;;) {
        const found = await client.search({ header: { subject } }, { uid: true });
        if (Array.isArray(found) && found.length > 0) {
          uid = found[found.length - 1];
          break;
        }
        if (now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      if (uid === undefined) {
        steps.push({
          id: 'deliver',
          title: 'Доставка в ящик',
          state: 'fail',
          detail: `письмо не появилось в ящике за ${String(Math.round(waitMs / 1000))} секунд`,
          hint:
            'Отправка прошла, значит оборвалось после Postfix. Смотрите доставку в Dovecot ' +
            '(раздел «Журналы почты», служба dovecot): чаще всего это переполненная квота, ' +
            'несуществующий ящик или ошибка в личных правилах фильтрации.',
        });
        return { ok: false, mailbox, seconds: null, steps };
      }

      seconds = Math.max(0, Math.round((now() - startedAt) / 1000));
      steps.push({
        id: 'deliver',
        title: 'Доставка в ящик',
        state: 'ok',
        detail: `письмо в папке «Входящие» через ${String(seconds)} с`,
      });

      /* --- 3. Подписано ли исходящее письмо --- */
      const message = await client.fetchOne(String(uid), { headers: true }, { uid: true });
      if (message !== false && message.headers) headers = message.headers.toString('utf8');
      const signed = /^dkim-signature:/im.test(headers);
      steps.push({
        id: 'dkim',
        title: 'Подпись DKIM у исходящего письма',
        state: signed ? 'ok' : 'fail',
        detail: signed
          ? 'подпись на месте'
          : 'письмо ушло без подписи — чужие серверы будут считать его подозрительным',
        ...(signed
          ? {}
          : {
              hint:
                'Проверьте, что для домена выпущен ключ DKIM (раздел «Домены и DNS», ' +
                'кнопка записи DKIM) и что rspamd поднят.',
            }),
      });

      /* --- 4. Убрать за собой --- */
      try {
        await client.messageDelete(String(uid), { uid: true });
        steps.push({
          id: 'cleanup',
          title: 'Уборка письма проверки',
          state: 'ok',
          detail: 'письмо удалено из ящика',
        });
      } catch (err) {
        steps.push({
          id: 'cleanup',
          title: 'Уборка письма проверки',
          state: 'warn',
          detail: err instanceof Error ? err.message : String(err),
          hint: `Письмо осталось в ящике. Найдите его по теме «${subject}» и удалите вручную.`,
        });
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    steps.push({
      id: 'deliver',
      title: 'Доставка в ящик',
      state: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      hint:
        'Письмо отправлено, но заглянуть в ящик не удалось. Проверьте службу dovecot ' +
        'и настройки IMAP_HOST/IMAP_PORT.',
    });
    return { ok: false, mailbox, seconds, steps };
  } finally {
    await client.logout().catch(() => client.close());
  }

  return {
    ok: steps.every((step) => step.state !== 'fail'),
    mailbox,
    seconds,
    steps,
  };
}
