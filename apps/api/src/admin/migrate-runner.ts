/**
 * Работник переноса почты: берёт задания из базы и выполняет их.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ РАБОТНИК, А НЕ ОБРАБОТЧИК ЗАПРОСА
 *
 * Перенос одного ящика идёт часами, сотни ящиков — сутками. Ждать этого
 * в HTTP-запросе нельзя (nginx закроет соединение через две минуты),
 * а держать задание в памяти процесса нельзя тем более: обновление образа
 * или перезапуск контейнера посреди ночного переноса оставили бы
 * администратора у пустого экрана — без чисел, без отчёта и без понимания,
 * что успело переехать.
 *
 * Поэтому задание — строка в базе, а здесь только тот, кто её выполняет.
 * Тот же приём уже применён в отложенной отправке (очередь файлами на
 * постоянном томе, mail/deferred-send.ts) и в заданиях импорта CSV
 * (таблица user_import_jobs, admin/import-jobs.ts).
 *
 * ------------------------------------------------------------------
 * ЧТО ПРОИСХОДИТ ПРИ ПЕРЕЗАПУСКЕ КОНТЕЙНЕРА ПОСРЕДИ ПЕРЕНОСА
 *
 * 1. Задание остаётся в состоянии running с последним биением (heartbeat)
 *    умершего процесса.
 * 2. Новый процесс при старте забирает все незавершённые задания, чьё
 *    биение просрочено, — то есть и это тоже.
 * 3. Ящики, уже помеченные ok, пропускаются. Ящик, который был в работе,
 *    начинается заново — но НЕ с нуля: состояние переноса (migrate_cursors
 *    и migrate_messages, их ведёт сам packages/migrate в той же базе)
 *    помнит, до какого письма дошли в каждой папке, а дедупликация
 *    страхует от повторов даже при потере состояния.
 * 4. Пароли лежат в задании зашифрованными и переживают перезапуск вместе
 *    с ним — иначе продолжить было бы нечем, а спросить их в три часа
 *    ночи не у кого.
 *
 * Итог для человека: он видит, что счётчики снова растут, а не начинает
 * сутки переноса заново.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  migrateBatch,
  PgStateStore,
  type BatchAccount,
  type MailboxReport,
  type ProgressEvent,
  type StateStore,
} from '@mail-true/migrate';
import type { AdminDb, MigrationJobRow } from './db.js';
import {
  collectErrors,
  destEndpointFor,
  destMailboxProblem,
  sourceEndpointFor,
  unpackSecrets,
  type DestSettings,
  type SourceSettings,
} from './migrate-jobs.js';
import type { SecretBox } from '../crypto.js';
import { errorInfo } from '../log.js';

export interface MigrationRunnerOptions {
  db: AdminDb;
  logger: Logger;
  /** Шифровальщик паролей задания. null — секрета нет, перенос недоступен. */
  box: SecretBox | null;
  /** Служебный доступ к нашему Dovecot: пароли ящиков-приёмников не нужны. */
  dest: DestSettings;
  /** Строка подключения для состояния докачки (та же база). */
  stateConnectionString: string;
  /**
   * Чем заводить хранилище состояния докачки. По умолчанию — таблицы
   * Postgres в той же базе (переживают перезапуск контейнера, ради этого
   * всё и делается). Переопределяется только в проверках: поднимать
   * Postgres ради проверки того, что задание пропускает уже перенесённые
   * ящики, — это проверка не того.
   */
  createState?: () => StateStore;
  /** Как часто искать задания, секунды. */
  intervalSeconds?: number;
  /** После какого молчания работника задание считается брошенным, секунды. */
  staleSeconds?: number;
  /** Сколько ящиков переносить одновременно. */
  concurrency?: number;
  /** Через сколько часов задание сдаётся и пароли стираются. */
  maxHours?: number;
}

/**
 * Как часто числа задания попадают в базу.
 *
 * Не после каждого письма: на скорости в сотню писем в секунду это сотня
 * UPDATE в секунду ради цифры, которую человек читает раз в пару секунд.
 * И не раз в минуту: тогда экран стоит, и перенос выглядит зависшим —
 * ровно то, ради чего раздел и делался.
 */
