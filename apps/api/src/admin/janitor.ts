/**
 * Фоновая уборка админки.
 *
 * Три задачи, у каждой своя причина существовать:
 *
 *  1. Физическое удаление каталогов ящиков, отправленных в карантин при
 *     удалении (см. mailbox-cleanup.ts). В обработчике запроса этого не
 *     делают: `rm -rf` большого ящика — это ожидание на ровном месте
 *     и риск таймаута посреди удаления.
 *
 *  2. Закрытие брошенных сеансов входа администратора в чужой ящик.
 *     Отметка о завершении ставилась только явным выходом, поэтому при
 *     истечении срока, закрытой вкладке или выходе из админки запись
 *     оставалась открытой навсегда — в журнале, который читает ВЛАДЕЛЕЦ
 *     ящика, вход выглядел бесконечным.
 *
 *  3. Удаление просроченных заданий импорта: в них лежат сгенерированные
 *     пароли (шифротекстом), и лежать вечно они не должны.
 *
 *  4. Поиск осиротевших каталогов в почтовом хранилище — только сообщить,
 *     не удалять: каталог мог быть заведён руками. Сообщение намеренно
 *     редкое (см. ORPHAN_REMINDER_MS): проход раз в минуту, а находка
 *     живёт неделями, и повтор на каждом проходе топит журнал.
 *
 * Уборщик умышленно тупой: никаких очередей и блокировок. Единственный
 * узел админки — сам процесс API; если их когда-нибудь станет несколько,
 * повторная уборка того же каталога безвредна (rm -rf с force), а строку
 * закрывает условие `state = 'pending'`.
 */
import type { Logger } from 'pino';
import type { AdminDb } from './db.js';
import { errorInfo } from '../log.js';
import { findOrphanMaildirs, quarantineMaildir, removeTree } from './mailbox-cleanup.js';

export interface JanitorOptions {
  db: AdminDb;
  logger: Logger;
  mailRoot: string;
  intervalSeconds: number;
  /** Сколько карантинов убирать за один проход. */
  batch?: number;
  /**
   * Сроки хранения журналов панели: аудит действий, обращения к ИИ,
   * справочник знакомых адресов и следы подбора пароля.
   *
   * ФУНКЦИЯ, А НЕ ОБЪЕКТ — и это не украшение. Все четыре настройки
   * объявлены в реестре как группа `live`, то есть панель обещает: «новое
   * значение действует со следующего обращения». Уборщик же брал их один
   * раз при создании, из окружения, и держал до перезапуска контейнера —
   * то есть правка в панели не делала ничего вообще. Читаем на каждом
   * проходе: между походами в базу у службы настроек свой короткий кэш,
   * а проход идёт раз в минуту.
   */
  retention?: () => Promise<{
    auditDays: number;
    aiDays: number;
    knownIpDays: number;
    loginFailureDays: number;
  }>;
  /** Часы. Подменяется в тестах, чтобы не ждать сутки ради напоминания. */
  now?: () => number;
}

export interface JanitorRunResult {
  purgedMaildirs: number;
  bytesFreed: number;
  closedSessions: number;
  removedImportJobs: number;
  /** Сколько строк неудачных входов в панель убрано по сроку. */
  removedLoginFailures: number;
  /** Сколько строк журналов панели убрано по срокам: аудит, ИИ, адреса. */
  removedAuditRows: number;
  removedAiRows: number;
  removedKnownIps: number;
  orphanMaildirs: number;
  /** Была ли на этом проходе запись в журнал про осиротевшие каталоги. */
  orphanReported: boolean;
  /**
   * Сколько удалений ящиков упёрлись в предел попыток и больше не берутся
   * в работу. Ноль — норма; всё остальное означает чужую почту, лежащую
   * на диске без срока.
   */
  stuckDeletions: number;
}

/**
 * Как часто напоминать про осиротевшие каталоги, если состав не меняется.
 *
 * Раз в сутки — компромисс между «забыть навсегда» и «долбить каждую
 * минуту»: администратор, читающий журнал за смену, увидит напоминание
 * ровно один раз, а не полторы тысячи.
 */
/**
 * Сколько держим запись о неудачных входах в панель.
 *
 * Тридцать суток — тот срок, за который запись ещё может пригодиться при
 * разборе: «кто и откуда ломился в панель в прошлом месяце». Дальше это
 * просто вес в базе и в резервных копиях.
 */
/**
 * Через сколько минут молчания задание импорта считается брошенным.
 *
 * Промежуточное сохранение идёт не реже чем раз в 25 строк, а строка —
 * это миллисекунды: полчаса тишины у живого импорта не бывает. Запас
 * взят с большим перекрытием намеренно — ошибиться в эту сторону значит
 * подождать, а в другую — закрыть работающее задание.
 */
