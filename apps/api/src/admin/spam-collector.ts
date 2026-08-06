/**
 * Съёмка счётчиков антиспама по расписанию.
 *
 * Зачем — подробно в миграции 0022_rspamd_stats.sql: счётчики rspamd
 * накопительные и обнуляются при перезапуске процесса, а вопрос
 * «сколько спама было за неделю» существует только у того, кто эту неделю
 * записывал.
 *
 * Отдельный сборщик, а не строка в MetricsCollector: тот снимает состояние
 * машины (процессор, диск, очередь) и обязан работать, даже когда антиспам
 * лежит. Смешав их, мы получили бы снимок показателей сервера, который не
 * пишется из-за недоступного rspamd, — то есть потерю истории нагрузки
 * ровно в тот момент, когда что-то сломалось.
 *
 * Обращение к rspamd дешёвое: один GET /stat, ответ — несколько килобайт.
 */
import type { Logger } from 'pino';
import type { AdminDb } from './db.js';
import { RepeatGuard, noteRecovered, warnOnce } from './repeat-log.js';
import type { RspamdClient } from './rspamd.js';
import { sampleFromStat, SpamStore } from './spam-store.js';

export interface SpamCollectorOptions {
  db: AdminDb;
  logger: Logger;
  rspamd: RspamdClient;
  /** Как часто снимать, секунды. 0 — не снимать вовсе. */
  intervalSeconds: number;
  retentionDays: number;
  maxRows: number;
}

export class SpamCollector {
  readonly #store: SpamStore;
  readonly #logger: Logger;
  readonly #rspamd: RspamdClient;
  readonly #intervalSeconds: number;
  readonly #retentionDays: number;
  readonly #maxRows: number;
  readonly #guard = new RepeatGuard();
  #timer: NodeJS.Timeout | null = null;
  /** Уборка не нужна на каждом проходе — раз в сотню снимков достаточно. */
  #sinceCleanup = 0;

  constructor(options: SpamCollectorOptions) {
    this.#store = new SpamStore(options.db);
    this.#logger = options.logger;
    this.#rspamd = options.rspamd;
    this.#intervalSeconds = options.intervalSeconds;
    this.#retentionDays = options.retentionDays;
    this.#maxRows = options.maxRows;
  }

  start(): void {
    if (this.#timer || this.#intervalSeconds <= 0) return;
    void this.runOnce();
    this.#timer = setInterval(() => {
      void this.runOnce();
    }, this.#intervalSeconds * 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Один снимок.
   *
   * Недоступный rspamd — это НОРМАЛЬНОЕ состояние почтового сервера (его
   * перезапускают, обновляют, он падает), а не сбой сборщика. Поэтому
   * ошибка не роняет расписание и не пишется в журнал на каждом проходе:
   * иначе лежащий сутки антиспам оставил бы полторы тысячи одинаковых
   * строк, в которых потонет всё остальное.
   */
  async runOnce(): Promise<void> {
    try {
      const stat = await this.#rspamd.stat();
      await this.#store.insertSample(sampleFromStat(stat));
      noteRecovered(this.#guard, this.#logger, 'Счётчики антиспама снова снимаются');
      this.#sinceCleanup += 1;
      if (this.#sinceCleanup >= 100) {
        this.#sinceCleanup = 0;
        await this.#store.prune(this.#retentionDays, this.#maxRows).catch(() => 0);
      }
    } catch (err) {
      warnOnce(
        this.#guard,
        this.#logger,
        err,
        'Не удалось снять счётчики антиспама: раздел «Спам» покажет состояние прямо сейчас, ' +
          'но без сравнения с прошлыми часами',
      );
    }
  }
}
