/**
 * Работник выгрузки ящика: обходит папки по IMAP и складывает письма
 * в ZIP-архив на диске.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТО ФОНОВОЕ ЗАДАНИЕ, А НЕ ОТВЕТ НА ЗАПРОС
 * ------------------------------------------------------------------
 * Потому что ящик бывает на гигабайты. «Нажал и жди ответа» на таком
 * объёме — это оборванное соединение, пустой файл и ноль объяснений:
 * обратный прокси закрывает запрос по своему сроку, браузер по своему,
 * ноутбук закрывает крышку. Поэтому запрос только СТАВИТ задание, а
 * человек видит ход работы и скачивает готовый файл отдельно — ровно
 * так же устроен перенос почты с чужого сервера (admin/migrate-runner.ts).
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ СЛУЖЕБНЫЙ ВХОД, А НЕ ПАРОЛЬ ЧЕЛОВЕКА
 * ------------------------------------------------------------------
 * Задание переживает выход из почты: человек заказал выгрузку и закрыл
 * вкладку. Пароля в этот момент у нас уже нет и хранить его ради выгрузки
 * мы не будем. Вход идёт служебным пользователем Dovecot (`ящик*mtadmin`)
 * — тем же, которым в ящики входит панель, сборщик чужой почты и возврат
 * отложенных писем. Не настроен служебный вход — раздела нет вовсе, и
 * причина сказана прямо: кнопка появляется вместе с поведением.
 *
 * ------------------------------------------------------------------
 * ЧТО ОГРАНИЧИВАЕТ РАБОТУ, ЧТОБЫ ОНА НЕ ПОЛОЖИЛА СЕРВЕР
 * ------------------------------------------------------------------
 *   1. Одно живое задание на ящик — частичный уникальный индекс в базе
 *      (см. миграцию 0024). Двойное нажатие не заводит второй обход.
 *   2. Одно задание на весь сервер одновременно (MAILBOX_EXPORT_CONCURRENCY).
 *      Остальные стоят в очереди и видят своё место в ней.
 *   3. Потолок размера архива (MAILBOX_EXPORT_MAX_BYTES): дойдя до него,
 *      задание останавливается, СОХРАНЯЕТ собранное и говорит, чего в
 *      архиве нет, — а не заполняет диск и не выбрасывает часы работы.
 *   4. Срок жизни готового файла (MAILBOX_EXPORT_TTL_HOURS): уборщик
 *      удаляет и файл, и его место в списке.
 *   5. Письма читаются по одному потоком (`fetch`), а не пачкой: в памяти
 *      одновременно живёт ровно одно письмо.
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import type { Folder } from '@mail-true/shared';
import type { AppConfig } from '../config.js';
import { listFolders } from '../imap/service.js';
import { errorInfo } from '../log.js';
import { masterLogin } from '../mail/snooze-service.js';
import type { SettingsConfig } from './config.js';
import type { ExportRow, OwnerStore } from './owner-db.js';
import { ZipWriter, safeEntryName, safeEntryPath } from './zip.js';

/** Через сколько писем сообщать в базу о ходе работы. */
const PROGRESS_EVERY = 25;
/** И не реже чем раз в столько миллисекунд — чтобы полоска не замирала. */
const PROGRESS_EVERY_MS = 3_000;
/**
 * Через сколько минут без отметки живости чужое задание считается
 * брошенным. Нужно из-за перезапуска контейнера посреди работы: без срока
 * давности такое задание висело бы в 'running' навсегда.
 */
const STALE_MINUTES = 10;

/** Сколько просроченных файлов удалять за один проход уборщика. */
const EXPIRE_BATCH = 20;

export interface ExportRunnerOptions {
  config: AppConfig;
  settings: SettingsConfig;
  logger: Logger;
  store: OwnerStore;
  master: { user: string; password: string; separator: string } | null;
  /**
   * Чем открывать ящик. По умолчанию — служебный вход в Dovecot.
   * Подменяется в проверках: убедиться, что задание переживает отказ
   * почтового сервера, иначе можно было бы только выключив настоящий
   * Dovecot, то есть на деле никак.
   */
  connect?: ((email: string) => Promise<ImapFlow>) | undefined;
}

export class ExportRunner {
  readonly #opts: ExportRunnerOptions;
  #timer: NodeJS.Timeout | null = null;
  #active = 0;
  #ticking = false;

