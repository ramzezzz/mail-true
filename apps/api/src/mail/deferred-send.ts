/**
 * Отложенная отправка: очередь писем на диске и работник, который их шлёт.
 *
 * Требование к возможности одно и оно жёсткое: письмо должно уйти, даже если
 * браузер закрыт, а человек вышел из почты. Значит, ждать нельзя ни в
 * браузере (там таймер живёт до первого закрытия вкладки), ни в памяти
 * процесса (перезапуск сервера — и письмо пропало молча). Поэтому очередь
 * лежит файлами на том же постоянном томе, что и загруженные вложения,
 * и переживает перезапуск.
 *
 * Что лежит в очереди:
 *   <id>.eml   — письмо целиком, уже собранное (вложения внутри);
 *   <id>.json  — конверт: кому отправлять, когда и от чьего имени.
 *
 * Порядок записи важен: сперва `.eml`, потом `.json`. Наличие `.json` и
 * значит «запись целая» — иначе выключение питания посреди записи оставило бы
 * в очереди письмо без тела, и работник вечно пытался бы его отправить.
 *
 * Пароль ящика лежит в `.json` зашифрованным (SecretBox, тот же, что у
 * сессий): без него сервер не сможет ни отправить письмо через submission,
 * ни положить копию в «Отправленные», а спросить его в три часа ночи не
 * у кого. Это ровно та же защита, под которой пароль и так лежит в сессии
 * (см. session.ts, поле passwordEnc), — новых поблажек здесь нет.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Конверт отложенного письма. Тело лежит рядом, в файле `<id>.eml`. */
export interface DeferredEntry {
  id: string;
  /** Ящик, от имени которого письмо уйдёт. */
  owner: string;
  /** Пароль ящика, зашифрованный SecretBox. */
  passwordEnc: string;
  /** Когда отправлять (ISO). */
  sendAt: string;
  /** Все получатели конверта — to + cc + bcc. */
  envelopeTo: string[];
  /** Тема — только для журнала и сообщений об ошибке. */
  subject: string;
  /** Сколько раз уже пробовали отправить. */
  attempts: number;
  createdAt: string;
}

/** Идентификаторы задаём сами (randomUUID) — сюда не должен пролезть путь. */
const ID_RE = /^[0-9a-f-]{36}$/i;

export class DeferredSpool {
  #ready = false;

  constructor(private readonly dir: string) {}

