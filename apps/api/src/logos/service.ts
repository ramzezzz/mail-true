/**
 * Сборка всего вместе: кэш, единственность запроса на домен, ограничение
 * исходящего потока и срок, дольше которого интерфейс не ждёт.
 *
 * ------------------------------------------------------------------
 * Три правила, ради которых этот слой существует
 * ------------------------------------------------------------------
 * 1. ОДИН ДОМЕН — ОДИН ПОХОД. В списке из пятидесяти писем домены
 *    повторяются десятками раз, а параллельных запросов от разных
 *    пользователей может быть сколько угодно. Все они складываются в одно
 *    обещание (#inflight): первый идёт в сеть, остальные ждут его результат.
 * 2. СПИСОК ПИСЕМ НЕ ЖДЁТ. Логотипы запрашиваются отдельным запросом, и даже
 *    он не висит дольше SENDER_LOGO_WAIT_MS: домены, за которые не успели,
 *    отвечаются как «ещё ищем», поиск продолжается в фоне, интерфейс
 *    переспросит и получит готовое.
 * 3. ПРОСРОЧЕННОЕ ПОКАЗЫВАЕТСЯ, ПОКА НЕ ОБНОВИЛОСЬ. Истёкший срок — повод
 *    сходить за свежим в фоне, а не повод убрать логотип из кружка.
 */
import type { Logger } from 'pino';
import type { AiService } from '../ai/service.js';
import { AiLogoHints } from './ai.js';
import type { LogoConfig } from './config.js';
import { domainOfAddress } from '../mail/sender-auth.js';
import { findLogo, type LogoHintProvider } from './sources.js';
import { isFresh, LogoStore, type CachedLogo } from './store.js';
import { LogoOverrideStore, type LogoOverride } from './overrides.js';

/** Сколько доменов принимаем в одном запросе. Страница списка — 50 писем. */
export const MAX_DOMAINS_PER_REQUEST = 60;

export type LogoStatus =
  /** Логотип есть — интерфейс может его показывать. */
  | { status: 'ready'; version: string; source: string; width: number; height: number }
  /** Логотипа нет и не будет в ближайшее время — рисуется буква. */
  | { status: 'none' }
  /** Ещё ищем. Интерфейс переспросит позже; до тех пор — буква. */
  | { status: 'pending' };

/** Простой счётчик исходящих поисков: скользящее окно в одну минуту. */
class MinuteBudget {
  #stamps: number[] = [];
  constructor(private readonly max: number) {}

  take(): boolean {
    const now = Date.now();
    this.#stamps = this.#stamps.filter((t) => now - t < 60_000);
    if (this.#stamps.length >= this.max) return false;
    this.#stamps.push(now);
    return true;
  }
}

export class SenderLogoService {
  readonly #config: LogoConfig;
  readonly #logger: Logger;
  readonly #store: LogoStore;
  readonly #ai: AiService | null;
  readonly #budget: MinuteBudget;
  /** Идущие прямо сейчас поиски: ключ — домен. Ровно одно на домен. */
  readonly #inflight = new Map<string, Promise<CachedLogo | null>>();
  #running = 0;
  readonly #queue: Array<() => void> = [];
  /** Счётчик походов наружу — его показывает проба и по нему считался отчёт. */
  #outboundRequests = 0;

  readonly #overrides: LogoOverrideStore;

  constructor(init: {
    config: LogoConfig;
    logger: Logger;
    store: LogoStore;
    overrides: LogoOverrideStore;
    ai?: AiService | null;
  }) {
    this.#config = init.config;
    this.#logger = init.logger;
    this.#store = init.store;
    this.#overrides = init.overrides;
    this.#ai = init.ai ?? null;
    this.#budget = new MinuteBudget(init.config.SENDER_LOGO_LOOKUPS_PER_MINUTE);
  }

  get overrides(): LogoOverrideStore {
    return this.#overrides;
  }

  /**
   * Забыть, что мы знали о домене: администратор поменял решение вручную.
   * Иначе слой памяти отдавал бы прежнюю картинку до перезапуска, и
   * загрузка выглядела бы неработающей.
   */
  forgetDomain(domain: string): void {
    this.#store.forget(domain);
  }

  /** Выключатель на весь сервер. Выключено — маршруты честно это говорят. */
  get enabled(): boolean {
    return this.#config.SENDER_LOGOS_ENABLED;
  }

  get store(): LogoStore {
    return this.#store;
  }

