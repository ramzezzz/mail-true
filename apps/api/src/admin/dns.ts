/**
 * Проверка DNS-записей домена.
 *
 * Самое частое место, где спотыкаются при установке почтового сервера,
 * поэтому каждая проверка возвращает не «SPF: FAIL», а: зачем нужна запись,
 * что должно быть опубликовано (готовая строка для копирования), что
 * опубликовано на самом деле и что конкретно сделать.
 */
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

export type DnsCheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';
export type DnsCheckId =
  | 'mx'
  | 'spf'
  | 'dkim'
  | 'dmarc'
  | 'ptr'
  | 'autoconfig'
  | 'autodiscover';

export interface DnsCheckResult {
  id: DnsCheckId;
  title: string;
  /** Зачем нужна эта запись — человеческим языком. */
  purpose: string;
  recordName: string;
  recordType: string;
  /** Готовое значение для вставки в панель регистратора. */
  expected: string;
  /** Что реально опубликовано в DNS. */
  actual: string[];
  status: DnsCheckStatus;
  /** Что не так и как починить. */
  hint: string;
}

export interface DnsReport {
  domain: string;
  checkedAt: string;
  overall: DnsCheckStatus;
  checks: DnsCheckResult[];
}

export interface DnsCheckOptions {
  /** Имя почтового сервера (значение MX и цель CNAME автонастройки). */
  mailHostname: string;
  /** Публичный IPv4 сервера; пусто — проверка PTR будет «неизвестно». */
  publicIpv4?: string;
  /** Селектор DKIM (по умолчанию mail). */
  dkimSelector?: string;
  /** Ожидаемый публичный ключ DKIM (base64 из rspamd). */
  dkimPublicKey?: string | null;
  /** Таймаут одного запроса, мс. */
  timeoutMs?: number;
  /** Свои DNS-серверы (по умолчанию системные). */
  servers?: readonly string[];
}

/** Итоговое состояние: худшее из проверок (fail > warn > unknown > ok). */
export function worstStatus(statuses: readonly DnsCheckStatus[]): DnsCheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.includes('unknown')) return 'unknown';
  return 'ok';
}

/** Полное имя записи без точки на конце. */
function fqdn(name: string): string {
  return name.replace(/\.+$/, '').toLowerCase();
}

/** Ошибка «записи нет» отличается от «DNS не отвечает». */
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN';
}

type LookupOutcome<T> = { kind: 'ok'; value: T } | { kind: 'empty' } | { kind: 'error'; message: string };

