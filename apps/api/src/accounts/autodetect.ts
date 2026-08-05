/**
 * Автоопределение настроек чужого почтового сервера по адресу.
 *
 * Тот же механизм, что и для сторонних клиентов (apps/autoconfig),
 * только наоборот: там мы ОТДАЁМ настройки нашего сервера, здесь ИЩЕМ
 * чужие. Поэтому формат ответа переиспользуется буквально — мы разбираем
 * ровно тот XML `clientConfig` версии 1.1, который apps/autoconfig умеет
 * формировать (см. apps/autoconfig/src/autoconfig.ts). Благодаря этому
 * ящик на любом сервере Mail.True подключается к другому такому же
 * серверу без единой настройки руками, а разбор проверяется тестом
 * на выводе того самого генератора.
 *
 * Порядок поиска — от точного к предположительному:
 *
 *   1. Список известных сервисов (быстрые кнопки «Яндекс», «Gmail»,
 *      «Mail.ru», «Outlook», «Yahoo» — ровно как в mail.ru).
 *   2. Наш собственный домен: настройки известны точно.
 *   3. Mozilla Autoconfig по HTTP: autoconfig.<домен> и
 *      <домен>/.well-known/autoconfig/… — их публикуют многие серверы.
 *   4. DNS SRV: _imaps._tcp / _submission._tcp (RFC 6186).
 *   5. Предположение по имени домена: imap.<домен>:993, smtp.<домен>:587.
 *
 * Ни один шаг не обязателен: сеть может быть недоступна, домен —
 * не отвечать. Поэтому каждый шаг снабжён таймаутом, а результат всегда
 * содержит источник — пользователь должен видеть, откуда взялись
 * настройки, и иметь возможность их поправить.
 */
import { Resolver } from 'node:dns/promises';

export type DetectSource = 'known' | 'local' | 'autoconfig' | 'srv' | 'guess';

export interface ServerSettings {
  host: string;
  port: number;
  /** Сразу TLS (993 / 465). false — открытое соединение или STARTTLS. */
  secure: boolean;
}

export interface DetectedSettings {
  /** Откуда взялись настройки. */
  source: DetectSource;
  /** Человекочитаемое имя сервиса для мастера подключения. */
  providerLabel: string;
  imap: ServerSettings;
  smtp: ServerSettings;
  /** Имя пользователя: обычно полный адрес. */
  username: string;
  /**
   * Настройки достоверны (взяты из списка, от самого сервера или из DNS),
   * а не угаданы. Интерфейс должен показывать разницу.
   */
  confident: boolean;
}

/* ------------------------------------------------------------------ */
/* Список известных сервисов                                           */
/* ------------------------------------------------------------------ */

interface KnownProvider {
  label: string;
  domains: string[];
  imap: ServerSettings;
  smtp: ServerSettings;
  /** Подсказка про пароль приложения — без неё подключение не заведётся. */
  note?: string;
}

/**
 * Быстрые кнопки популярных сервисов. Список сознательно короткий:
 * это те же сервисы, что предлагает mail.ru, плюс отечественные.
 * Всё остальное определяется по HTTP/DNS или настраивается руками.
 */
export const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    label: 'Яндекс',
    domains: ['yandex.ru', 'yandex.com', 'ya.ru', 'yandex.by', 'yandex.kz'],
    imap: { host: 'imap.yandex.ru', port: 993, secure: true },
    smtp: { host: 'smtp.yandex.ru', port: 465, secure: true },
    note: 'Яндекс требует пароль приложения, а не основной пароль от аккаунта.',
  },
  {
    label: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    note: 'Gmail требует пароль приложения при включённой двухфакторной аутентификации.',
  },
  {
    label: 'Mail.ru',
    domains: ['mail.ru', 'inbox.ru', 'bk.ru', 'list.ru', 'internet.ru'],
    imap: { host: 'imap.mail.ru', port: 993, secure: true },
    smtp: { host: 'smtp.mail.ru', port: 465, secure: true },
    note: 'Mail.ru требует пароль для внешних приложений.',
  },
  {
    label: 'Outlook',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
  },
  {
    label: 'Yahoo',
    domains: ['yahoo.com', 'yahoo.co.uk', 'ymail.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    note: 'Yahoo требует пароль приложения.',
  },
  {
    label: 'Rambler',
    domains: ['rambler.ru', 'lenta.ru', 'autorambler.ru', 'ro.ru'],
    imap: { host: 'imap.rambler.ru', port: 993, secure: true },
    smtp: { host: 'smtp.rambler.ru', port: 465, secure: true },
  },
];

