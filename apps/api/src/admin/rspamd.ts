/**
 * Управляющий интерфейс Rspamd (контроллер, порт 11334).
 *
 * ------------------------------------------------------------------
 * ЧТО КОНТРОЛЛЕР ДАЁТ, А ЧТО НЕТ
 * ------------------------------------------------------------------
 * Проверено живьём на rspamd 4.1.4 (контейнер стенда), а не взято из
 * документации — документация описывает семейство версий, а раздел панели
 * обязан обещать ровно то, что отвечает ЭТОТ сервер:
 *
 *   GET  /stat        накопленные счётчики: проверено писем, разбивка по
 *                     действиям, обучено, состояние байесовых файлов.
 *                     ВАЖНО: счётчики накопленные С МОМЕНТА ЗАПУСКА
 *                     процесса, а не «за сутки». Отсюда снимки в базе
 *                     (см. spam-store.ts) — иначе «за период» не бывает.
 *   GET  /counters    сколько раз сработал каждый символ и его вес.
 *                     Тоже с момента запуска.
 *   GET  /history     последние проверенные письма целиком: оценка,
 *                     действие, все символы. Живёт В ПАМЯТИ процесса и
 *                     теряется при перезапуске — глубина невелика.
 *   GET  /actions     действующие ОБЩИЕ пороги (add header, reject...).
 *   GET  /maps        список карт; GET /getmap + POST /savemap — чтение и
 *                     ЗАПИСЬ файла карты. Запись работает: rspamd сам
 *                     переписывает файл и перечитывает его, то есть правка
 *                     из панели доезжает до фильтра без перезапуска.
 *   POST /learnspam   обучение байесова классификатора на письме.
 *   POST /learnham
 *   POST /checkv2     проверка письма без доставки; в ответе есть и
 *                     пороги, применённые ИМЕННО К ЭТОМУ письму.
 *   GET  /errors      последние ошибки самого rspamd.
 *
 * Чего контроллер НЕ даёт (и потому раздел этого не обещает):
 *
 *   • изменения порогов. /saveactions на этом сервере отвечает
 *     «400 Cannot parse input» при любом виде тела, а работал бы он только
 *     при заведённом dynamic_conf — то есть писал бы пороги в СКРЫТЫЙ файл
 *     поверх infra/rspamd/local.d/actions.conf. Тогда в конфигурации
 *     появилось бы два источника истины, и правка actions.conf молча
 *     переставала бы действовать. Пороги отдаём на чтение и говорим, где
 *     они правятся;
 *   • сведений о профилях настроек (local.d/settings.conf). Про то, что
 *     у своих аутентифицированных отправителей пороги свои, контроллер
 *     не расскажет — но их можно ИЗМЕРИТЬ пробным письмом (см. probe()).
 */
import { ApiError } from '../errors.js';

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/* ------------------------------------------------------------------ */
/* Ответы контроллера                                                   */
/* ------------------------------------------------------------------ */

/** Накопленные счётчики (GET /stat). */
export interface RspamdStat {
  version: string;
  /** Сколько секунд работает процесс. По нему видно перезапуск. */
  uptimeSeconds: number;
  scanned: number;
  learned: number;
  spamCount: number;
  hamCount: number;
  /** Действия: ключ — как их зовёт сам rspamd («add header», «reject»...). */
  actions: Record<string, number>;
  /** Байесовы классификаторы: сколько знают о спаме и о не-спаме. */
  statfiles: Array<{ symbol: string; type: string; revision: number; users: number }>;
  connections: number;
}

/** Одно правило и то, как часто оно срабатывало (GET /counters). */
export interface RspamdCounter {
  symbol: string;
  weight: number;
  hits: number;
  frequency: number;
  /** Среднее время вычисления правила, секунды. Видно дорогие правила. */
  timeSeconds: number;
}

/** Письмо из истории проверок (GET /history). */
export interface RspamdHistoryRow {
  at: string;
  action: string;
  score: number;
  requiredScore: number | null;
  subject: string;
  sender: string;
  recipients: string[];
  ip: string;
  /** Аутентифицированный отправитель — то есть письмо НАШЕГО пользователя. */
  user: string;
  sizeBytes: number;
  isSkipped: boolean;
  /** Символы, давшие ненулевой вклад, от большего к меньшему. */
  symbols: Array<{ name: string; score: number; description: string }>;
}

