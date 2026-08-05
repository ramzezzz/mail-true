/**
 * Проверка DNS-записей домена.
 *
 * Самое частое место, где спотыкаются при установке почтового сервера,
 * поэтому каждая проверка возвращает не «SPF: FAIL», а пять вещей:
 * зачем нужна запись и что сломается без неё, что должно быть опубликовано
 * (готовая строка для копирования), что опубликовано на самом деле,
 * вывод (настроено / не настроено / настроено с ошибкой) и что сделать.
 *
 * ── У КОГО СПРАШИВАЕМ ─────────────────────────────────────────────
 *
 * У публичных резольверов, а НЕ у своего unbound и не у системного
 * резольвера контейнера. Это не придирка: в стеке стоит собственный
 * рекурсивный резольвер (infra/unbound), а контейнеры к тому же ходят
 * через встроенный DNS docker (127.0.0.11), который отвечает на имена
 * контейнеров. Спросив «у себя», проверка показала бы то, что мы сами
 * себе прописали, — а вопрос стоит ровно обратный: видит ли наши записи
 * остальной интернет, тот самый, что решает, доставлять ли нашу почту.
 *
 * Резольверы перебираются по очереди: первый, кто ответил по существу
 * (записи или «такого имени нет»), считается ответившим. Если по существу
 * не ответил никто — это НЕ «записи нет», а «не удалось спросить»
 * (verdict = 'unreachable'). Разница принципиальная: в первом случае надо
 * идти к регистратору, во втором — чинить сеть, и молчаливое «не
 * настроено» при недоступном резольвере было бы обманом.
 *
 * Набор ожидаемых записей взят из docs/install.md (раздел «DNS: какие
 * записи и зачем») и совпадает с тем, что печатает установщик
 * (apps/autoconfig/src/dns.ts).
 */
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

/* ================================================================== */
/* Типы                                                                */
/* ================================================================== */

/** Итоговая метка для плашки и для колонки dns_overall в базе. */
export type DnsCheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';

/**
 * Вывод по записи человеческим языком. Отличается от статуса тем, что
 * различает «записи нет» и «запись есть, но не та» — заказчику нужно
 * именно это различие, а колонка в базе знает только четыре значения.
 */
export type DnsVerdict = 'ok' | 'missing' | 'mismatch' | 'warn' | 'unreachable';

/** Разделы из docs/install.md, по которым сгруппирован диалог. */
export type DnsGroup = 'core' | 'web' | 'client';

export type DnsRecordType = 'A' | 'MX' | 'TXT' | 'CNAME' | 'SRV' | 'PTR';

export type DnsCheckId =
  | 'a'
  | 'mx'
  | 'spf'
  | 'dkim'
  | 'dmarc'
  | 'ptr'
  | 'web-apex'
  | 'web-mail'
  | 'web-admin'
  | 'autoconfig'
  | 'autodiscover'
  | 'srv-imaps'
  | 'srv-submission'
  | 'srv-pop3s'
  | 'srv-autodiscover';

export interface DnsCheckResult {
  id: DnsCheckId;
  group: DnsGroup;
  title: string;
  /** Зачем нужна эта запись — человеческим языком. */
  purpose: string;
  /** Что сломается, если записи нет. */
  impact: string;
  recordName: string;
  recordType: DnsRecordType;
  /** Готовое значение для вставки в панель регистратора. */
  expected: string;
  /**
   * Можно ли просто скопировать значение к регистратору. У PTR нельзя:
   * обратной зоной владеет хостер, а не регистратор домена.
   */
  copyable: boolean;
  /** Что реально опубликовано в DNS (как ответил мир). */
  actual: string[];
  status: DnsCheckStatus;
  verdict: DnsVerdict;
  /** В чём именно расхождение; null — расхождения нет или сравнивать нечего. */
  diff: string | null;
  /** Что сделать, чтобы починить. */
  hint: string;
  /** Без неё почта не работает (true) или только неудобно (false). */
  required: boolean;
  /** Какой резольвер ответил; null — никто не ответил. */
  askedVia: string | null;
}

export interface DnsResolverInfo {
  /** У кого спрашивали (по порядку). */
  servers: string[];
  /** Кто ответил по существу хотя бы раз. */
  answeredBy: string[];
  /** Ответил ли вообще хоть кто-нибудь. */
  reachable: boolean;
}

export interface DnsReport {
  domain: string;
  checkedAt: string;
  overall: DnsCheckStatus;
  resolver: DnsResolverInfo;
  checks: DnsCheckResult[];
}

export interface DnsCheckOptions {
  /** Имя почтового сервера (значение MX и цель CNAME автонастройки). */
  mailHostname: string;
  /** Публичный IPv4 сервера; пусто — сверять A и PTR не с чем. */
  publicIpv4?: string;
  /** Селектор DKIM (по умолчанию mail). */
  dkimSelector?: string;
  /** Ожидаемый публичный ключ DKIM (base64 из rspamd). */
  dkimPublicKey?: string | null;
  /** Порт IMAPS для SRV-записи (993). */
  imapsPort?: number;
  /** Порт submission для SRV-записи (587). */
  submissionPort?: number;
  /** Порт POP3S для SRV-записи (995). */
  pop3sPort?: number;
  /** Таймаут одного запроса, мс. */
  timeoutMs?: number;
  /** У кого спрашивать; по умолчанию публичные резольверы. */
  servers?: readonly string[] | undefined;
  /** Подставной резольвер для проверок. */
  querier?: DnsQuerier;
}

/* ================================================================== */
/* Резольвер: спрашиваем внешний мир                                   */
/* ================================================================== */

/**
 * Публичные резольверы по умолчанию. Несколько — не для надёжности
 * ответа, а чтобы отличить «нашу сеть не выпускают наружу» от «записи
 * действительно нет»: если недоступны все, вывод честно говорит, что
 * спросить не удалось.
 */
export const PUBLIC_RESOLVERS: readonly string[] = ['8.8.8.8', '9.9.9.9', '1.1.1.1', '8.8.4.4'];

export type DnsAnswer =
  /** Резольвер ответил записями. */
  | { kind: 'records'; values: string[]; via: string }
  /** Резольвер ответил по существу: такого имени/типа нет. */
  | { kind: 'absent'; via: string }
  /** По существу не ответил никто — спросить не удалось. */
  | { kind: 'unreachable'; reason: string };

