/**
 * Проба состояния сервера приложения.
 *
 * Зачем модуль, а не одна строка в маршруте. Проба `{ok:true}` без единой
 * проверки — не проба: при остановленном Redis каждый запрос вошедшего
 * пользователя отвечал 500, вход не работал вовсе, а контейнер оставался
 * `healthy`, и обратный прокси продолжал слать туда трафик. Красный сигнал
 * должен появляться там же, где появляется отказ.
 *
 * Три решения, которые определяют устройство модуля.
 *
 * 1. КРИТИЧНОСТЬ. Части делятся на те, без которых продукт НЕ РАБОТАЕТ
 *    (Postgres, Redis, IMAP), и те, без которых он работает хуже
 *    (отправка почты, антиспам). В пробу контейнера попадают только первые.
 *    Иначе остановленный антиспам — служба, при отказе которой почта
 *    продолжает ходить, — красил бы пробу и уводил сервер приложения
 *    в круг перезапусков, лечащих не ту болезнь.
 *
 * 2. ЦЕНА. Пробу дёргают каждые несколько секунд. Результат кэшируется на
 *    HEALTH_CACHE_MS, а одновременные вызовы получают ОДНО и то же
 *    выполнение (см. #inflight): сколько бы проверок ни пришло разом,
 *    к Redis и Dovecot уйдёт не больше одного обращения на окно кэша.
 *    Проверки пользуются уже открытыми соединениями там, где они есть.
 *
 * 3. ГРАНИЦА ОЖИДАНИЯ. У каждой проверки свой предел времени. Без него
 *    зависший Postgres превращал бы пробу в вечно висящий запрос, и
 *    проверка контейнера падала бы по своему таймауту без объяснения.
 */
import { connect, type Socket } from 'node:net';

/** Состояние отдельной части: она либо отвечает, либо нет. */
export type PartState = 'ok' | 'fail';

/** Итог одной проверки. */
export interface ProbeResult {
  ok: boolean;
  /** Человеческий текст: что именно проверено или что именно сломано. */
  detail: string;
}

/** Проверяемая часть системы. */
export interface HealthPart {
  id: string;
  title: string;
  /**
   * true — без этой части продукт не работает (проба контейнера краснеет);
   * false — работает хуже, но работает (в пробу контейнера не входит).
   */
  critical: boolean;
  probe: () => Promise<ProbeResult>;
}

export interface PartReport {
  id: string;
  title: string;
  critical: boolean;
  state: PartState;
  detail: string;
  /** Сколько миллисекунд отвечала часть — видно медленную, но живую службу. */
  latencyMs: number;
}

export interface HealthReport {
  /** ok — всё на месте; degraded — отказала неважная часть; fail — важная. */
  status: 'ok' | 'degraded' | 'fail';
  uptimeSeconds: number;
  checkedAt: string;
  parts: PartReport[];
}

export interface HealthMonitorOptions {
  /** Срок жизни готового результата, мс. */
  ttlMs?: number;
  /** Предел ожидания одной проверки, мс. */
  timeoutMs?: number;
  now?: () => number;
  uptime?: () => number;
}

/** Ждёт обещание не дольше ms; по истечении — отказ с внятным текстом. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${String(ms)} мс`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Проверка «отвечает ли порт» — без протокольного диалога.
 *
 * Для Dovecot этого достаточно: если порт IMAP не принимает соединение,
 * почту не прочитает никто. Полный вход по IMAP пробой не делаем — он
 * требует чужого пароля и стоит на порядок дороже.
 *
 * ПРОЩАНИЕ (`farewell`). Оборвать соединение сразу после установки дешевле,
 * но Postfix пишет на это `warning: lost connection after CONNECT`. Проба
 * идёт каждые несколько секунд, и журнал доставки — тот самый, что админка
 * показывает в разделе «Журналы почты», — заполнялся предупреждениями,
 * которые порождали мы сами. Настоящая потеря соединения (сканер, кривой
 * клиент) в этом потоке становилась неотличимой. Поэтому там, где у службы
 * есть команда выхода, проба прощается по протоколу: SMTP — `QUIT`,
 * IMAP — `LOGOUT`. Ответа не ждём дольше FAREWELL_WAIT_MS: порт уже
 * ответил на соединение, а это и есть предмет проверки.
 *
 * Команда идёт ТОЛЬКО ПОСЛЕ ПРИВЕТСТВИЯ. Отправленная сразу, она даёт
 * `improper command pipelining after CONNECT` — то же предупреждение, лишь
 * под другим именем: по правилам SMTP клиент обязан дождаться строки 220.
 * Если приветствия нет за BANNER_WAIT_MS, прощание не отправляем вовсе:
 * говорить в тишину незачем, а порт уже признан открытым.
 */
const FAREWELL_WAIT_MS = 250;
const BANNER_WAIT_MS = 400;