const IMPORT_STALE_MINUTES = 30;

const LOGIN_FAILURE_KEEP_DAYS = 30;

/**
 * Сколько раз пробуем убрать карантинный каталог, прежде чем отступить.
 *
 * Отступить приходится: каталог может не удаляться по причине, которая
 * сама не пройдёт (том смонтирован только на чтение, чужой владелец), а
 * долбиться в него каждую минуту вечно — значит забить журнал и мешать
 * остальной уборке. Но и молча забыть о нём нельзя: там лежит чужая
 * почта. Поэтому число вынесено сюда и о застрявших записях говорится
 * вслух — в журнале уборщика и в самопроверке панели, где для них есть
 * отдельная проверка и кнопка «попробовать снова».
 */
export const MAX_PURGE_ATTEMPTS = 10;

/** Как часто напоминать о застрявших удалениях, если состав не меняется. */
const STUCK_REMINDER_MS = 24 * 60 * 60 * 1000;

const ORPHAN_REMINDER_MS = 24 * 60 * 60 * 1000;

export class AdminJanitor {
  readonly #opts: JanitorOptions;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  /**
   * Состав осиротевших каталогов, о котором уже сообщено, и когда.
   *
   * Уборщик ходит раз в минуту, а осиротевший каталог живёт неделями:
   * он не удаляется сам, потому что мог быть заведён руками. Без памяти
   * о сказанном одна и та же папка попадала в журнал ~1440 раз в сутки,
   * и настоящие предупреждения в нём тонули. Помним поимённо, а не
   * счётчиком: если одна папка исчезла и появилась другая, количество
   * то же самое, а сообщить надо.
   */
  #orphansReported: ReadonlySet<string> = new Set();
  #orphansReportedAt = 0;
  /** Когда в последний раз говорили про застрявшие удаления. */
  #stuckReportedAt = 0;

  constructor(opts: JanitorOptions) {
    this.#opts = opts;
  }