export interface DnsQuerier {
  readonly servers: readonly string[];
  query(type: DnsRecordType, name: string): Promise<DnsAnswer>;
  /** Кто ответил по существу хотя бы раз. */
  answeredBy(): string[];
}

/** Полное имя записи без точки на конце и в нижнем регистре. */
export function fqdn(name: string): string {
  return name.replace(/\.+$/, '').toLowerCase();
}

/**
 * «Записи нет» — это ответ по существу, а не отказ.
 * ENOTFOUND/NXDOMAIN — нет такого имени, ENODATA — имя есть, а записей
 * запрошенного типа у него нет. И то и другое лечится у регистратора.
 */
function isDefiniteAbsence(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN';
}

function describeFailure(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case 'ETIMEOUT':
    case 'ETIMEDOUT':
      return 'резольвер не ответил вовремя';
    case 'ECONNREFUSED':
      return 'резольвер отказал в соединении';
    case 'ESERVFAIL':
      return 'резольвер ответил SERVFAIL (сбой на его стороне или проверка DNSSEC не сошлась)';
    case 'EREFUSED':
      return 'резольвер отказался отвечать';
    default:
      return code ?? (err instanceof Error ? err.message : String(err));
  }
}

/** Приводит ответ любого типа к строкам в том виде, как их пишут в зоне. */
async function askOne(
  server: string,
  type: DnsRecordType,
  name: string,
  timeoutMs: number,
): Promise<DnsAnswer> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([server]);
  try {
    let values: string[];
    switch (type) {
      case 'A':
        values = await resolver.resolve4(name);
        break;
      case 'MX': {
        const mx = await resolver.resolveMx(name);
        values = mx
          .slice()
          .sort((a, b) => a.priority - b.priority)
          .map((r) => `${String(r.priority)} ${fqdn(r.exchange)}`);
        break;
      }
      case 'TXT': {
        // Длинное значение DNS отдаёт кусками по 255 символов — склеиваем
        // без разделителя, ровно как это делает получатель письма.
        const txt = await resolver.resolveTxt(name);
        values = txt.map((chunks) => chunks.join(''));
        break;
      }
      case 'CNAME':
        values = (await resolver.resolveCname(name)).map(fqdn);
        break;
      case 'SRV': {
        const srv = await resolver.resolveSrv(name);
        values = srv.map(
          (r) => `${String(r.priority)} ${String(r.weight)} ${String(r.port)} ${fqdn(r.name)}`,
        );
        break;
      }
      case 'PTR':
        values = (await resolver.reverse(name)).map(fqdn);
        break;
    }
    if (values.length === 0) return { kind: 'absent', via: server };
    return { kind: 'records', values, via: server };
  } catch (err) {
    if (isDefiniteAbsence(err)) return { kind: 'absent', via: server };
    return { kind: 'unreachable', reason: `${server}: ${describeFailure(err)}` };
  }
}

/**
 * Опрашивает публичные резольверы по очереди. Первый ответ по существу
 * побеждает; сервер, который ответил, запоминается и спрашивается первым
 * в следующий раз — иначе на каждой записи мы бы заново ждали таймаута
 * от резольвера, который в этой сети недоступен.
 */
export function createPublicQuerier(options: {
  servers?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
} = {}): DnsQuerier {
  const servers = [...(options.servers && options.servers.length > 0 ? options.servers : PUBLIC_RESOLVERS)];
  const timeoutMs = options.timeoutMs ?? 4000;
  const answered = new Set<string>();
  let preferred = 0;

  return {
    servers,
    answeredBy: () => [...answered],
    async query(type, name) {
      const reasons: string[] = [];
      for (let i = 0; i < servers.length; i += 1) {
        const index = (preferred + i) % servers.length;
        const server = servers[index];
        if (server === undefined) continue;
        const answer = await askOne(server, type, name, timeoutMs);
        if (answer.kind === 'unreachable') {
          reasons.push(answer.reason);
          continue;
        }
        preferred = index;
        answered.add(server);
        return answer;
      }
      return {
        kind: 'unreachable',
        reason: reasons.join('; ') || 'не задано ни одного резольвера',
      };
    },
  };
}

/* ================================================================== */
/* Готовые значения записей (docs/install.md)                          */
/* ================================================================== */

/** Рекомендованная строка SPF: отправлять могут хосты из MX домена. */
export function buildSpfRecord(_mailHostname?: string): string {
  return 'v=spf1 mx ~all';
}

/** Рекомендованная строка DMARC: подозрительные — в спам, отчёты почтмейстеру. */
export function buildDmarcRecord(domain: string): string {
  return `v=DMARC1; p=quarantine; rua=mailto:postmaster@${fqdn(domain)}; adkim=s; aspf=s`;
}

/** Готовая TXT-запись DKIM из публичного ключа rspamd. */
export function buildDkimRecord(publicKey: string): string {
  return `v=DKIM1; k=rsa; p=${normalizeDkimKey(publicKey)}`;
}

/* ================================================================== */
/* Разбор и сравнение значений                                         */
/* ================================================================== */

/**
 * Ключ DKIM для сравнения по существу.
 *
 * Значение длинное, и панели DNS режут его на куски по 255 символов,
 * дописывают переводы строк, кавычки и пробелы; администратор нередко
 * вставляет ключ с отступами из файла rspamd. Всё это — то же самое
 * base64. Сравнение «посимвольно» объявило бы верную запись ошибочной,
 * поэтому оставляем только символы алфавита base64 и выбрасываем
 * выравнивающие «=»: они несут ноль сведений.
 */
export function normalizeDkimKey(value: string): string {
  return value.replace(/[^A-Za-z0-9+/]/g, '');
}

export interface DkimRecord {
  version: string | null;
  keyType: string | null;
  /** Публичный ключ, приведённый к сравнимому виду; null — ключа в записи нет. */
  key: string | null;
  /** p= пустой: так объявляют отозванный ключ. */
  revoked: boolean;
}

