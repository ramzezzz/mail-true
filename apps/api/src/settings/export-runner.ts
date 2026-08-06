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
 *      задание честно останавливается с причиной, а не заполняет диск.
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
    const file = join(dir, `${job.id}-${Date.now()}.zip`);
    let zip: ZipWriter | null = null;
    let client: ImapFlow | null = null;

    try {
      await mkdir(dir, { recursive: true });
      client = await this.#connect(job.accountEmail);
      zip = new ZipWriter(file);

      const folders = pickFolders(await listFolders(client), job);
      const total = folders.reduce((sum, f) => sum + f.totalCount, 0);
      await store.updateExportProgress(job.id, { totalMessages: total });

      await zip.add(
        'ЧИТАТЬ.txt',
        Buffer.from(readmeText(job, folders), 'utf8'),
        new Date(),
      );

      let done = 0;
      let bytes = 0;
      let skipped = 0;
      let lastReport = Date.now();

      for (const folder of folders) {
        if (folder.totalCount === 0) continue;
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
              skipped += 1;
              continue;
            }
            const name = entryName(folder, msg.uid, msg.envelope?.subject ?? '');
            await zip.add(name, source, msg.envelope?.date ?? new Date());
            done += 1;
            bytes += source.length;

            if (zip.bytesWritten > settings.MAILBOX_EXPORT_MAX_BYTES) {
              throw new ExportTooBigError(settings.MAILBOX_EXPORT_MAX_BYTES);
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
      }

      const size = await zip.finish();
      zip = null;
      const expiresAt = new Date(Date.now() + settings.MAILBOX_EXPORT_TTL_HOURS * 3600_000);
      await store.updateExportProgress(job.id, {
        doneMessages: done,
        doneBytes: bytes,
        skipped,
        totalMessages: Math.max(total, done),
      });
      await store.finishExport(job.id, {
        state: 'ready',
        filePath: file,
        fileBytes: size,
        expiresAt,
      });
      logger.info(
        { job: job.id, messages: done, skipped, bytes: size },
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

/** Архив перерос потолок: диск общий, и заполнить его целиком нельзя. */
export class ExportTooBigError extends Error {
  constructor(limit: number) {
    super(
      `Архив вырос больше допустимых ${Math.round(limit / (1024 * 1024 * 1024))} ГБ и остановлен. ` +
        'Выгрузите ящик по частям — например, без «Спама» и «Корзины».',
    );
    this.name = 'ExportTooBigError';
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
 */
export function entryName(folder: Folder, uid: number, subject: string): string {
  const clean = safeEntryName(subject).slice(0, 80).trim();
  const tail = clean === '' || clean === 'без имени' ? 'без темы' : clean;
  const dir = safeEntryPath(folder.path.split(/[/.]/u));
  return `${dir === '' ? 'Ящик' : dir}/${String(uid).padStart(6, '0')} ${tail}.eml`;
}

/** Пояснение внутри архива: что это, что потерялось и как этим пользоваться. */
export function readmeText(job: ExportRow, folders: readonly Folder[]): string {
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
  for (const folder of folders) {
    lines.push(`  ${folder.path} — писем: ${folder.totalCount}`);
  }
  if (!job.includeSpam) lines.push('', 'Папка «Спам» в выгрузку не включалась.');
  if (!job.includeTrash) lines.push('Папка «Корзина» в выгрузку не включалась.');
  lines.push('');
  return lines.join('\r\n');
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