  constructor(opts: ExportRunnerOptions) {
    this.#opts = opts;
  }

  start(intervalMs = this.#opts.settings.MAILBOX_EXPORT_TICK_MS): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    // Таймер не удерживает процесс живым — как у всех остальных работников.
    this.#timer.unref?.();
    this.#opts.logger.info({ everyMs: intervalMs }, 'Выгрузка ящиков: работник запущен');
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Один проход: убрать просроченные файлы и взять следующее задание.
   *
   * Наружу не бросает ничего: это фоновая задача, и её отказ обязан
   * оказаться в журнале и в last_error записи, а не уронить процесс.
   */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#expireOld(now);
      if (this.#active >= this.#opts.settings.MAILBOX_EXPORT_CONCURRENCY) return;
      const stale = new Date(now.getTime() - STALE_MINUTES * 60_000);
      const job = await this.#opts.store.claimExport(now, stale);
      if (!job) return;
      this.#active += 1;
      void this.#run(job).finally(() => {
        this.#active -= 1;
      });
    } catch (err) {
      this.#opts.logger.warn(errorInfo(err), 'Выгрузка ящика: проход не удался');
    } finally {
      this.#ticking = false;
    }
  }

  /** Уборка: срок готового файла вышел — удаляем и файл, и право скачать. */
  async #expireOld(now: Date): Promise<void> {
    const rows = await this.#opts.store.listExpiredExports(now, EXPIRE_BATCH);
    for (const row of rows) {
      if (row.filePath) await rm(row.filePath, { force: true }).catch(() => undefined);
      await this.#opts.store.finishExport(row.id, { state: 'expired', filePath: null });
      this.#opts.logger.info(
        { job: row.id, account: row.accountEmail },
        'Выгрузка ящика: срок хранения архива вышел, файл удалён',
      );
    }
  }

  async #connect(email: string): Promise<ImapFlow> {
    if (this.#opts.connect) return this.#opts.connect(email);
    const master = this.#opts.master;
    if (!master) throw new Error('Служебный пользователь Dovecot не настроен');
    const config = this.#opts.config;
    const client = new ImapFlow({
      host: config.IMAP_HOST,
      port: config.IMAP_PORT,
      secure: config.IMAP_SECURE,
      auth: { user: masterLogin(email, master.user, master.separator), pass: master.password },
      tls: { rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED },
      logger: false,
      disableAutoIdle: true,
      clientInfo: { name: 'Mail.True Export', version: '0.1.0' },
    });
    // Без обработчика событие error валит процесс целиком.
    client.on('error', () => undefined);
    await client.connect();
    return client;
  }

  async #run(job: ExportRow): Promise<void> {
    const { logger, settings, store } = this.#opts;
    const dir = settings.MAILBOX_EXPORT_DIR;
    /*
     * Недописанный архив прошлой попытки — удалить.
     *
     * Задание подхватывается заново, если процесс перезапустился посреди
     * работы (протухший heartbeat). Имя нового файла содержит текущее
     * время, то есть прежний файл под старым именем не перезаписывается —
     * а удалять его было некому: уборщик по сроку смотрит только на
     * готовые записи. В томе оставался кусок архива с НАСТОЯЩИМИ письмами
     * человека, и знать о нём никто не мог.
     */
    if (job.filePath) {
      await rm(job.filePath, { force: true }).catch(() => undefined);
    }
    const file = join(dir, `${job.id}-${Date.now()}.zip`);
    let zip: ZipWriter | null = null;
    let client: ImapFlow | null = null;

    try {
      await mkdir(dir, { recursive: true });
      /*
       * Имя будущего архива записывается в задание ДО первого байта.
       *
       * Иначе ветка выше не срабатывала никогда: путь появлялся в записи
       * только в finishExport, то есть у ГОТОВОГО архива, а у задания в
       * работе он всегда был NULL. Перезапуск посреди выгрузки оставлял
       * на диске частичную копию переписки — навсегда и невидимо ни для
       * кого: уборщик по сроку смотрит только на готовые записи.
       */
      await store.updateExportProgress(job.id, { filePath: file });
      client = await this.#connect(job.accountEmail);
      zip = new ZipWriter(file);

      const folders = pickFolders(await listFolders(client), job);
      const total = folders.reduce((sum, f) => sum + f.totalCount, 0);
      await store.updateExportProgress(job.id, { totalMessages: total });

      let done = 0;
      let bytes = 0;
      let skipped = 0;
      let lastReport = Date.now();
      /** Что стало с каждой папкой — это и есть правда об архиве. */
      const outcomes: FolderOutcome[] = [];
      /** Архив упёрся в потолок: дальше не идём, но собранное сохраняем. */
      let truncated = false;

      for (const folder of folders) {
        if (truncated) {
          outcomes.push({ path: folder.path, saved: 0, lost: 0, state: 'not-reached' });
          continue;
        }
        /*
         * Пустую папку открывать незачем — но «пусто» и «счётчик не
         * прочитался» это РАЗНЫЕ вещи, и раньше здесь стояло просто
         * `if (folder.totalCount === 0) continue`.
         *
         * Счётчик берётся из STATUS, а STATUS может не пройти (папку
         * переименовали, повреждён индекс, отказано в доступе) — тогда в
         * счётчике ноль просто потому, что взять его негде (см. пометку
         * countUnknown в mail/folders.ts). Такая папка молча выпадала из
         * архива целиком: полоска доходила до 100%, задание становилось
         * ready, `skipped` не рос, а в ЧИТАТЬ.txt было написано «писем:
         * 0». Человек забирал «всю свою почту» — и папки в ней не было.
         * Теперь непрочитанный счётчик означает «открыть и посмотреть».
         */
        if (folder.totalCount === 0 && folder.countUnknown !== true) {
          outcomes.push({ path: folder.path, saved: 0, lost: 0, state: 'empty' });
          continue;
        }

        let saved = 0;
        let lost = 0;
        /*
         * Своя обёртка на КАЖДУЮ папку.
         *
         * Список папок снят один раз, в начале обхода, а обход идёт
         * часами: за это время папку могло не стать (правило фильтрации
         * переложило письма, человек переименовал папку с телефона), и
         * `getMailboxLock` на исчезнувшей папке бросает. Раньше это
         * исключение долетало до общего разбора внизу, где `zip.abort()`
         * и `rm(file)`, — то есть одна пропавшая папка стирала часы
         * работы и весь уже собранный архив. Для отдельного ПИСЬМА такой
         * исход давно признан недопустимым (см. `lost` ниже) — для папки
         * рассуждение ровно то же, только цена выше.
         */
        try {
          const lock = await client.getMailboxLock(folder.path);
          try {
            /*
             * Письма читаются потоком, по одному. Забрать их пачкой было бы
             * проще на вид и означало бы весь ящик в памяти разом: у ящика
             * на десять гигабайт это мгновенная смерть процесса (потолок
             * кучи 512 МБ).
             */
            for await (const msg of client.fetch(
              '1:*',
              { uid: true, source: true, envelope: true, size: true },
              { uid: false },
            )) {
              const source = msg.source;
              if (!source) {
                // Письмо, которое сервер не отдал (битый файл в Maildir —
                // редкость, но встречается). Пропускаем и считаем: потерять
                // весь архив из-за одного письма было бы хуже.
                lost += 1;
                skipped += 1;
                continue;
              }
              const name = entryName(folder, msg.uid, msg.envelope?.subject ?? '');
              await zip.add(name, source, msg.envelope?.date ?? new Date());
              saved += 1;
              done += 1;
              bytes += source.length;

              if (zip.bytesWritten > settings.MAILBOX_EXPORT_MAX_BYTES) {
                /*
                 * Потолок — не повод выбросить собранное.
                 *
                 * Раньше здесь бросалось исключение, а общий разбор внизу
                 * сносил файл и ставил заданию 'failed'. В отказе при этом
                 * советовалось «выгрузите по частям, например без Спама и
                 * Корзины» — но выбрать можно ровно эти две вещи, и обе по
                 * умолчанию уже выключены. То есть ящик крупнее потолка
                 * выгрузить было нельзя НИКАК, а каждая попытка стирала
                 * многочасовую работу. Теперь обход останавливается,
                 * архив закрывается как есть, человек его скачивает, а
                 * чего в нём нет — написано и в задании, и в ЧИТАТЬ.txt.
                 */
                truncated = true;
                break;
              }

              const now = Date.now();
              if (done % PROGRESS_EVERY === 0 || now - lastReport > PROGRESS_EVERY_MS) {
                lastReport = now;
                await store.updateExportProgress(job.id, {
                  doneMessages: done,
                  doneBytes: bytes,
                  skipped,
                });
                // Отмена проверяется здесь же, а не отдельным таймером:
                // человек, нажавший «Отменить», ждёт остановки в течение
                // секунд, и это единственное место, которое выполняется
                // достаточно часто и умеет остановиться чисто.
                const fresh = await store.findExport(job.id);
                if (fresh && fresh.state !== 'running') throw new ExportCancelledError();
              }
            }
          } finally {
            lock.release();
          }
          outcomes.push({
            path: folder.path,
            saved,
            lost,
            state: truncated ? 'truncated' : 'ok',
          });
        } catch (err) {
          // Отмену человек нажал сам — она обязана остановить всё задание,
          // а не превратиться в «папку не удалось прочитать».
          if (err instanceof ExportCancelledError) throw err;
          const reason = err instanceof Error ? err.message : String(err);
          outcomes.push({ path: folder.path, saved, lost, state: 'failed', reason });
          logger.warn(
            { ...errorInfo(err), job: job.id, folder: folder.path },
            'Выгрузка ящика: папку прочитать не удалось, остальные собираются дальше',
          );
        }
      }

      /*
       * Пояснение кладётся в архив ПОСЛЕДНИМ, а не первым.
       *
       * Раньше оно писалось до обхода и пересказывало счётчики папок,
       * то есть обещало то, чего в архиве могло и не оказаться: «писем:
       * 0» у папки, которую не смогли прочитать, и полный список папок
       * у архива, оборвавшегося на потолке. Теперь в нём написано, что
       * в архиве ЕСТЬ и чего в нём нет.
       */
      await zip.add(
        'ЧИТАТЬ.txt',
        Buffer.from(readmeText(job, outcomes, truncated), 'utf8'),
        new Date(),
      );

      const size = await zip.finish();
      zip = null;
      const expiresAt = new Date(Date.now() + settings.MAILBOX_EXPORT_TTL_HOURS * 3600_000);
      await store.updateExportProgress(job.id, {
        doneMessages: done,
        doneBytes: bytes,
        skipped,
        totalMessages: Math.max(total, done),
      });
      const warning = exportWarning(job, outcomes, truncated, settings.MAILBOX_EXPORT_MAX_BYTES);
      await store.finishExport(job.id, {
        state: 'ready',
        filePath: file,
        fileBytes: size,
        expiresAt,
        // Готовый архив с оговоркой — это по-прежнему готовый архив:
        // скачать его можно, и это лучшее, что есть у человека. Но
        // оговорка едет вместе с ним и видна на экране.
        lastError: warning,
      });
      logger.info(
        { job: job.id, messages: done, skipped, bytes: size, truncated, warning },
        'Выгрузка ящика готова',
      );
    } catch (err) {
      await zip?.abort().catch(() => undefined);
      await rm(file, { force: true }).catch(() => undefined);
      if (err instanceof ExportCancelledError) {
        // Состояние уже 'cancelled' — его поставил маршрут отмены.
        // Перетирать его здесь нельзя: получилось бы «отменено» → «сорвалось».
        logger.info({ job: job.id }, 'Выгрузка ящика отменена человеком');
      } else {
        const reason = err instanceof Error ? err.message : String(err);
        await this.#opts.store
          .finishExport(job.id, { state: 'failed', lastError: reason.slice(0, 500) })
          .catch(() => undefined);
        logger.warn(errorInfo(err), 'Выгрузка ящика сорвалась');
      }
    } finally {
      await client?.logout().catch(() => undefined);
    }
  }
}