export function probeTcpPort(
  host: string,
  port: number,
  timeoutMs = 3000,
  farewell?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: Socket | null = null;
    let goodbye: NodeJS.Timeout | undefined;
    const done = (result: boolean): void => {
      if (!socket) return;
      if (goodbye) clearTimeout(goodbye);
      socket.removeAllListeners();
      socket.destroy();
      socket = null;
      resolve(result);
    };
    try {
      socket = connect({ host, port });
    } catch {
      resolve(false);
      return;
    }
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      if (!farewell || !socket) {
        done(true);
        return;
      }
      // Ошибка записи после успешного соединения ничего не меняет: порт
      // открыт. Дальше либо служба закроет соединение сама, либо выйдет
      // время ожидания — в обоих случаях результат уже известен, поэтому
      // прежние обработчики отказа снимаем: иначе разрыв во время прощания
      // превратил бы успешную пробу в «порт не отвечает».
      const live = socket;
      live.removeAllListeners('error');
      live.removeAllListeners('timeout');
      live.on('error', () => done(true));
      live.once('close', () => done(true));
      live.once('data', () => {
        if (goodbye) clearTimeout(goodbye);
        live.write(farewell, () => undefined);
        goodbye = setTimeout(() => done(true), FAREWELL_WAIT_MS);
        goodbye.unref?.();
      });
      goodbye = setTimeout(() => done(true), BANNER_WAIT_MS);
      goodbye.unref?.();
    });
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Команда выхода для порта, если у службы она есть. */
export const SMTP_FAREWELL = 'QUIT\r\n';
export const IMAP_FAREWELL = 'A1 LOGOUT\r\n';

/** Часть, проверяемая открытием TCP-соединения (Dovecot, Postfix). */
export function tcpPart(opts: {
  id: string;
  title: string;
  critical: boolean;
  host: string;
  port: number;
  timeoutMs?: number;
  /** Команда выхода: с ней служба не считает пробу оборванным соединением. */
  farewell?: string;
  /** Чем грозит отказ — попадает в текст ответа. */
  consequence: string;
}): HealthPart {
  const where = `${opts.host}:${String(opts.port)}`;
  return {
    id: opts.id,
    title: opts.title,
    critical: opts.critical,
    probe: async () => {
      const ok = await probeTcpPort(opts.host, opts.port, opts.timeoutMs ?? 3000, opts.farewell);
      return {
        ok,
        detail: ok ? `Порт ${where} открыт` : `Порт ${where} не отвечает — ${opts.consequence}`,
      };
    },
  };
}

/**
 * Сборщик состояния. Части регистрируются теми модулями, которым они
 * принадлежат: почтовый API кладёт Redis и IMAP, админка — Postgres.
 * Так проба не тянет за собой знание о чужих подключениях и не открывает
 * своих собственных.
 */
export class HealthMonitor {
  readonly #parts: HealthPart[] = [];
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #uptime: () => number;

  #cached: HealthReport | null = null;
  #cachedAt = 0;
  #inflight: Promise<HealthReport> | null = null;

  constructor(options: HealthMonitorOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 2000;
    this.#timeoutMs = options.timeoutMs ?? 3000;
    this.#now = options.now ?? Date.now;
    this.#uptime = options.uptime ?? process.uptime;
  }

  register(part: HealthPart): void {
    const at = this.#parts.findIndex((p) => p.id === part.id);
    if (at >= 0) this.#parts[at] = part;
    else this.#parts.push(part);
    // Новая часть обязана попасть в ближайший ответ, а не через окно кэша.
    this.#cached = null;
  }

  get partIds(): string[] {
    return this.#parts.map((p) => p.id);
  }

  /** Готовый отчёт: из кэша, из уже идущей проверки или новой. */
  async report(): Promise<HealthReport> {
    const cached = this.#cached;
    if (cached && this.#now() - this.#cachedAt < this.#ttlMs) return cached;
    // Совпавшие по времени вызовы делят одну проверку: проба дёргается
    // и контейнером, и прокси, и админкой — умножать обращения незачем.
    this.#inflight ??= this.#run().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #run(): Promise<HealthReport> {
    const parts = await Promise.all(this.#parts.map((part) => this.#runOne(part)));
    const report: HealthReport = {
      status: statusOf(parts),
      uptimeSeconds: Math.round(this.#uptime()),
      checkedAt: new Date(this.#now()).toISOString(),
      parts,
    };
    this.#cached = report;
    this.#cachedAt = this.#now();
    return report;
  }

  async #runOne(part: HealthPart): Promise<PartReport> {
    const started = this.#now();
    const base = { id: part.id, title: part.title, critical: part.critical };
    try {
      const result = await withDeadline(part.probe(), this.#timeoutMs, part.title);
      return {
        ...base,
        state: result.ok ? 'ok' : 'fail',
        detail: result.detail,
        latencyMs: this.#now() - started,
      };
    } catch (err) {
      return {
        ...base,
        state: 'fail',
        detail: err instanceof Error ? err.message : String(err),
        latencyMs: this.#now() - started,
      };
    }
  }
}

/** Общее состояние: важная часть перевешивает неважную. */
export function statusOf(parts: PartReport[]): 'ok' | 'degraded' | 'fail' {
  if (parts.some((p) => p.critical && p.state === 'fail')) return 'fail';
  if (parts.some((p) => p.state === 'fail')) return 'degraded';
  return 'ok';
}

/** Части, из-за которых продукт не работает прямо сейчас. */
export function brokenCriticalParts(report: HealthReport): PartReport[] {
  return report.parts.filter((p) => p.critical && p.state === 'fail');
}