  start(): void {
    const seconds = this.#opts.intervalSeconds;
    if (seconds <= 0 || this.#timer) return;
    this.#timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => {
        this.#opts.logger.warn(errorInfo(err), 'Проход уборщика админки не удался');
      });
    }, seconds * 1000);
    // Процесс не должен держаться на свете ради уборщика.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Один проход. Возвращает, что именно сделано, — для теста и журнала. */
  async runOnce(): Promise<JanitorRunResult> {
    const result: JanitorRunResult = {
      purgedMaildirs: 0,
      bytesFreed: 0,
      closedSessions: 0,
      removedImportJobs: 0,
      removedLoginFailures: 0,
      removedAuditRows: 0,
      removedAiRows: 0,
      removedKnownIps: 0,
      orphanMaildirs: 0,
      orphanReported: false,
      stuckDeletions: 0,
    };
    // Проходы не должны наезжать друг на друга: удаление большого ящика
    // может не уложиться в интервал.
    if (this.#running) return result;
    this.#running = true;
    try {
      const { db, logger } = this.#opts;

      /* --- 1. карантин -> диск свободен --- */
      const pending = await db.listDeletionsToPurge(this.#opts.batch ?? 20, MAX_PURGE_ATTEMPTS);
      for (const row of pending) {
        if (!row.quarantinePath) {
          /*
           * Карантина нет — но причины у этого ДВЕ, и путать их нельзя.
           *
           * Раньше здесь стояло одно «убирать нечего, закрываем запись».
           * Оно верно ровно для одного случая: каталога не существовало,
           * потому что ящик ни разу не открывали. Второй случай выглядит
           * так же, а означает противоположное: увести каталог в карантин
           * НЕ УДАЛОСЬ (том смонтирован только на чтение, чужой владелец,
           * нет прав). Тогда почта осталась лежать по ЖИВОМУ пути — и
           * доставалась тому, кто заведёт ящик с этим же адресом заново.
           * Запись при этом закрывалась как «убрано».
           *
           * Отличаем по записанной ошибке предыдущей попытки. Есть ошибка
           * — пробуем увести в карантин ещё раз (том могли перемонтировать,
           * права поправить). Не вышло снова — оставляем запись открытой с
           * причиной: пусть висит и попадается на глаза, это честнее, чем
           * зелёная отметка над чужой перепиской.
           */
          if (row.error !== null && row.error !== '') {
            /*
             * СНАЧАЛА — А НЕ ЗАВЕЛИ ЛИ ЯЩИК ЗАНОВО?
             *
             * Повтор ходит по ЖИВОМУ пути каталога, и между попытками
             * адрес мог снова стать чужим... то есть снова стать своим:
             * администратор заводит ящик с тем же адресом, Dovecot
             * открывает тот же каталог, туда приходит новая почта.
             *
             * Дальше уборщик переименовывал этот каталог в карантин и
             * удалял — вместе с перепиской, которой три дня от роду, —
             * и записывал «Каталог удалённого ящика убран с диска».
             *
             * Случай не выдуманный: повтор написан ровно для тех отказов,
             * которые чинят руками (том оказался только на чтение, права
             * не те), и между «не получилось» и «починили» проходят часы,
             * которых хватает, чтобы завести ящик заново.
             *
             * Живой ящик с этим адресом — не повод для уборки: запись об
             * удалении закрываем как исполненную, каталог не трогаем.
             */
            const stillExists = await db.listEmailsIn([row.email]);
            if (stillExists.length > 0) {
              await db.updateMailboxDeletion(row.id, {
                state: 'purged',
                purged: true,
                error: null,
              });
              logger.warn(
                { email: row.email },
                'Ящик с этим адресом заведён заново — каталог не трогаем, запись закрыта',
              );
              continue;
            }
            // Метка карантина — номер записи об удалении, тот же, что
            // ставит маршрут удаления: так каталог одного и того же ящика,
            // удалённого дважды, не перетирает сам себя.
            const retry = await quarantineMaildir(this.#opts.mailRoot, row.email, String(row.id));
            if (retry.quarantinePath === null) {
              await db.updateMailboxDeletion(row.id, {
                bumpAttempts: true,
                error: retry.error ?? row.error,
              });
              logger.warn(
                { email: row.email, path: retry.maildirPath, err: retry.error ?? row.error },
                'Каталог ящика не удалось увести в карантин — запись оставлена открытой',
              );
              continue;
            }
            await db.updateMailboxDeletion(row.id, {
              quarantinePath: retry.quarantinePath,
              maildirPath: retry.maildirPath,
              error: null,
            });
            row.quarantinePath = retry.quarantinePath;
          } else {
            // Каталога не было вовсе — убирать нечего, закрываем запись.
            await db.updateMailboxDeletion(row.id, { state: 'purged', purged: true });
            continue;
          }
        }
        try {
          const bytes = await removeTree(row.quarantinePath);
          await db.updateMailboxDeletion(row.id, {
            state: 'purged',
            purged: true,
            bytesFreed: bytes,
            error: null,
          });
          result.purgedMaildirs += 1;
          result.bytesFreed += bytes;
          logger.info(
            { email: row.email, bytes, path: row.quarantinePath },
            'Каталог удалённого ящика убран с диска',
          );
        } catch (err) {
          await db.updateMailboxDeletion(row.id, {
            bumpAttempts: true,
            error: err instanceof Error ? err.message : String(err),
          });
          logger.warn(errorInfo(err, { email: row.email }), 'Не удалось убрать каталог ящика');
        }
      }

      /*
       * Записи, упёршиеся в предел попыток, из выборки выше уже не
       * приходят — а каталог с чужой почтой лежит на диске. Раньше это
       * было полностью беззвучно: предупреждения пишутся только при
       * обработке строки, а необработанная строка молчит. Говорим о них
       * раз в сутки (чаще — значит утопить настоящие предупреждения) и
       * отдаём число наружу: его показывает самопроверка панели.
       */
      result.stuckDeletions = await db.countStuckDeletions(MAX_PURGE_ATTEMPTS);
      if (result.stuckDeletions > 0) {
        const now = this.#opts.now?.() ?? Date.now();
        if (now - this.#stuckReportedAt >= STUCK_REMINDER_MS) {
          this.#stuckReportedAt = now;
          logger.error(
            { count: result.stuckDeletions, attempts: MAX_PURGE_ATTEMPTS },
            'Удаление ящиков застряло: карантинные каталоги с почтой остаются на диске. ' +
              'Проверьте права на почтовый том и нажмите «Попробовать снова» в разделе обслуживания',
          );
        }
      } else {
        this.#stuckReportedAt = 0;
      }

      /* --- 2. брошенные сеансы входа в чужой ящик --- */
      result.closedSessions = await db.expireStaleMailboxAccess();
      if (result.closedSessions > 0) {
        logger.info(
          { closed: result.closedSessions },
          'Закрыты записи о входе в чужой ящик с истёкшим сроком',
        );
      }

      /* --- 3. просроченные задания импорта --- */
      result.removedImportJobs = await db.deleteExpiredImportJobs();

      /* --- 3а. брошенные задания импорта --- */
      /*
       * Импорт идёт прямо в процессе, принявшем запрос, — работника у
       * него нет. Перезапуск контейнера посреди работы оставлял строку в
       * '''running''' навсегда: страница показывала «идёт» бесконечно, а смена
       * основного домена была запрещена НЕДЕЛЮ (до expires_at) с
       * сообщением «Идёт массовое заведение ящиков», которое неправда.
       */
      const staleImports = await db.failStaleImportJobs(IMPORT_STALE_MINUTES);
      if (staleImports > 0) {
        logger.warn(
          { jobs: staleImports },
          'Задания импорта ящиков, брошенные перезапуском, помечены неудавшимися',
        );
      }

      /* --- 3б. следы подбора паролей к панели --- */
      /*
       * Каждая неудачная попытка входа оставляет строку на пару «логин +
       * адрес». Удаляет её только удачный вход С ТОГО ЖЕ адреса под тем
       * же логином — то есть при переборе случайных логинов с ботнета не
       * удаляет никогда.
       *
       * Уборка для этого была написана вместе с таблицей и с индексом по
       * `updated_at`, но не вызывалась ниоткуда: метод существовал, а
       * работника у него не было. Таблица росла от каждого перебора и
       * оставалась расти после него — ровно то, от чего предостерегает
       * её собственный комментарий.
       *
       * Строки с действующей блокировкой метод не трогает: пока замок
       * держит, его основание должно лежать рядом.
       */
      // Отказ чтения настроек не должен останавливать уборку: тогда
      // работают умолчания, и об этом сказано в журнале.
      const retention = this.#opts.retention
        ? await this.#opts.retention().catch((err: unknown) => {
            logger.warn(
              errorInfo(err),
              'Уборщик: сроки хранения журналов прочитать не удалось. ' +
                'Следы подбора убираются по умолчанию, журналы панели — на следующем проходе',
            );
            return undefined;
          })
        : undefined;
      result.removedLoginFailures = await db.sweepAdminLoginFailures(
        retention?.loginFailureDays ?? LOGIN_FAILURE_KEEP_DAYS,
      );
      if (result.removedLoginFailures > 0) {
        logger.info(
          { removed: result.removedLoginFailures },
          'Уборщик: убраны старые записи о неудачных входах в панель',
        );
      }

      /*
       * --- 3в. журналы панели по срокам ---
       *
       * Журнал действий администраторов, обращения к ИИ и справочник
       * знакомых адресов входа: строка на каждое действие, срока не было
       * ни у одного, а в резервную копию попадают все три.
       */
      if (retention) {
        const swept = await db.sweepAdminLogs({
          auditDays: retention.auditDays,
          aiDays: retention.aiDays,
          knownIpDays: retention.knownIpDays,
        });
        result.removedAuditRows = swept.audit;
        result.removedAiRows = swept.ai;
        result.removedKnownIps = swept.knownIps;
        const total = swept.audit + swept.ai + swept.knownIps;
        if (total > 0) {
          logger.info(swept, 'Уборщик: журналы панели подчищены по срокам хранения');
        }
      }

      /* --- 4. осиротевшие каталоги: только сообщаем, и не на каждом проходе --- */
      const emails = await db.listAllMailboxEmails();
      const orphans = await findOrphanMaildirs(this.#opts.mailRoot, emails);
      result.orphanMaildirs = orphans.length;
      const now = (this.#opts.now ?? Date.now)();
      const current = new Set(orphans);

      if (orphans.length === 0) {
        // Хранилище чисто — забываем сказанное, чтобы повторное появление
        // той же папки снова считалось новостью, а не «уже сообщали».
        this.#orphansReported = current;
        this.#orphansReportedAt = 0;
      } else {
        const appeared = orphans.filter((name) => !this.#orphansReported.has(name));
        // Молчим, пока состав тот же: новость — это ПОЯВЛЕНИЕ каталога.
        // Исчезновение чужой папки само по себе поводом для тревоги не
        // является, но состав всё равно запоминаем ниже.
        const overdue = now - this.#orphansReportedAt >= ORPHAN_REMINDER_MS;
        if (appeared.length > 0 || overdue) {
          logger.warn(
            {
              count: orphans.length,
              sample: orphans.slice(0, 10),
              appeared: appeared.slice(0, 10),
              // Напоминание отличимо от новости: без этого читающий журнал
              // не поймёт, случилось ли что-то или это суточный повтор.
              reason: appeared.length > 0 ? 'appeared' : 'reminder',
            },
            'В почтовом хранилище есть каталоги, которым не соответствует ни один ящик. ' +
              'Сами не удаляем: каталог мог быть заведён вручную. ' +
              'Повторно сообщим при появлении нового каталога или через сутки',
          );
          this.#orphansReportedAt = now;
          result.orphanReported = true;
        }
        this.#orphansReported = current;
      }
      return result;
    } finally {
      this.#running = false;
    }
  }
}
