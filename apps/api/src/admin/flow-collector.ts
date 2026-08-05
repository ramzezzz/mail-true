/**
 * Сборщик истории доставки: читает журнал Postfix и складывает разобранные
 * события в базу.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ИМЕННО ТАК, А НЕ ИНАЧЕ
 * ------------------------------------------------------------------
 * Postfix не хранит историю. Доставленное письмо стирается из очереди, и
 * единственный его след — строка в журнале. Другого источника нет: ни базы,
 * ни программного интерфейса у Postfix для этого не предусмотрено. Значит,
 * либо разбирать журнал, либо не показывать обработанные письма вовсе.
 *
 * Разбирать при каждом запросе тоже нельзя: это перечитывание десятков
 * мегабайт ради одной страницы и линейный поиск по файлу вместо отбора по
 * индексу. Поэтому строки разбираются один раз на лету и ложатся в таблицу.
 *
 * ------------------------------------------------------------------
 * ЧТО ЭТО ЗНАЧИТ ДЛЯ ЧЕСТНОСТИ ПОКАЗАННОГО
 * ------------------------------------------------------------------
 * История начинается с момента, когда сборщик впервые запустился, — не
 * раньше. Дата этого момента хранится (mail_flow_cursor.started_at) и
 * показывается в интерфейсе. Обещать «за год», когда данных за час,
 * нельзя: пустая таблица «за год» врёт, а «за последний час» — нет.
 *
 * Хранение ограничено с двух сторон — сроком и числом строк
 * (см. миграцию 0007). Что вытеснено, того больше нет: это тоже сказано
 * в интерфейсе, а не оставлено на догадку.
 */
import { join } from 'node:path';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type { AdminDb } from './db.js';
import { FlowStore } from './flow-store.js';
import { LOG_FILE_NAMES, describeLogFile, readNewLines } from './log-files.js';
import {
  QueueMetaCache,
  isQueueRemoval,
  parseLogLine,
  toFlowEvent,
  toQueueMeta,
  type FlowEvent,
} from './mail-log.js';

export interface FlowCollectorOptions {
  db: AdminDb;
  logger: Logger;
  /** Каталог общего тома с журналами. */
  logDir: string;
  /** Как часто заглядывать в журнал, секунды. 0 — не запускать вовсе. */
  intervalSeconds: number;
  /** Сколько суток хранить историю. */
  retentionDays: number;
  /** Потолок числа строк истории. */
  maxRows: number;
  /** Сколько байт журнала разбирать за один заход. */
  chunkBytes?: number;
}

/** Источник истории у нас один — журнал Postfix. */
const SOURCE = 'postfix';

export class FlowCollector {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly meta = new QueueMetaCache();
  private readonly chunkBytes: number;
  private readonly store: FlowStore;
  private lastPruneAt = 0;

  constructor(private readonly opts: FlowCollectorOptions) {
    this.chunkBytes = opts.chunkBytes ?? 2 * 1024 * 1024;
    this.store = new FlowStore(opts.db);
  }

  get path(): string {
    return join(this.opts.logDir, LOG_FILE_NAMES[SOURCE]);
  }

  start(): void {
    if (this.opts.intervalSeconds <= 0) {
      this.opts.logger.info('Сборщик истории доставки выключен (интервал 0)');
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalSeconds * 1000);
    // Держать процесс живым ради сборщика незачем
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Один заход: дочитать журнал, разобрать, записать.
   *
   * Заходы не накладываются друг на друга: разбор двух мегабайт может занять
   * больше интервала, и параллельные заходы записали бы одни и те же строки
   * дважды.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.collect();
      await this.maybePrune();
    } catch (err) {
      this.opts.logger.warn(errorInfo(err), 'Сборщик истории доставки: заход не удался');
    } finally {
      this.running = false;
    }
  }

  private async collect(): Promise<void> {
    const info = await describeLogFile(this.opts.logDir, SOURCE);
    if (!info.present || info.fileId === null) return;

    const cursor = await this.store.getCursor(SOURCE);

    let offset = cursor?.byteOffset ?? 0;
    if (cursor === null) {
      // Первый запуск на непустом журнале. Разбираем только хвост: перед
      // нами может лежать журнал за неделю, и разбирать его целиком в
      // первом же заходе значит подвесить сервер приложения на старте.
      offset = Math.max(0, info.sizeBytes - this.chunkBytes);
    } else if (cursor.fileId !== info.fileId) {
      // Журнал провернулся: новый файл, старые смещения ничего не значат.
      this.opts.logger.info(
        { from: cursor.fileId, to: info.fileId },
        'Журнал Postfix провернулся — читаем новый файл сначала',
      );
      offset = 0;
    } else if (offset > info.sizeBytes) {
      // Файл стал короче при том же inode — его обрезали на месте.
      offset = 0;
    }

    const { lines, nextOffset } = await readNewLines(this.path, offset, this.chunkBytes);
    if (lines.length === 0) {
      if (nextOffset !== offset || cursor === null || cursor.fileId !== info.fileId) {
        await this.store.setCursor(SOURCE, info.fileId, nextOffset);
      }
      return;
    }

    const now = new Date();
    const events: FlowEvent[] = [];
    for (const line of lines) {
      const entry = parseLogLine(SOURCE, line, now);
      // Строка `from=…, size=…` идёт раньше строк о доставке и несёт
      // отправителя с размером: в самих строках доставки их нет.
      const meta = toQueueMeta(entry);
      if (meta && entry.queueId) {
        this.meta.set(entry.queueId, meta);
        continue;
      }
      const event = toFlowEvent(entry, this.meta.get(entry.queueId));
      if (event) events.push(event);
      // Письмо ушло из очереди — помнить о нём больше нечего.
      if (isQueueRemoval(entry) && entry.queueId) this.meta.delete(entry.queueId);
    }

    if (events.length > 0) {
      await this.store.insertEvents(events);
    }
    await this.store.setCursor(SOURCE, info.fileId, nextOffset);
    this.opts.logger.debug(
      { lines: lines.length, events: events.length, offset: nextOffset },
      'Сборщик истории доставки: порция разобрана',
    );
  }

  /** Уборка истории — раз в десять минут, а не на каждом заходе. */
  private async maybePrune(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneAt < 10 * 60 * 1000) return;
    this.lastPruneAt = now;
    const removed = await this.store.prune(this.opts.retentionDays, this.opts.maxRows);
    if (removed > 0) {
      this.opts.logger.info({ removed }, 'История доставки: вытеснены старые записи');
    }
  }
}