  /** Каталог заводится при первой же записи, а не при старте сервера. */
  async init(): Promise<void> {
    if (this.#ready) return;
    await mkdir(this.dir, { recursive: true });
    this.#ready = true;
  }

  private rawPath(id: string): string {
    return join(this.dir, `${id}.eml`);
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /**
   * Кладёт письмо в очередь. Возвращает конверт с присвоенным id.
   */
  async add(
    entry: Omit<DeferredEntry, 'id' | 'attempts' | 'createdAt'>,
    raw: Buffer,
  ): Promise<DeferredEntry> {
    await this.init();
    const full: DeferredEntry = {
      ...entry,
      id: randomUUID(),
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    await writeFile(this.rawPath(full.id), raw);
    // Конверт пишется через временное имя и переименование: `.json` на месте
    // означает, что запись целая, и работник имеет право её взять.
    const tmp = `${this.metaPath(full.id)}.tmp`;
    await writeFile(tmp, JSON.stringify(full), 'utf8');
    await rename(tmp, this.metaPath(full.id));
    return full;
  }

  /** Конверт по id (null, если записи нет или она испорчена). */
  async get(id: string): Promise<DeferredEntry | null> {
    if (!ID_RE.test(id)) return null;
    try {
      return JSON.parse(await readFile(this.metaPath(id), 'utf8')) as DeferredEntry;
    } catch {
      return null;
    }
  }

  /** Тело письма по id. */
  async raw(id: string): Promise<Buffer | null> {
    if (!ID_RE.test(id)) return null;
    try {
      return await readFile(this.rawPath(id));
    } catch {
      return null;
    }
  }

  /** Все конверты очереди, старые первыми. */
  async all(): Promise<DeferredEntry[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const found: DeferredEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const entry = await this.get(name.slice(0, -5));
      if (entry) found.push(entry);
    }
    return found.sort((a, b) => a.sendAt.localeCompare(b.sendAt));
  }

  /** Письма, которым пора уходить. */
  async due(now: Date): Promise<DeferredEntry[]> {
    const stamp = now.getTime();
    return (await this.all()).filter((e) => Date.parse(e.sendAt) <= stamp);
  }

  /** Отмечает неудачную попытку и возвращает их общее число. */
  async bumpAttempt(id: string): Promise<number> {
    const entry = await this.get(id);
    if (!entry) return 0;
    const next = { ...entry, attempts: entry.attempts + 1 };
    await writeFile(this.metaPath(id), JSON.stringify(next), 'utf8');
    return next.attempts;
  }

  async remove(id: string): Promise<void> {
    if (!ID_RE.test(id)) return;
    await unlink(this.rawPath(id)).catch(() => undefined);
    await unlink(this.metaPath(id)).catch(() => undefined);
  }
}

/** Чем кончилась попытка отправки. */
export type DeliveryOutcome = 'sent' | 'retry' | 'failed';

export interface DeferredSenderOptions {
  spool: DeferredSpool;
  /**
   * Отправка одного письма. `retry` — временная беда (сервер недоступен),
   * `failed` — отказ навсегда (адрес не существует, письмо отвергнуто).
   */
  deliver(entry: DeferredEntry, raw: Buffer): Promise<DeliveryOutcome>;
  /**
   * Письмо отправить не удалось и больше не будет. Здесь его сохраняют
   * человеку в черновики: молча выбросить написанное нельзя.
   */
  onGiveUp(entry: DeferredEntry, raw: Buffer): Promise<void>;
  /** Сколько раз пробовать, прежде чем сдаться. */
  maxAttempts?: number;
  log?: {
    info(obj: unknown, msg: string): void;
    warn(obj: unknown, msg: string): void;
  };
}

/**
 * Работник очереди. Просыпается по таймеру, забирает всё, чему пора,
 * и отправляет.
 */
export class DeferredSender {
  readonly #options: Required<Pick<DeferredSenderOptions, 'maxAttempts'>> &
    DeferredSenderOptions;
  #timer: NodeJS.Timeout | null = null;
  /** Один проход за раз: иначе медленный SMTP отправил бы письмо дважды. */
  #running = false;

  constructor(options: DeferredSenderOptions) {
    this.#options = { maxAttempts: 5, ...options };
  }

  start(intervalMs: number): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    // Таймер очереди не должен сам по себе удерживать процесс живым
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Один проход. Возвращает, сколько писем ушло. */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    let sent = 0;
    try {
      const { spool, deliver, onGiveUp, maxAttempts, log } = this.#options;
      for (const entry of await spool.due(now)) {
        const raw = await spool.raw(entry.id);
        if (!raw) {
          // Тела нет — отправлять нечего, а конверт будет мозолить глаза вечно
          log?.warn({ id: entry.id }, 'Отложенное письмо без тела — убрано из очереди');
          await spool.remove(entry.id);
          continue;
        }

        let outcome: DeliveryOutcome;
        try {
          outcome = await deliver(entry, raw);
        } catch {
          outcome = 'retry';
        }

        if (outcome === 'sent') {
          await spool.remove(entry.id);
          sent += 1;
          log?.info({ id: entry.id, owner: entry.owner }, 'Отложенное письмо отправлено');
          continue;
        }

        const attempts = await spool.bumpAttempt(entry.id);
        if (outcome === 'failed' || attempts >= maxAttempts) {
          // Дальше пробовать бессмысленно. Написанное не выбрасываем:
          // оно уезжает в черновики, где его видно и можно отправить руками.
          await onGiveUp(entry, raw).catch(() => undefined);
          await spool.remove(entry.id);
          log?.warn(
            { id: entry.id, owner: entry.owner, attempts },
            'Отложенное письмо отправить не удалось — сохранено в черновиках',
          );
        }
      }
    } finally {
      this.#running = false;
    }
    return sent;
  }
}

/**
 * Годится ли дата для отложенной отправки.
 *
 * Прошедшее время и «через минуту» отдельной очереди не требуют — такое
 * письмо просто отправляется сразу. Дальний край нужен, чтобы очередь не
 * превращалась в архив: письмо, лежащее год, переживёт и смену пароля
 * ящика, и сам ящик.
 */
export const DEFERRED_MIN_DELAY_MS = 60_000;
/**
 * Дальний край — тридцать суток, а не год.
 *
 * Дело не в объёме очереди, а в ПАРОЛЕ: он лежит в конверте зашифрованным
 * ровно до отправки, и чем дальше край, тем дольше он лежит. Год хранения
 * ради письма, которое почти наверняка не уйдёт (за год пароль ящика сменят,
 * а то и сам ящик закроют), — плата ни за что.
 *
 * Тридцать суток покрывают то, ради чего отложенную отправку и включают:
 * «утром в понедельник», «после отпуска», «к началу месяца».
 */
export const DEFERRED_MAX_DELAY_MS = 30 * 24 * 3600 * 1000;

export type DeferredCheck =
  | { kind: 'now' }
  | { kind: 'later'; at: Date }
  | { kind: 'invalid'; reason: string };

export function checkSendAt(sendAt: string | undefined, now: Date): DeferredCheck {
  if (!sendAt) return { kind: 'now' };
  const at = new Date(sendAt);
  const delay = at.getTime() - now.getTime();
  if (Number.isNaN(at.getTime())) {
    return { kind: 'invalid', reason: 'Не удалось разобрать время отложенной отправки' };
  }
  if (delay > DEFERRED_MAX_DELAY_MS) {
    return { kind: 'invalid', reason: 'Отложить отправку можно не больше чем на 30 суток' };
  }
  // Меньше минуты — считаем, что человек имел в виду «сейчас»
  return delay < DEFERRED_MIN_DELAY_MS ? { kind: 'now' } : { kind: 'later', at };
}
