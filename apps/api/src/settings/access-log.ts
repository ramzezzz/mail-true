/**
 * История входов в ящик: разбор строк журналов Dovecot и Postfix.
 *
 * Здесь только чистые функции над строками — ни файлов, ни сети, ни базы.
 * Ровно поэтому разбор проверяется без стенда, а стенд нужен лишь чтобы
 * убедиться, что строки именно такие. Так же устроен разбор журналов
 * почтового стека для админки (admin/mail-log.ts), и формат строки берётся
 * оттуда же — здесь из него вынимается другое: не «что случилось с
 * письмом», а «кто и откуда вошёл».
 *
 * ------------------------------------------------------------------
 * ЧТО ИМЕННО МЫ ЗДЕСЬ ИЩЕМ
 * ------------------------------------------------------------------
 * Ровно четыре вида событий, и все четыре — про вход по паролю:
 *
 *   Dovecot, удачный вход по IMAP или POP3:
 *     imap-login: Info: Login: user=<a@b>, method=PLAIN, rip=1.2.3.4, …
 *     pop3-login: Info: Login: user=<a@b>, method=PLAIN, rip=1.2.3.4, …
 *
 *   Dovecot, неудачный:
 *     imap-login: Info: Disconnected: Aborted login (auth failed, 1 attempts
 *       in 2 secs): user=<a@b>, method=PLAIN, rip=1.2.3.4, …
 *
 *   Postfix, отправка с проверкой пароля (submission, порт 587/465):
 *     postfix/submission/smtpd[129]: 7102517C8E: client=host[1.2.3.4],
 *       sasl_method=PLAIN, sasl_username=a@b
 *
 * ------------------------------------------------------------------
 * ЧЕГО МЫ ЗДЕСЬ НЕ ПОКАЗЫВАЕМ И ПОЧЕМУ
 * ------------------------------------------------------------------
 * Неудачной попытки SMTP в журнале Postfix НЕТ в пригодном виде: строка
 * «SASL PLAIN authentication failed» приходит БЕЗ имени пользователя —
 * Postfix его не печатает, потому что на момент отказа не считает
 * представленное имя достоверным. Отнести такую строку к конкретному
 * ящику невозможно, а показать её всем владельцам ящиков сразу — значит
 * показать каждому чужие попытки. Поэтому её здесь нет, и раздел говорит
 * об этом прямо, а не делает вид, что неудачных отправок не бывает.
 *
 * Строки без ящика (`user=<>`, а таких в журнале большинство — это пробы
 * состояния и оборванные подключения) отбрасываются по той же причине:
 * приписать их владельцу ящика нельзя.
 */

import { networkInterfaces } from 'node:os';
import { parseSyslogTime } from '../admin/mail-log.js';

/** Каким способом человек попал в ящик. */
export type AccessChannel = 'web' | 'imap' | 'pop3' | 'smtp';

export const ACCESS_CHANNELS: readonly AccessChannel[] = ['web', 'imap', 'pop3', 'smtp'];

export function isAccessChannel(value: unknown): value is AccessChannel {
  return typeof value === 'string' && (ACCESS_CHANNELS as readonly string[]).includes(value);
}

/** Одно событие доступа — то, что человек видит строкой таблицы. */
export interface AccessEvent {
  /** Время события в ISO. */
  at: string;
  channel: AccessChannel;
  /** Вошёл или не смог. */
  success: boolean;
  /** Адрес, откуда пришли. Пусто — в строке его не было. */
  ip: string | null;
  /** Браузер или почтовая программа; у журнальных событий пусто. */
  userAgent: string | null;
  /**
   * Подключение самого веб-интерфейса к Dovecot, а не человека.
   *
   * Сервер приложения проверяет пароль настоящим IMAP-логином и держит
   * соединения к Dovecot всё время работы, поэтому в журнале на один вход
   * человека приходятся десятки строк с адресом нашего же контейнера.
   * Скрывать их совсем нельзя (это записи журнала, они существуют), но и
   * показывать вперемешку с настоящими входами значит утопить настоящие.
   * Поэтому они помечены и по умолчанию свёрнуты — см. AccessLogPage.
   */
  service: boolean;
  /** Короткое пояснение по-русски. */
  detail: string;
  /** Откуда взято: наша запись или журнал службы. */
  origin: 'app' | 'dovecot' | 'postfix';
}