  get outboundRequests(): number {
    return this.#outboundRequests;
  }

  /**
   * Приводит список доменов к тому, что вообще имеет смысл искать.
   * Мусор отбрасывается молча: он приходит из чужих заголовков писем.
   */
  static normalizeDomains(raw: readonly unknown[]): string[] {
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      // Тот же разбор, что и у отправителя письма: доменом считается лишь
      // то, что им выглядит. `user@[192.0.2.1]` сюда не пройдёт.
      const domain = domainOfAddress(`x@${item.trim()}`);
      if (domain === null) continue;
      if (domain.length > 253) continue;
      if (!out.includes(domain)) out.push(domain);
      if (out.length >= MAX_DOMAINS_PER_REQUEST) break;
    }
    return out;
  }

  /**
   * Состояние логотипов для набора доменов.
   *
   * @param email ящик спрашивающего — нужен только помощнику ИИ: его
   *              настройки и ключ заданы на домен ящика. Ни в кэш, ни в
   *              журнал адрес не попадает: кэш общий и ключом ему домен.
   */
  async resolve(domains: readonly string[], email: string): Promise<Map<string, LogoStatus>> {
    const result = new Map<string, LogoStatus>();
    if (!this.enabled || domains.length === 0) {
      for (const domain of domains) result.set(domain, { status: 'none' });
      return result;
    }

    /*
     * Ручные решения читаются ПЕРЕД кэшем и сильнее его — см. порядок,
     * расписанный в overrides.ts. Запрещённый домен вдобавок не попадает
     * в поиск вовсе: ходить в сеть за картинкой, которую всё равно не
     * покажем, было бы и бессмысленно, и невежливо по отношению к чужому
     * серверу.
     */
    const manual = await this.#overrides.read(domains);
    const pendingLookup: string[] = [];
    for (const domain of domains) {
      const decision = manual.get(domain);
      if (decision?.blocked) {
        result.set(domain, { status: 'none' });
        continue;
      }
      if (decision?.bytes && decision.mime) {
        result.set(domain, manualStatus(decision));
        continue;
      }
      pendingLookup.push(domain);
    }
    if (pendingLookup.length === 0) return result;
    domains = pendingLookup;

    const cached = await this.#store.read(domains);
    const waiting: Array<Promise<void>> = [];

    for (const domain of domains) {
      const entry = cached.get(domain);

      if (entry && isFresh(entry)) {
        result.set(domain, statusOf(entry));
        continue;
      }

      if (entry) {
        /*
         * Срок вышел. Показываем ПРЕЖНЕЕ и обновляем в фоне: пока новый
         * логотип не приехал, вчерашний лучше буквы, а мигать кружком
         * при каждом истечении срока — худшее из решений.
         */
        result.set(domain, statusOf(entry));
        void this.#lookup(domain, email).catch(() => undefined);
        continue;
      }

      // Ничего не знаем: ставим «ещё ищем» и ждём не дольше общего срока.
      result.set(domain, { status: 'pending' });
      const started = this.#lookup(domain, email);
      waiting.push(
        started
          .then((fresh) => {
            if (fresh) result.set(domain, statusOf(fresh));
          })
          .catch(() => undefined),
      );
    }

    if (waiting.length > 0 && this.#config.SENDER_LOGO_WAIT_MS > 0) {
      await Promise.race([
        Promise.allSettled(waiting),
        new Promise((resolve) => setTimeout(resolve, this.#config.SENDER_LOGO_WAIT_MS)),
      ]);
    }

    return result;
  }

  /**
   * Байты логотипа для отдачи браузеру. null — показывать нечего.
   * Порядок тот же: запрет сильнее ручной картинки, ручная — автоматической.
   */
  async image(domain: string): Promise<CachedLogo | null> {
    const decision = await this.#overrides.get(domain);
    if (decision?.blocked) return null;
    if (decision?.bytes && decision.mime) {
      return {
        domain,
        source: null,
        mime: decision.mime,
        bytes: decision.bytes,
        width: decision.width,
        height: decision.height,
        version: decision.version,
        // Ручная картинка не протухает: её поставил человек, а не сеть.
        expiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
      };
    }
    const found = (await this.#store.read([domain])).get(domain);
    if (!found?.bytes || !found.mime) return null;
    return found;
  }

  /** Состояние одного домена для панели: что действует и откуда взялось. */
  async adminState(domain: string): Promise<{
    domain: string;
    state: 'blocked' | 'manual' | 'auto' | 'none';
    autoSource: string | null;
    hasManual: boolean;
    version: string | null;
  }> {
    const decision = await this.#overrides.get(domain);
    const cached = (await this.#store.read([domain])).get(domain);
    const hasManual = Boolean(decision?.bytes);
    const state = decision?.blocked
      ? 'blocked'
      : hasManual
        ? 'manual'
        : cached?.bytes
          ? 'auto'
          : 'none';
    return {
      domain,
      state,
      autoSource: cached?.source ?? null,
      hasManual,
      version: state === 'manual' ? (decision?.version ?? null) : state === 'auto' ? (cached?.version ?? null) : null,
    };
  }

  /**
   * Поиск одного домена. Повторные вызовы, пока идёт первый, получают
   * ТО ЖЕ САМОЕ обещание — походов наружу от этого больше не становится.
   */
  #lookup(domain: string, email: string): Promise<CachedLogo | null> {
    const running = this.#inflight.get(domain);
    if (running) return running;

    const task = this.#runLookup(domain, email).finally(() => {
      this.#inflight.delete(domain);
    });
    this.#inflight.set(domain, task);
    return task;
  }

  async #runLookup(domain: string, email: string): Promise<CachedLogo | null> {
    /*
     * Ограничитель исходящего потока стоит на ВЕСЬ сервер, а не на
     * пользователя: наружу ходим мы, и защищать надо чужие сайты от нас,
     * а нашу сеть — от лавины при первом открытии большого ящика. Кэш
     * общий, поэтому второму пользователю того же домена это ничего
     * не стоит.
     */
    if (!this.#budget.take()) {
      this.#logger.debug({ domain }, 'Поиск логотипа отложен: исчерпан предел на минуту');
      return null;
    }

    await this.#acquire();
    try {
      const ai: LogoHintProvider | undefined = this.#ai
        ? new AiLogoHints({ ai: this.#ai, email, logger: this.#logger })
        : undefined;

      const startedAt = Date.now();
      const outcome = await findLogo(domain, { config: this.#config, logger: this.#logger, ai });
      this.#outboundRequests += outcome.requests;
      /*
       * Сколько обращений наружу стоил домен — в журнал, уровнем info.
       * Это единственное место продукта, где сервер сам ходит в интернет,
       * и администратор должен видеть цену возможности, не залезая в
       * отладку: «сто доменов по три запроса» — это разговор, а «логотипы
       * включены» — нет.
       */
      this.#logger.info(
        {
          domain,
          outcome: outcome.kind,
          requests: outcome.requests,
          ms: Date.now() - startedAt,
          source: outcome.kind === 'found' ? outcome.logo.source : null,
        },
        'Поиск логотипа домена завершён',
      );

      if (outcome.kind === 'found') {
        const { image, source } = outcome.logo;
        return await this.#store.write(domain, {
          source,
          mime: image.mime,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          ttlHours: this.#store.ttlHoursFor('found'),
        });
      }

      // Отрицательный ответ запоминается точно так же, как положительный:
      // без этого сервер ходил бы за одним и тем же несуществующим
      // логотипом при каждом открытии списка.
      return await this.#store.write(domain, {
        source: null,
        mime: null,
        bytes: null,
        width: null,
        height: null,
        ttlHours: this.#store.ttlHoursFor(outcome.kind),
      });
    } catch (err) {
      this.#logger.warn({ domain, err }, 'Поиск логотипа домена не удался');
      return null;
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#running < this.#config.SENDER_LOGO_CONCURRENCY) {
      this.#running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#queue.push(() => {
        this.#running += 1;
        resolve();
      });
    });
  }

  #release(): void {
    this.#running -= 1;
    const next = this.#queue.shift();
    if (next) next();
  }
}

/** Ручная картинка администратора — она же и есть ответ. */
function manualStatus(decision: LogoOverride): LogoStatus {
  return {
    status: 'ready',
    version: decision.version,
    source: 'manual',
    width: decision.width ?? 0,
    height: decision.height ?? 0,
  };
}

function statusOf(entry: CachedLogo): LogoStatus {
  if (entry.bytes && entry.mime) {
    return {
      status: 'ready',
      version: entry.version,
      source: entry.source ?? 'unknown',
      width: entry.width ?? 0,
      height: entry.height ?? 0,
    };
  }
  return { status: 'none' };
}
