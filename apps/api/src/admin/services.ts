/**
 * Проверки служб, которые видно только со стороны почты: антиспам,
 * подпись исходящих и свой резольвер.
 *
 * Почему они здесь, а не в общей пробе состояния (src/health.ts). Отказ
 * любой из них НЕ мешает продукту работать: письма ходят, ящик читается,
 * вход работает. Но последствия молчаливые и дорогие:
 *
 *   • лежит rspamd — почта идёт без проверки, спам едет во «Входящие»;
 *   • не подписываются исходящие — принимающая сторона видит письма без
 *     DKIM, и репутация домена тихо портится неделями, пока кто-нибудь
 *     не пожалуется, что письма уходят в спам;
 *   • молчит свой резольвер — внешние списки репутации перестают
 *     отвечать, и антиспам «работает», ничего не находя.
 *
 * Ни одно из трёх не видно ни из журналов почты, ни из пробы контейнера.
 * Поэтому их место — сводка администратора.
 *
 * Сеть вынесена в параметры (fetchImpl, resolveNsImpl): разбор ответа
 * проверяется юнит-тестами без живого rspamd.
 */

/** Состояние службы в сводке (совпадает с ServiceStatus в overview.ts). */
export interface ServiceCheck {
  state: 'ok' | 'fail' | 'unknown';
  detail: string;
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
export type ResolveNsImpl = (server: string, timeoutMs: number) => Promise<string[]>;

/** Ответ rspamd на /checkv2 в той части, которая нас интересует. */
interface CheckV2Body {
  'dkim-signature'?: unknown;
  symbols?: Record<string, { name?: string; options?: unknown }>;
}

/**
 * Письмо-образец для проверки подписи. Отправитель — почтмейстер своего
 * домена: DKIM подписывается по домену из заголовка From (use_domain =
 * "header" в infra/rspamd/entrypoint.sh).
 */
export function signingProbeMessage(domain: string): string {
  const lines = [
    `From: postmaster@${domain}`,
    'To: dkim-probe@example.org',
    'Subject: DKIM probe',
    `Message-ID: <dkim-probe@${domain}>`,
    '',
    'Проверка подписи исходящих писем.',
    '',
  ];
  return lines.join('\r\n');
}

/**
 * Разбирает ответ rspamd: подписалось ли письмо-образец.
 *
 * Признаков два, и достаточно любого: готовая подпись в поле
 * `dkim-signature` и символ DKIM_SIGNED. Первый бывает не во всех версиях
 * ответа, второй ставит сам модуль подписи.
 */
export function readSigningVerdict(body: unknown, domain: string): ServiceCheck {
  const data = (body ?? {}) as CheckV2Body;
  const signature = data['dkim-signature'];
  const signed =
    (typeof signature === 'string' && signature.length > 0) ||
    (Array.isArray(signature) && signature.length > 0) ||
    Object.prototype.hasOwnProperty.call(data.symbols ?? {}, 'DKIM_SIGNED');
  if (signed) {
    return {
      state: 'ok',
      detail: `Исходящие письма домена ${domain} подписываются DKIM`,
    };
  }
  return {
    state: 'fail',
    detail:
      `Исходящие письма домена ${domain} уходят БЕЗ подписи DKIM: rspamd отвечает, ` +
      'но подпись не ставит. Проверьте ключ /var/lib/rspamd/dkim/' +
      `${domain}.<селектор>.key и настройки dkim_signing — принимающая сторона ` +
      'считает такие письма подозрительными, и репутация домена портится молча',
  };
}

export interface AntispamProbeOptions {
  host: string;
  port: number;
  /** Пароль контроллера rspamd; без него доступна только проверка «жив». */
  password: string;
  /** Домен, для которого проверяется подпись. */
  domain: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  /**
   * Сколько миллисекунд разрешено отдавать ПРЕЖНИЙ ответ о подписи.
   *
   * Ноль (умолчание) — не кэшировать вовсе: живая проверка обязана быть
   * живой. Разбор — у dkimProbeCache ниже.
   */
  cacheMs?: number;
}

/**
 * Спрашивает rspamd о двух вещах сразу: отвечает ли он и подписывает ли
 * исходящие. Второе — не косметика: антиспам и подпись живут в одном
 * процессе, и «жив» ещё не значит «подписывает».
 */
/**
 * Готовый ответ о подписи — чтобы не сканировать по письму на каждый опрос.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ КЭШ И ПОЧЕМУ ЕГО НЕ БЫЛО ВИДНО
 * ------------------------------------------------------------------
 * Проверка подписи — это НАСТОЯЩЕЕ сканирование: письмо уходит в rspamd
 * через /checkv2 и попадает в его счётчик проверенных писем. Сводка же
 * опрашивается раз в пятнадцать секунд, то есть двести сорок фиктивных
 * сканирований в час на каждую открытую вкладку.
 *
 * Тот же счётчик показывает раздел «Спам», и доля спама считается как
 * «спам / проверено». Открытая на ночь сводка занижала её кратно: письма
 * не приходили, а знаменатель рос. Настройка подписи при этом не меняется
 * по пятнадцать секунд — на неё влияет правка ключей DKIM, а это событие
 * редкое и заметное.
 *
 * Кэш ВЫКЛЮЧЕН по умолчанию (`cacheMs` не задан): «Живая проверка» на
 * странице наблюдения должна сканировать по-настоящему, на то она и
 * живая. Кэшем пользуется только сводка.
 */
let dkimProbeCache: { key: string; at: number; value: ServiceCheck } | null = null;

export async function checkAntispam(
  options: AntispamProbeOptions,
): Promise<{ antispam: ServiceCheck; dkim: ServiceCheck }> {
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 2000;
  const base = `http://${options.host}:${String(options.port)}`;

  let alive: Response;
  try {
    alive = await doFetch(`${base}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const detail =
      `Контроллер ${options.host}:${String(options.port)} не отвечает (${reason}). ` +
      'Почта продолжает ходить, но БЕЗ проверки на спам и БЕЗ подписи DKIM';
    return {
      antispam: { state: 'fail', detail },
      dkim: {
        state: 'fail',
        detail: 'Подпись исходящих не работает: её ставит тот же rspamd, который не отвечает',
      },
    };
  }
  if (!alive.ok) {
    return {
      antispam: {
        state: 'fail',
        detail: `Контроллер ответил ${String(alive.status)} — антиспам и подпись DKIM не работают`,
      },
      dkim: { state: 'fail', detail: 'Подпись исходящих не проверена: rspamd отвечает с ошибкой' },
    };
  }

  const antispam: ServiceCheck = {
    state: 'ok',
    detail: `Отвечает на ${options.host}:${String(options.port)}; письма проверяются`,
  };

  if (options.password === '') {
    return {
      antispam,
      dkim: {
        state: 'unknown',
        detail:
          'Подпись исходящих не проверена: не задан RSPAMD_PASSWORD. ' +
          'Без пароля контроллер не принимает проверочное письмо',
      },
    };
  }

  const cacheKey = `${base}|${options.domain}`;
  const cacheMs = options.cacheMs ?? 0;
  if (cacheMs > 0 && dkimProbeCache && dkimProbeCache.key === cacheKey) {
    if (Date.now() - dkimProbeCache.at < cacheMs) {
      return { antispam, dkim: dkimProbeCache.value };
    }
  }

  const remember = (dkim: ServiceCheck): { antispam: ServiceCheck; dkim: ServiceCheck } => {
    if (cacheMs > 0) dkimProbeCache = { key: cacheKey, at: Date.now(), value: dkim };
    return { antispam, dkim };
  };

  try {
    const response = await doFetch(`${base}/checkv2`, {
      method: 'POST',
      headers: {
        Password: options.password,
        // Заголовки описывают отправку своим аутентифицированным
        // пользователем — именно такие письма и подписываются.
        IP: '127.0.0.1',
        User: `postmaster@${options.domain}`,
        From: `postmaster@${options.domain}`,
        Rcpt: 'dkim-probe@example.org',
      },
      body: signingProbeMessage(options.domain),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        antispam,
        dkim: {
          state: 'unknown',
          detail: `Подпись исходящих не проверена: контроллер ответил ${String(response.status)}`,
        },
      };
    }
    return remember(readSigningVerdict(await response.json(), options.domain));
  } catch (err) {
    return {
      antispam,
      dkim: {
        state: 'unknown',
        detail: `Подпись исходящих не проверена: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

export interface ResolverProbeOptions {
  /** Адрес своего резольвера (RESOLVER_IP). Пустой — резольвер не настроен. */
  address: string;
  timeoutMs?: number;
  resolveNsImpl?: ResolveNsImpl;
}

/**
 * Проверяет свой резольвер запросом NS корневой зоны.
 *
 * Почему именно корневая зона, а не «открыт ли порт». Открытый порт ничего
 * не доказывает: резольвер, потерявший связь с корневыми серверами,
 * отвечает на порт и молча не отвечает по существу — а именно по существу
 * его спрашивает антиспам, когда проверяет адрес отправителя по внешним
 * спискам. Ответ на NS «.» приходит из кэша, стоит он почти ничего.
 */
export async function checkResolver(options: ResolverProbeOptions): Promise<ServiceCheck> {
  if (options.address === '') {
    return {
      state: 'unknown',
      detail:
        'Свой резольвер не задан (RESOLVER_IP): проверить, отвечает ли unbound, неоткуда. ' +
        'Внешние списки репутации при этом могут молча не работать',
    };
  }
  const timeoutMs = options.timeoutMs ?? 2000;
  const resolveNs = options.resolveNsImpl ?? defaultResolveNs;
  try {
    const servers = await resolveNs(options.address, timeoutMs);
    if (servers.length === 0) {
      return {
        state: 'fail',
        detail: `Резольвер ${options.address} отвечает пустым ответом — внешние списки антиспама молчат`,
      };
    }
    return {
      state: 'ok',
      detail: `Резольвер ${options.address} отвечает; рекурсия работает (корневых серверов: ${String(servers.length)})`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      state: 'fail',
      detail:
        `Резольвер ${options.address} не отвечает (${reason}). Проверки по внешним спискам ` +
        'перестают работать молча: письма проходят, спам не находится',
    };
  }
}

/** Настоящий запрос к DNS: отдельная функция ради подмены в тестах. */
async function defaultResolveNs(server: string, timeoutMs: number): Promise<string[]> {
  const { Resolver } = await import('node:dns/promises');
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([server]);
  return resolver.resolveNs('.');
}
