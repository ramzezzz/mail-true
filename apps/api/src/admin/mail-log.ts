/**
 * Разбор журналов почтового стека.
 *
 * Источники и их вид:
 *
 *   postfix  — postlogd, syslog-подобная строка:
 *     `Aug  5 20:30:01 mail postfix/lmtp[42]: 4c2w: to=<a@b>, ... status=sent (…)`
 *   dovecot  — свой формат с явной пометкой важности:
 *     `Aug 05 20:30:01 lmtp(a@b)<42><sid>: Error: …`
 *   api      — pino, по объекту JSON на строку:
 *     `{"level":50,"time":1712345678901,"msg":"…"}`
 *
 * Здесь только чистые функции над строками: ни файлов, ни сети, ни базы.
 * Ровно поэтому разбор проверяется без стенда, а стенд нужен только чтобы
 * убедиться, что строки именно такие.
 *
 * ВАЖНО про год. В syslog-строке года нет — это свойство формата, а не
 * недосмотр. Год берётся от «сейчас», и если получившаяся дата оказалась
 * заметно в будущем, значит строка от прошлого года (31 декабря → 1 января).
 * Без этой поправки вся история за новогоднюю ночь уезжала бы на год вперёд
 * и не показывалась бы никогда.
 */

/** Уровень важности — общий для всех источников, четыре ступени. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Какой службы журнал. */
export type LogSource = 'postfix' | 'dovecot' | 'api';

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];
export const LOG_SOURCES: readonly LogSource[] = ['postfix', 'dovecot', 'api'];

