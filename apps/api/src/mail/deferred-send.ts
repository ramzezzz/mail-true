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
  /**
   * Загрузки, которые держит это письмо (только у «отмены отправки»).
   *
   * Обычная отложенная отправка удаляет вложения из временного хранилища
   * сразу: письмо уже собрано в `.eml`, загрузки больше не нужны никому.
   * У отмены иначе — если человек нажмёт «Отменить», письмо вернётся
   * в окно написания с ТЕМИ ЖЕ идентификаторами вложений, и удалённые
   * файлы превратили бы возвращённое письмо в письмо без вложений.
   * Поэтому здесь они переживают очередь и убираются, только когда письмо
   * действительно ушло (или окончательно не ушло).
   */
  attachmentIds?: string[];
}

/**
 * Извещение о письме, которое отправить НЕ УДАЛОСЬ и уже не удастся.
 *
 * Появилось вместе с отменой отправки, и появилось не по прихоти. Пока
 * письмо уходило прямо в запросе, отказ почтового сервера человек видел
 * сразу — красным по месту, не отходя от письма. Как только между
 * нажатием «Отправить» и настоящей отправкой встали секунды очереди,
 * отказывать стало НЕКОМУ: человек уже закрыл вкладку и ушёл. Письмо при
 * этом ложится в черновики (см. onGiveUp), но черновик, о котором не
 * сказали, — это молчаливая потеря: человек узнаёт о ней от адресата
 * вопросом «почему вы не ответили».
 *
 * Поэтому извещение — не событие, а ЗАПИСЬ: она лежит рядом с очередью,
 * на том же постоянном томе, переживает и закрытую вкладку, и перезапуск
 * сервера, и дожидается человека. Событие по сокету (для открытой вкладки)
 * поверх неё — приятная мелочь, а не механизм.
 */
export interface SendFailureNotice {
  id: string;
  /** Чей ящик. Чужие извещения не показываются и не удаляются. */
  owner: string;
  /** Тема — по ней человек узнаёт, о каком письме речь. */
  subject: string;
  /** Кому письмо должно было уйти. */
  envelopeTo: string[];
  /** Что именно ответил почтовый сервер, по-русски. */
  reason: string;
  /** Адреса, которые сервер назвал поимённо (если назвал). */
  rejected: Array<{ address: string; message: string }>;
  /** Сколько раз пробовали и когда пробовали в последний раз. */
  attempts: number;
  lastAttemptAt: string;
  /** UID черновика, в который письмо сохранено; null — не сохранилось. */
  draftUid: number | null;
  createdAt: string;
}

/** Причина неудачи, какой её видит человек, открывший черновик. */
export interface SendFailureReason {
  reason: string;
  rejected: Array<{ address: string; message: string }>;
  attempts: number;
  lastAttemptAt: string;
  envelopeTo: string[];
}

/**
 * Заголовок, которым помечается черновик, вернувшийся из очереди.
 *
 * Именно ЗАГОЛОВОК, а не приписка в теле письма. Тело — это то, что уйдёт
 * получателю: объяснение «почему не отправилось», вставленное в текст,
 * рано или поздно уедет адресату вместе с письмом, когда человек нажмёт
 * «Отправить» второй раз и не заметит чужой абзац. Заголовок же читает
 * только наш интерфейс — и показывает его отдельной полосой в окне
 * написания, откуда он никуда не денется.
 *
 * Значение — JSON в base64: причина приходит от почтового сервера, в ней
 * бывает что угодно, включая переводы строк и кириллицу, а заголовок
 * обязан остаться одной строкой ASCII (RFC 5322 §2.2).
 */
export const SEND_FAILURE_HEADER = 'X-Mail-True-Send-Failure';

/**
 * Приписывает заголовок к готовому письму.
 *
 * Заголовок ставится ПЕРВЫМ, до всех остальных: так не нужно ни искать
 * конец блока заголовков, ни разбирать письмо целиком — а значит нечему
 * и испортить байты, которые человек потом отправит.
 */
export function withFailureHeader(raw: Buffer, reason: SendFailureReason): Buffer {
  const value = Buffer.from(JSON.stringify(reason), 'utf8').toString('base64');
  return Buffer.concat([Buffer.from(`${SEND_FAILURE_HEADER}: ${value}\r\n`, 'ascii'), raw]);
}