/** Разбор TXT-записи DKIM на теги. */
export function parseDkimRecord(value: string): DkimRecord {
  const tags = new Map<string, string>();
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key === '') continue;
    // Значение может содержать «=» (выравнивание base64) — режем только по первому.
    tags.set(key, part.slice(eq + 1).trim());
  }
  const rawKey = tags.get('p');
  const key = rawKey === undefined ? null : normalizeDkimKey(rawKey);
  return {
    version: tags.get('v') ?? null,
    keyType: tags.get('k') ?? null,
    key,
    revoked: key === '',
  };
}

/** Совпадают ли два ключа DKIM по существу (перенос строк и «=» не в счёт). */
export function dkimKeysMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const left = normalizeDkimKey(a);
  const right = normalizeDkimKey(b);
  return left !== '' && left === right;
}

export interface SpfRecord {
  valid: boolean;
  /** Механизмы без «v=spf1» и без завершающего «all». */
  mechanisms: string[];
  /** Завершающий механизм: «-all», «~all», «?all», «+all»; null — его нет. */
  all: string | null;
  /** Ссылается ли запись на чужую (include:/redirect=) — тогда проверить до конца нельзя. */
  delegates: boolean;
}

/** Разбор строки SPF на механизмы. */
export function parseSpfRecord(value: string): SpfRecord {
  const tokens = value.trim().split(/\s+/).filter((t) => t !== '');
  const first = tokens[0]?.toLowerCase() ?? '';
  const rest = tokens.slice(1);
  let all: string | null = null;
  const mechanisms: string[] = [];
  for (const token of rest) {
    if (/^[-~?+]?all$/i.test(token)) {
      all = token.toLowerCase();
      continue;
    }
    mechanisms.push(token.toLowerCase());
  }
  return {
    valid: first === 'v=spf1',
    mechanisms,
    all,
    delegates: mechanisms.some((m) => m.startsWith('include:') || m.startsWith('redirect=')),
  };
}

/** Разрешает ли SPF отправку с нашего сервера. */
export function spfAllowsHost(
  record: SpfRecord,
  host: string,
  publicIpv4?: string,
): 'yes' | 'no' | 'unclear' {
  const target = fqdn(host);
  for (const m of record.mechanisms) {
    if (m === 'mx' || m === `mx:${target}`) return 'yes';
    if (m === `a:${target}`) return 'yes';
    if (publicIpv4 && (m === `ip4:${publicIpv4}` || m.startsWith(`ip4:${publicIpv4}/`))) return 'yes';
  }
  return record.delegates ? 'unclear' : 'no';
}

/** Разбор TXT-записи DMARC на теги. */
export function parseDmarcRecord(value: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key === '') continue;
    tags.set(key, part.slice(eq + 1).trim());
  }
  return tags;
}

/** Итоговое состояние: худшее из проверок (fail > warn > unknown > ok). */
export function worstStatus(statuses: readonly DnsCheckStatus[]): DnsCheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.includes('unknown')) return 'unknown';
  return 'ok';
}

/**
 * Статус для плашки. «Запись есть, но не та» — всегда ошибка: неверная
 * запись хуже отсутствующей, потому что выглядит настроенной. Отсутствие
 * необязательной записи — только замечание.
 */
export function statusOf(verdict: DnsVerdict, required: boolean): DnsCheckStatus {
  switch (verdict) {
    case 'ok':
      return 'ok';
    case 'warn':
      return 'warn';
    case 'unreachable':
      return 'unknown';
    case 'mismatch':
      return 'fail';
    case 'missing':
      return required ? 'fail' : 'warn';
  }
}

/* ================================================================== */
/* Сборка проверок                                                     */
/* ================================================================== */

interface Judgement {
  verdict: DnsVerdict;
  diff: string | null;
  hint: string;
}

interface CheckSpec {
  id: DnsCheckId;
  group: DnsGroup;
  title: string;
  purpose: string;
  impact: string;
  recordName: string;
  recordType: DnsRecordType;
  expected: string;
  required: boolean;
  copyable?: boolean;
  /** Как судить по полученным записям. */
  judge: (values: string[]) => Judgement;
  /** Что сказать, когда записей нет. */
  missingHint: string;
}

const UNREACHABLE_HINT =
  'Проверка не состоялась: ни один резольвер не ответил. Это НЕ значит, что записи нет — ' +
  'сначала проверьте, выпускает ли сервер запросы на 53/udp наружу, и повторите.';

function toCheck(spec: CheckSpec, answer: DnsAnswer): DnsCheckResult {
  let verdict: DnsVerdict;
  let diff: string | null = null;
  let hint: string;
  let actual: string[] = [];
  let askedVia: string | null = null;

  if (answer.kind === 'unreachable') {
    verdict = 'unreachable';
    hint = `${UNREACHABLE_HINT} Причина: ${answer.reason}.`;
  } else if (answer.kind === 'absent') {
    askedVia = answer.via;
    verdict = 'missing';
    diff = 'записи с таким именем и типом нет ни одной';
    hint = spec.missingHint;
  } else {
    askedVia = answer.via;
    actual = answer.values;
    const judged = spec.judge(answer.values);
    verdict = judged.verdict;
    diff = judged.diff;
    hint = judged.hint;
  }

  return {
    id: spec.id,
    group: spec.group,
    title: spec.title,
    purpose: spec.purpose,
    impact: spec.impact,
    recordName: spec.recordName,
    recordType: spec.recordType,
    expected: spec.expected,
    copyable: spec.copyable ?? true,
    actual,
    status: statusOf(verdict, spec.required),
    verdict,
    diff,
    hint,
    required: spec.required,
    askedVia,
  };
}

/**
 * Имя может быть опубликовано и как CNAME, и как A — оба варианта рабочие.
 * Собираем из двух ответов один: записи важнее «нет записи», а «нет записи»
 * говорим только тогда, когда ОБА резольвера ответили по существу.
 * Иначе получилось бы «не настроено» там, где на самом деле не спросили.
 */
export function combineNameAnswers(
  cname: DnsAnswer | null,
  a: DnsAnswer,
): { answer: DnsAnswer; type: 'CNAME' | 'A' } {
  if (cname !== null && cname.kind === 'records') return { answer: cname, type: 'CNAME' };
  if (a.kind === 'records') return { answer: a, type: 'A' };
  const cnameDefinite = cname === null || cname.kind === 'absent';
  if (cnameDefinite && a.kind === 'absent') return { answer: a, type: 'A' };
  const unreachable = a.kind === 'unreachable' ? a : cname;
  return {
    answer: unreachable ?? { kind: 'unreachable', reason: 'нет ответа' },
    type: 'A',
  };
}