/** Карта rspamd (GET /maps). */
export interface RspamdMapInfo {
  id: number;
  uri: string;
  description: string;
  type: string;
}

/** Ошибка самого rspamd (GET /errors). */
export interface RspamdError {
  at: string;
  type: string;
  module: string;
  message: string;
}

/** Итог проверки письма (POST /checkv2). */
export interface RspamdVerdict {
  score: number;
  action: string;
  /** Пороги, применённые именно к этому письму. */
  thresholds: Record<string, number>;
  symbols: Array<{ name: string; score: number; description: string }>;
}

/* ------------------------------------------------------------------ */
/* Разбор ответов — отдельно от сети, чтобы проверять без живого rspamd  */
/* ------------------------------------------------------------------ */

const num = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

export function parseStat(body: unknown): RspamdStat {
  const data = (body ?? {}) as Record<string, unknown>;
  const actionsRaw = (data.actions ?? {}) as Record<string, unknown>;
  const actions: Record<string, number> = {};
  for (const [key, value] of Object.entries(actionsRaw)) actions[key] = num(value);
  const statfilesRaw = Array.isArray(data.statfiles) ? data.statfiles : [];
  return {
    version: str(data.version, '?'),
    uptimeSeconds: num(data.uptime),
    scanned: num(data.scanned),
    learned: num(data.learned),
    spamCount: num(data.spam_count),
    hamCount: num(data.ham_count),
    actions,
    statfiles: statfilesRaw.map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      return {
        symbol: str(row.symbol, '?'),
        type: str(row.type, '?'),
        revision: num(row.revision),
        users: num(row.users),
      };
    }),
    connections: num(data.connections),
  };
}

export function parseCounters(body: unknown): RspamdCounter[] {
  if (!Array.isArray(body)) return [];
  return body.map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      symbol: str(row.symbol, '?'),
      weight: num(row.weight),
      hits: num(row.hits),
      frequency: num(row.frequency),
      timeSeconds: num(row.time),
    };
  });
}

/**
 * Символы, отсортированные по числу срабатываний.
 *
 * Ноль срабатываний отсеиваем: в rspamd около полутора тысяч правил, и
 * почти все они за время работы сервера не сработали ни разу. Показывать
 * их в списке «по каким правилам чаще всего» — это полторы тысячи строк,
 * в которых ответа нет.
 */
export function topSymbols(counters: readonly RspamdCounter[], limit = 20): RspamdCounter[] {
  return counters
    .filter((c) => c.hits > 0)
    .sort((a, b) => b.hits - a.hits || Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, limit);
}

/** Символы письма: только те, что дали вклад, от большего к меньшему. */
function parseSymbols(raw: unknown): Array<{ name: string; score: number; description: string }> {
  const map = (raw ?? {}) as Record<string, unknown>;
  return Object.entries(map)
    .map(([name, value]) => {
      const row = (value ?? {}) as Record<string, unknown>;
      return {
        name: str(row.name, name),
        score: num(row.score),
        description: str(row.description),
      };
    })
    .filter((s) => s.score !== 0)
    .sort((a, b) => b.score - a.score);
}

export function parseHistory(body: unknown): RspamdHistoryRow[] {
  const data = (body ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(data.rows) ? data.rows : [];
  return rows
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const rcpt = Array.isArray(row.rcpt_smtp)
        ? row.rcpt_smtp
        : Array.isArray(row.rcpt_mime)
          ? row.rcpt_mime
          : [];
      return {
        at: new Date(num(row.unix_time) * 1000).toISOString(),
        action: str(row.action, 'no action'),
        score: num(row.score),
        requiredScore: row.required_score === undefined ? null : num(row.required_score),
        subject: str(row.subject),
        sender: str(row.sender_smtp) || str(row.sender_mime),
        recipients: rcpt.map((r) => str(r)),
        ip: str(row.ip),
        user: str(row.user),
        sizeBytes: num(row.size),
        isSkipped: row.is_skipped === true,
        symbols: parseSymbols(row.symbols),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Действующие общие пороги: имя действия → балл (null — действие выключено). */
export function parseActions(body: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!Array.isArray(body)) return out;
  for (const item of body) {
    const row = (item ?? {}) as Record<string, unknown>;
    const name = str(row.action);
    if (name === '') continue;
    out[name] = row.value === null || row.value === undefined ? null : num(row.value);
  }
  return out;
}

export function parseMaps(body: unknown): RspamdMapInfo[] {
  if (!Array.isArray(body)) return [];
  return body.map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      id: num(row.map),
      uri: str(row.uri),
      description: str(row.description),
      type: str(row.type),
    };
  });
}