class ExportCancelledError extends Error {
  constructor() {
    super('Выгрузка отменена');
    this.name = 'ExportCancelledError';
  }
}

/* ------------------------------------------------------------------ */
/* Чистые функции: их и проверяют без стенда                            */
/* ------------------------------------------------------------------ */

/** Что стало с папкой при обходе: из этого складывается вся правда об архиве. */
export interface FolderOutcome {
  path: string;
  /** Сколько её писем лежит в архиве. */
  saved: number;
  /** Сколько её писем сервер не отдал (битый файл в Maildir). */
  lost: number;
  state:
    /** Прочитана целиком. */
    | 'ok'
    /** Пуста — и это ответ сервера, а не догадка. */
    | 'empty'
    /** Не прочитана: папки не стало, отказано в доступе, оборвалась связь. */
    | 'failed'
    /** Вошла не целиком: на ней архив упёрся в потолок. */
    | 'truncated'
    /** До неё обход не дошёл: потолок кончился раньше. */
    | 'not-reached';
  /** Почему не прочитана — словами сервера. */
  reason?: string;
}

/** Потолок словами: гигабайты, а не байты — их и читает человек. */
function limitGb(limit: number): string {
  const gb = limit / (1024 * 1024 * 1024);
  return (gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10).toString().replace('.', ',');
}