async function attempt<T>(fn: () => Promise<T>): Promise<LookupOutcome<T>> {
  try {
    const value = await fn();
    if (Array.isArray(value) && value.length === 0) return { kind: 'empty' };
    return { kind: 'ok', value };
  } catch (err) {
    if (isNotFound(err)) return { kind: 'empty' };
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Рекомендованная строка SPF для домена, обслуживаемого этим сервером. */
export function buildSpfRecord(mailHostname: string): string {
  return `v=spf1 mx a:${fqdn(mailHostname)} -all`;
}

/** Рекомендованная строка DMARC: начинаем с наблюдения, без отбрасывания. */
export function buildDmarcRecord(domain: string): string {
  return `v=DMARC1; p=quarantine; rua=mailto:postmaster@${fqdn(domain)}; adkim=r; aspf=r; pct=100`;
}

/** Готовая TXT-запись DKIM из публичного ключа rspamd. */
export function buildDkimRecord(publicKey: string): string {
  return `v=DKIM1; k=rsa; p=${publicKey.replace(/\s+/g, '')}`;
}

/** Разбор строки SPF: собранная из кусков TXT-запись. */
function joinTxt(chunks: string[][]): string[] {
  return chunks.map((parts) => parts.join(''));
}

/**
 * Проверяет весь набор DNS-записей домена.
 * Никогда не бросает: сетевая ошибка превращается в статус «неизвестно»
 * с понятным пояснением.
 */
export async function checkDomainDns(
  domain: string,
  options: DnsCheckOptions,
): Promise<DnsReport> {
  const name = fqdn(domain);
  const host = fqdn(options.mailHostname);
  const selector = options.dkimSelector || 'mail';
  const resolver = new Resolver({ timeout: options.timeoutMs ?? 4000, tries: 1 });
  if (options.servers && options.servers.length > 0) {
    resolver.setServers([...options.servers]);
  }

  const checks: DnsCheckResult[] = [];

  /* --- MX ---------------------------------------------------------- */
  {
    const outcome = await attempt(() => resolver.resolveMx(name));
    const actual =
      outcome.kind === 'ok'
        ? outcome.value
            .slice()
            .sort((a, b) => a.priority - b.priority)
            .map((mx) => `${mx.priority} ${fqdn(mx.exchange)}`)
        : [];
    let status: DnsCheckStatus = 'fail';
    let hint =
      `Записи MX нет — внешние серверы не знают, куда доставлять почту для «${name}». ` +
      `Добавьте у регистратора запись MX со значением «10 ${host}.».`;
    if (outcome.kind === 'error') {
      status = 'unknown';
      hint = `Не удалось спросить DNS: ${outcome.message}. Проверьте доступность DNS-сервера.`;
    } else if (outcome.kind === 'ok') {
      const points = outcome.value.some((mx) => fqdn(mx.exchange) === host);
      if (points) {
        status = 'ok';
        hint = `Почта домена направлена на «${host}» — верно.`;
      } else {
        status = 'warn';
        hint =
          `MX указывает на другой сервер (${actual.join(', ')}), а не на «${host}». ` +
          `Пока это так, входящая почта будет приходить не сюда.`;
      }
    }
    checks.push({
      id: 'mx',
      title: 'MX — приём почты',
      purpose: 'Говорит остальному интернету, какой сервер принимает почту для домена.',
      recordName: name,
      recordType: 'MX',
      expected: `10 ${host}.`,
      actual,
      status,
      hint,
    });
  }

  /* --- SPF --------------------------------------------------------- */
  const expectedSpf = buildSpfRecord(host);
  {
    const outcome = await attempt(() => resolver.resolveTxt(name));
    const txt = outcome.kind === 'ok' ? joinTxt(outcome.value) : [];
    const spf = txt.filter((r) => r.toLowerCase().startsWith('v=spf1'));
    let status: DnsCheckStatus = 'fail';
    let hint =
      `Записи SPF нет. Без неё чужие серверы не знают, кому позволено слать письма ` +
      `от имени «${name}», и часто кладут такие письма в спам. ` +
      `Добавьте TXT-запись со значением ниже.`;
    if (outcome.kind === 'error') {
      status = 'unknown';
      hint = `Не удалось спросить DNS: ${outcome.message}.`;
    } else if (spf.length > 1) {
      status = 'fail';
      hint =
        `Записей SPF несколько (${spf.length}) — это ошибка: по стандарту допустима ровно одна. ` +
        `Оставьте одну, объединив условия.`;
    } else if (spf.length === 1) {
      const value = spf[0] ?? '';
      const mentionsUs = value.includes(host) || /\bmx\b/i.test(value);
      const strict = /[-~]all\s*$/i.test(value.trim());
      if (mentionsUs && strict) {
        status = 'ok';
        hint = 'SPF опубликован и разрешает отправку с этого сервера.';
      } else if (mentionsUs) {
        status = 'warn';
        hint =
          `SPF есть и этот сервер разрешён, но запись заканчивается не на «-all» или «~all». ` +
          `Без этого получатели не знают, что делать с письмами от неразрешённых отправителей.`;
      } else {
        status = 'fail';
        hint =
          `SPF есть, но в нём не упомянут «${host}» и нет механизма «mx». ` +
          `Письма с этого сервера будут считаться подделкой.`;
      }
    }
    checks.push({
      id: 'spf',
      title: 'SPF — кто вправе слать от домена',
      purpose: 'Перечисляет серверы, которым разрешено отправлять почту от имени домена.',
      recordName: name,
      recordType: 'TXT',
      expected: expectedSpf,
      actual: spf,
      status,
      hint,
    });
  }

  /* --- DKIM -------------------------------------------------------- */
  {
    const dkimName = `${selector}._domainkey.${name}`;
    const outcome = await attempt(() => resolver.resolveTxt(dkimName));
    const txt = outcome.kind === 'ok' ? joinTxt(outcome.value) : [];
    const expected = options.dkimPublicKey
      ? buildDkimRecord(options.dkimPublicKey)
      : 'v=DKIM1; k=rsa; p=<публичный ключ из rspamd>';
    let status: DnsCheckStatus = 'fail';
    let hint =
      `Записи DKIM нет. Сервер уже подписывает исходящие письма (rspamd, селектор «${selector}»), ` +
      `но получатели не могут проверить подпись, пока ключ не опубликован. ` +
      `Публичный ключ лежит в контейнере rspamd: ` +
      `/var/lib/rspamd/dkim/${name}.${selector}.dns.txt`;
    if (outcome.kind === 'error') {
      status = 'unknown';
      hint = `Не удалось спросить DNS: ${outcome.message}.`;
    } else if (txt.length > 0) {
      const published = txt.find((r) => r.toLowerCase().includes('v=dkim1')) ?? txt[0] ?? '';
      const publishedKey = /p=([A-Za-z0-9+/=]+)/.exec(published)?.[1] ?? '';
      if (!options.dkimPublicKey) {
        status = 'warn';
        hint =
          `Запись DKIM опубликована, но админка не знает ожидаемый ключ, ` +
          `поэтому сверить не с чем. Загрузите публичный ключ в настройках домена.`;
      } else if (publishedKey === options.dkimPublicKey.replace(/\s+/g, '')) {
        status = 'ok';
        hint = 'Опубликованный ключ совпадает с тем, которым подписывает сервер.';
      } else {
        status = 'fail';
        hint =
          `Опубликован ДРУГОЙ ключ — подписи не пройдут проверку. ` +
          `Замените значение записи на строку из поля «Что должно быть».`;
      }
    }
    checks.push({
      id: 'dkim',
      title: 'DKIM — подпись исходящих',
      purpose: 'Публичный ключ, которым получатель проверяет подпись наших писем.',
      recordName: dkimName,
      recordType: 'TXT',
      expected,
      actual: txt,
      status,
      hint,
    });
  }

  /* --- DMARC ------------------------------------------------------- */
  {
    const dmarcName = `_dmarc.${name}`;
    const outcome = await attempt(() => resolver.resolveTxt(dmarcName));
    const txt = outcome.kind === 'ok' ? joinTxt(outcome.value) : [];
    const dmarc = txt.filter((r) => r.toLowerCase().startsWith('v=dmarc1'));
    let status: DnsCheckStatus = 'fail';
    let hint =
      `Записи DMARC нет. Она говорит получателям, что делать с письмами, ` +
      `у которых не сошлись SPF и DKIM, и куда слать отчёты. ` +
      `Начните с «p=quarantine», позже переходите на «p=reject».`;
    if (outcome.kind === 'error') {
      status = 'unknown';
      hint = `Не удалось спросить DNS: ${outcome.message}.`;
    } else if (dmarc.length > 0) {
      const value = dmarc[0] ?? '';
      const policy = /p=(\w+)/i.exec(value)?.[1]?.toLowerCase();
      if (policy === 'none') {
        status = 'warn';
        hint =
          `DMARC опубликован с политикой «none» — это режим наблюдения, ` +
          `подделки не блокируются. Когда убедитесь, что свои письма проходят, ` +
          `смените на «p=quarantine», а затем «p=reject».`;
      } else if (policy === 'quarantine' || policy === 'reject') {
        status = 'ok';
        hint = `DMARC опубликован с политикой «${policy}».`;
      } else {
        status = 'fail';
        hint = 'В записи DMARC не удалось прочитать политику «p=».';
      }
    }
    checks.push({
      id: 'dmarc',
      title: 'DMARC — политика при несовпадении',
      purpose: 'Указывает, что делать с письмами, не прошедшими SPF и DKIM.',
      recordName: dmarcName,
      recordType: 'TXT',
      expected: buildDmarcRecord(name),
      actual: dmarc,
      status,
      hint,
    });
  }

  /* --- PTR --------------------------------------------------------- */
  {
    const ip = (options.publicIpv4 ?? '').trim();
    let status: DnsCheckStatus = 'unknown';
    let actual: string[] = [];
    let hint =
      `Публичный адрес сервера не задан (MAIL_PUBLIC_IPV4), проверить обратную зону нечем. ` +
      `Укажите адрес — и админка сверит, разворачивается ли он в «${host}».`;
    if (ip !== '') {
      if (isIP(ip) === 0) {
        status = 'fail';
        hint = `«${ip}» — не похоже на IP-адрес.`;
      } else {
        const outcome = await attempt(() => resolver.reverse(ip));
        if (outcome.kind === 'error') {
          status = 'unknown';
          hint = `Не удалось спросить DNS: ${outcome.message}.`;
        } else if (outcome.kind === 'empty') {
          status = 'fail';
          hint =
            `У адреса ${ip} нет обратной записи. Крупные почтовые службы часто ` +
            `отказывают в приёме почты с адресов без PTR. Запись заказывают ` +
            `у владельца адреса (хостера), а не у регистратора домена.`;
        } else {
          actual = outcome.value.map(fqdn);
          if (actual.includes(host)) {
            status = 'ok';
            hint = `Адрес ${ip} разворачивается в «${host}» — верно.`;
          } else {
            status = 'warn';
            hint =
              `Адрес ${ip} разворачивается в «${actual.join(', ')}», а не в «${host}». ` +
              `Желательно, чтобы PTR совпадал с именем, которым сервер представляется в HELO.`;
          }
        }
      }
    }
    checks.push({
      id: 'ptr',
      title: 'PTR — обратная зона',
      purpose: 'Обратная запись адреса сервера; без неё почту часто не принимают.',
      recordName: ip === '' ? '<адрес сервера>' : ip,
      recordType: 'PTR',
      expected: `${host}.`,
      actual,
      status,
      hint,
    });
  }

  /* --- autoconfig / autodiscover ----------------------------------- */
  for (const item of [
    {
      id: 'autoconfig' as const,
      title: 'autoconfig — автонастройка Thunderbird',
      recordName: `autoconfig.${name}`,
      purpose: 'Чтобы почтовый клиент сам нашёл настройки по адресу пользователя.',
    },
    {
      id: 'autodiscover' as const,
      title: 'autodiscover — автонастройка Outlook',
      recordName: `autodiscover.${name}`,
      purpose: 'То же для Outlook и мобильных клиентов Microsoft.',
    },
  ]) {
    const outcome = await attempt(() => resolver.resolveCname(item.recordName));
    const actual = outcome.kind === 'ok' ? outcome.value.map(fqdn) : [];
    let status: DnsCheckStatus = 'warn';
    let hint =
      `Записи нет. Без неё клиенты не настроятся автоматически — пользователю ` +
      `придётся вбивать серверы вручную. Не критично, но заметно упрощает жизнь.`;
    if (outcome.kind === 'error') {
      status = 'unknown';
      hint = `Не удалось спросить DNS: ${outcome.message}.`;
    } else if (actual.includes(host)) {
      status = 'ok';
      hint = `Указывает на «${host}» — верно.`;
    } else if (actual.length > 0) {
      status = 'warn';
      hint = `Указывает на «${actual.join(', ')}», а не на «${host}».`;
    }
    checks.push({
      id: item.id,
      title: item.title,
      purpose: item.purpose,
      recordName: item.recordName,
      recordType: 'CNAME',
      expected: `${host}.`,
      actual,
      status,
      hint,
    });
  }

  return {
    domain: name,
    checkedAt: new Date().toISOString(),
    overall: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}