/** Порядок ступеней: выбранный уровень показывает себя и всё, что важнее. */
const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/** Входит ли уровень строки в выбранный порог («предупреждения и хуже»). */
export function levelAtLeast(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[threshold];
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export function isLogSource(value: unknown): value is LogSource {
  return typeof value === 'string' && (LOG_SOURCES as readonly string[]).includes(value);
}

/** Разобранная строка журнала. */
export interface LogEntry {
  source: LogSource;
  level: LogLevel;
  /** Время события; null — в строке его не было (продолжение стека и т.п.). */
  at: Date | null;
  /** Кто сказал: smtpd, lmtp, imap, qmgr… Пусто, если не определилось. */
  component: string;
  /** Идентификатор письма в очереди, если строка про конкретное письмо. */
  queueId: string | null;
  /** Текст без служебной шапки — то, что человек читает. */
  text: string;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Время из syslog-подобной метки («Aug  5 20:30:01», «Aug 05 20:30:01»).
 * Год подставляется от `now` с поправкой на переход через новый год.
 *
 * Пояса в метке тоже нет. Считаем её временем ТОГО ЖЕ пояса, в котором
 * живёт сервер приложения: и он, и Postfix — контейнеры одного стека, у
 * обоих пояс по умолчанию UTC, и разъехаться они могут только если кто-то
 * задаст TZ одному из них. Никакой догадки лучше здесь не существует:
 * в строке журнала данных о поясе просто нет.
 */
export function parseSyslogTime(month: string, day: string, time: string, now: Date): Date | null {
  const m = MONTHS[month.slice(0, 3).toLowerCase()];
  if (m === undefined) return null;
  const [hh, mm, ss] = time.split(':').map((part) => Number(part));
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null;
  const at = new Date(now.getFullYear(), m, Number(day), hh, mm, ss);
  // Дата «в будущем» больше чем на сутки — это прошлый год. Сутки запаса,
  // а не ноль: часы контейнеров расходятся на секунды, и без запаса свежая
  // запись иногда объявлялась бы прошлогодней.
  if (at.getTime() - now.getTime() > 24 * 3600 * 1000) {
    at.setFullYear(at.getFullYear() - 1);
  }
  return at;
}

/* ------------------------------------------------------------------ */
/* Postfix                                                              */
/* ------------------------------------------------------------------ */

// Aug  5 20:30:01 mail postfix/lmtp[42]: текст
//
// Служба бывает составной: `postfix/submission/smtpd` — это smtpd, поднятый
// на порту 587. Косая черта в имени поэтому разрешена: без неё разбор
// спотыкался ровно на подаче почты пользователями, то есть на самом частом
// на этом сервере событии.
const POSTFIX_LINE =
  /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+(?:postfix\/)?([\w./-]+?)(?:\[(\d+)\])?:\s?([\s\S]*)$/;

/** Идентификатор письма в начале текста: `4c2wKp1Vt2z: to=<…>`. */
const QUEUE_ID_PREFIX = /^([A-Za-z0-9]{5,32}):\s/;

/**
 * Слово на месте идентификатора, которое идентификатором НЕ является.
 *
 * `NOQUEUE:` Postfix пишет ровно там, где обычно стоит идентификатор, и
 * означает оно обратное: очередь этому письму не заведена вовсе (его
 * отбили на команде RCPT). Проверка поймала это на живом примере: без
 * исключения «NOQUEUE» ложился в историю как настоящий идентификатор,
 * по нему связывались между собой чужие друг другу отказы, а «письмо
 * NOQUEUE» ещё и оседало в памяти отправителей.
 */
const NOT_A_QUEUE_ID = new Set(['NOQUEUE']);

function queueIdOf(text: string): string | null {
  const found = QUEUE_ID_PREFIX.exec(text)?.[1] ?? null;
  if (found === null || NOT_A_QUEUE_ID.has(found)) return null;
  return found;
}

/**
 * Важность строки Postfix.
 *
 * У Postfix нет поля уровня — важность приходится выводить из текста, и
 * это сознательное решение о том, что человек считает бедой:
 *
 *   * `status=bounced` / `expired` — письмо НЕ дойдёт никогда. Ошибка.
 *   * `status=deferred` — письмо ещё дойдёт, но что-то не так. Предупреждение.
 *   * `reject` на приёме — чужое письмо не приняли. Тоже предупреждение:
 *     на живом сервере это ежеминутная норма (спам), и красить её в ошибку
 *     значит утопить настоящие ошибки.
 *   * `fatal`, `panic` — сломался сам сервер. Ошибка.
 */
export function postfixLevel(text: string): LogLevel {
  const lower = text.toLowerCase();
  if (/\b(fatal|panic):/.test(lower)) return 'error';
  if (/\bstatus=(bounced|expired)\b/.test(lower)) return 'error';
  if (/\berror:/.test(lower)) return 'error';
  if (/\bstatus=deferred\b/.test(lower)) return 'warn';
  if (/\bwarning:/.test(lower)) return 'warn';
  if (/\b(reject|refused|denied|timeout|lost connection|too many errors)\b/.test(lower)) {
    return 'warn';
  }
  return 'info';
}

/* ------------------------------------------------------------------ */
/* Dovecot                                                              */
/* ------------------------------------------------------------------ */

// Aug 05 20:30:01 lmtp(a@b)<42><sid>: Error: текст
const DOVECOT_LINE =
  /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+([^:]*?):\s*(?:(Fatal|Panic|Error|Warning|Info|Debug):\s*)?([\s\S]*)$/;

const DOVECOT_LEVELS: Readonly<Record<string, LogLevel>> = {
  fatal: 'error',
  panic: 'error',
  error: 'error',
  warning: 'warn',
  info: 'info',
  debug: 'debug',
};

/* ------------------------------------------------------------------ */
/* Сервер приложения (pino)                                             */
/* ------------------------------------------------------------------ */

/** Числовые уровни pino сводим к четырём ступеням. */
export function pinoLevel(level: number): LogLevel {
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  if (level >= 30) return 'info';
  return 'debug';
}

/* ------------------------------------------------------------------ */
/* Общий разбор                                                         */
/* ------------------------------------------------------------------ */

/**
 * Разбирает одну строку журнала.
 *
 * Не разобранная строка НЕ выбрасывается: она отдаётся как есть с уровнем
 * info. Молча терять строки в журнале нельзя — именно непонятная строка
 * чаще всего и оказывается той, ради которой журнал открыли.
 */
export function parseLogLine(source: LogSource, line: string, now: Date = new Date()): LogEntry {
  if (source === 'api') return parseApiLine(line, now);
  if (source === 'dovecot') return parseDovecotLine(line, now);
  return parsePostfixLine(line, now);
}

function parsePostfixLine(line: string, now: Date): LogEntry {
  const m = POSTFIX_LINE.exec(line);
  if (!m) {
    return { source: 'postfix', level: 'info', at: null, component: '', queueId: null, text: line };
  }
  const [, month = '', day = '', time = '', , component = '', , rest = ''] = m;
  return {
    source: 'postfix',
    level: postfixLevel(rest),
    at: parseSyslogTime(month, day, time, now),
    component,
    queueId: queueIdOf(rest),
    text: rest,
  };
}

function parseDovecotLine(line: string, now: Date): LogEntry {
  const m = DOVECOT_LINE.exec(line);
  if (!m) {
    return { source: 'dovecot', level: 'info', at: null, component: '', queueId: null, text: line };
  }
  const [, month = '', day = '', time = '', who = '', marker, rest = ''] = m;
  const level = marker ? (DOVECOT_LEVELS[marker.toLowerCase()] ?? 'info') : 'info';
  // «lmtp(user@dom)<pid><sid>» → «lmtp»: в колонке нужен вид службы,
  // а кто и в какой сессии — остаётся в тексте.
  const component = who.replace(/[(<].*$/, '').trim();
  return {
    source: 'dovecot',
    level,
    at: parseSyslogTime(month, day, time, now),
    component,
    queueId: null,
    // Кто именно (ящик, сессия) обязан остаться в тексте: без этого строка
    // об ошибке доставки перестаёт отвечать на вопрос «кому не доставилось».
    text: who === '' ? rest : `${who}: ${rest}`,
  };
}

function parseApiLine(line: string, now: Date): LogEntry {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return { source: 'api', level: 'info', at: null, component: '', queueId: null, text: line };
  }
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const level = typeof obj.level === 'number' ? pinoLevel(obj.level) : 'info';
    const at = typeof obj.time === 'number' ? new Date(obj.time) : null;
    const msg = typeof obj.msg === 'string' ? obj.msg : '';
    // Остальные поля записи — это и есть подробности (err, url, ящик),
    // ради которых в журнал и смотрят. Складываем их в хвост строки,
    // выбрасывая служебные, одинаковые у каждой записи.
    const extras = Object.entries(obj)
      .filter(([key]) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key))
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    return {
      source: 'api',
      level,
      at,
      component: typeof obj.component === 'string' ? obj.component : 'api',
      queueId: null,
      text: extras ? `${msg} ${extras}` : msg,
    };
  } catch {
    return { source: 'api', level: 'info', at: now, component: '', queueId: null, text: line };
  }
}