/** Указывает ли CNAME/A на наш сервер. */
function judgeTarget(
  values: string[],
  type: 'CNAME' | 'A',
  host: string,
  serverIps: readonly string[],
): Judgement {
  if (type === 'CNAME') {
    if (values.some((v) => fqdn(v) === host)) {
      return { verdict: 'ok', diff: null, hint: `Указывает на «${host}» — верно.` };
    }
    return {
      verdict: 'mismatch',
      diff: `ожидается «${host}», опубликовано «${values.join(', ')}»`,
      hint: `Запись ведёт на чужой сервер. Замените значение CNAME на «${host}.».`,
    };
  }
  if (serverIps.length === 0) {
    return {
      verdict: 'warn',
      diff: null,
      hint:
        `Опубликован адрес ${values.join(', ')}, но админка не знает адрес сервера ` +
        `(не задан MAIL_PUBLIC_IPV4 и не резолвится «${host}») — сверить не с чем.`,
    };
  }
  if (values.some((v) => serverIps.includes(v))) {
    return {
      verdict: 'ok',
      diff: null,
      hint: `Адрес ${values.join(', ')} — это наш сервер, верно (A вместо CNAME допустима).`,
    };
  }
  return {
    verdict: 'mismatch',
    diff: `ожидается адрес ${serverIps.join(', ')} (или CNAME на «${host}»), опубликовано ${values.join(', ')}`,
    hint:
      'Имя ведёт на чужой адрес — посетители и почтовые клиенты уйдут не туда. ' +
      `Замените запись на CNAME «${host}.» либо на A с адресом сервера.`,
  };
}

/**
 * Проверяет весь набор DNS-записей домена.
 *
 * Никогда не бросает: недоступность резольвера превращается в вывод
 * «не удалось спросить», а не в «не настроено».
 */
