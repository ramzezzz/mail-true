/**
 * Служба отложенных писем: приём срока, список «Отложенных», досрочный
 * возврат и работник, который возвращает письма в назначенный час.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ВОЗВРАТ ДЕЛАЕТ СЕРВЕР, А НЕ БРАУЗЕР
 * ------------------------------------------------------------------
 * Возможность имеет смысл ровно в одном случае: человек отложил письмо
 * и УШЁЛ. В отпуск, в командировку, просто спать. Таймер в браузере
 * умирает вместе с вкладкой, поэтому единственное место, где он может
 * жить, — сервер. Так же это устроено у Fastmail, и они это подчёркивают
 * отдельно: «делаем на сервере, потому что так надёжнее».
 *
 * Войти в чужой ящик без пароля владельца сервер умеет: служебный
 * пользователь Dovecot (`ящик*mtadmin`) — тот самый, которым в ящики
 * входит панель (admin/mailbox.ts) и сборщик почты с чужих ящиков
 * (accounts/service.ts). Третьего способа здесь не заводится, и пароль
 * владельца ради возврата НЕ хранится нигде.
 *
 * ------------------------------------------------------------------
 * ЧТО БУДЕТ ПРИ ПЕРЕЗАПУСКЕ КОНТЕЙНЕРА
 * ------------------------------------------------------------------
 * Ничего. Срок лежит в Postgres, а не в памяти процесса, и «зависших»
 * состояний у записи нет: пока письмо не вернулось, запись остаётся
 * 'pending'. Работник, поднявшись, первым же проходом заберёт всё, чему
 * срок настал, пока сервер лежал, — записи никуда не делись и никакого
 * восстановления не требуют. Именно поэтому здесь нет ничего похожего на
 * resetRunning() сборщика почты: там состояние 'running' живёт в базе и
 * его действительно надо сбрасывать, здесь — нечего.
 *
 * ------------------------------------------------------------------
 * ЧТО БУДЕТ, ЕСЛИ В СРОК НЕДОСТУПЕН DOVECOT
 * ------------------------------------------------------------------
 * Запись останется живой, число попыток вырастет на единицу, причина ляжет
 * в last_error — и следующий проход попробует снова. Сдаваться нельзя:
 * недоступность почтового сервера проходит сама, а «сдались» означало бы
 * письмо, которое не вернётся никогда. Поэтому предела попыток здесь нет
 * вовсе; после SNOOZE_LOUD_AFTER неудач сообщение в журнале становится
 * предупреждением — чтобы копящиеся письма было видно до того, как о них
 * спросит человек.
 */
import { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import type { Folder } from '@mail-true/shared';
import type { AppConfig } from '../config.js';
import { ApiError, BadRequestError, NotFoundError, UpstreamUnavailableError } from '../errors.js';
import { existingUids, groupIdsByFolder, requireFolder, requireOrCreateFolder } from '../imap/service.js';
import { errorInfo } from '../log.js';
import type { SnoozeStore, SnoozedRow } from './snooze-db.js';
import {
  SNOOZE_FOLDER_ID,
  copyToSnooze,
  discardCopies,
  readSourceInfo,
  returnSnoozed,
} from './snooze-mailbox.js';
import { checkSnoozeRequest, type SnoozeRequest } from './snooze-schedule.js';

/** Как часто работник проверяет, кому пора возвращаться. */
export const SNOOZE_TICK_MS = 30_000;
/** Сколько писем возвращается за один проход. */
export const SNOOZE_BATCH = 100;
/** После скольких неудач подряд жаловаться в журнал громко. */
export const SNOOZE_LOUD_AFTER = 5;

/** Модуль выключен: нет базы или не применена миграция. */
export class SnoozeUnavailableError extends ApiError {
  constructor(message: string) {
    super(503, 'SNOOZE_UNAVAILABLE', message);
  }
}

/** Отложенное письмо в форме, которую читает интерфейс. */
export interface SnoozedItem {
  /** Составной идентификатор письма в папке «Отложенные». */
  id: string;
  subject: string;
  from: string;
  /** Когда вернётся (ISO). */
  wakeAt: string;
  preset: string;
  /** Откуда его отложили — путь IMAP, для подсказки в строке. */
  originPath: string;
  /**
   * Срок не сохранился: письмо лежит в «Отложенных», а записи о нём нет.
   * Так выглядит письмо, положенное сюда вручную, и письмо, у которого
   * обрыв случился между копией и записью срока. Такое письмо само не
   * вернётся — и интерфейс обязан сказать об этом прямо, а не молчать.
   */
  orphan: boolean;
}

export interface SnoozeServiceOptions {
  config: AppConfig;
  logger: Logger;
  master: { user: string; password: string; separator: string } | null;
  /**
   * Чем открывать чужой ящик. По умолчанию — служебный вход в Dovecot.
   *
   * Подменяется в проверках, и это не «дырка для тестов»: без подмены
   * убедиться, что при недоступном Dovecot срок НЕ теряется, можно было бы
   * только выключив настоящий Dovecot — то есть на деле никак. А это ровно
   * тот случай, ради которого возможность и делается серверной.
   */
  connect?: ((email: string) => Promise<ImapFlow>) | undefined;
}

/** Вход в ящик служебным пользователем: `ящик*mtadmin`. */
export function masterLogin(email: string, user: string, separator: string): string {
  return `${email}${separator}${user}`;
}

export class SnoozeService {
  readonly #opts: SnoozeServiceOptions;
  /**
   * Хранилище появляется ПОСЛЕ проверки схемы, а не в конструкторе.
   *
   * Проверка схемы — это запрос к Postgres, то есть ожидание, а сборка
   * маршрутов ждать не должна: почта обязана подняться и с лежащей базой.
   * Поэтому служба рождается выключенной и включается сама, когда
   * выяснится, что миграция применена (см. routes/messages.ts).
   */
  #store: SnoozeStore | null = null;
  #reason: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(opts: SnoozeServiceOptions) {
    this.#opts = opts;
  }

  /** Включает возможность: база на месте, миграция применена. */
  attachStore(store: SnoozeStore): void {
    this.#store = store;
    this.#reason = null;
  }

  /** Выключает возможность с объяснением, которое увидит человек. */
  disable(reason: string): void {
    this.#store = null;
    this.#reason = reason;
  }

  /** Возможность доступна: есть база с применённой миграцией. */
  get available(): boolean {
    return this.#store !== null;
  }

  /**
   * Возврат по расписанию возможен: вдобавок настроен служебный вход.
   *
   * Разделено намеренно. Без базы отложить письмо нельзя вовсе. Без
   * служебного входа отложить можно, но вернуть само оно не сможет — и об
   * этом надо предупреждать ДО того, как человек на это понадеется.
   */
  get scheduledReturnAvailable(): boolean {
    return this.available && this.#opts.master !== null;
  }

  get unavailableReason(): string | null {
    return this.#reason;
  }

  #requireStore(): SnoozeStore {
    const store = this.#store;
    if (!store) {
      throw new SnoozeUnavailableError(
        this.#reason ?? 'Отложить письмо нельзя: не настроена база данных (DATABASE_URL)',
      );
    }
    return store;
  }

  /* ---------------------------------------------------------------- */
  /* Отложить                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Убирает письма в «Отложенные» и записывает срок.
   *
   * Порядок действий и разбор обрывов — в snooze-mailbox.ts, в заголовке
   * файла. Здесь он собран воедино и специально не разнесён по слоям:
   * «копия, запись, удаление» должно читаться одним куском, иначе первая
   * же правка переставит шаги местами.
   */
  async snooze(
    client: ImapFlow,
    accountEmail: string,
    ids: string[],
    request: SnoozeRequest,
    now: Date = new Date(),
  ): Promise<{ snoozed: number; wakeAt: string }> {
    const store = this.#requireStore();
    const check = checkSnoozeRequest(request, now);
    if (check.kind === 'invalid') throw new BadRequestError(check.reason);

    const byFolder = groupIdsByFolder(ids);
    // Сперва проверяем ВСЕ папки-источники и только потом трогаем хоть
    // что-нибудь: письмо из несуществующей папки в середине списка не
    // должно оставлять половину пачки отложенной. Тот же порядок, что
    // у перемещения писем (routes/messages.ts).
    const targets: Array<{ folder: Folder; uids: number[] }> = [];
    for (const [folderId, uids] of byFolder) {
      targets.push({ folder: await requireFolder(client, folderId), uids });
    }
    const snoozeFolder = await requireOrCreateFolder(client, SNOOZE_FOLDER_ID);

    let snoozed = 0;
    for (const { folder, uids } of targets) {
      // Письмо уже в «Отложенных»: переносить его само в себя нечего,
      // а срок ему меняют отдельным действием.
      if (folder.path === snoozeFolder.path) continue;

      /* Шаг 1: копия. Под блокировкой исходной папки — и только она. */
      let present: number[] = [];
      let placements: Awaited<ReturnType<typeof copyToSnooze>> = [];
      const lock = await client.getMailboxLock(folder.path);
      try {
        present = await existingUids(client, uids);
        if (present.length === 0) continue;
        const info = await readSourceInfo(client, present);
        placements = await copyToSnooze(client, snoozeFolder, present, info);
      } finally {
        lock.release();
      }

      if (placements.length === 0) {
        // Сервер не сказал, какие номера получили копии. Удалять оригиналы
        // в этом случае нельзя ни при каких обстоятельствах: вернуть их
        // потом будет нечем. Лучше честный отказ, чем письмо в никуда.
        throw new UpstreamUnavailableError(
          'Почтовый сервер не подтвердил перенос письма — оно осталось на месте',
        );
      }

      /* Шаг 2: запись срока. Только после подтверждения сервером. */
      const recorded: number[] = [];
      const orphanCopies: number[] = [];
      for (const placement of placements) {
        try {
          await store.add({
            accountEmail,
            snoozePath: snoozeFolder.path,
            snoozeUid: placement.snoozeUid,
            snoozeUidValidity: placement.snoozeUidValidity,
            originPath: folder.path,
            messageId: placement.info.messageId,
            subject: placement.info.subject,
            fromAddress: placement.info.fromAddress,
            wakeAt: check.at,
            timeZone: check.zoneUsed,
            preset: check.preset,
          });
          recorded.push(placement.sourceUid);
        } catch (err) {
          // Срок не записался. Оригинал ЕЩЁ НА МЕСТЕ (шаг 3 не начинался),
          // поэтому копию убираем — иначе человек получил бы дубль в
          // «Отложенных», который никогда не вернётся.
          orphanCopies.push(placement.snoozeUid);
          this.#opts.logger.warn(
            errorInfo(err, { account: accountEmail, uid: placement.sourceUid }),
            'Не удалось записать срок отложенного письма — письмо осталось на месте',
          );
        }
      }
      if (orphanCopies.length > 0) {
        await discardCopies(client, snoozeFolder.path, orphanCopies);
      }
      if (recorded.length === 0) {
        throw new UpstreamUnavailableError(
          'Не удалось сохранить срок возврата — письмо осталось на месте',
        );
      }

      /* Шаг 3: удаление оригиналов. */
      const removeLock = await client.getMailboxLock(folder.path);
      try {
        await client.messageDelete(recorded, { uid: true });
      } finally {
        removeLock.release();
      }
      snoozed += recorded.length;
    }

    return { snoozed, wakeAt: check.at.toISOString() };
  }

  /* ---------------------------------------------------------------- */
  /* Список и досрочный возврат                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Что лежит в «Отложенных».
   *
   * Список строится по базе И по самой папке, а не только по базе: письмо,
   * положенное в папку руками, и письмо, чей срок не записался при обрыве,
   * в базе не значатся — но в папке они есть, и человек их там видит.
   * Показать список, в котором нет того, что видно глазами, значит соврать.
   */
  async listSnoozed(client: ImapFlow, accountEmail: string): Promise<SnoozedItem[]> {
    const store = this.#requireStore();
    let folder: Folder;
    try {
      folder = await requireFolder(client, SNOOZE_FOLDER_ID);
    } catch (err) {
      // Папки ещё нет — значит, никто ничего не откладывал. Это не ошибка.
      if (err instanceof NotFoundError) return [];
      throw err;
    }

    const rows = await store.listPending(accountEmail);
    const byUid = new Map<number, SnoozedRow>();
    for (const row of rows) {
      if (row.snoozePath === folder.path) byUid.set(row.snoozeUid, row);
    }

    const lock = await client.getMailboxLock(folder.path);
    let uids: number[] = [];
    try {
      uids = await this.#allUids(client);
    } finally {
      lock.release();
    }

    const items: SnoozedItem[] = [];
    for (const uid of uids) {
      const row = byUid.get(uid);
      items.push({
        id: `${folder.id}:${uid}`,
        subject: row?.subject ?? '',
        from: row?.fromAddress ?? '',
        wakeAt: row?.wakeAt ?? '',
        preset: row?.preset ?? 'custom',
        originPath: row?.originPath ?? '',
        orphan: row === undefined,
      });
    }
    // Ближайший срок — первым; письма без срока в конце: они не вернутся
    // сами, и место им не среди тех, что вот-вот приедут.
    items.sort((a, b) => {
      if (a.orphan !== b.orphan) return a.orphan ? 1 : -1;
      return a.wakeAt.localeCompare(b.wakeAt);
    });
    return items;
  }

  /** Все номера писем в уже открытой папке. */
  async #allUids(client: ImapFlow): Promise<number[]> {
    const mailbox = client.mailbox;
    const exists = typeof mailbox === 'object' && mailbox ? mailbox.exists : 0;
    if (exists === 0) return [];
    const found = await client.search({ all: true }, { uid: true });
    return Array.isArray(found) ? found : [];
  }

  /**
   * «Вернуть сейчас».
   *
   * Работает и с письмами, у которых срока в базе нет: письмо в папке —
   * значит, человек его видит и вправе достать. Такое письмо возвращается
   * во «Входящие»: откуда оно пришло, спросить уже не у кого.
   */
  async returnNow(
    client: ImapFlow,
    accountEmail: string,
    ids: string[],
  ): Promise<{ returned: number }> {
    const store = this.#requireStore();
    const folder = await requireFolder(client, SNOOZE_FOLDER_ID);

    const uids: number[] = [];
    for (const [folderId, list] of groupIdsByFolder(ids)) {
      if (folderId !== folder.id) {
        throw new BadRequestError('Вернуть можно только письмо из папки «Отложенные»');
      }
      uids.push(...list);
    }

    const rows = await store.findPendingByUids(accountEmail, folder.path, uids);
    const byUid = new Map(rows.map((row) => [row.snoozeUid, row]));

    let returned = 0;
    for (const uid of uids) {
      const row = byUid.get(uid);
      const outcome = await returnSnoozed(
        client,
        row ??
          // Письмо без записи: возвращаем во «Входящие». resolveReturnPath
          // подставит их сам, потому что такой папки в ящике нет.
          this.#syntheticRow(accountEmail, folder.path, uid),
      );
      if (outcome.kind === 'gone') {
        if (row) await store.close(row.id, 'gone', 'Письма в «Отложенных» уже не было');
        continue;
      }
      if (row) await store.close(row.id, 'cancelled');
      returned += 1;
    }
    return { returned };
  }

  /** Запись «как будто из базы» для письма, срока у которого нет. */
  #syntheticRow(accountEmail: string, snoozePath: string, uid: number): SnoozedRow {
    return {
      id: 0,
      accountEmail,
      snoozePath,
      snoozeUid: uid,
      snoozeUidValidity: 0,
      // Заведомо несуществующий путь: resolveReturnPath отправит письмо
      // во «Входящие» — единственную папку, которая есть в любом ящике.
      originPath: ' ',
      messageId: null,
      subject: '',
      fromAddress: '',
      wakeAt: new Date(0).toISOString(),
      timeZone: null,
      preset: 'custom',
      state: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: new Date(0).toISOString(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Работник                                                          */
  /* ---------------------------------------------------------------- */

  start(intervalMs = SNOOZE_TICK_MS): void {
    if (this.#timer || !this.available) return;
    if (!this.#opts.master) {
      this.#opts.logger.warn(
        'Возврат отложенных писем по расписанию выключен: не настроен служебный ' +
          'пользователь Dovecot (DOVECOT_MASTER_USER/DOVECOT_MASTER_PASSWORD). ' +
          'Отложенные письма придётся возвращать вручную.',
      );
      return;
    }
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    // Таймер не должен сам по себе удерживать процесс живым — как у очереди
    // отложенной отправки и у сборщика почты.
    this.#timer.unref?.();
    this.#opts.logger.info({ everyMs: intervalMs }, 'Возврат отложенных писем запущен');
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Соединение с ящиком служебным пользователем. */
  async #connect(email: string): Promise<ImapFlow> {
    if (this.#opts.connect) return this.#opts.connect(email);
    const master = this.#opts.master;
    if (!master) throw new Error('Служебный пользователь Dovecot не настроен');
    const config = this.#opts.config;
    const client = new ImapFlow({
      host: config.IMAP_HOST,
      port: config.IMAP_PORT,
      secure: config.IMAP_SECURE,
      auth: {
        user: masterLogin(email, master.user, master.separator),
        pass: master.password,
      },
      tls: { rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED },
      logger: false,
      disableAutoIdle: true,
      clientInfo: { name: 'Mail.True Snooze', version: '0.1.0' },
    });
    // Без обработчика событие error валит процесс целиком.
    client.on('error', () => undefined);
    await client.connect();
    return client;
  }

  /**
   * Один проход: вернуть всё, чему пора.
   *
   * Возвращает число вернувшихся писем. Наружу не бросает ничего: это
   * фоновая задача, и её отказ не должен ронять процесс — он должен
   * оказаться в журнале и в last_error записи.
   */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.#running || !this.available) return 0;
    this.#running = true;
    const log = this.#opts.logger;
    let returned = 0;
    try {
      const store = this.#requireStore();
      const due = await store.listDue(now, SNOOZE_BATCH);
      if (due.length === 0) return 0;

      // По одному соединению на ящик, а не на письмо: вход в ящик стоит
      // рукопожатия TLS и запроса к базе пользователей Dovecot.
      const byAccount = new Map<string, SnoozedRow[]>();
      for (const row of due) {
        const list = byAccount.get(row.accountEmail);
        if (list) list.push(row);
        else byAccount.set(row.accountEmail, [row]);
      }

      for (const [email, rows] of byAccount) {
        let client: ImapFlow;
        try {
          client = await this.#connect(email);
        } catch (err) {
          // Dovecot недоступен или отверг служебный вход. Записи остаются
          // живыми: недоступность проходит сама, а сдаться значило бы
          // потерять срок навсегда.
          const message = err instanceof Error ? err.message : String(err);
          for (const row of rows) {
            const attempts = await store.markAttempt(row.id, message).catch(() => 0);
            this.#report(email, row, attempts, message);
          }
          continue;
        }

        try {
          for (const row of rows) {
            try {
              const outcome = await returnSnoozed(client, row);
              if (outcome.kind === 'gone') {
                // Человек сам утащил письмо из «Отложенных» или удалил его.
                // Это НЕ ошибка и не повод останавливать остальные: молча
                // закрываем запись.
                await store.close(row.id, 'gone', 'Письма в «Отложенных» больше нет');
                log.info(
                  { account: email, uid: row.snoozeUid },
                  'Отложенное письмо не вернулось: его нет в папке',
                );
                continue;
              }
              await store.close(row.id, 'returned');
              returned += 1;
              log.info(
                {
                  account: email,
                  uid: row.snoozeUid,
                  path: outcome.path,
                  fellBack: outcome.fellBack,
                },
                'Отложенное письмо вернулось',
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const attempts = await store.markAttempt(row.id, message).catch(() => 0);
              this.#report(email, row, attempts, message);
            }
          }
        } finally {
          await client.logout().catch(() => client.close());
        }
      }
    } catch (err) {
      this.#opts.logger.warn(errorInfo(err), 'Проход возврата отложенных писем не удался');
    } finally {
      this.#running = false;
    }
    return returned;
  }

  /** Неудача возврата: тихо в первый раз, громко — когда письма копятся. */
  #report(email: string, row: SnoozedRow, attempts: number, message: string): void {
    const payload = { account: email, uid: row.snoozeUid, attempts, reason: message };
    if (attempts >= SNOOZE_LOUD_AFTER) {
      this.#opts.logger.warn(payload, 'Отложенное письмо не удаётся вернуть — попробуем снова');
    } else {
      this.#opts.logger.info(payload, 'Возврат отложенного письма отложен до следующего прохода');
    }
  }
}
