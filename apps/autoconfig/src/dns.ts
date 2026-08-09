/**
 * DNS-записи для боевой публикации домена: MX, SPF, DKIM (ключ из rspamd),
 * DMARC, CNAME autoconfig/autodiscover и SRV-записи (RFC 6186 + autodiscover).
 * Плюс живая проверка того, что уже опубликовано.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Resolver } from 'node:dns/promises';
import type { MailSettings } from './config.js';

export interface DnsRecord {
  /** Имя записи относительно зоны домена ('@' — сам домен) */
  name: string;
  type: 'MX' | 'TXT' | 'CNAME' | 'SRV';
  /** Значение в том виде, как его вводят в панели DNS */
  value: string;
  /** Для чего нужна запись (по-русски, для администратора) */
  purpose: string;
  /** false — запись не удалось сформировать (нет DKIM-ключа) */
  ready: boolean;
}

/**
 * Разбор файла <домен>.<селектор>.dns.txt, который пишет rspamadm dkim_keygen:
 * значение TXT разбито на несколько строк в кавычках — склеиваем их.
 * Возвращает полное значение записи (v=DKIM1; k=rsa; p=...).
 */
export function parseDkimDnsTxt(text: string): string | null {
  const chunks = [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '');
  if (chunks.length === 0) return null;
  const value = chunks.join('').trim();
  return value.includes('v=DKIM1') ? value : null;
}