const PROGRESS_FLUSH_MS = 2000;

export class MigrationRunner {
  readonly #opts: Required<
    Pick<MigrationRunnerOptions, 'intervalSeconds' | 'staleSeconds' | 'concurrency' | 'maxHours'>
  > &
    MigrationRunnerOptions;
  /** Свой идентификатор. У перезапущенного контейнера он другой — на этом всё и держится. */
  readonly #runner = randomUUID().slice(0, 32);
  #timer: NodeJS.Timeout | null = null;
  #scanning = false;
  /** Задания, которые этот процесс ведёт прямо сейчас: id → как остановить. */
  readonly #active = new Map<number, AbortController>();
  /** Начатые прогоны: их надо дождаться при остановке процесса. */
  readonly #running = new Map<number, Promise<void>>();
  /**
   * Процесс гасят.
   *
   * Отличать это от «человек нажал Остановить» обязательно. Перезапуск
   * контейнера — не решение прекратить перенос: завершив задание по
   * SIGTERM, мы стёрли бы пароли (они стираются вместе с завершением)
   * и превратили обновление образа в потерю всей ночи переноса.
   */
  #shuttingDown = false;

  constructor(options: MigrationRunnerOptions) {
    this.#opts = {
      intervalSeconds: 10,
      staleSeconds: 60,
      concurrency: 2,
      maxHours: 48,
      ...options,
    };
  }

  /** Идентификатор работника — нужен проверкам и журналу. */
  get runnerId(): string {
    return this.#runner;
  }

  start(): void {
    if (this.#timer) return;
    // Первый проход сразу: незавершённые задания предыдущего процесса
    // должны продолжиться, а не ждать десять секунд.
    void this.scan().catch(() => undefined);
    this.#timer = setInterval(
      () => void this.scan().catch(() => undefined),
      this.#opts.intervalSeconds * 1000,
    );
    this.#timer.unref();
  }

  /**
   * «Появилось задание — посмотри сейчас».
   *
   * Без этого только что созданное задание ждало бы очередного прохода
   * (десять секунд), и человек, нажавший «Начать перенос», десять секунд
   * смотрел бы на неподвижный ноль, не понимая, приняли ли его нажатие.
   */
  nudge(): void {
    void this.scan().catch(() => undefined);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#shuttingDown = true;
    // Прерываем перенос на границе письма. Задание при этом НЕ завершается:
    // оно остаётся идущим и отпускается (см. runJob), чтобы следующий
    // процесс подхватил его сразу, а не выждав срок молчания.
    for (const control of this.#active.values()) control.abort();
  }

  /**
   * Дождаться, пока начатые задания отпустят себя.
   *
   * Без ожидания подключение к базе закрывается раньше, чем задание
   * успевает записать «я ничей», — и оно висит «идущим» с чужим биением
   * ровно столько, сколько длится срок молчания. Человек в это время
   * видит задание, которое якобы ведут, а числа не двигаются.
   */
  async drain(timeoutMs = 15_000): Promise<void> {
    const pending = [...this.#running.values()];
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  /** Один проход: забрать задания и запустить те, что ещё не идут. */
  async scan(): Promise<number> {
    if (this.#scanning) return 0;
    this.#scanning = true;
    try {
      await this.#opts.db.expireStaleMigrationJobs(this.#opts.maxHours).catch(() => 0);
      const jobs = await this.#opts.db.claimMigrationJobs(this.#runner, this.#opts.staleSeconds);
      let started = 0;
      for (const job of jobs) {
        const id = Number(job.id);
        if (this.#active.has(id)) continue;
        started += 1;
        const promise = this.runJob(job).catch((err: unknown) =>
          this.#opts.logger.error(errorInfo(err, { jobId: id }), 'Задание переноса упало'),
        );
        // Промис запоминаем, чтобы остановка процесса могла его дождаться
        this.#running.set(id, promise);
        void promise.finally(() => this.#running.delete(id));
      }
      return started;
    } finally {
      this.#scanning = false;
    }
  }

  /** Выполнить одно задание целиком. */
  async runJob(job: MigrationJobRow): Promise<void> {
    const { db, logger, box } = this.#opts;
    const id = Number(job.id);
    const control = new AbortController();
    this.#active.set(id, control);

    // Биение: пока оно идёт, задание не отберёт другой процесс. Оно же
    // читает флаг остановки — отдельного таймера ради этого не заводим.
    const beat = setInterval(() => {
      void (async () => {
        await db.touchMigrationJob(id, this.#runner).catch(() => undefined);
        if (await db.isMigrationStopRequested(id).catch(() => false)) control.abort();
      })();
    }, 5000);
    beat.unref();

    const state = this.#opts.createState?.() ?? new PgStateStore(this.#opts.stateConnectionString);
    try {
      if (box === null) {
        await db.updateMigrationJob(id, {
          state: 'failed',
          error:
            'Не задан ADMIN_SESSION_SECRET/SESSION_SECRET: расшифровать пароли исходных ' +
            'ящиков нечем, перенос выполнить нельзя.',
          finished: true,
        });
        return;
      }
      const secrets = unpackSecrets(box, job.secret_enc);
      if (secrets === null) {
        // Пароли стёрты (задание уже завершалось) или сменился ключ.
        // Сказать это словами обязательно: иначе человек видит отказ IMAP
        // «неверный пароль» и идёт проверять чужой сервер.
        await db.updateMigrationJob(id, {
          state: 'failed',
          error:
            'Пароли исходных ящиков недоступны: свёрток стёрт при завершении задания ' +
            'или сменился ключ шифрования. Запустите перенос заново — уже перенесённые ' +
            'письма повторно не поедут.',
          finished: true,
        });
        return;
      }

      // Уже нажали «Остановить», пока задание стояло в очереди
      if (await db.isMigrationStopRequested(id)) control.abort();

      await db.updateMigrationJob(id, { state: 'running', started: true });
      await state.init();

      const items = await db.listMigrationItems(id);
      // Пропускаем то, что уже сделано: после перезапуска контейнера
      // переносить заново ящик, который целиком переехал вчера, — это
      // часы работы и сканирование чужого сервера ни за чем.
      const pending = items.filter((item) => item.state !== 'ok');
      const source: SourceSettings = {
        host: job.source_host,
        port: job.source_port,
        secure: job.source_secure,
        allowInsecureTls: job.source_insecure_tls,
        masterUser: job.source_master_user,
        masterSeparator: job.source_master_separator,
      };

      const accounts: BatchAccount[] = [];
      const positions: number[] = [];
      const noPassword: number[] = [];
      /*
       * Ящики, в которые писать некуда: их удалили или отключили между
       * постановкой задания в очередь и очередью до этой строки.
       *
       * Проверка ЗДЕСЬ, а не только при создании задания, потому что
       * ночной перенос идёт часами, а восстановление настроек из копии
       * (POST /backup/restore) выключает ящики за секунды. Ровно так это
       * и поймали: копия отключила ящик посреди переноса, Dovecot отказал
       * во входе, а раздел переноса назвал причиной «неправильный пароль»
       * — и человек пошёл проверять пароль служебного доступа.
       */
      const destProblems: Array<{ position: number; reason: string }> = [];
      for (const item of pending) {
        const problem = destMailboxProblem({
          exists: item.dest_active !== null,
          active: item.dest_active === true,
        });
        if (problem !== null) {
          destProblems.push({ position: item.position, reason: problem });
          continue;
        }
        const endpoint = sourceEndpointFor(source, secrets, {
          sourceUser: item.source_user,
          position: item.position,
        });
        if (endpoint === null) {
          noPassword.push(item.position);
          continue;
        }
        accounts.push({ source: endpoint, dest: destEndpointFor(this.#opts.dest, item.dest_user) });
        positions.push(item.position);
      }

      for (const position of noPassword) {
        await db.updateMigrationItem(id, position, {
          state: 'failed',
          errors: JSON.stringify(['Пароль исходного ящика не задан — переносить нечем']),
          finished: true,
        });
      }
      for (const { position, reason } of destProblems) {
        await db.updateMigrationItem(id, position, {
          state: 'failed',
          errors: JSON.stringify([reason]),
          finished: true,
        });
      }

      // Строки, отказавшие ДО начала переноса, идут в подсчёт уже
      // отказавшими. Иначе задание, у которого все ящики-приёмники
      // отключены, показало бы «выполнено» и ноль ошибок — то есть
      // соврало бы ровно тем числом, ради которого отчёт и открывают.
      const failedBeforeStart = new Set([...noPassword, ...destProblems.map((p) => p.position)]);
      const totals = await this.migrateAll({
        jobId: id,
        accounts,
        positions,
        state,
        signal: control.signal,
        items: items.map((i) => ({
          position: i.position,
          copied: i.copied,
          skipped: i.skipped,
          failed: i.failed,
          state: failedBeforeStart.has(i.position) ? 'failed' : i.state,
        })),
      });

      /*
       * Ящик мог исчезнуть УЖЕ ВО ВРЕМЯ переноса.
       *
       * Проверка перед стартом ловит то, что было плохо к началу; эта —
       * то, что стало плохо посреди работы. Восстановление настроек из
       * копии выключает ящики за секунды, а перенос идёт часами, так что
       * попасть между ними — не редкость, а обычный порядок вещей.
       *
       * По содержимому ответа IMAP отличить «пароль не тот» от «ящика для
       * сервера больше нет» невозможно (Dovecot отвечает одинаково), зато
       * наша же база знает это точно. Поэтому объяснение приписывается
       * ПЕРВЫМ к ошибкам ящика — над «сервер не принял логин или пароль»,
       * которое без него уводит проверять пароли.
       */
      const after = await db.listMigrationItems(id).catch(() => []);
      for (const item of after) {
        if (item.state !== 'failed' && item.state !== 'partial') continue;
        if (failedBeforeStart.has(item.position)) continue;
        const problem = destMailboxProblem({
          exists: item.dest_active !== null,
          active: item.dest_active === true,
        });
        if (problem === null) continue;
        let errors: string[] = [];
        if (item.errors !== null) {
          try {
            const parsed: unknown = JSON.parse(item.errors);
            if (Array.isArray(parsed)) errors = parsed.map((e) => String(e));
          } catch {
            errors = [item.errors];
          }
        }
        if (errors.includes(problem)) continue;
        await db
          .updateMigrationItem(id, item.position, {
            errors: JSON.stringify([problem, ...errors]),
          })
          .catch(() => undefined);
      }

      // Гасят процесс, а не задание. Задание не завершаем: завершение
      // стирает пароли, и обновление образа посреди ночного переноса
      // означало бы, что докачивать нечем. Отпускаем — и следующий
      // процесс возьмёт его сразу, продолжив с записанного курсора.
      if (this.#shuttingDown && !(await db.isMigrationStopRequested(id).catch(() => false))) {
        await db.releaseMigrationJob(id, this.#runner).catch(() => undefined);
        logger.info(
          { jobId: id },
          'Перенос отпущен при остановке сервера — продолжится после запуска',
        );
        return;
      }

      // Итог задания. Остановку не выдаём ни за успех, ни за поломку:
      // отдельное состояние показывает ровно то, что произошло. А если
      // не переехал НИ ОДИН ящик — это отказ задания, а не «выполнено
      // с замечаниями»: обычно так выглядит неверный адрес или пароль,
      // и увидеть это надо в списке заданий, не открывая отчёт.
      const finalState = control.signal.aborted
        ? 'stopped'
        : totals.doneMailboxes === 0 && totals.failedMailboxes > 0
          ? 'failed'
          : 'done';
      await db.updateMigrationJob(id, {
        state: finalState,
        doneCount: totals.doneMailboxes,
        copied: totals.copied,
        skipped: totals.skipped,
        failed: totals.failed,
        finished: true,
        ...(control.signal.aborted
          ? {
              error:
                'Перенос остановлен. Уже перенесённые письма повторно не поедут: ' +
                'запустите новое задание с тем же списком, чтобы докачать остальное.',
            }
          : // Причина отказа — на самом задании, а не только в строке ящика:
            // в списке заданий видно состояние, но не содержимое отчёта, и
            // «не выполнено» без причины отправляет искать поломку наугад.
            destProblems.length > 0 && accounts.length === 0
            ? {
                error:
                  `Переносить некуда: ${String(destProblems.length)} ящик(ов)-приёмник(ов) ` +
                  'удалены или отключены (подробности — в строках ящиков). ' +
                  'Восстановите их и повторите задание: уже перенесённые письма повторно не поедут.',
              }
            : {}),
      });
      logger.info(
        {
          jobId: id,
          mailboxes: totals.doneMailboxes,
          copied: totals.copied,
          skipped: totals.skipped,
          failed: totals.failed,
          state: finalState,
        },
        'Задание переноса почты завершено',
      );
    } catch (err) {
      logger.error(errorInfo(err, { jobId: id }), 'Задание переноса почты не выполнено');
      await db
        .updateMigrationJob(id, {
          state: 'failed',
          error: err instanceof Error ? err.message : String(err),
          finished: true,
        })
        .catch(() => undefined);
    } finally {
      clearInterval(beat);
      this.#active.delete(id);
      await state.close().catch(() => undefined);
    }
  }

  /**
   * Пакетный перенос с записью прогресса в базу.
   *
   * Саму работу делает migrateBatch из packages/migrate — здесь только
   * перевод его событий в строки базы, чтобы экран показывал движение.
   */
  private async migrateAll(input: {
    jobId: number;
    accounts: BatchAccount[];
    positions: number[];
    state: StateStore;
    signal: AbortSignal;
    items: Array<{
      position: number;
      copied: number;
      skipped: number;
      failed: number;
      state: string;
    }>;
  }): Promise<{
    doneMailboxes: number;
    failedMailboxes: number;
    copied: number;
    skipped: number;
    failed: number;
  }> {
    const { db } = this.#opts;
    const { jobId, accounts, positions, items } = input;

    /*
     * Числа, накопленные ПРЕДЫДУЩИМИ проходами этого задания.
     *
     * Поймано на живом стенде. Перезапуск контейнера посреди переноса
     * ящика на 924 письма: до перезапуска в приёмник легло 724 письма,
     * после — новый процесс докачал остальные 200 и записал в строку
     * ящика «перенесено 200 из 924». Ящик переехал ЦЕЛИКОМ, а отчёт
     * показывал недостачу в 724 письма — то есть звал повторять перенос,
     * которого не требуется.
     *
     * Складываются только copied и skipped: это письма, которые уже лежат
     * в приёмнике, и они никуда не денутся. Ошибки — НЕ складываются:
     * повторный проход заново пробует всё, что не переехало (курсор
     * замирает перед первым непереехавшим письмом), поэтому число ошибок
     * текущего прохода и есть настоящее.
     */
    const carried = new Map<
      number,
      { copied: number; skipped: number; failed: number; total: number }
    >();
    for (const i of items) {
      carried.set(i.position, { copied: i.copied, skipped: i.skipped, failed: i.failed, total: 0 });
    }
    /** Ящики, которых этот проход не касается: их числа берём как есть. */
    const untouched = items.filter((i) => !positions.includes(i.position));
    const base = untouched.reduce(
      (acc, i) => ({
        copied: acc.copied + i.copied,
        skipped: acc.skipped + i.skipped,
        failed: acc.failed + i.failed,
      }),
      { copied: 0, skipped: 0, failed: 0 },
    );
    // Ящики, до которых проход не дошёл, потому что они уже перенесены
    let doneMailboxes = untouched.filter((i) => i.state === 'ok' || i.state === 'partial').length;
    let failedMailboxes = untouched.filter((i) => i.state === 'failed').length;
    const live = new Map<
      number,
      { copied: number; skipped: number; failed: number; total: number; folder: string | null }
    >();
    let lastFlush = 0;

    /** Итог по ящику с учётом предыдущих проходов. */
    const withCarried = (
      position: number,
      v: { copied: number; skipped: number; failed: number },
    ): { copied: number; skipped: number; failed: number } => {
      const before = carried.get(position) ?? { copied: 0, skipped: 0, failed: 0, total: 0 };
      return {
        copied: before.copied + v.copied,
        skipped: before.skipped + v.skipped,
        failed: v.failed,
      };
    };

    const totals = (): { copied: number; skipped: number; failed: number } => {
      let copied = base.copied;
      let skipped = base.skipped;
      let failed = base.failed;
      for (const [position, v] of live.entries()) {
        const sum = withCarried(position, v);
        copied += sum.copied;
        skipped += sum.skipped;
        failed += sum.failed;
      }
      return { copied, skipped, failed };
    };

    const flush = async (force: boolean): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastFlush < PROGRESS_FLUSH_MS) return;
      lastFlush = now;
      const sum = totals();
      await db
        .updateMigrationJob(jobId, {
          doneCount: doneMailboxes,
          copied: sum.copied,
          skipped: sum.skipped,
          failed: sum.failed,
        })
        .catch(() => undefined);
      for (const [position, v] of live.entries()) {
        const item = withCarried(position, v);
        await db
          .updateMigrationItem(jobId, position, {
            copied: item.copied,
            skipped: item.skipped,
            failed: item.failed,
            total: v.total,
            currentFolder: v.folder,
          })
          .catch(() => undefined);
      }
    };

    if (accounts.length === 0) {
      await flush(true);
      return { doneMailboxes, failedMailboxes, ...totals() };
    }

    await migrateBatch({
      accounts,
      concurrency: this.#opts.concurrency,
      // Логгер в imapflow НЕ передаётся намеренно. Он пишет протокольный
      // обмен, а в обмене есть команда входа — то есть пароль оказался бы
      // в журнале сервера открытым текстом. Требование «паролей в журнале
      // нет ни в каком виде» важнее удобства отладки; отказы и без того
      // разобраны словами (describeImapError).
      migrate: { state: input.state, signal: input.signal },
      onProgress: (index, _account, event: ProgressEvent) => {
        const position = positions[index];
        if (position === undefined) return;
        const current = live.get(position) ?? {
          copied: 0,
          skipped: 0,
          failed: 0,
          total: 0,
          folder: null,
        };
        if (event.type === 'start') {
          current.total = event.messages;
          void db
            .updateMigrationItem(jobId, position, {
              state: 'running',
              total: event.messages,
              started: true,
            })
            .catch(() => undefined);
        } else if (event.type === 'folder-start') {
          current.folder = event.sourcePath;
        } else if (event.type === 'message') {
          current.copied = event.copied;
          current.skipped = event.skipped;
          current.failed = event.failed;
        }
        live.set(position, current);
        void flush(false);
      },
      onAccountDone: (index, report: MailboxReport) => {
        const position = positions[index];
        if (position === undefined) return;
        live.set(position, {
          copied: report.copied,
          skipped: report.skipped,
          failed: report.failed,
          total: report.totalMessages,
          folder: null,
        });
        if (report.status === 'ok' || report.status === 'partial') doneMailboxes += 1;
        if (report.status === 'failed') failedMailboxes += 1;
        const errors = collectErrors(report.folders);
        // Ошибка уровня ящика (не достучались, нет пароля) в папки не
        // попадает — без неё отчёт показал бы «ошибок 0» у не переехавшего
        // ящика, и это самое опасное враньё в отчёте.
        if (report.error !== undefined && report.status !== 'stopped') errors.unshift(report.error);
        // Числа с учётом предыдущих проходов: продолженный после
        // перезапуска ящик обязан показать всё, что в нём лежит, а не
        // только докачанное этим проходом.
        const final = withCarried(position, report);
        void db
          .updateMigrationItem(jobId, position, {
            state: report.status,
            total: report.totalMessages,
            copied: final.copied,
            skipped: final.skipped,
            failed: final.failed,
            currentFolder: null,
            errors: errors.length > 0 ? JSON.stringify(errors) : null,
            finished: true,
          })
          .catch(() => undefined);
        void flush(true);
      },
    });

    await flush(true);
    return { doneMailboxes, failedMailboxes, ...totals() };
  }
}