/** Домен из адреса в нижнем регистре. */
export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

/** Ищет сервис в списке известных. */
export function findKnownProvider(domain: string): KnownProvider | null {
  const lower = domain.toLowerCase();
  return KNOWN_PROVIDERS.find((p) => p.domains.includes(lower)) ?? null;
}

/* ------------------------------------------------------------------ */
/* Разбор Mozilla clientConfig                                          */
/* ------------------------------------------------------------------ */

interface XmlServer {
  kind: 'incoming' | 'outgoing';
  type: string;
  hostname: string;
  port: number;
  socketType: string;
}

/** Извлекает значение простого тега без учёта пространств имён. */
function tagValue(block: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? (m[1] ?? '').trim() : '';
}

/**
 * Разбирает XML `clientConfig` (Mozilla Autoconfig 1.1).
 *
 * Полноценный XML-разбор здесь не нужен и вреден: формат плоский,
 * а лишняя зависимость на разбор произвольного XML — лишняя поверхность
 * для чужих данных. Берём ровно те четыре поля, которые нужны.
 */
export function parseClientConfigXml(xml: string): {
  providerLabel: string;
  servers: XmlServer[];
} {
  const servers: XmlServer[] = [];
  const re = /<(incomingServer|outgoingServer)\b[^>]*type="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of xml.matchAll(re)) {
    const kind = (m[1] ?? '').toLowerCase() === 'incomingserver' ? 'incoming' : 'outgoing';
    const body = m[3] ?? '';
    const port = Number(tagValue(body, 'port'));
    const hostname = tagValue(body, 'hostname');
    if (!hostname || !Number.isFinite(port) || port <= 0) continue;
    servers.push({
      kind,
      type: (m[2] ?? '').toLowerCase(),
      hostname,
      port,
      socketType: tagValue(body, 'socketType').toUpperCase(),
    });
  }
  const label = tagValue(xml, 'displayName') || tagValue(xml, 'displayShortName');
  return { providerLabel: label, servers };
}

/** Собирает настройки из разобранного clientConfig. Возвращает null, если IMAP не найден. */
export function settingsFromClientConfig(
  xml: string,
  email: string,
): Omit<DetectedSettings, 'source'> | null {
  const { providerLabel, servers } = parseClientConfigXml(xml);
  // Предпочитаем IMAP поверх TLS: он не зависит от согласования STARTTLS.
  const imapServers = servers.filter((s) => s.kind === 'incoming' && s.type === 'imap');
  const imap =
    imapServers.find((s) => s.socketType === 'SSL') ?? imapServers.find(() => true) ?? null;
  if (!imap) return null;
  const smtpServers = servers.filter((s) => s.kind === 'outgoing');
  const smtp =
    smtpServers.find((s) => s.socketType === 'SSL') ?? smtpServers.find(() => true) ?? null;
  const domain = domainOf(email);
  return {
    providerLabel: providerLabel || domain,
    imap: { host: imap.hostname, port: imap.port, secure: imap.socketType === 'SSL' },
    smtp: smtp
      ? { host: smtp.hostname, port: smtp.port, secure: smtp.socketType === 'SSL' }
      : { host: `smtp.${domain}`, port: 587, secure: false },
    username: email,
    confident: true,
  };
}

/* ------------------------------------------------------------------ */
/* Предположение по имени домена                                        */
/* ------------------------------------------------------------------ */

/** Настройки «по общему правилу»: их придётся проверить подключением. */
export function guessSettings(email: string): DetectedSettings {
  const domain = domainOf(email);
  return {
    source: 'guess',
    providerLabel: domain,
    imap: { host: `imap.${domain}`, port: 993, secure: true },
    smtp: { host: `smtp.${domain}`, port: 587, secure: false },
    username: email,
    confident: false,
  };
}

/* ------------------------------------------------------------------ */
/* Полное определение                                                   */
/* ------------------------------------------------------------------ */