/**
 * Оговорка к готовому архиву: чего в нём нет и что с этим делать.
 *
 * Пишется в поле ошибки задания и показывается рядом с кнопкой
 * «Скачать» — там, где человек решает, забрал он свою почту или нет.
 * Молчание здесь было бы обманом: полоска дошла до конца, состояние
 * «Готово», а папки в архиве нет.
 *
 * Совет обязан быть выполнимым. Выбрать в заказе можно ровно две вещи —
 * «Спам» и «Корзину», — поэтому предлагать «выгрузить по частям» тому,
 * кто их и так не включал, нельзя: это тупик. Ему говорится правда:
 * собранное сохранено, а ящик целиком в такой архив не помещается, и
 * потолок задаёт администратор сервера.
 */
export function exportWarning(
  job: Pick<ExportRow, 'includeSpam' | 'includeTrash'>,
  outcomes: readonly FolderOutcome[],
  truncated: boolean,
  limit: number,
): string | null {
  const parts: string[] = [];

  const failed = outcomes.filter((o) => o.state === 'failed');
  if (failed.length > 0) {
    parts.push(
      `Не удалось прочитать ${String(failed.length)} ${plural(failed.length, 'папку', 'папки', 'папок')} ` +
        `(${failed.map((o) => o.path).join(', ')}) — их писем в архиве нет.`,
    );
  }

  if (truncated) {
    const missed = outcomes.filter((o) => o.state === 'not-reached').map((o) => o.path);
    parts.push(
      `Архив дорос до потолка в ${limitGb(limit)} ГБ и остановлен: всё, что успело поместиться, ` +
        'сохранено — этот архив можно скачать.' +
        (missed.length > 0 ? ` Не попали в него папки: ${missed.join(', ')}.` : '') +
        (job.includeSpam || job.includeTrash
          ? ' Закажите выгрузку заново без «Спама» и «Корзины» — тогда поместится больше.'
          : ' Ящик целиком в архив такого размера не помещается: потолок задаёт администратор ' +
            'сервера (MAILBOX_EXPORT_MAX_BYTES).'),
    );
  }

  return parts.length === 0 ? null : parts.join(' ');
}