/** Читает причину обратно. null — обычный черновик, его никто не отвергал. */
export function readFailureHeader(value: string | undefined | null): SendFailureReason | null {
  if (!value) return null;
  try {
    // Заголовок мог быть сложен на несколько строк — пробелы убираем
    const parsed = JSON.parse(
      Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8'),
    ) as SendFailureReason;
    return typeof parsed.reason === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Достаёт причину прямо из исходника письма.
 *
 * Своим разбором, а не общим `parseMessageHeaders`: тот оставляет только
 * заголовки из белого списка и обрезает длинные — то есть наше значение
 * либо выбросил бы целиком, либо испортил обрезкой ровно посередине
 * base64. А здесь достаточно пройти по блоку заголовков до первой пустой
 * строки: это первые несколько сотен байт, письмо целиком разбирать
 * незачем.
 */
export function readFailureFromRaw(raw: Buffer): SendFailureReason | null {
  // Блок заголовков кончается пустой строкой; 64 КБ с запасом хватает
  // на любой разумный набор, а читать всё письмо ради одной строки не нужно
  const head = raw.subarray(0, Math.min(raw.length, 64 * 1024)).toString('binary');
  const end = head.search(/\r?\n\r?\n/);
  const block = end < 0 ? head : head.slice(0, end);
  const lines = block.split(/\r?\n/);
  const needle = `${SEND_FAILURE_HEADER.toLowerCase()}:`;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.toLowerCase().startsWith(needle)) continue;
    let value = line.slice(needle.length);
    // Продолжения сложенной строки начинаются с пробела или табуляции
    for (let j = i + 1; j < lines.length && /^[ \t]/.test(lines[j] ?? ''); j += 1) {
      value += lines[j];
    }
    return readFailureHeader(value);
  }
  return null;
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

  /* --- Извещения о неудавшейся отправке ---------------------------
   *
   * Лежат в том же каталоге, но с другим расширением (`.fail`, а не
   * `.json`): обход очереди смотрит только на `.json`, поэтому извещение
   * никогда не будет принято за письмо, которому пора уходить. Разделять
   * их по разным каталогам незачем — постоянный том один и тот же, и
   * терять их надо тоже вместе. */

  private failPath(id: string): string {
    return join(this.dir, `${id}.fail`);
  }

  /** Записывает извещение. Возвращает его с присвоенным id. */
  async addFailure(
    notice: Omit<SendFailureNotice, 'id' | 'createdAt'>,
  ): Promise<SendFailureNotice> {
    await this.init();
    const full: SendFailureNotice = {
      ...notice,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    // Через временное имя и переименование — по той же причине, что
    // и конверт письма: половина файла хуже, чем его отсутствие.
    const tmp = `${this.failPath(full.id)}.tmp`;
    await writeFile(tmp, JSON.stringify(full), 'utf8');
    await rename(tmp, this.failPath(full.id));
    return full;
  }

  /** Извещения одного ящика, старые первыми. */
  async failures(owner: string): Promise<SendFailureNotice[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const found: SendFailureNotice[] = [];
    for (const name of names) {
      if (!name.endsWith('.fail')) continue;
      try {
        const notice = JSON.parse(
          await readFile(join(this.dir, name), 'utf8'),
        ) as SendFailureNotice;
        // Чужие извещения не отдаём никогда: в них тема и адреса
        if (notice.owner === owner) found.push(notice);
      } catch {
        /* испорченное извещение молча пропускаем */
      }
    }
    return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Убирает извещение — человек его прочитал.
   *
   * Владелец проверяется здесь, а не в маршруте: «прочитал» чужое
   * извещение не должен уметь никто, даже по случайно угаданному id.
   * Возвращает false, если убирать было нечего.
   */
  async removeFailure(owner: string, id: string): Promise<boolean> {
    if (!ID_RE.test(id)) return false;
    try {
      const notice = JSON.parse(
        await readFile(this.failPath(id), 'utf8'),
      ) as SendFailureNotice;
      if (notice.owner !== owner) return false;
    } catch {
      return false;
    }
    await unlink(this.failPath(id)).catch(() => undefined);
    return true;
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
  /** Одноразовый будильник к ближайшему сроку — см. wakeAt. */
  #wake: NodeJS.Timeout | null = null;
  #wakeAt = 0;
  /** Один проход за раз: иначе медленный SMTP отправил бы письмо дважды. */
  #running = false;
  /**
   * Письма, взятые в работу прямо сейчас.
   *
   * Это замок, и нужен он из-за «отмены отправки»: человек жмёт «Отменить»
   * ровно в ту секунду, когда работник уже отдаёт письмо SMTP. Без замка
   * отмена успевала бы стереть запись очереди уже ПОСЛЕ того, как письмо
   * ушло, — и мы отвечали бы «отменено» о письме, которое у получателя.
   * Проверка и захват здесь синхронные (одна операция над Set, без await),
   * поэтому в одном процессе Node это настоящий взаимный исключатель:
   * между `has` и `add` вклиниться нечему.
   *
   * Замок живёт в памяти, а не в файле: перезапуск процесса обязан снимать
   * его сам собой, иначе оборванная посреди отправки запись осталась бы
   * «занятой» навсегда и письмо не ушло бы никогда.
   */
  readonly #busy = new Set<string>();

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
    if (this.#wake) clearTimeout(this.#wake);
    this.#wake = null;
    this.#wakeAt = 0;
  }

  /**
   * Разбудить работника к назначенному сроку.
   *
   * Постоянный таймер очереди ходит раз в полминуты — этого хватает письму,
   * которое ждёт до утра, но не письму, которое ждёт пять секунд отмены:
   * обещание «уйдёт через 5 секунд» превратилось бы в «уйдёт когда-нибудь
   * в ближайшие полминуты». Поэтому на близкий срок ставится отдельный
   * одноразовый будильник. Более поздний срок уже назначенного будильника
   * игнорируется: тот проснётся раньше и всё равно заберёт всё, чему пора.
   *
   * Четверть секунды запаса — на неточность таймеров: проснуться на
   * миллисекунду раньше срока значит не увидеть письмо в `due()` и уснуть
   * до следующего получаса.
   */
  wakeAt(at: Date): void {
    const when = Math.max(Date.now(), at.getTime()) + 250;
    if (this.#wake && this.#wakeAt <= when) return;
    if (this.#wake) clearTimeout(this.#wake);
    this.#wakeAt = when;
    this.#wake = setTimeout(() => {
      this.#wake = null;
      this.#wakeAt = 0;
      void this.tick();
    }, when - Date.now());
    this.#wake.unref();
  }

  /**
   * Взять письмо в исключительную работу. `false` — оно уже у кого-то.
   * Захват синхронный: см. пояснение к #busy.
   */
  claim(id: string): boolean {
    if (this.#busy.has(id)) return false;
    this.#busy.add(id);
    return true;
  }

  /** Отпустить письмо. Вызывать обязательно, иначе оно застрянет навсегда. */
  release(id: string): void {
    this.#busy.delete(id);
  }

  /** Один проход. Возвращает, сколько писем ушло. */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    let sent = 0;
    try {
      const { spool, deliver, onGiveUp, maxAttempts, log } = this.#options;
      for (const entry of await spool.due(now)) {
        // Письмо отменяют прямо сейчас — трогать его нельзя
        if (!this.claim(entry.id)) continue;
        try {
          // Список `due` собран раньше: пока мы возились с предыдущим
          // письмом, это могли отменить. Молча пропускаем — отменённого
          // письма просто нет.
          if (!(await spool.get(entry.id))) continue;

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
        } finally {
          this.release(entry.id);
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

/* --- Отмена отправки ------------------------------------------------
 *
 * Это ТА ЖЕ очередь, только срок другой: не «завтра в девять», а «через
 * пять секунд». Второй очереди для этого нет намеренно — две очереди писем
 * в одном продукте расходятся в поведении при первом же дефекте, и чинить
 * пришлось бы обе, а вспоминать о второй — не всегда.
 *
 * Из этого же следует главное свойство нашей отмены: письмо ждёт на
 * СЕРВЕРЕ, а не в браузере. Закрытая вкладка отменяет отмену, а не отправку.
 */

/** Что можно выбрать в настройках. Ноль — отмена выключена. */
export const UNDO_SEND_CHOICES = [0, 5, 10, 30] as const;

/**
 * Сколько секунд на отмену у ящика, который ничего не выбирал.
 *
 * Пять, а не ноль: возможность, которую надо сперва найти в настройках,
 * не спасёт никого — а спасает она от ошибки, которую иначе не исправить
 * ничем, кроме второго письма с извинениями. Пять, а не десять и не
 * тридцать: задержка настоящая, письмо эти секунды НЕ У ПОЛУЧАТЕЛЯ, и
 * платить за отмену больше, чем она стоит, незачем. «Забыл вложение» и
 * «не тот адресат» замечают в первую секунду после нажатия, а не на
 * двадцатой.
 */
export const DEFAULT_UNDO_SEND_SECONDS = 5;

/**
 * Приводит значение к одному из разрешённых.
 *
 * Всё непонятное — в «выключено», а не в умолчание: задерживать письмо
 * из-за мусора в настройке нельзя, это поведение человек не выбирал.
 */
export function normalizeUndoSeconds(value: unknown): number {
  const found = UNDO_SEND_CHOICES.find((c) => c === value);
  return found ?? 0;
}

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