/* ------------------------------------------------------------------ */
/* События доставки (история обработанных писем)                        */
/* ------------------------------------------------------------------ */

export type FlowStatus = 'sent' | 'deferred' | 'bounced' | 'expired' | 'rejected' | 'held';
export type FlowDirection = 'in' | 'out' | 'unknown';

/** Одна попытка доставки одному адресату — строка истории. */
export interface FlowEvent {
  occurredAt: Date;
  queueId: string | null;
  direction: FlowDirection;
  status: FlowStatus;
  sender: string | null;
  recipient: string | null;
  relay: string | null;
  delaySeconds: number | null;
  sizeBytes: number | null;
  dsn: string | null;
  reason: string | null;
  component: string;
}

/** То, что известно о письме из строки `from=…, size=…` до попыток доставки. */
export interface QueueMeta {
  sender: string | null;
  sizeBytes: number | null;
  /**
   * Направление, если оно уже было определено по более ранней строке того
   * же письма.
   *
   * Повторные попытки Postfix пишет псевдотранспортом `error`:
   * «delivery temporarily suspended: …». По нему направление не определить
   * никак — и в разделе такие строки показывались как «неизвестно», хотя
   * первая попытка того же письма честно назвала его исходящим. Письмо в
   * очереди одно, направление у него одно: берём уже известное, а не гадаем
   * по адресу (адрес врёт — алиас, пересылка, ящик на чужом домене).
   */
  direction?: FlowDirection;
}

const STATUS_MAP: Readonly<Record<string, FlowStatus>> = {
  sent: 'sent',
  deferred: 'deferred',
  bounced: 'bounced',
  expired: 'expired',
  undeliverable: 'bounced',
};