/** Склонение по-русски: 1 папка, 2 папки, 5 папок. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Какие папки попадают в архив.
 *
 * «Спам» и «Корзина» — только по прямой просьбе: в спаме бывает половина
 * объёма ящика, а корзину человек уже решил выбросить.
 *
 * Служебной папки восстановления (см. recovery-mailbox.ts) здесь нет и не
 * бывает: её не отдаёт общий список папок вовсе. Это правильно и для
 * выгрузки тоже — там лежит уже выброшенное, чему осталось дожить свой
 * срок, и класть его в архив «всей почты» значило бы вернуть человеку то,
 * что он выбросил дважды.
 *
 * Черновики и отправленные включаются всегда: это переписка человека, и
 * забирать её он приходит целиком.
 */
export function pickFolders(folders: Folder[], job: ExportRow): Folder[] {
  return folders.filter((folder) => {
    if (folder.role === 'spam') return job.includeSpam;
    if (folder.role === 'trash') return job.includeTrash;
    return true;
  });
}

/**
 * Имя файла письма внутри архива.
 *
 * Номер письма впереди темы — не украшение: темы повторяются (двадцать
 * писем «Re: договор»), а имя файла в архиве должно быть уникальным,
 * иначе распаковщик молча перезапишет одно другим. Номер IMAP уникален
 * в пределах папки, а папка здесь — каталог.
 *
 * Путь режется ТОЛЬКО по «/» — разделителю папок у нашего Dovecot.
 * Раньше он резался ещё и по точке, и это ломало ровно то, ради чего
 * номер стоит впереди темы: папка «vip.клиенты» давала тот же каталог,
 * что настоящая «vip/клиенты», номера писем в разных папках совпадают
 * сплошь и рядом — и распаковщик молча клал одно письмо поверх другого.
 * Точка в имени папки при этом не запрещена ничем и встречается у любого,
 * кто раскладывает почту по доменам и номерам договоров.
 */