export function parseErrors(body: unknown, limit = 20): RspamdError[] {
  if (!Array.isArray(body)) return [];
  return body
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      return {
        at: new Date(num(row.ts) * 1000).toISOString(),
        type: str(row.type),
        module: str(row.module),
        message: str(row.message),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

export function parseVerdict(body: unknown): RspamdVerdict {
  const data = (body ?? {}) as Record<string, unknown>;
  const thresholdsRaw = (data.thresholds ?? {}) as Record<string, unknown>;
  const thresholds: Record<string, number> = {};
  for (const [key, value] of Object.entries(thresholdsRaw)) thresholds[key] = num(value);
  return {
    score: num(data.score),
    action: str(data.action, 'no action'),
    thresholds,
    symbols: parseSymbols(data.symbols),
  };
}

/**
 * Адрес из заголовка письма («Иван <ivan@example.org>» → ivan@example.org).
 *
 * Нужен проверке письма, и это не мелочь оформления. Rspamd судит о
 * ОТПРАВИТЕЛЕ по КОНВЕРТУ (заголовок запроса From), а не по тексту письма:
 * конверта в вставленном тексте нет вовсе. Подставив вместо него
 * постоянный служебный адрес, панель показывала бы проверку, в которой
 * правила по отправителю — то есть ровно те списки, которые тут же рядом
 * и правят, — не срабатывают НИКОГДА. Проверено живьём: письмо с домена
 * из чёрного списка получало 11,8 балла без символа BLACKLIST_SENDER_DOMAIN.
 *
 * Разбор нарочно грубый: нужен адрес для конверта, а не полное соответствие
 * RFC 5322. Не нашли — вызывающий подставит свой запасной.
 */
export function senderFromMessage(message: string): string | null {
  // Смотрим только в шапку: строка «From:» в теле письма (цитата, подпись)
  // конвертом не является.
  const head = message.split(/\r?\n\r?\n/u)[0] ?? '';
  const line = /^From:\s*(.+)$/imu.exec(head)?.[1]?.trim();
  if (!line) return null;
  const angled = /<([^>]+)>/u.exec(line)?.[1];
  const candidate = (angled ?? line).trim().replace(/^"|"$/gu, '');
  return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u.test(candidate) ? candidate.toLowerCase() : null;
}

/* ------------------------------------------------------------------ */
/* Карты: разбор и сборка файла                                         */
/* ------------------------------------------------------------------ */

/**
 * Записи карты — строки, которые не комментарий и не пустые.
 *
 * Порядок сохраняется: файл правится дописыванием и вычёркиванием строк,
 * а не пересозданием. Заголовок с пояснениями, который лежит в каждом
 * файле maps.d, обязан пережить правку из панели — иначе первая же
 * добавленная запись стёрла бы объяснение, зачем этот файл нужен.
 */
export function parseMapEntries(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Добавляет запись, сохраняя всё остальное содержимое файла как есть. */
export function addMapEntry(text: string, entry: string): string {
  if (parseMapEntries(text).some((line) => line.toLowerCase() === entry.toLowerCase())) {
    return text;
  }
  const base = text.replace(/\s+$/u, '');
  return base === '' ? `${entry}\n` : `${base}\n${entry}\n`;
}

/** Убирает запись. Комментарии и прочие строки не трогаются. */
export function removeMapEntry(text: string, entry: string): string {
  const target = entry.trim().toLowerCase();
  const kept = text.split(/\r?\n/u).filter((line) => line.trim().toLowerCase() !== target);
  return `${kept.join('\n').replace(/\s+$/u, '')}\n`;
}

/* ------------------------------------------------------------------ */
/* Клиент                                                               */
/* ------------------------------------------------------------------ */

export interface RspamdClientOptions {
  host: string;
  port: number;
  /** Пароль контроллера (RSPAMD_PASSWORD). Пустой — управление недоступно. */
  password: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

/**
 * Контроллер не настроен или ответил отказом.
 *
 * Наследуется от ApiError, а не от Error: иначе общий обработчик отдал бы
 * «Внутренняя ошибка сервера», и лежащий антиспам выглядел бы как поломка
 * панели. 503 — это «служба недоступна», что здесь и есть правда.
 */
export class RspamdUnavailableError extends ApiError {
  constructor(message: string) {
    super(503, 'RSPAMD_UNAVAILABLE', message);
    this.name = 'RspamdUnavailableError';
  }
}

export class RspamdClient {
  readonly #host: string;
  readonly #port: number;
  readonly #password: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchImpl;

  constructor(options: RspamdClientOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#password = options.password;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /**
   * Настроен ли доступ к управлению.
   *
   * Без пароля контроллер отвечает только на /ping: посмотреть статистику,
   * прочитать списки и тем более обучить фильтр нельзя. Это не поломка,
   * а незаполненная переменная окружения, и говорить о ней надо прямо.
   */
  get configured(): boolean {
    return this.#password !== '';
  }

  get address(): string {
    return `${this.#host}:${String(this.#port)}`;
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.configured) {
      throw new RspamdUnavailableError(
        'Не задан RSPAMD_PASSWORD: управляющий интерфейс антиспама отвечает только на проверку ' +
          '«жив». Задайте пароль в infra/.env и перезапустите контейнеры api и rspamd',
      );
    }
    const url = `http://${this.#host}:${String(this.#port)}${path}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: { Password: this.#password, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new RspamdUnavailableError(
        `Антиспам ${this.address} не отвечает (${err instanceof Error ? err.message : String(err)}). ` +
          'Почта продолжает ходить, но БЕЗ проверки на спам и без подписи DKIM',
      );
    }
    if (response.status === 403 || response.status === 401) {
      throw new RspamdUnavailableError(
        `Антиспам ${this.address} не принял пароль контроллера: RSPAMD_PASSWORD у сервера ` +
          'приложения и у rspamd разошлись',
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new RspamdUnavailableError(
        `Антиспам ${this.address} ответил ${String(response.status)}${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }
    const raw = await response.text();
    if (raw === '') return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }

  async stat(): Promise<RspamdStat> {
    return parseStat(await this.#request('/stat'));
  }

  async counters(): Promise<RspamdCounter[]> {
    return parseCounters(await this.#request('/counters'));
  }

  async history(): Promise<RspamdHistoryRow[]> {
    return parseHistory(await this.#request('/history'));
  }

  async actions(): Promise<Record<string, number | null>> {
    return parseActions(await this.#request('/actions'));
  }

  async maps(): Promise<RspamdMapInfo[]> {
    return parseMaps(await this.#request('/maps'));
  }

  async errors(limit = 20): Promise<RspamdError[]> {
    return parseErrors(await this.#request('/errors'), limit);
  }

  async getMap(id: number): Promise<string> {
    const body = await this.#request('/getmap', { headers: { Map: String(id) } });
    return typeof body === 'string' ? body : JSON.stringify(body ?? '');
  }

  /**
   * Записать карту целиком.
   *
   * Пишет САМ rspamd — сервер приложения к файлам maps.d доступа не имеет
   * и иметь не должен. Заодно это снимает вопрос «доехала ли правка»:
   * файл переписан тем же процессом, который его читает.
   */
  async saveMap(id: number, text: string): Promise<void> {
    await this.#request('/savemap', {
      method: 'POST',
      headers: { Map: String(id), 'Content-Type': 'text/plain' },
      body: text,
    });
  }

  /** Обучение классификатора на конкретном письме. */
  async learn(kind: 'spam' | 'ham', message: string): Promise<void> {
    await this.#request(kind === 'spam' ? '/learnspam' : '/learnham', {
      method: 'POST',
      headers: { 'Content-Type': 'message/rfc822' },
      body: message,
    });
  }

  /**
   * Проверка письма без доставки.
   *
   * Нужна для двух вещей: показать, как фильтр ОЦЕНИТ конкретное письмо, и
   * узнать пороги, действующие для отправителя данного вида. Второе иначе
   * не узнать: профили настроек (local.d/settings.conf) контроллер
   * отдельно не показывает.
   */
  async check(
    message: string,
    envelope: { ip: string; from: string; rcpt: string; user?: string },
  ): Promise<RspamdVerdict> {
    const headers: Record<string, string> = {
      IP: envelope.ip,
      From: envelope.from,
      Rcpt: envelope.rcpt,
      'Content-Type': 'message/rfc822',
    };
    if (envelope.user) headers.User = envelope.user;
    return parseVerdict(
      await this.#request('/checkv2', { method: 'POST', headers, body: message }),
    );
  }
}