/**
 * Удержанное письмо: `hold:` от cleanup/smtpd и `postsuper -h` от человека.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТО ВООБЩЕ НАДО РАЗБИРАТЬ
 * ------------------------------------------------------------------
 * Состояние `held` было в схеме (0007_mail_flow.sql), в наборе состояний
 * FlowStatus, в фильтре истории («придержано») и в графике долей — а
 * ставить его было некому: STATUS_MAP переводит слово из `status=…`, а
 * удержание Postfix словом `status=` не записывает вовсе. Фильтр честно
 * работал и всегда возвращал ноль строк, то есть предлагал искать то,
 * чего в базе не бывает по построению.
 *
 * Удержание записывается двумя способами, и оба нужны:
 *
 *   1. `postfix/cleanup[…]: 3F2A1B: hold: header Subject: … from …;
 *      from=<a@b> to=<c@d>` — сработало правило header_checks/body_checks
 *      с действием HOLD; так же выглядит HOLD из smtpd-ограничений;
 *   2. `postfix/postsuper[…]: 3F2A1B: placed on hold` — письмо придержал
 *      человек руками (`postsuper -h`), обычно разбирая всплеск рассылки.
 *
 * Второй способ адресата не называет: postsuper знает только очередь.
 * Адресат тогда берётся из того, что уже известно об этом письме, — как
 * и отправитель у обычных строк доставки.
 */
const HOLD_ACTION = /(?:^|\s)hold:\s/;
const HOLD_BY_HAND = /\bplaced on hold\b/;

/**
 * Достаёт значение поля `key=…` из хвоста строки Postfix.
 *
 * Разделитель полей у Postfix разный в разных строках, и это не мелочь:
 * в строке о доставке поля идут через запятую (`to=<a@b>, relay=…`), а в
 * строке об отказе на приёме — через пробел (`from=<a@b> to=<c@d>
 * proto=ESMTP helo=<x>`). Проверка поймала это на живом примере: разбор
 * по одной лишь запятой утаскивал в адресата ещё и «proto=ESMTP helo=<x>».
 *
 * Поэтому значение — либо адрес в угловых скобках целиком (внутри них
 * бывают и пробелы, и запятые), либо кусок до ближайшего разделителя.
 */
function field(text: string, key: string): string | null {
  const m = new RegExp(`(?:^|[\\s,])${key}=(<[^>]*>|[^,\\s]*)`).exec(text);
  if (!m) return null;
  return m[1]!.trim() || null;
}

/** Снимает угловые скобки с адреса и приводит к нижнему регистру. */
function address(raw: string | null): string | null {
  if (raw === null) return null;
  const clean = raw.replace(/^<|>$/g, '').trim();
  if (clean === '') return null;
  return clean.toLowerCase();
}

/**
 * Направление письма.
 *
 * Определяется транспортом, а не адресом: адрес врёт (алиас, пересылка,
 * ящик на чужом домене), транспорт — нет. lmtp — это доставка в наши
 * ящики через Dovecot, smtp — отправка наружу. Всё прочее честно
 * называется неизвестным, а не угадывается.
 */
export function directionOf(component: string, relay: string | null): FlowDirection {
  // У составных имён («submission/smtpd») значение несёт последняя часть.
  const service = component.split('/').pop() ?? component;
  if (service === 'lmtp' || service === 'virtual' || service === 'local') return 'in';
  if (service === 'smtp' || service === 'relay') return 'out';
  if (relay && /:24\b/.test(relay)) return 'in';
  return 'unknown';
}

/**
 * Направление письма, которое отклонили или придержали НА ПРИЁМЕ.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ОТДЕЛЬНО ОТ directionOf
 * ------------------------------------------------------------------
 * У отклонённого письма нет ни транспорта, ни узла-получателя: до
 * доставки оно не дошло. Раньше в этом месте стояло `direction: 'in'`
 * без единой проверки — и это неверно ровно там, где важнее всего.
 * Отклонить можно и ИСХОДЯЩЕЕ письмо, и таких отказов на живом сервере
 * не меньше: не прошла проверка отправителя, письмо крупнее предела,
 * сработало правило header_checks на подаче, ящик исчерпал разрешённую
 * частоту. Все они писались как входящие, и на графике «отклонено на
 * приёме» в столбце «входящие» стояли собственные сотрудники — то есть
 * фильтр по направлению уводил в противоположную сторону.
 *
 * Различается по двум признакам, оба надёжны:
 *
 *   * имя службы. Подача пользователями поднята отдельными службами с
 *     собственными именами в журнале: `postfix/submission/smtpd` (587) и
 *     `postfix/submissions/smtpd` (465) — см. infra/postfix/conf/master.cf.
 *     Приём чужой почты идёт службой без приставки (`postfix/smtpd`, 25);
 *   * `sasl_username=` в строке. Он значит, что клиент ПРЕДСТАВИЛСЯ, а
 *     представляются только свои и только при отправке. Признак нужен
 *     отдельно от имени службы: подать письмо можно и в порт 25, если
 *     разрешена аутентификация на нём.
 *
 * Всё, что не подошло, — «входящее», и это не догадка: на порт 25 идёт
 * чужая почта, и отказ там по определению входящий.
 */