export function entryName(folder: Folder, uid: number, subject: string): string {
  const clean = safeEntryName(subject).slice(0, 80).trim();
  const tail = clean === '' || clean === 'без имени' ? 'без темы' : clean;
  const dir = safeEntryPath(folder.path.split('/'));
  return `${dir === '' ? 'Ящик' : dir}/${String(uid).padStart(6, '0')} ${tail}.eml`;
}

/**
 * Пояснение внутри архива: что это, что потерялось и как этим пользоваться.
 *
 * Составляется ПОСЛЕ обхода, по его итогам, а не по счётчикам папок до
 * начала работы. Прежний список пересказывал `totalCount`, то есть писал
 * «писем: 0» у папки, счётчик которой не прочитался (её писем в архиве не
 * было вовсе), и перечислял папки, до которых обход не дошёл. Архив
 * человек открывает через месяцы — единственное, что расскажет ему тогда
 * правду, это файл внутри самого архива.
 */
export function readmeText(
  job: ExportRow,
  outcomes: readonly FolderOutcome[],
  truncated = false,
): string {
  const lines = [
    'Выгрузка почтового ящика',
    '========================',
    '',
    `Ящик:  ${job.accountEmail}`,
    `Заказана: ${new Date(job.createdAt).toLocaleString('ru-RU')}`,
    '',
    'Что внутри',
    '----------',
    'Каждая папка ящика — каталог, каждое письмо — отдельный файл .eml.',
    'Файл .eml открывается двойным щелчком в любой почтовой программе',
    '(Thunderbird, Outlook, «Почта» в Windows и macOS) и содержит письмо',
    'целиком: заголовки, текст и вложения, байт в байт как на сервере.',
    '',
    'Чего внутри НЕТ',
    '---------------',
    'Пометок «прочитано», флажков и меток: файл .eml их не хранит — это',
    'свойства письма в ящике, а не самого письма. Если нужен полный',
    'перенос вместе с пометками, переносите ящик по IMAP, а не архивом.',
    '',
    'Папки',
    '-----',
  ];
  for (const outcome of outcomes) {
    lines.push(`  ${outcome.path} — ${folderLine(outcome)}`);
  }
  if (!job.includeSpam) lines.push('', 'Папка «Спам» в выгрузку не включалась.');
  if (!job.includeTrash) lines.push('Папка «Корзина» в выгрузку не включалась.');

  const failed = outcomes.filter((o) => o.state === 'failed');
  const notReached = outcomes.filter((o) => o.state === 'not-reached');
  if (failed.length > 0 || truncated) {
    lines.push('', 'ВНИМАНИЕ: в архиве не вся почта', '-------------------------------');
  }
  if (failed.length > 0) {
    lines.push(
      `Эти папки прочитать не удалось, их писем здесь НЕТ: ${failed.map((o) => o.path).join(', ')}.`,
      'Закажите выгрузку заново — обычно со второго раза папка читается.',
    );
  }
  if (truncated) {
    lines.push(
      'Архив дорос до потолка, заданного администратором сервера, и остановлен.',
      'Всё, что успело поместиться, — здесь.',
    );
    if (notReached.length > 0) {
      lines.push(`В архив не попали папки: ${notReached.map((o) => o.path).join(', ')}.`);
    }
  }
  lines.push('');
  return lines.join('\r\n');
}

/** Судьба одной папки одной строкой — так, как её прочитает человек. */
function folderLine(outcome: FolderOutcome): string {
  const lost = outcome.lost > 0 ? `; сервер не отдал писем: ${String(outcome.lost)}` : '';
  switch (outcome.state) {
    case 'ok':
      return `писем: ${String(outcome.saved)}${lost}`;
    case 'empty':
      return 'пусто';
    case 'failed':
      return `ПРОЧИТАТЬ НЕ УДАЛОСЬ (${outcome.reason ?? 'причина неизвестна'}), писем здесь нет`;
    case 'truncated':
      return `писем: ${String(outcome.saved)}${lost}; папка вошла НЕ ЦЕЛИКОМ — архив дорос до потолка`;
    case 'not-reached':
      return 'в архив не попала: архив дорос до потолка раньше';
  }
}

/** Есть ли файл готовой выгрузки на диске и сколько он весит. */
export async function exportFileSize(path: string): Promise<number | null> {
  try {
    const st = await stat(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}