/** Читает DKIM-запись из каталога ключей rspamd; null, если ключа ещё нет. */
export async function readDkimRecord(
  settings: MailSettings,
  domain: string,
): Promise<string | null> {
  const file = join(settings.dkimDnsDir, `${domain}.${settings.dkimSelector}.dns.txt`);
  try {
    return parseDkimDnsTxt(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Полный набор записей, которые администратор публикует в DNS домена. */
export function buildDnsRecords(
  settings: MailSettings,
  domain: string,
  dkimValue: string | null,
): DnsRecord[] {
  const host = `${settings.hostname}.`;
  const sel = settings.dkimSelector;
  return [
    {
      name: '@',
      type: 'MX',
      value: `10 ${host}`,
      purpose: 'Приём входящей почты',
      ready: true,
    },
    {
      name: '@',
      type: 'TXT',
      value: `v=spf1 mx ~all`,
      purpose: 'SPF: разрешает отправку почты только с MX-хостов домена',
      ready: true,
    },
    {
      name: `${sel}._domainkey`,
      type: 'TXT',
      value: dkimValue ?? '(DKIM-ключ ещё не сгенерирован rspamd — запустите почтовый стек)',
      purpose: 'DKIM: публичный ключ подписи исходящей почты (генерирует rspamd)',
      ready: dkimValue !== null,
    },
    {
      name: '_dmarc',
      type: 'TXT',
      value: `v=DMARC1; p=quarantine; rua=mailto:${settings.dmarcRua}; adkim=s; aspf=s`,
      purpose: 'DMARC: политика обработки писем, не прошедших SPF/DKIM',
      ready: true,
    },
    {
      name: 'autoconfig',
      type: 'CNAME',
      value: host,
      purpose: 'Автонастройка Thunderbird (Mozilla Autoconfig)',
      ready: true,
    },
    {
      name: 'autodiscover',
      type: 'CNAME',
      value: host,
      purpose: 'Автонастройка Outlook (Microsoft Autodiscover)',
      ready: true,
    },
    {
      name: '_imaps._tcp',
      type: 'SRV',
      value: `0 1 ${settings.imap.sslPort} ${host}`,
      purpose: 'SRV (RFC 6186): IMAP по SSL',
      ready: true,
    },
    {
      name: '_submission._tcp',
      type: 'SRV',
      value: `0 1 ${settings.smtp.startTlsPort} ${host}`,
      purpose: 'SRV (RFC 6186): отправка почты (submission)',
      ready: true,
    },
    {
      name: '_pop3s._tcp',
      type: 'SRV',
      value: `0 1 ${settings.pop3.sslPort} ${host}`,
      purpose: 'SRV (RFC 6186): POP3 по SSL',
      ready: true,
    },
    {
      name: '_autodiscover._tcp',
      type: 'SRV',
      value: `0 0 443 ${host}`,
      purpose: 'SRV: указывает Outlook хост Autodiscover',
      ready: true,
    },
  ];
}

/** Разбивает длинное TXT-значение на строки по 255 символов (лимит DNS). */
function txtZoneValue(value: string): string {
  if (value.length <= 255) return `"${value}"`;
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += 255) parts.push(`"${value.slice(i, i + 255)}"`);
  return `( ${parts.join('\n\t')} )`;
}

/** Фрагмент зонного файла BIND для копирования целиком. */
export function buildZoneFile(
  settings: MailSettings,
  domain: string,
  records: DnsRecord[],
): string {
  const ttl = settings.dnsTtl;
  const lines = [`; DNS-записи для почтового домена ${domain} (Mail.True)`, `$ORIGIN ${domain}.`];
  for (const r of records) {
    if (!r.ready) {
      lines.push(`; ${r.name} IN TXT — ${r.value}`);
      continue;
    }
    const value = r.type === 'TXT' ? txtZoneValue(r.value) : r.value;
    lines.push(`${r.name}\t${ttl}\tIN\t${r.type}\t${value}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Разбор опубликованной TXT по существу.
 *
 * Возвращает не «совпало / не совпало», а ответ на вопрос, ради которого
 * запись и проверяют: работает ли она.
 */
function judgeTxt(
  record: DnsRecord,
  published: readonly string[],
): { status: DnsCheckResult['status']; comment: string } {
  const first = published[0] ?? '';
  const lower = first.toLowerCase();

  if (record.name === '@') {
    // SPF. Важны две вещи: разрешены ли наши отправители и что делать с
    // остальными. Точный вид записи — дело владельца домена.
    const allowsMx = /(^|\s)([+~-]?)(mx|a)(\s|:|$)/u.test(lower) || lower.includes('include:');
    const all = /(^|\s)([+~?-])all(\s|$)/u.exec(lower);
    if (!allowsMx) {
      return {
        status: 'mismatch',
        comment:
          'SPF опубликован, но не разрешает отправку с этого сервера: нужен механизм mx (или a/include)',
      };
    }
    if (!all) {
      return {
        status: 'mismatch',
        comment: 'В SPF нет завершающего all — получатели не знают, что делать с чужими письмами',
      };
    }
    if (all[2] === '+') {
      return {
        status: 'mismatch',
        comment: '«+all» разрешает отправку от вашего имени кому угодно — так делать нельзя',
      };
    }
    return {
      status: 'ok',
      comment: all[2] === '-' ? 'SPF опубликован, политика строгая' : 'SPF опубликован',
    };
  }

  if (record.name === '_dmarc') {
    const policy = /(^|;)\s*p\s*=\s*(none|quarantine|reject)/u.exec(lower);
    if (!policy) {
      return {
        status: 'mismatch',
        comment: 'В DMARC нет политики p= (none, quarantine или reject)',
      };
    }
    if (policy[2] === 'none') {
      return {
        status: 'ok',
        comment: 'DMARC опубликован, но политика p=none ничего не предписывает получателям',
      };
    }
    return { status: 'ok', comment: 'DMARC опубликован' };
  }

  // DKIM. Пока ключа нет, ожидаемого значения не существует — и сказать
  // «совпадает» нельзя ни при какой опубликованной записи.
  if (!record.ready) {
    return {
      status: 'unknown',
      comment:
        'Ключ DKIM ещё не выпущен rspamd, поэтому сверять опубликованное не с чем. ' +
        'Поднимите почтовый стек и проверьте снова',
    };
  }
  const normalize = (value: string): string => value.replace(/[\s;]+/gu, '');
  const ok = published.some((value) => normalize(value) === normalize(record.value));
  return {
    status: ok ? 'ok' : 'mismatch',
    comment: ok
      ? 'опубликовано'
      : 'опубликован другой ключ DKIM — письма будут подписаны не тем ключом',
  };
}

export interface DnsCheckResult {
  name: string;
  type: string;
  expected: string;
  /**
   * `unknown` — проверить нечем, а не «всё хорошо».
   *
   * Появилось из-за DKIM: пока rspamd не выпустил ключ, ожидаемого
   * значения не существует, и сравнивать опубликованное не с чем. Раньше
   * такой случай считался успехом, и самопроверка печатала зелёное
   * «опубликована и совпадает» на чужой ключ, оставшийся от прежнего
   * провайдера.
   */
  status: 'ok' | 'mismatch' | 'missing' | 'error' | 'unknown';
  found: string[];
  comment: string;
}

const withTimeout = async <T>(p: Promise<T>, ms = 5000): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const stripDot = (s: string): string => s.replace(/\.$/, '').toLowerCase();

/**
 * То, что нужно от резольвера. Отдельный тип — чтобы проверку можно было
 * прогнать на подставном резольвере, не завися от настоящего DNS.
 */
export interface DnsResolverLike {
  resolveMx(hostname: string): Promise<Array<{ priority: number; exchange: string }>>;
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveCname(hostname: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolveSrv(
    hostname: string,
  ): Promise<Array<{ priority: number; weight: number; port: number; name: string }>>;
}

/**
 * Живая проверка: резолвит каждую ожидаемую запись и сравнивает с тем,
 * что должно быть опубликовано.
 */
export async function checkDns(
  settings: MailSettings,
  domain: string,
  records: DnsRecord[],
  resolver: DnsResolverLike = new Resolver(),
): Promise<DnsCheckResult[]> {
  const host = stripDot(settings.hostname);
  const fqdn = (name: string): string => (name === '@' ? domain : `${name}.${domain}`);

  // Адреса нашего сервера. Нужны, чтобы сравнить с ними A-запись,
  // опубликованную вместо CNAME. Резолвим один раз на всю проверку.
  let ownIpsCache: Promise<string[]> | null = null;
  const ownIps = (): Promise<string[]> => {
    ownIpsCache ??= withTimeout(resolver.resolve4(host)).catch(() => [] as string[]);
    return ownIpsCache;
  };

  const checkOne = async (r: DnsRecord): Promise<DnsCheckResult> => {
    const base: Omit<DnsCheckResult, 'status' | 'found' | 'comment'> = {
      name: fqdn(r.name),
      type: r.type,
      expected: r.value,
    };
    try {
      switch (r.type) {
        case 'MX': {
          const mx = await withTimeout(resolver.resolveMx(fqdn(r.name)));
          const found = mx.map((m) => `${m.priority} ${m.exchange}`);
          const byName = mx.some((m) => stripDot(m.exchange) === host);
          if (byName) {
            /*
             * Имя совпало — но этого мало. Совпадение имени ничего не
             * говорит о том, есть ли у него адрес: MX, указывающий на
             * хост без A-записи, почту не принимает вовсе, а проверка
             * рапортовала зелёным. Тот же дефект в админской проверке
             * уже разобран (apps/api/src/admin/dns.ts) — здесь осталась
             * прежняя версия.
             */
            const ips = await ownIps();
            if (ips.length === 0) {
              return {
                ...base,
                status: 'mismatch',
                found,
                comment: `MX указывает на ${host}, но у этого имени нет адреса (A-записи) — почта на домен не придёт`,
              };
            }
            return { ...base, status: 'ok', found, comment: 'MX указывает на наш сервер' };
          }
          return {
            ...base,
            status: 'mismatch',
            found,
            comment: 'MX не указывает на наш сервер',
          };
        }
        case 'TXT': {
          const txt = (await withTimeout(resolver.resolveTxt(fqdn(r.name)))).map((c) => c.join(''));
          const marker = r.name === '@' ? 'v=spf1' : r.name === '_dmarc' ? 'v=DMARC1' : 'v=DKIM1';
          const relevant = txt.filter((t) => t.includes(marker));
          if (relevant.length === 0) {
            return {
              ...base,
              status: 'missing',
              found: txt,
              comment: `TXT-запись с ${marker} не найдена`,
            };
          }
          /*
           * Сверяем ПО СУЩЕСТВУ, а не посимвольно.
           *
           * Побуквенное сравнение объявляло ошибкой более строгий
           * `-all` вместо `~all` и свой адрес для отчётов DMARC — то
           * есть подталкивало администратора «починить» верную запись,
           * ослабив её. Проверять надо смысл: разрешает ли SPF наши MX,
           * задана ли политика DMARC.
           */
          const verdict = judgeTxt(r, relevant);
          return { ...base, status: verdict.status, found: relevant, comment: verdict.comment };
        }
        case 'CNAME': {
          const name = fqdn(r.name);
          try {
            const cname = await withTimeout(resolver.resolveCname(name));
            const ok = cname.some((c) => stripDot(c) === host);
            return {
              ...base,
              status: ok ? 'ok' : 'mismatch',
              found: cname,
              comment: ok ? 'CNAME указывает на наш сервер' : 'CNAME указывает не туда',
            };
          } catch {
            // Вместо CNAME допустима A-запись — но ТОЛЬКО если она ведёт на
            // наш сервер. Раньше здесь безусловно возвращалось «ok»: чужая
            // A-запись (записи опубликованы адресом, осталась запись прежнего
            // провайдера) выглядела настроенной, а Outlook шёл не туда.
            const a = await withTimeout(resolver.resolve4(name));
            const mine = await ownIps();
            if (mine.length === 0) {
              return {
                ...base,
                status: 'error',
                found: a,
                comment:
                  `вместо CNAME опубликована A-запись ${a.join(', ')}, но адрес самого ` +
                  `${host} не резолвится — сравнить не с чем`,
              };
            }
            const ok = a.some((ip) => mine.includes(ip));
            return {
              ...base,
              status: ok ? 'ok' : 'mismatch',
              found: a,
              comment: ok
                ? `вместо CNAME опубликована A-запись ${a.join(', ')} — это адрес ${host}, допустимо`
                : `A-запись ведёт на ${a.join(', ')}, а ${host} имеет адрес ${mine.join(', ')} — ` +
                  `клиенты уйдут на чужой сервер`,
            };
          }
        }
        case 'SRV': {
          const srv = await withTimeout(resolver.resolveSrv(fqdn(r.name)));
          const found = srv.map((s) => `${s.priority} ${s.weight} ${s.port} ${s.name}`);
          const [, , portStr] = r.value.split(' ');
          const wantPort = Number(portStr);
          const ok = srv.some((s) => stripDot(s.name) === host && s.port === wantPort);
          return {
            ...base,
            status: ok ? 'ok' : 'mismatch',
            found,
            comment: ok ? 'опубликовано' : 'хост или порт не совпадают',
          };
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      const missing = code === 'ENOTFOUND' || code === 'ENODATA';
      return {
        ...base,
        status: missing ? 'missing' : 'error',
        found: [],
        comment: missing ? 'запись не опубликована' : `ошибка резолва: ${code}`,
      };
    }
  };

  return Promise.all(records.map(checkOne));
}