export function inboundDirectionOf(component: string, text: string): FlowDirection {
  const parts = component.split('/');
  // Приставка службы стоит ПЕРЕД smtpd: «submission/smtpd».
  const service = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  if (service === 'submission' || service === 'submissions' || service === 'smtps') return 'out';
  if (/\bsasl_username=\S/.test(text)) return 'out';
  return 'in';
}

/**
 * Достаёт событие доставки из разобранной строки Postfix.
 *
 * `meta` — то, что запомнено по этому письму из более ранней строки
 * `from=…, size=…`: в строке о доставке отправителя нет, а показать его
 * надо. Если письмо пришло в разбор без начала (журнал провернулся ровно
 * между строками), отправитель останется пустым — это честнее, чем
 * подставить чужого.
 */
export function toFlowEvent(entry: LogEntry, meta: QueueMeta | undefined): FlowEvent | null {
  if (entry.source !== 'postfix' || entry.at === null) return null;
  const text = entry.text;

  // Придержанное письмо. Проверяется ДО отказа: у строки cleanup с
  // действием HOLD слова «reject» нет, а у отказа нет слова «hold», —
  // но порядок всё равно задан явно, чтобы правило не зависело от того,
  // как Postfix однажды перепишет формулировку.
  if (HOLD_ACTION.test(text) || HOLD_BY_HAND.test(text)) {
    const to = address(field(text, 'to'));
    const from = address(field(text, 'from'));
    // `postsuper: … placed on hold` не называет ни адресата, ни
    // отправителя — только очередь. Тогда берём то, что уже известно
    // об этом письме из строки его приёма.
    if (to === null && from === null && entry.queueId === null) return null;
    const reasonMatch = /hold:\s*(.*?)(?:;\s*from=|$)/.exec(text);
    return {
      occurredAt: entry.at,
      queueId: entry.queueId,
      direction: inboundDirectionOf(entry.component, text) === 'out' ? 'out' : (meta?.direction ?? 'in'),
      status: 'held',
      sender: from ?? meta?.sender ?? null,
      recipient: to,
      relay: null,
      delaySeconds: null,
      sizeBytes: meta?.sizeBytes ?? null,
      dsn: null,
      reason:
        reasonMatch?.[1]?.trim().slice(0, 500) ??
        (HOLD_BY_HAND.test(text) ? 'придержано вручную (postsuper -h)' : text.slice(0, 500)),
      component: entry.component,
    };
  }

  // Отказ на приёме: очереди у такого письма нет вовсе.
  if (/\breject:\s/.test(text)) {
    const to = address(field(text, 'to'));
    const from = address(field(text, 'from'));
    if (to === null && from === null) return null;
    const reasonMatch = /reject:\s*(.*?)(?:;\s*from=|$)/.exec(text);
    return {
      occurredAt: entry.at,
      queueId: entry.queueId,
      // Отклонить можно и исходящее: см. inboundDirectionOf.
      direction: inboundDirectionOf(entry.component, text),
      status: 'rejected',
      sender: from,
      recipient: to,
      relay: null,
      delaySeconds: null,
      sizeBytes: null,
      dsn: /\b([45]\.\d\.\d)\b/.exec(text)?.[1] ?? null,
      reason: reasonMatch?.[1]?.trim().slice(0, 500) ?? text.slice(0, 500),
      component: entry.component,
    };
  }

  const status = field(text, 'status');
  const to = field(text, 'to');
  if (status === null || to === null) return null;
  const statusWord = (status.split(/\s+/)[0] ?? '').toLowerCase();
  const mapped = STATUS_MAP[statusWord];
  if (!mapped) return null;

  const relay = field(text, 'relay');
  const delayRaw = field(text, 'delay');
  const delay = delayRaw === null ? null : Number(delayRaw);
  // Текст в скобках в самом конце — это ответ принимающей стороны,
  // ровно то, что человек ищет, когда спрашивает «почему не дошло».
  const reason = /\(([\s\S]*)\)\s*$/.exec(text)?.[1] ?? null;

  // Транспорт `error` (повторные попытки) направления не несёт — тогда
  // берём то, что уже известно об этом же письме из очереди.
  const byTransport = directionOf(entry.component, relay);
  return {
    occurredAt: entry.at,
    queueId: entry.queueId,
    direction: byTransport === 'unknown' ? (meta?.direction ?? 'unknown') : byTransport,
    status: mapped,
    sender: meta?.sender ?? null,
    recipient: address(to),
    relay,
    delaySeconds: delay !== null && Number.isFinite(delay) ? delay : null,
    sizeBytes: meta?.sizeBytes ?? null,
    dsn: field(text, 'dsn'),
    reason: reason === null ? null : reason.slice(0, 500),
    component: entry.component,
  };
}

