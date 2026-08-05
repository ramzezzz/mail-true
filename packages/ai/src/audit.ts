/**
 * Журнал обращений к ИИ.
 *
 * Требование спецификации: всё, что уходит наружу, пишется в журнал —
 * когда, какое письмо, какая возможность, сколько токенов, — чтобы
 * администратор мог проверить и посчитать.
 *
 * Записи из кэша тоже попадают в журнал, но с пометкой cached: наружу
 * они не уходили, и это должно быть видно.
 */

import type { AiErrorKind, AiFeature, TokenUsage } from './types.js';

export interface AiAuditEntry {
  /** Момент вызова, ISO 8601. */
  at: string;
  /** Кому принадлежит ящик. */
  accountId: string;
  /** Идентификатор письма или цепочки; null — обращение без письма. */
  messageId: string | null;
  feature: AiFeature;
  /** Версия формулировки запроса — по ней видно, какой именно текст уходил. */
  promptVersion: string;
  /** Адрес, куда ушли данные. */
  endpoint: string;
  model: string;
  /** Модель внутри периметра — письма сервер не покидали. */
  local: boolean;
  usage: TokenUsage;
  /** Ответ взят из кэша, отправки наружу не было. */
  cached: boolean;
  /** Сколько символов ушло наружу. */
  outboundChars: number;
  durationMs: number;
  ok: boolean;
  /** Причина отказа, если вызов не удался. */
  errorKind: AiErrorKind | null;
}

export interface AiAuditFilter {
  accountId?: string;
  messageId?: string;
  feature?: AiFeature;
  /** Нижняя граница по времени, ISO 8601. */
  since?: string;
  limit?: number;
}

export interface AiAuditTotals {
  requests: number;
  cachedRequests: number;
  failedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  outboundChars: number;
}

export interface AiAuditLog {
  record(entry: AiAuditEntry): Promise<void>;
  list(filter?: AiAuditFilter): Promise<AiAuditEntry[]>;
  totals(filter?: AiAuditFilter): Promise<AiAuditTotals>;
}

function matches(entry: AiAuditEntry, filter?: AiAuditFilter): boolean {
  if (!filter) return true;
  if (filter.accountId !== undefined && entry.accountId !== filter.accountId) return false;
  if (filter.messageId !== undefined && entry.messageId !== filter.messageId) return false;
  if (filter.feature !== undefined && entry.feature !== filter.feature) return false;
  if (filter.since !== undefined && entry.at < filter.since) return false;
  return true;
}

export function sumEntries(entries: readonly AiAuditEntry[]): AiAuditTotals {
  const totals: AiAuditTotals = {
    requests: 0,
    cachedRequests: 0,
    failedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    outboundChars: 0,
  };
  for (const entry of entries) {
    totals.requests += 1;
    if (entry.cached) totals.cachedRequests += 1;
    if (!entry.ok) totals.failedRequests += 1;
    totals.promptTokens += entry.usage.promptTokens;
    totals.completionTokens += entry.usage.completionTokens;
    totals.totalTokens += entry.usage.totalTokens;
    totals.outboundChars += entry.outboundChars;
  }
  return totals;
}

/** Журнал в памяти. Кольцевой буфер: для тестов и для однопроцессной сборки. */
export class InMemoryAuditLog implements AiAuditLog {
  readonly #entries: AiAuditEntry[] = [];
  readonly #capacity: number;

  constructor(capacity = 10_000) {
    this.#capacity = capacity;
  }

  record(entry: AiAuditEntry): Promise<void> {
    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) this.#entries.shift();
    return Promise.resolve();
  }

  list(filter?: AiAuditFilter): Promise<AiAuditEntry[]> {
    const found = this.#entries.filter((e) => matches(e, filter));
    const limit = filter?.limit;
    return Promise.resolve(limit !== undefined ? found.slice(-limit) : found);
  }

  totals(filter?: AiAuditFilter): Promise<AiAuditTotals> {
    return Promise.resolve(sumEntries(this.#entries.filter((e) => matches(e, filter))));
  }
}

/** Минимальная часть логгера pino, нужная журналу. */
export interface AuditLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Журнал в структурированный лог (pino). Чтение не поддерживается —
 * для отчётов администратора используйте хранилище с чтением.
 */
export class LoggerAuditLog implements AiAuditLog {
  readonly #logger: AuditLogger;
  readonly #inner: AiAuditLog | null;

  constructor(logger: AuditLogger, inner?: AiAuditLog) {
    this.#logger = logger;
    this.#inner = inner ?? null;
  }

  async record(entry: AiAuditEntry): Promise<void> {
    this.#logger.info({ ai: entry }, 'обращение к ИИ');
    if (this.#inner) await this.#inner.record(entry);
  }

  list(filter?: AiAuditFilter): Promise<AiAuditEntry[]> {
    return this.#inner ? this.#inner.list(filter) : Promise.resolve([]);
  }

  totals(filter?: AiAuditFilter): Promise<AiAuditTotals> {
    return this.#inner ? this.#inner.totals(filter) : Promise.resolve(sumEntries([]));
  }
}

/** Журнал выключен. */
export class NoopAuditLog implements AiAuditLog {
  record(): Promise<void> {
    return Promise.resolve();
  }
  list(): Promise<AiAuditEntry[]> {
    return Promise.resolve([]);
  }
  totals(): Promise<AiAuditTotals> {
    return Promise.resolve(sumEntries([]));
  }
}