/* ------------------------------------------------------------------ */
/* Dovecot                                                              */
/* ------------------------------------------------------------------ */

/**
 * Шапка строки Dovecot: `Aug 06 17:43:13 imap-login: Info: <текст>`.
 *
 * Повторяет разбор из admin/mail-log.ts намеренно: там из строки нужен
 * уровень важности и текст для показа, здесь — служба и поля `user=`/`rip=`.
 * Свести их в одну функцию значило бы, что правка ради журнала админки
 * тихо меняет историю входов, и наоборот.
 */
const DOVECOT_HEAD =
  /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+([a-z0-9-]+)(?:\([^)]*\))?(?:<[^>]*>)*:\s+(?:(Info|Warning|Error|Fatal|Panic|Debug):\s+)?([\s\S]*)$/;

/** `user=<a@b>` — ящик, к которому относится строка. */
const USER_FIELD = /(?:^|[\s,])user=<([^>]*)>/;
/** `rip=1.2.3.4` — адрес того, кто подключился (remote IP). */
const RIP_FIELD = /(?:^|[\s,])rip=([^\s,]+)/;

/**
 * Служба Dovecot → способ входа.
 *
 * `imap`/`pop3` (без `-login`) сюда НЕ входят: это уже работающая сессия,
 * а не вход, и её строки («Logged out», статистика) появляются на каждое
 * закрытие соединения. Показывать их как входы значило бы удваивать
 * каждое событие.
 */
const DOVECOT_SERVICE_CHANNEL: Readonly<Record<string, AccessChannel>> = {
  'imap-login': 'imap',
  'pop3-login': 'pop3',
  // Подача письма через Dovecot submission (если он включён) — тот же
  // вход по паролю, что и через Postfix, и способ у него тот же.
  'submission-login': 'smtp',
};

/**
 * Разбирает строку журнала Dovecot целиком, вместе с её шапкой.
 *
 * Возвращает null для всего, что не является входом по паролю
 * конкретного ящика, — таких строк в журнале подавляющее большинство.
 */
export function parseDovecotAccess(line: string, now: Date): AccessEvent | null {
  const head = DOVECOT_HEAD.exec(line);
  if (!head) return null;
  const [, month = '', day = '', time = '', service = '', , rest = ''] = head;
  const at = parseSyslogTime(month, day, time, now);
  if (!at) return null;
  return dovecotAccessFromParts(service, rest, at);
}

/**
 * То же, но для уже разобранной строки: службу, текст и время читатель
 * журнала (admin/log-files.ts) отдаёт по отдельности.
 *
 * Две точки входа, а не одна: разбор проверяется НАСТОЯЩИМИ строками
 * из настоящего журнала (иначе проверка сторожила бы наше представление
 * о журнале), а читатель отдаёт разобранное и склеивать строку обратно
 * ради этого — значит терять время в самом горячем месте.
 */