/**
 * Достаёт из строки сведения о письме, которые дальше пригодятся его
 * попыткам доставки: `4c2w: from=<a@b>, size=1234, nrcpt=1 (queue active)`.
 */
export function toQueueMeta(entry: LogEntry): QueueMeta | null {
  if (entry.source !== 'postfix' || entry.queueId === null) return null;
  /*
   * Строка ДЕЙСТВИЯ — не сведения о письме, а событие, и путать их нельзя.
   *
   * У cleanup с правилом HOLD (и с правилом REJECT) поля `from=` и `to=`
   * стоят в конце той же строки, что и само действие. Сборщик, увидев
   * `from=`, считал такую строку описанием письма и прекращал её разбор
   * (`continue` в flow-collector.ts) — то есть событие удержания терялось
   * ровно там, где появлялось. Событие важнее сведений: отправителя и
   * размер того же письма всё равно принесёт строка его приёма.
   */
  if (HOLD_ACTION.test(entry.text) || /(?:^|\s)reject:\s/.test(entry.text)) return null;
  const from = field(entry.text, 'from');
  if (from === null) return null;
  const size = field(entry.text, 'size');
  const sizeNumber = size === null ? null : Number(size);
  return {
    sender: address(from),
    sizeBytes: sizeNumber !== null && Number.isFinite(sizeNumber) ? sizeNumber : null,
  };
}

/** Строка `4c2w: removed` — письмо ушло из очереди, помнить о нём нечего. */
export function isQueueRemoval(entry: LogEntry): boolean {
  return entry.source === 'postfix' && entry.queueId !== null && /:\s*removed\s*$/.test(entry.text);
}

/**
 * Ограниченная память об отправителях писем, ещё лежащих в очереди.
 *
 * Почему с пределом. Строка `from=` приходит раз, строк `to=` бывает
 * много и позже — между ними письмо может пролежать в очереди сутки.
 * Помнить всё без предела нельзя: на сервере с рассылками эта память
 * росла бы вместе с очередью и однажды съела бы кучу процесса. Предел
 * вытесняет самое старое; худшее следствие — у очень старого письма
 * не покажется отправитель.
 */
export class QueueMetaCache {
  private readonly items = new Map<string, QueueMeta>();

  constructor(private readonly limit = 20_000) {}

  set(queueId: string, meta: QueueMeta): void {
    // Перевставка двигает запись в конец: так вытесняется именно
    // давно не встречавшееся, а не давно заведённое.
    this.items.delete(queueId);
    this.items.set(queueId, meta);
    while (this.items.size > this.limit) {
      const oldest = this.items.keys().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
    }
  }

  get(queueId: string | null): QueueMeta | undefined {
    if (queueId === null) return undefined;
    return this.items.get(queueId);
  }

  delete(queueId: string): void {
    this.items.delete(queueId);
  }

  get size(): number {
    return this.items.size;
  }
}