/** Настройки нашего собственного сервера — для ящиков наших доменов. */
export interface LocalMailSettings {
  domains: string[];
  hostname: string;
  imapPort: number;
  imapSecure: boolean;
  smtpPort: number;
  smtpSecure: boolean;
  label: string;
}

export interface DetectOptions {
  /** Наш собственный сервер: для его доменов настройки известны точно. */
  local?: LocalMailSettings | undefined;
  /** Ходить ли в сеть (HTTP/DNS). В тестах — false. */
  probeNetwork?: boolean;
  /** Таймаут одного сетевого шага, мс. */
  timeoutMs?: number;
  /** Подмена загрузчика XML (тесты). */
  fetchXml?: ((url: string, timeoutMs: number) => Promise<string | null>) | undefined;
  /** Подмена SRV-резолвера (тесты). */
  resolveSrv?:
    | ((name: string) => Promise<Array<{ name: string; port: number; priority: number }>>)
    | undefined;
}

/** Загружает XML автонастройки, не падая на любой сетевой ошибке. */
async function defaultFetchXml(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const text = await res.text();
    return text.includes('<clientConfig') ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultResolveSrv(
  name: string,
): Promise<Array<{ name: string; port: number; priority: number }>> {
  try {
    const resolver = new Resolver();
    const records = await resolver.resolveSrv(name);
    return records
      .filter((r) => r.name !== '.' && r.name !== '')
      .map((r) => ({ name: r.name, port: r.port, priority: r.priority }))
      .sort((a, b) => a.priority - b.priority);
  } catch {
    return [];
  }
}

/**
 * Определяет настройки чужого сервера по адресу ящика.
 * Всегда что-то возвращает: в худшем случае — предположение с
 * `confident: false`, которое пользователь поправит в мастере.
 */
export async function detectMailSettings(
  email: string,
  options: DetectOptions = {},
): Promise<DetectedSettings> {
  const domain = domainOf(email);
  if (domain === '') return guessSettings(email);

  // 1. Известный сервис
  const known = findKnownProvider(domain);
  if (known) {
    return {
      source: 'known',
      providerLabel: known.label,
      imap: { ...known.imap },
      smtp: { ...known.smtp },
      username: email,
      confident: true,
    };
  }

  // 2. Наш собственный домен
  const local = options.local;
  if (local && local.domains.some((d) => d.toLowerCase() === domain)) {
    return {
      source: 'local',
      providerLabel: local.label,
      imap: { host: local.hostname, port: local.imapPort, secure: local.imapSecure },
      smtp: { host: local.hostname, port: local.smtpPort, secure: local.smtpSecure },
      username: email,
      confident: true,
    };
  }

  if (options.probeNetwork === false) return guessSettings(email);

  const timeoutMs = options.timeoutMs ?? 4000;
  const fetchXml = options.fetchXml ?? defaultFetchXml;
  const resolveSrv = options.resolveSrv ?? defaultResolveSrv;

  // 3. Mozilla Autoconfig
  const encoded = encodeURIComponent(email);
  const urls = [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encoded}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encoded}`,
    `http://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encoded}`,
  ];
  for (const url of urls) {
    const xml = await fetchXml(url, timeoutMs);
    if (!xml) continue;
    const parsed = settingsFromClientConfig(xml, email);
    if (parsed) return { source: 'autoconfig', ...parsed };
  }

  // 4. DNS SRV (RFC 6186)
  const [imaps, submission] = await Promise.all([
    resolveSrv(`_imaps._tcp.${domain}`),
    resolveSrv(`_submission._tcp.${domain}`),
  ]);
  const imapSrv = imaps[0];
  if (imapSrv) {
    const smtpSrv = submission[0];
    return {
      source: 'srv',
      providerLabel: domain,
      imap: { host: imapSrv.name, port: imapSrv.port, secure: imapSrv.port === 993 },
      smtp: smtpSrv
        ? { host: smtpSrv.name, port: smtpSrv.port, secure: smtpSrv.port === 465 }
        : { host: `smtp.${domain}`, port: 587, secure: false },
      username: email,
      confident: true,
    };
  }

  // 5. Предположение
  return guessSettings(email);
}