export async function checkDomainDns(
  domain: string,
  options: DnsCheckOptions,
): Promise<DnsReport> {
  const name = fqdn(domain);
  const host = fqdn(options.mailHostname);
  const selector = options.dkimSelector || 'mail';
  const ip = (options.publicIpv4 ?? '').trim();
  const imapsPort = options.imapsPort ?? 993;
  const submissionPort = options.submissionPort ?? 587;
  const pop3sPort = options.pop3sPort ?? 995;

  const querier =
    options.querier ??
    createPublicQuerier({ servers: options.servers, timeoutMs: options.timeoutMs });

  /* Адрес сервера нужен нескольким проверкам сразу — спрашиваем один раз. */
  const hostA = await querier.query('A', host);
  const configuredIp = ip !== '' && isIP(ip) !== 0 ? ip : '';
  const publishedIps = hostA.kind === 'records' ? hostA.values : [];
  const serverIps = configuredIp !== '' ? [configuredIp] : publishedIps;

  /**
   * Чей PTR спрашивать.
   *
   * MAIL_PUBLIC_IPV4 установщик выставляет не всегда, и проверка PTR при
   * этом молчала — «неизвестно» навсегда. Между тем адрес сервера в этот
   * момент уже опубликован: это A-запись «${host}», которую мы только что
   * спросили. Берём её, а в подсказке честно говорим, откуда взят адрес.
   */
  const ptrIp = configuredIp !== '' ? configuredIp : (publishedIps.find((v) => isIP(v) === 4) ?? '');
  const ptrIpFromDns = configuredIp === '' && ptrIp !== '';

  const [
    mxAnswer,
    spfAnswer,
    dkimAnswer,
    dmarcAnswer,
    ptrAnswer,
    apexAnswer,
    mailCnameAnswer,
    mailAAnswer,
    adminCnameAnswer,
    adminAAnswer,
    autoconfigCnameAnswer,
    autoconfigAAnswer,
    autodiscoverCnameAnswer,
    autodiscoverAAnswer,
    srvImaps,
    srvSubmission,
    srvPop3s,
    srvAutodiscover,
  ] = await Promise.all([
    querier.query('MX', name),
    querier.query('TXT', name),
    querier.query('TXT', `${selector}._domainkey.${name}`),
    querier.query('TXT', `_dmarc.${name}`),
    ptrIp !== ''
      ? querier.query('PTR', ptrIp)
      : Promise.resolve<DnsAnswer>({ kind: 'unreachable', reason: 'адрес сервера неизвестен' }),
    querier.query('A', name),
    querier.query('CNAME', `mail.${name}`),
    querier.query('A', `mail.${name}`),
    querier.query('CNAME', `admin.${name}`),
    querier.query('A', `admin.${name}`),
    querier.query('CNAME', `autoconfig.${name}`),
    querier.query('A', `autoconfig.${name}`),
    querier.query('CNAME', `autodiscover.${name}`),
    querier.query('A', `autodiscover.${name}`),
    querier.query('SRV', `_imaps._tcp.${name}`),
    querier.query('SRV', `_submission._tcp.${name}`),
    querier.query('SRV', `_pop3s._tcp.${name}`),
    querier.query('SRV', `_autodiscover._tcp.${name}`),
  ]);

  const checks: DnsCheckResult[] = [];

  /* --- A: где стоит сервер ----------------------------------------- */
  checks.push(
    toCheck(
      {
        id: 'a',
        group: 'core',
        title: 'A — адрес почтового сервера',
        purpose: `Говорит, по какому адресу искать сам сервер «${host}».`,
        impact:
          'Без неё не на что сослаться всем остальным записям: не выпустится ' +
          'сертификат, и чужие серверы не найдут, куда доставлять почту.',
        recordName: host,
        recordType: 'A',
        expected: ip !== '' ? ip : '<публичный адрес сервера>',
        required: true,
        missingHint:
          `У имени «${host}» нет A-записи. Добавьте у регистратора запись типа A ` +
          `с адресом сервера${ip !== '' ? ` (${ip})` : ''}.`,
        judge: (values) => {
          if (ip === '') {
            return {
              verdict: 'warn',
              diff: null,
              hint:
                `Адрес опубликован (${values.join(', ')}), но админка не знает ожидаемый: ` +
                'задайте MAIL_PUBLIC_IPV4 — тогда будет с чем сверять.',
            };
          }
          if (values.includes(ip)) {
            return { verdict: 'ok', diff: null, hint: `«${host}» указывает на ${ip} — верно.` };
          }
          return {
            verdict: 'mismatch',
            diff: `ожидается ${ip}, опубликовано ${values.join(', ')}`,
            hint:
              `Имя сервера ведёт на чужой адрес. Пока это так, сертификат не выпустится, ` +
              `а почта пойдёт не сюда. Исправьте A-запись «${host}» на ${ip}.`,
          };
        },
      },
      hostA,
    ),
  );

  /* --- MX ----------------------------------------------------------
   *
   * Проверяем по существу, а не по имени. Совпадения имени обменника
   * мало: почта идёт не на имя, а на адрес, в который это имя
   * разворачивается. Зелёный MX при мёртвой или чужой A-записи не
   * доказывал ничего — письма всё равно не доходили.
   */
  const exchangesOf = (values: string[]): string[] => [
    ...new Set(values.map((v) => fqdn(v.split(/\s+/)[1] ?? '')).filter((v) => v !== '')),
  ];
  const foreignExchanges = mxAnswer.kind === 'records'
    ? exchangesOf(mxAnswer.values).filter((e) => e !== host).slice(0, 3)
    : [];
  const exchangeAddresses = new Map<string, DnsAnswer>([[host, hostA]]);
  await Promise.all(
    foreignExchanges.map(async (exchange) => {
      exchangeAddresses.set(exchange, await querier.query('A', exchange));
    }),
  );

  checks.push(
    toCheck(
      {
        id: 'mx',
        group: 'core',
        title: 'MX — куда доставлять почту домена',
        purpose: 'Говорит остальному интернету, какой сервер принимает почту для домена.',
        impact: `Без неё письма на «@${name}» просто не дойдут: отправителю вернётся отказ.`,
        recordName: name,
        recordType: 'MX',
        expected: `10 ${host}.`,
        required: true,
        missingHint:
          `Записи MX нет — внешние серверы не знают, куда доставлять почту для «${name}». ` +
          `Добавьте запись MX со значением «10 ${host}.». Точка на конце обязательна: ` +
          'без неё многие панели дописывают домен ещё раз.',
        judge: (values) => {
          const ours = exchangesOf(values).includes(host);
          if (ours) {
            const target = exchangeAddresses.get(host);
            if (target?.kind === 'absent') {
              return {
                verdict: 'mismatch',
                diff: `MX ведёт на «${host}», но у этого имени нет A-записи`,
                hint:
                  `Имя в MX верное, а разворачивать его не во что: чужой сервер получит отказ ` +
                  `ещё до соединения. Сначала заведите A-запись «${host}».`,
              };
            }
            if (
              target?.kind === 'records' &&
              configuredIp !== '' &&
              !target.values.includes(configuredIp)
            ) {
              return {
                verdict: 'mismatch',
                diff: `«${host}» разворачивается в ${target.values.join(', ')}, а сервер стоит на ${configuredIp}`,
                hint:
                  'Имя в MX наше, но ведёт на чужой адрес — почта уйдёт не на этот сервер. ' +
                  `Исправьте A-запись «${host}» на ${configuredIp}.`,
              };
            }
            return {
              verdict: 'ok',
              diff: null,
              hint:
                `Почта домена направлена на «${host}»` +
                (target?.kind === 'records' ? `, и это имя разворачивается в ${target.values.join(', ')}` : '') +
                ' — верно.',
            };
          }
          // Имя чужое — но, возможно, это тот же самый сервер под другим именем.
          const reachesUs = serverIps.length > 0 &&
            foreignExchanges.some((exchange) => {
              const a = exchangeAddresses.get(exchange);
              return a?.kind === 'records' && a.values.some((v) => serverIps.includes(v));
            });
          if (reachesUs) {
            return {
              verdict: 'warn',
              diff: `в MX стоит «${foreignExchanges.join(', ')}», а не «${host}»`,
              hint:
                'Почта дойдёт: имя в MX разворачивается в адрес этого сервера. Но оно не совпадает ' +
                `с тем, которым сервер представляется («${host}»), а на это смотрят при проверке ` +
                `PTR. Лучше поставить «10 ${host}.».`,
            };
          }
          return {
            verdict: 'mismatch',
            diff: `ожидается «10 ${host}.», опубликовано «${values.join(', ')}»`,
            hint:
              `MX указывает на другой сервер. Пока это так, входящая почта приходит не сюда. ` +
              `Замените значение на «10 ${host}.».`,
          };
        },
      },
      mxAnswer,
    ),
  );

  /* --- SPF --------------------------------------------------------- */
  const expectedSpf = buildSpfRecord(host);
  {
    const spfValues =
      spfAnswer.kind === 'records'
        ? spfAnswer.values.filter((r) => r.trim().toLowerCase().startsWith('v=spf1'))
        : [];
    // Из всех TXT домена берём только SPF: остальные (проверки владения
    // и прочее) к делу не относятся и лишь мешают читать.
    const spfAnswerOnly: DnsAnswer =
      spfAnswer.kind === 'records'
        ? spfValues.length > 0
          ? { kind: 'records', values: spfValues, via: spfAnswer.via }
          : { kind: 'absent', via: spfAnswer.via }
        : spfAnswer;
    checks.push(
      toCheck(
        {
          id: 'spf',
          group: 'core',
          title: 'SPF — кому разрешено отправлять от имени домена',
          purpose: 'Перечисляет серверы, которым разрешено отправлять почту от имени домена.',
          impact:
            'Без неё письма почти гарантированно попадают в спам: получатель не может ' +
            'отличить нашу отправку от подделки.',
          recordName: name,
          recordType: 'TXT',
          expected: expectedSpf,
          required: true,
          missingHint:
            `TXT-записи с SPF у домена нет. Добавьте TXT со значением «${expectedSpf}»: ` +
            '«mx» разрешает отправку тем хостам, что указаны в MX, «~all» — остальные подозрительны.',
          judge: (values) => {
            if (values.length > 1) {
              return {
                verdict: 'mismatch',
                diff: `записей SPF ${String(values.length)}, допустима ровно одна`,
                hint:
                  'Записей SPF несколько — по стандарту это ошибка, и проверка у получателя ' +
                  'заканчивается ничем. Оставьте одну, объединив условия.',
              };
            }
            const raw = values[0] ?? '';
            const parsed = parseSpfRecord(raw);
            const allows = spfAllowsHost(parsed, host, ip || undefined);
            if (allows === 'no') {
              return {
                verdict: 'mismatch',
                diff: `в записи нет ни «mx», ни «a:${host}»${ip ? `, ни «ip4:${ip}»` : ''}`,
                hint:
                  `SPF есть, но наш сервер в нём не разрешён — письма с него считаются подделкой. ` +
                  `Добавьте механизм «mx» (или «a:${host}»).`,
              };
            }
            if (allows === 'unclear') {
              return {
                verdict: 'warn',
                diff: 'запись ссылается на чужую (include:/redirect=) — проверить до конца нельзя',
                hint:
                  'SPF ссылается на чужую запись, поэтому убедиться, что наш сервер разрешён, ' +
                  `отсюда нельзя. Если отправка идёт с «${host}», добавьте механизм «mx» явно.`,
              };
            }
            if (parsed.all === null) {
              return {
                verdict: 'warn',
                diff: 'нет завершающего «~all» или «-all»',
                hint:
                  'Наш сервер разрешён, но запись не говорит, что делать с остальными. ' +
                  'Допишите в конец «~all».',
              };
            }
            if (parsed.all === '+all' || parsed.all === '?all') {
              return {
                verdict: 'warn',
                diff: `запись заканчивается на «${parsed.all}» — отправлять разрешено всем`,
                hint:
                  'Такая запись не защищает от подделок: слать от имени домена может кто угодно. ' +
                  'Замените окончание на «~all», а позже на «-all».',
              };
            }
            return {
              verdict: 'ok',
              diff: null,
              hint: 'SPF опубликован и разрешает отправку с этого сервера.',
            };
          },
        },
        spfAnswerOnly,
      ),
    );
  }

  /* --- DKIM -------------------------------------------------------- */
  {
    const dkimName = `${selector}._domainkey.${name}`;
    const expectedKey = options.dkimPublicKey ?? null;
    const expected = expectedKey
      ? buildDkimRecord(expectedKey)
      : 'v=DKIM1; k=rsa; p=<публичный ключ из rspamd>';
    checks.push(
      toCheck(
        {
          id: 'dkim',
          group: 'core',
          title: 'DKIM — подпись исходящих писем',
          purpose: 'Публичный ключ, которым получатель проверяет подпись наших писем.',
          impact:
            'Сервер уже подписывает письма, но без опубликованного ключа проверить подпись ' +
            'невозможно — крупные службы понижают доверие к таким письмам.',
          recordName: dkimName,
          recordType: 'TXT',
          expected,
          required: true,
          missingHint:
            `Записи DKIM нет. Публичный ключ лежит в контейнере rspamd: ` +
            `/var/lib/rspamd/dkim/${name}.${selector}.dns.txt — опубликуйте его значением TXT. ` +
            'Значение длинное; панели, которые режут его на куски по 255 символов, — это нормально.',
          judge: (values) => {
            const record = values.find((v) => v.toLowerCase().includes('v=dkim1')) ?? values[0] ?? '';
            const parsed = parseDkimRecord(record);
            if (parsed.revoked) {
              return {
                verdict: 'mismatch',
                diff: 'в записи пустой «p=» — так объявляют отозванный ключ',
                hint: 'Ключ помечен отозванным: подписи не проверятся. Впишите в «p=» действующий ключ.',
              };
            }
            if (parsed.key === null) {
              return {
                verdict: 'mismatch',
                diff: 'в записи нет тега «p=» с ключом',
                hint: 'Опубликованная запись не похожа на DKIM: в ней нет ключа. Замените её целиком.',
              };
            }
            if (expectedKey === null) {
              return {
                verdict: 'warn',
                diff: null,
                hint:
                  'Запись DKIM опубликована, но админка не знает ожидаемый ключ, поэтому сверить ' +
                  'не с чем. Внесите публичный ключ кнопкой «Ключ DKIM» — и проверка станет полной.',
              };
            }
            if (dkimKeysMatch(parsed.key, expectedKey)) {
              return {
                verdict: 'ok',
                diff: null,
                hint: 'Опубликованный ключ совпадает с тем, которым подписывает сервер.',
              };
            }
            return {
              verdict: 'mismatch',
              diff:
                `опубликован другой ключ: ожидается …${normalizeDkimKey(expectedKey).slice(-16)}, ` +
                `опубликовано …${parsed.key.slice(-16)}`,
              hint:
                'Опубликован ЧУЖОЙ ключ — подписи не пройдут проверку. Так бывает, когда стек ' +
                'переустановили: rspamd сгенерировал новый ключ, а в DNS остался старый. ' +
                'Замените значение записи на строку из поля «Что должно быть».',
            };
          },
        },
        dkimAnswer,
      ),
    );
  }

  /* --- DMARC ------------------------------------------------------- */
  {
    const dmarcName = `_dmarc.${name}`;
    const dmarcValues =
      dmarcAnswer.kind === 'records'
        ? dmarcAnswer.values.filter((r) => r.trim().toLowerCase().startsWith('v=dmarc1'))
        : [];
    const dmarcOnly: DnsAnswer =
      dmarcAnswer.kind === 'records'
        ? dmarcValues.length > 0
          ? { kind: 'records', values: dmarcValues, via: dmarcAnswer.via }
          : { kind: 'absent', via: dmarcAnswer.via }
        : dmarcAnswer;
    checks.push(
      toCheck(
        {
          id: 'dmarc',
          group: 'core',
          title: 'DMARC — что делать с не прошедшими проверку',
          purpose: 'Указывает получателям, как поступать с письмами, не прошедшими SPF и DKIM.',
          impact:
            'Без неё каждый получатель решает сам, и отчётов о подделках от нашего имени ' +
            'не приходит вовсе.',
          recordName: dmarcName,
          recordType: 'TXT',
          expected: buildDmarcRecord(name),
          required: true,
          missingHint:
            'Записи DMARC нет. Добавьте TXT со значением ниже: «p=quarantine» кладёт ' +
            'подозрительные в спам, «rua» — адрес для отчётов. Начать можно с «p=none» ' +
            '(только отчёты) и перейти к «quarantine», когда своя почта проходит проверки.',
          judge: (values) => {
            if (values.length > 1) {
              return {
                verdict: 'mismatch',
                diff: `записей DMARC ${String(values.length)}, допустима ровно одна`,
                hint: 'Записей DMARC несколько — получатели проигнорируют политику. Оставьте одну.',
              };
            }
            const tags = parseDmarcRecord(values[0] ?? '');
            const policy = tags.get('p')?.toLowerCase();
            if (policy === undefined) {
              return {
                verdict: 'mismatch',
                diff: 'в записи нет обязательного тега «p=»',
                hint: 'Запись без политики «p=» недействительна. Замените её на строку из поля «Что должно быть».',
              };
            }
            if (policy === 'none') {
              return {
                verdict: 'warn',
                diff: 'политика «p=none» — режим наблюдения, подделки не блокируются',
                hint:
                  'Это правильное начало. Когда убедитесь по отчётам, что своя почта проходит, ' +
                  'смените на «p=quarantine», а затем «p=reject».',
              };
            }
            if (policy === 'quarantine' || policy === 'reject') {
              return {
                verdict: 'ok',
                diff: null,
                hint: `DMARC опубликован с политикой «${policy}».`,
              };
            }
            return {
              verdict: 'mismatch',
              diff: `неизвестная политика «p=${policy}»`,
              hint: 'Допустимы только none, quarantine и reject. Исправьте значение «p=».',
            };
          },
        },
        dmarcOnly,
      ),
    );
  }

  /* --- PTR --------------------------------------------------------- */
  {
    const badIp = ip !== '' && isIP(ip) === 0;
    const ptrSpec: CheckSpec = {
      id: 'ptr',
      group: 'core',
      title: 'PTR — обратная запись адреса',
      purpose: 'Разворачивает адрес сервера обратно в его имя.',
      impact:
        'Без PTR или при несовпадении имени Google, Mail.ru и Яндекс отклоняют письма ' +
        'ещё на этапе подключения — до того, как увидят текст.',
      recordName: ptrIp === '' ? '<адрес сервера неизвестен>' : ptrIp,
      recordType: 'PTR',
      expected: `${host}.`,
      required: true,
      // Единственная запись, которую нельзя завести у регистратора домена.
      copyable: false,
      missingHint:
        `У адреса ${ptrIp} нет обратной записи. Её заказывают у владельца адреса — ` +
        'хостера или провайдера (раздел обычно называется rDNS или «обратная зона»), ' +
        `а не у регистратора домена. Нужное значение — «${host}.».` +
        (ptrIpFromDns ? ` Адрес взят из A-записи «${host}»: MAIL_PUBLIC_IPV4 не задан.` : ''),
      judge: (values) => {
        const source = ptrIpFromDns
          ? ` (адрес взят из A-записи «${host}» — MAIL_PUBLIC_IPV4 в infra/.env не задан)`
          : '';
        if (values.includes(host)) {
          return {
            verdict: 'ok',
            diff: null,
            hint: `Адрес ${ptrIp} разворачивается в «${host}» — верно${source}.`,
          };
        }
        return {
          verdict: 'mismatch',
          diff: `ожидается «${host}», опубликовано «${values.join(', ')}»`,
          hint:
            'Имя в обратной записи должно совпадать с тем, которым сервер представляется ' +
            `(MAIL_HOSTNAME = «${host}»). Попросите хостера поставить «${host}.»${source}.`,
        };
      },
    };
    if (badIp) {
      checks.push({
        ...toCheck(ptrSpec, { kind: 'unreachable', reason: 'некорректный адрес' }),
        verdict: 'mismatch',
        status: 'fail',
        diff: `«${ip}» — не похоже на IP-адрес`,
        hint: 'Проверьте значение MAIL_PUBLIC_IPV4 в infra/.env: там должен быть адрес IPv4 сервера.',
      });
    } else if (ptrIp === '') {
      // Молчаливое «неизвестно» бесполезно: говорим, почему проверять нечего
      // и где взять адрес.
      checks.push({
        ...toCheck(ptrSpec, { kind: 'unreachable', reason: 'адрес сервера неизвестен' }),
        hint:
          'Проверять нечем: адрес сервера не задан (MAIL_PUBLIC_IPV4 в infra/.env) и узнать его ' +
          `из DNS не вышло — у «${host}» нет A-записи. Заведите A-запись или впишите адрес ` +
          'в infra/.env и перезапустите api: тогда админка сверит обратную зону сама.',
      });
    } else {
      checks.push(toCheck(ptrSpec, ptrAnswer));
    }
  }

  /* --- Веб-интерфейс ------------------------------------------------ */
  const webTargets: Array<{
    id: DnsCheckId;
    label: string;
    recordName: string;
    /** null — у имени CNAME быть не может (вершина зоны). */
    cname: DnsAnswer | null;
    a: DnsAnswer;
    purpose: string;
    impact: string;
    expected: string;
    type: 'A' | 'CNAME';
  }> = [
    {
      id: 'web-apex',
      label: 'Сам домен — почта на своём имени',
      recordName: name,
      cname: null,
      a: apexAnswer,
      purpose: `Чтобы почта открывалась прямо на «https://${name}».`,
      impact: 'Без неё веб-почта на самом домене не откроется; всё остальное работает.',
      expected: ip !== '' ? ip : '<публичный адрес сервера>',
      type: 'A',
    },
  ];
  if (`mail.${name}` !== host) {
    webTargets.push({
      id: 'web-mail',
      label: 'mail.<домен> — привычный адрес почты',
      recordName: `mail.${name}`,
      cname: mailCnameAnswer,
      a: mailAAnswer,
      purpose: 'Второй адрес веб-почты, к которому все привыкли.',
      impact: 'Без неё почта откроется только на самом домене.',
      expected: `${host}.`,
      type: 'CNAME',
    });
  }
  webTargets.push({
    id: 'web-admin',
    label: 'admin.<домен> — вход в админку',
    recordName: `admin.${name}`,
    cname: adminCnameAnswer,
    a: adminAAnswer,
    purpose: 'Отдельное имя админки: у неё своя cookie, и её удобно закрыть целиком.',
    impact:
      'Без неё админка снаружи недоступна. Если она снаружи не нужна — запись можно ' +
      'не публиковать намеренно, почта от этого не пострадает.',
    expected: `${host}.`,
    type: 'CNAME',
  });

  for (const target of webTargets) {
    // CNAME важнее: если он есть, A-записи у имени существовать не может.
    const { answer, type: answeredType } = combineNameAnswers(target.cname, target.a);
    checks.push(
      toCheck(
        {
          id: target.id,
          group: 'web',
          title: target.label,
          purpose: target.purpose,
          impact: target.impact,
          recordName: target.recordName,
          recordType: target.type,
          expected: target.expected,
          required: false,
          missingHint:
            `Записи «${target.recordName}» нет. Добавьте ` +
            (target.type === 'CNAME'
              ? `CNAME со значением «${host}.»`
              : `A с адресом сервера${ip !== '' ? ` (${ip})` : ''}`) +
            '. Сертификат выпустится сам, как только имя начнёт резолвиться.',
          judge: (values) => judgeTarget(values, answeredType, host, serverIps),
        },
        answer,
      ),
    );
  }

  /* --- Автонастройка клиентов --------------------------------------- */
  const autoTargets: Array<{
    id: DnsCheckId;
    label: string;
    recordName: string;
    cname: DnsAnswer;
    a: DnsAnswer;
    purpose: string;
  }> = [
    {
      id: 'autoconfig',
      label: 'autoconfig — автонастройка Thunderbird',
      recordName: `autoconfig.${name}`,
      cname: autoconfigCnameAnswer,
      a: autoconfigAAnswer,
      purpose: 'Thunderbird ищет настройки по этому имени.',
    },
    {
      id: 'autodiscover',
      label: 'autodiscover — автонастройка Outlook',
      recordName: `autodiscover.${name}`,
      cname: autodiscoverCnameAnswer,
      a: autodiscoverAAnswer,
      purpose: 'Outlook и мобильные клиенты Microsoft ищут настройки по этому имени.',
    },
  ];

  for (const target of autoTargets) {
    const { answer, type: answeredType } = combineNameAnswers(target.cname, target.a);
    checks.push(
      toCheck(
        {
          id: target.id,
          group: 'client',
          title: target.label,
          purpose: target.purpose,
          impact:
            'Без неё клиент не настроится сам: пользователю придётся вбивать адреса ' +
            'серверов и порты руками. Почта при этом ходит.',
          recordName: target.recordName,
          recordType: 'CNAME',
          expected: `${host}.`,
          required: false,
          missingHint: `Записи нет. Добавьте CNAME «${target.recordName}» со значением «${host}.».`,
          judge: (values) => judgeTarget(values, answeredType, host, serverIps),
        },
        answer,
      ),
    );
  }

  const srvSpecs: Array<{
    id: DnsCheckId;
    label: string;
    recordName: string;
    expected: string;
    port: number;
    purpose: string;
    answer: DnsAnswer;
  }> = [
    {
      id: 'srv-imaps',
      label: 'SRV _imaps — где забирать почту',
      recordName: `_imaps._tcp.${name}`,
      expected: `0 1 ${String(imapsPort)} ${host}.`,
      port: imapsPort,
      purpose: 'Подсказывает клиенту адрес и порт IMAP по SSL.',
      answer: srvImaps,
    },
    {
      id: 'srv-submission',
      label: 'SRV _submission — куда сдавать исходящие',
      recordName: `_submission._tcp.${name}`,
      expected: `0 1 ${String(submissionPort)} ${host}.`,
      port: submissionPort,
      purpose: 'Подсказывает клиенту адрес и порт отправки.',
      answer: srvSubmission,
    },
    {
      id: 'srv-pop3s',
      label: 'SRV _pop3s — забор почты по POP3',
      recordName: `_pop3s._tcp.${name}`,
      expected: `0 1 ${String(pop3sPort)} ${host}.`,
      port: pop3sPort,
      purpose: 'То же для клиентов, работающих по POP3.',
      answer: srvPop3s,
    },
    {
      id: 'srv-autodiscover',
      label: 'SRV _autodiscover — подсказка для Outlook',
      recordName: `_autodiscover._tcp.${name}`,
      expected: `0 0 443 ${host}.`,
      port: 443,
      purpose: 'Указывает Outlook хост службы Autodiscover.',
      answer: srvAutodiscover,
    },
  ];

  for (const spec of srvSpecs) {
    checks.push(
      toCheck(
        {
          id: spec.id,
          group: 'client',
          title: spec.label,
          purpose: spec.purpose,
          impact:
            'Без неё клиент перебирает имена наугад. Почта работает, но настройка ' +
            'вручную становится обязательной.',
          recordName: spec.recordName,
          recordType: 'SRV',
          expected: spec.expected,
          required: false,
          missingHint: `Записи нет. Добавьте SRV «${spec.recordName}» со значением «${spec.expected}».`,
          judge: (values) => {
            const parsed = values.map((v) => v.split(/\s+/));
            const good = parsed.some(
              (p) => Number(p[2]) === spec.port && fqdn(p[3] ?? '') === host,
            );
            if (good) {
              return {
                verdict: 'ok',
                diff: null,
                hint: `Указывает на «${host}» и порт ${String(spec.port)} — верно.`,
              };
            }
            return {
              verdict: 'mismatch',
              diff: `ожидается «${spec.expected}», опубликовано «${values.join(', ')}»`,
              hint:
                'Хост или порт не совпадают — клиент настроится не туда или не настроится вовсе. ' +
                `Исправьте значение на «${spec.expected}».`,
            };
          },
        },
        spec.answer,
      ),
    );
  }

  const answeredBy = querier.answeredBy();
  return {
    domain: name,
    checkedAt: new Date().toISOString(),
    overall: worstStatus(checks.map((c) => c.status)),
    resolver: {
      servers: [...querier.servers],
      answeredBy,
      reachable: answeredBy.length > 0,
    },
    checks,
  };
}