export function dovecotAccessFromParts(
  service: string,
  rest: string,
  at: Date,
): AccessEvent | null {
  const channel = DOVECOT_SERVICE_CHANNEL[service];
  if (!channel) return null;

  const email = USER_FIELD.exec(rest)?.[1]?.trim() ?? '';
  // Без ящика строку отнести не к кому — см. пояснение в шапке файла.
  if (email === '') return null;

  const ip = RIP_FIELD.exec(rest)?.[1] ?? null;

  if (rest.startsWith('Login:')) {
    return {
      at: at.toISOString(),
      channel,
      success: true,
      ip,
      userAgent: null,
      service: false,
      detail: 'Вход по паролю',
      origin: 'dovecot',
    };
  }

  /*
   * Неудача. Dovecot пишет её по-разному в зависимости от того, где
   * оборвалось: «Aborted login (auth failed, …)», «Disconnected: Login
   * failed», «Disconnected (auth failed, …)». Общее у всех одно — слова
   * «auth failed» либо «Login failed» и, что важнее, НАЛИЧИЕ ящика в
   * `user=<>`: пароль назвали, но не тот.
   */
  const failed = /auth failed|login failed|authentication failed/i.test(rest);
  if (failed) {
    return {
      at: at.toISOString(),
      channel,
      success: false,
      ip,
      userAgent: null,
      service: false,
      detail: 'Неверный пароль',
      origin: 'dovecot',
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Postfix                                                              */
/* ------------------------------------------------------------------ */

// Aug  6 16:46:09 mail postfix/submission/smtpd[129]: 7102517C8E: текст
const POSTFIX_HEAD =
  /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+\S+\s+(?:postfix\/)?([\w./-]+?)(?:\[\d+\])?:\s?([\s\S]*)$/;

/** `sasl_username=a@b` — кто представился при отправке. */
const SASL_USER_FIELD = /(?:^|[\s,])sasl_username=([^\s,]+)/;
/** `client=имя[1.2.3.4]` — откуда подключились. */
const CLIENT_FIELD = /(?:^|[\s,])client=[^\s,[]*\[([^\]]+)\]/;

/**
 * Разбирает строку журнала Postfix.
 *
 * Интересует ровно одна: подключение к submission/smtps, назвавшее пароль.
 * Всё остальное (доставка, очередь, отказы) — не про доступ к ящику.
 */
export function parsePostfixAccess(line: string, now: Date): AccessEvent | null {
  const head = POSTFIX_HEAD.exec(line);
  if (!head) return null;
  const [, month = '', day = '', time = '', component = '', rest = ''] = head;
  const at = parseSyslogTime(month, day, time, now);
  if (!at) return null;
  return postfixAccessFromParts(component, rest, at);
}

/** То же для уже разобранной строки — см. пояснение у dovecotAccessFromParts. */
export function postfixAccessFromParts(
  component: string,
  rest: string,
  at: Date,
): AccessEvent | null {
  // Только точки подачи. Обычный smtpd на 25-м порту принимает чужую
  // почту без пароля — это не вход в ящик.
  if (!component.includes('submission') && !component.includes('smtps')) return null;

  const email = SASL_USER_FIELD.exec(rest)?.[1]?.trim() ?? '';
  if (email === '') return null;

  return {
    at: at.toISOString(),
    channel: 'smtp',
    success: true,
    ip: CLIENT_FIELD.exec(rest)?.[1] ?? null,
    userAgent: null,
    service: false,
    detail: 'Отправка письма с проверкой пароля',
    origin: 'postfix',
  };
}

/* ------------------------------------------------------------------ */
/* Свой адрес и вид адреса                                              */
/* ------------------------------------------------------------------ */

/**
 * Адреса, которые процесс видит своими ПРЯМО СЕЙЧАС.
 *
 * Нужны, чтобы отличить подключение веб-интерфейса к Dovecot от входа
 * человека: первое приходит с адреса НАШЕГО контейнера. Сравнение по
 * собственным сетевым интерфейсам точнее, чем список доверенных подсетей:
 * подсеть стека может совпасть с подсетью офиса, а свой интерфейс — это
 * ровно мы и никто больше.
 *
 * ЭТОГО СПИСКА НЕДОСТАТОЧНО, и в этом был дефект. Адрес контейнера живёт
 * не дольше самого контейнера: после `docker compose up -d --build api`
 * Docker выдаёт следующий свободный, процесс считает своим 172.28.0.7, а
 * вчерашние строки журнала написаны про 172.28.0.2 — и вчерашние
 * служебные подключения начинают читаться как обычные входы по IMAP из
 * локальной сети. Раздел, заведённый ради вопроса «не заходил ли кто-то
 * чужой», сам же отвечал на него ложной тревогой.
 *
 * Поэтому текущие адреса — только ЗАТРАВКА: процесс записывает их в
 * таблицу `api_service_addresses` (миграция 0036), а сравнение идёт со
 * всем, что там накопилось. Собирает и отдаёт этот список
 * `ServiceAddressBook` (service-addresses.ts).
 *
 * Список читается один раз при первом обращении: адреса контейнера за
 * время его жизни не меняются.
 */
let ownAddressCache: Set<string> | null = null;

export function ownAddresses(): Set<string> {
  if (ownAddressCache) return ownAddressCache;
  const found = new Set<string>(['127.0.0.1', '::1']);
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) found.add(normalizeIp(item.address));
  }
  ownAddressCache = found;
  return found;
}

/** Только для проверок: забыть подсмотренные адреса. */
export function resetOwnAddresses(): void {
  ownAddressCache = null;
}

/**
 * Приводит адрес к сравнимому виду: `::ffff:1.2.3.4` — это `1.2.3.4`.
 *
 * Node отдаёт адрес подключения в форме IPv4-в-IPv6, а Dovecot пишет в
 * журнал обычный IPv4. Без приведения свой же адрес не узнавался бы.
 */
export function normalizeIp(ip: string | null | undefined): string {
  if (!ip) return '';
  const trimmed = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
  return mapped ? mapped[1]! : trimmed;
}

/**
 * Откуда пришли — словами, без обращения к внешним службам.
 *
 * Страну по адресу мы НЕ определяем и определять не будем: для этого нужна
 * либо база GeoIP (сотни мегабайт, которые надо ещё и обновлять), либо
 * запрос в чужую службу — то есть выдача адресов наших пользователей
 * наружу. Ни то, ни другое не стоит подписи под строкой в таблице.
 *
 * Что мы сказать МОЖЕМ и что действительно помогает: этот адрес из
 * локальной сети или из интернета. «Локальная сеть» рядом с неизвестным
 * входом означает «из вашего же дома или офиса», и это ровно тот ответ,
 * ради которого раздел и открывают.
 */
export function describeIp(ip: string | null): string {
  const value = normalizeIp(ip);
  if (value === '') return 'адрес неизвестен';
  if (value === '127.0.0.1' || value === '::1') return 'сам сервер';
  if (isPrivateIp(value)) return 'локальная сеть';
  return 'интернет';
}

/** Адрес из диапазонов RFC 1918 / RFC 4193 и прочих «не из интернета». */
export function isPrivateIp(ip: string): boolean {
  const value = normalizeIp(ip);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    // Ссылочно-локальные (169.254.0.0/16) и общая сеть провайдера
    // (100.64.0.0/10) тоже не «интернет»: наружу такой адрес не выходит.
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6: петля (::1), уникальные локальные (fc00::/7) и ссылочно-локальные
  // (fe80::/10).
  //
  // Петля здесь не для красоты: по этому признаку решается, проверять ли
  // страну входа. Без неё запрос с самой машины по IPv6 считался бы
  // пришедшим из интернета — то есть из страны, которой у него нет, — и
  // резервный вход в панель мог бы отказать при включённом списке стран.
  return value === '::1' || /^f[cd]/.test(value) || /^fe[89ab]/.test(value);
}

/**
 * Событие из журнала, отмеченное как своё служебное подключение.
 *
 * Отдельная функция, а не поле в разборе: разбор не знает и не должен
 * знать, на какой машине он запущен, — иначе его нельзя было бы проверить.
 *
 * `own` передаётся, а не берётся отсюда же, по той же причине: это ВСЕ
 * адреса, которые когда-либо были нашими (см. ServiceAddressBook), а не
 * только сегодняшние, и знать, откуда они взялись, этой функции незачем.
 */
export function markService(event: AccessEvent, own: ReadonlySet<string>): AccessEvent {
  if (event.origin === 'app') return event;
  const ip = normalizeIp(event.ip);
  if (ip === '' || !own.has(ip)) return event;
  /*
   * У НЕУДАЧИ пояснение не подменяется. Служебной пометки достаточно,
   * чтобы строка не читалась как чужой вход, а «Неверный пароль» здесь —
   * главное слово: это та же попытка, что и веб-вход строкой выше, и
   * заменить её на «служебное подключение» значило бы спрятать отказ.
   */
  if (!event.success) return { ...event, service: true };
  return {
    ...event,
    service: true,
    detail:
      event.channel === 'smtp'
        ? 'Отправка из веб-интерфейса'
        : 'Служебное подключение веб-интерфейса',
  };
}

/**
 * Сводит события в один список: свежие сверху.
 *
 * Сортировка по времени, а не «сперва наши, потом журнальные»: человек
 * читает историю как ленту, и запись о веб-входе обязана стоять рядом с
 * подключением по IMAP, случившимся в ту же минуту.
 */
export function mergeAccessEvents(...lists: AccessEvent[][]): AccessEvent[] {
  const all = lists.flat();
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return all;
}
