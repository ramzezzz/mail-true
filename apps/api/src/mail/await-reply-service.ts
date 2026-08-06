/**
 * Служба «напомнить, если не ответили»: приём срока, подборка «Ждут
 * ответа», отмена и работник, который к сроку проверяет, был ли ответ.
 *
 * ==================================================================
 * ПОЧЕМУ ЭТО СЕРВЕР, А НЕ БРАУЗЕР
 * ==================================================================
 * По той же причине, что и возврат отложенных писем (mail/snooze-service.ts,
 * там это разобрано подробно): срок в три дня переживает и закрытую вкладку,
 * и перезапуск контейнера, и отпуск. Поэтому и ждёт, и проверяет — сервер,
 * а в чужой ящик он входит служебным пользователем Dovecot (`ящик*mtadmin`),
 * тем же самым, которым туда входят панель, сборщик чужой почты и возврат
 * отложенных писем. Пароль владельца ради напоминания не хранится нигде.
 *
 * Планировщик здесь СВОЙ, но устроен один в один как у отложенных писем и
 * по той же причине: одна запись — одна задача, и её отказ не должен
 * останавливать остальные. Второй раз тот же код не пишется — общий у них
 * разбор сроков (mail/snooze-schedule.ts): «завтра утром» обязано означать
 * одно и то же в обеих возможностях, и две реализации этого правила
 * разошлись бы при первой правке.
 *
 * ==================================================================
 * ЧТО ПРОИСХОДИТ В СРОК
 * ==================================================================
 * Ответ есть  — запись закрывается, человек не видит НИЧЕГО. Это главное
 *               свойство возможности: напоминание, срабатывающее всегда, —
 *               это просто ещё одно письмо в почте.
 * Ответа нет  — копия отправленного письма кладётся во «Входящие»
 *               непрочитанной и закреплённой наверху, с пометкой «ответа
 *               нет». Именно копия: «Отправленные» должны остаться полной
 *               записью того, что человек отправлял, и вынимать оттуда
 *               письмо ради напоминания нельзя.
 *
 * Отдельного письма-напоминания не шлётся (так и написано в разборе,
 * docs/gaps.md, п. 4): письмо от самого себя — это шум, который человек
 * научится пропускать за неделю.
 */
import { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import type { Folder, FolderRole } from '@mail-true/shared';
import type { AppConfig } from '../config.js';
import { ApiError, BadRequestError } from '../errors.js';
import {
  existingUids,
  groupIdsByFolder,
  listFolders,
  requireFolder,
  searchUids,
} from '../imap/service.js';
import { errorInfo } from '../log.js';
import { rawHeaderValue } from './header-charset.js';
import {
  matchReply,
  type AwaitedLetter,
  type ReplyCandidate,
  type ReplyMatch,
} from './await-reply.js';
import type { AwaitingRow, AwaitingStore } from './await-reply-db.js';
import { parseMessageIdList, bareMessageId } from './mute-thread.js';
import { checkSnoozeRequest, type SnoozeRequest } from './snooze-schedule.js';

/** Как часто работник проверяет, кому пора. */
export const AWAIT_TICK_MS = 60_000;
/** Сколько записей проверяется за один проход. */
export const AWAIT_BATCH = 50;
/** После скольких неудач подряд жаловаться в журнал громко. */
export const AWAIT_LOUD_AFTER = 5;

/**
 * Ключевое слово на отправленном письме, пока ответа ждут.
 *
 * Нужно ровно для одного: человек, открывший «Отправленные», должен
 * видеть, на какие письма он поставил ожидание, — иначе единственным
 * местом, где это видно, оказывается подборка, а про неё легко забыть.
 */
export const AWAIT_KEYWORD = '$AwaitReply';

/**
 * Ключевое слово на поднятой копии: «ответа не было».
 *
 * Отдельное от AWAIT_KEYWORD, потому что смысл другой и показывается
 * по-другому: «ждём ответа» — спокойная пометка, «ответа нет» — то,
 * ради чего всё и затевалось.
 */
export const AWAIT_OVERDUE_KEYWORD = '$NoReplyYet';

/** Закрепление вверху списка — то же слово, что у вернувшихся отложенных. */
export const AWAIT_PINNED_KEYWORD = '$Pinned';

/** Роли папок, в которых ответ не ищется. */
const SKIP_ROLES: ReadonlySet<FolderRole> = new Set<FolderRole>([
  // Свои же письма и черновики — не ответы.
  'sent',
  'drafts',
  // Удалённое человек видел и выбросил; спам он не видел вовсе, и считать
  // спам ответом значило бы снимать напоминание из-за письма, которого
  // человеку никто не показал.
  'trash',
  'spam',
]);

/** Модуль выключен: нет базы или не применена миграция. */
export class AwaitUnavailableError extends ApiError {
  constructor(message: string) {
    super(503, 'AWAIT_REPLY_UNAVAILABLE', message);
  }
}

export const AWAIT_MIGRATION_HINT =
  'Ждать ответа нельзя: не применена миграция ' +
  'infra/postgres/migrations/0030_awaiting_replies.sql. Почта работает как обычно.';

/** Строка подборки «Ждут ответа». */
export interface AwaitingItem {
  /** Составной идентификатор отправленного письма. */
  id: string;
  messageId: string;
  subject: string;
  /** Кому писали. */
  to: string;
  /** Когда напомним (ISO). */
  dueAt: string;
  preset: string;
}

export interface AwaitReplyServiceOptions {
  config: AppConfig;
  logger: Logger;
  master: { user: string; password: string; separator: string } | null;
  /** Чем открывать чужой ящик. Подменяется в проверках — см. snooze-service.ts. */
  connect?: ((email: string) => Promise<ImapFlow>) | undefined;
}

export class AwaitReplyService {
  readonly #opts: AwaitReplyServiceOptions;
  #store: AwaitingStore | null = null;
  #reason: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(opts: AwaitReplyServiceOptions) {
    this.#opts = opts;
  }

  attachStore(store: AwaitingStore): void {
    this.#store = store;
    this.#reason = null;
  }

  disable(reason: string): void {
    this.#store = null;
    this.#reason = reason;
  }

  get available(): boolean {
    return this.#store !== null;
  }

  /**
   * Напоминание сработает само: вдобавок настроен служебный вход.
   *
   * Разделено намеренно, как у отложенных писем. Без базы ждать ответа
   * нельзя вовсе. Без служебного входа поставить срок можно, но проверить
   * его сервер не сможет — и об этом надо предупреждать ДО того, как
   * человек на срок понадеется.
   */
  get scheduledCheckAvailable(): boolean {
    return this.available && this.#opts.master !== null;
  }

  get unavailableReason(): string | null {
    return this.#reason;
  }

  #requireStore(): AwaitingStore {
    const store = this.#store;
    if (!store) {
      throw new AwaitUnavailableError(
        this.#reason ?? 'Ждать ответа нельзя: не настроена база данных (DATABASE_URL)',
      );
    }
    return store;
  }

  /* ---------------------------------------------------------------- */
  /* Поставить срок                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Ставит ожидание ответа на отправленные письма.
   *
   * Только на письма из «Отправленных», и это не придирка: ждать ответа
   * можно на то, что ты написал. Ожидание на чужом письме означало бы
   * «напомни, если Я не отвечу» — совсем другая возможность, и делать
   * её видом этой значило бы соврать в названии кнопки.
   */
  async wait(
    client: ImapFlow,
    accountEmail: string,
    ids: string[],
    request: SnoozeRequest,
    now: Date = new Date(),
  ): Promise<{ waiting: number; dueAt: string }> {
    const store = this.#requireStore();
    const check = checkSnoozeRequest(request, now);
    if (check.kind === 'invalid') throw new BadRequestError(check.reason);

    let waiting = 0;
    for (const [folderId, uids] of groupIdsByFolder(ids)) {
      const folder = await requireFolder(client, folderId);
      if (folder.role !== 'sent') {
        throw new BadRequestError(
          'Ждать ответа можно только на своё отправленное письмо — ' +
            'выберите его в папке «Отправленные»',
        );
      }
      const lock = await client.getMailboxLock(folder.path);
      try {
        const present = await existingUids(client, uids);
        if (present.length === 0) continue;
        const uidValidity = currentUidValidity(client);
        const letters = await readSentLetters(client, present);
        for (const letter of letters) {
          if (!letter.messageId) {
            /*
             * Письмо без Message-ID. Узнать ответ на него по ссылкам
             * невозможно, а одной запасной проверки (тот же адресат и та
             * же тема) для обещания «напомню, только если не ответили»
             * мало: она ошибается в сторону «ответ был», и ожидание тихо
             * снималось бы от любого письма собеседника с похожей темой.
             * Честный отказ лучше.
             */
            throw new BadRequestError(
              'У этого письма нет заголовка Message-ID — узнать ответ на него не по чему',
            );
          }
          await store.add({
            accountEmail,
            sentPath: folder.path,
            sentUid: letter.uid,
            sentUidValidity: uidValidity,
            messageId: letter.messageId,
            subject: letter.subject,
            toAddresses: letter.to.join(', '),
            sentAt: letter.date ?? now,
            dueAt: check.at,
            timeZone: check.zoneUsed,
            preset: check.preset,
          });
          waiting += 1;
        }
        // Пометка на отправленном письме — чтобы ожидание было видно там,
        // где человек его поставил. Отказ здесь не отменяет ожидания.
        await client
          .messageFlagsAdd(present, [AWAIT_KEYWORD], { uid: true })
          .catch(() => undefined);
      } finally {
        lock.release();
      }
    }

    if (waiting === 0) {
      throw new BadRequestError('Этих писем в «Отправленных» уже нет');
    }
    return { waiting, dueAt: check.at.toISOString() };
  }

  /** Подборка «Ждут ответа». */
  async list(accountEmail: string): Promise<AwaitingItem[]> {
    const store = this.#requireStore();
    const rows = await store.listWaiting(accountEmail);
    return rows.map((row) => ({
      id: `${encodeFolderId(row.sentPath)}:${String(row.sentUid)}`,
      messageId: row.messageId,
      subject: row.subject,
      to: row.toAddresses,
      dueAt: row.dueAt,
      preset: row.preset,
    }));
  }

  /**
   * «Больше не ждать».
   *
   * Снимает ожидание и пометку с письма. Работает и с письмами, записи
   * о которых уже нет: пометка на письме — это то, что человек ВИДИТ,
   * и оставлять её висеть, потому что запись закрылась сама, нельзя.
   */
  async cancel(
    client: ImapFlow,
    accountEmail: string,
    ids: string[],
  ): Promise<{ cancelled: number }> {
    const store = this.#requireStore();
    let cancelled = 0;
    for (const [folderId, uids] of groupIdsByFolder(ids)) {
      const folder = await requireFolder(client, folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const present = await existingUids(client, uids);
        if (present.length === 0) continue;
        const letters = await readSentLetters(client, present);
        for (const letter of letters) {
          if (!letter.messageId) continue;
          if (await store.cancelByMessageId(accountEmail, letter.messageId)) cancelled += 1;
        }
        await client
          .messageFlagsRemove(present, [AWAIT_KEYWORD, AWAIT_OVERDUE_KEYWORD], { uid: true })
          .catch(() => undefined);
      } finally {
        lock.release();
      }
    }
    return { cancelled };
  }

  /* ---------------------------------------------------------------- */
  /* Работник                                                          */
  /* ---------------------------------------------------------------- */

  start(intervalMs = AWAIT_TICK_MS): void {
    if (this.#timer || !this.available) return;
    if (!this.#opts.master) {
      this.#opts.logger.warn(
        'Напоминания об отсутствии ответа выключены: не настроен служебный ' +
          'пользователь Dovecot (DOVECOT_MASTER_USER/DOVECOT_MASTER_PASSWORD).',
      );
      return;
    }
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
    this.#opts.logger.info({ everyMs: intervalMs }, 'Проверка ожидаемых ответов запущена');
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
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
      auth: {
        user: `${email}${master.separator}${master.user}`,
        pass: master.password,
      },
      tls: { rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED },
      logger: false,
      disableAutoIdle: true,
      clientInfo: { name: 'Mail.True AwaitReply', version: '0.1.0' },
    });
    client.on('error', () => undefined);
    await client.connect();
    return client;
  }

  /**
   * Один проход. Возвращает, сколько напоминаний поднято.
   *
   * Наружу не бросает ничего: это фоновая задача, и её отказ обязан
   * оказаться в журнале и в last_error записи, а не уронить процесс.
   */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.#running || !this.available) return 0;
    this.#running = true;
    const log = this.#opts.logger;
    let reminded = 0;
    try {
      const store = this.#requireStore();
      const due = await store.listDue(now, AWAIT_BATCH);
      if (due.length === 0) return 0;

      const byAccount = new Map<string, AwaitingRow[]>();
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
          // Dovecot недоступен. Записи остаются живыми: недоступность
          // проходит сама, а сдаться значило бы напомнить не вовремя или
          // не напомнить вовсе.
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
              const match = await this.findReply(client, row);
              if (match) {
                await store.close(row.id, 'answered', match);
                await this.#clearKeyword(client, row);
                log.info(
                  { account: email, messageId: row.messageId, by: match },
                  'Ответ найден — напоминание не понадобилось',
                );
                continue;
              }
              const raised = await this.raise(client, row);
              if (!raised) {
                await store.close(row.id, 'gone', null, 'Отправленного письма в ящике больше нет');
                continue;
              }
              await store.close(row.id, 'reminded');
              /*
               * Пометку «ждём ответа» с отправленного письма снимаем и
               * здесь тоже. Ждать больше нечего — напоминание уже пришло,
               * — а оставленная пометка означала бы в «Отправленных»
               * неправду: письмо показывалось бы ожидающим ответа вечно,
               * и кнопка «Больше не ждать» предлагала бы отменить то,
               * что уже случилось.
               */
              await this.#clearKeyword(client, row);
              reminded += 1;
              log.info(
                { account: email, messageId: row.messageId },
                'Ответа нет — письмо поднято во «Входящие»',
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
      this.#opts.logger.warn(errorInfo(err), 'Проход проверки ожидаемых ответов не удался');
    } finally {
      this.#running = false;
    }
    return reminded;
  }

  #report(email: string, row: AwaitingRow, attempts: number, message: string): void {
    const payload = { account: email, messageId: row.messageId, attempts, reason: message };
    if (attempts >= AWAIT_LOUD_AFTER) {
      this.#opts.logger.warn(payload, 'Не удаётся проверить ответ — попробуем снова');
    } else {
      this.#opts.logger.info(payload, 'Проверка ответа отложена до следующего прохода');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Поиск ответа и подъём письма                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Ищет ответ на письмо. null — ответа нет.
   *
   * Сперва по ссылкам во всех папках, где ответ может лежать (правило
   * пользователя могло разложить его куда угодно), затем — запасной
   * проверкой по собеседнику и теме. Обе проверки заканчиваются одной и
   * той же функцией matchReply (mail/await-reply.ts): решение о том, что
   * считать ответом, живёт в ОДНОМ месте, а здесь только поиск кандидатов.
   */
  async findReply(client: ImapFlow, row: AwaitingRow): Promise<ReplyMatch> {
    const letter: AwaitedLetter = {
      messageId: row.messageId,
      subject: row.subject,
      recipients: splitAddresses(row.toAddresses),
      sentAt: new Date(row.sentAt),
      selfAddress: row.accountEmail,
    };

    const folders = (await listFolders(client)).filter((f) => !SKIP_ROLES.has(f.role));
    // По ссылкам — сперва и во всех папках: это точная проверка, и она
    // должна отработать раньше широкой.
    for (const folder of folders) {
      const found = await this.#scan(client, folder, letter, {
        or: [
          { header: { 'in-reply-to': row.messageId } },
          { header: { references: row.messageId } },
        ],
      });
      if (found) return found;
    }
    // Запасная: письма собеседника, пришедшие после нашего.
    for (const folder of folders) {
      for (const address of letter.recipients.slice(0, MAX_FALLBACK_RECIPIENTS)) {
        const found = await this.#scan(client, folder, letter, {
          from: address,
          since: letter.sentAt,
        });
        if (found) return found;
      }
    }
    return null;
  }

  /** Пробегает найденные письма папки через matchReply. */
  async #scan(
    client: ImapFlow,
    folder: Folder,
    letter: AwaitedLetter,
    query: Parameters<typeof searchUids>[1],
  ): Promise<ReplyMatch> {
    const lock = await client.getMailboxLock(folder.path).catch(() => null);
    if (!lock) return null;
    try {
      const uids = await searchUids(client, query);
      if (uids.length === 0) return null;
      const candidates = await readCandidates(client, uids.slice(-MAX_CANDIDATES));
      for (const candidate of candidates) {
        const match = matchReply(letter, candidate);
        if (match) return match;
      }
      return null;
    } catch {
      // Папка могла исчезнуть между списком и открытием. Это не повод
      // считать, что ответа нет: остальные папки ещё не смотрели.
      return null;
    } finally {
      lock.release();
    }
  }

  /**
   * Поднимает отправленное письмо во «Входящие».
   *
   * Копией, а не переносом: «Отправленные» обязаны остаться полной записью
   * отправленного. false — письма в «Отправленных» уже нет (человек его
   * удалил), напоминать нечем.
   */
  async raise(client: ImapFlow, row: AwaitingRow): Promise<boolean> {
    const folders = await listFolders(client);
    const inbox = folders.find((f) => f.role === 'inbox');
    const inboxPath = inbox?.path ?? 'INBOX';

    const lock = await client.getMailboxLock(row.sentPath).catch(() => null);
    if (!lock) return false;
    let copied: { uidMap?: Map<number, number> } | boolean;
    let uid: number | null;
    try {
      uid = await this.#locateSent(client, row);
      if (uid === null) return false;
      copied = (await client.messageCopy([uid], inboxPath, { uid: true })) as
        { uidMap?: Map<number, number> } | boolean;
    } finally {
      lock.release();
    }

    let newUid =
      typeof copied === 'object' && copied ? (copied.uidMap?.get(uid) ?? undefined) : undefined;
    const destLock = await client.getMailboxLock(inboxPath).catch(() => null);
    if (!destLock) return true;
    try {
      if (newUid === undefined) {
        // Сервер не сказал номер копии. Ищем её по Message-ID: без пометок
        // и без снятого «прочитано» копия была бы незаметной, а ради
        // заметности всё и делалось.
        const found = await searchUids(client, { header: { 'message-id': row.messageId } });
        newUid = found[found.length - 1];
      }
      if (newUid === undefined) return true;
      await client.messageFlagsRemove([newUid], ['\\Seen'], { uid: true });
      await client.messageFlagsAdd([newUid], [AWAIT_OVERDUE_KEYWORD, AWAIT_PINNED_KEYWORD], {
        uid: true,
      });
    } catch {
      /* пометки — украшение поверх; письмо уже во «Входящих» */
    } finally {
      destLock.release();
    }
    return true;
  }

  /** Снимает пометку «ждём ответа» с отправленного письма. */
  async #clearKeyword(client: ImapFlow, row: AwaitingRow): Promise<void> {
    const lock = await client.getMailboxLock(row.sentPath).catch(() => null);
    if (!lock) return;
    try {
      const uid = await this.#locateSent(client, row);
      if (uid === null) return;
      await client.messageFlagsRemove([uid], [AWAIT_KEYWORD], { uid: true });
    } catch {
      /* пометка — украшение; запись уже закрыта */
    } finally {
      lock.release();
    }
  }

  /**
   * Ищет отправленное письмо в уже открытой папке.
   *
   * Два ключа и тот же порядок, что у отложенных писем: сперва номер
   * (дёшево, но действителен только при совпадении UIDVALIDITY), потом
   * Message-ID (дорого, зато переживает пересоздание папки).
   */
  async #locateSent(client: ImapFlow, row: AwaitingRow): Promise<number | null> {
    const validity = currentUidValidity(client);
    const sameGeneration =
      row.sentUidValidity === 0 || validity === 0 || row.sentUidValidity === validity;
    if (sameGeneration) {
      const present = await existingUids(client, [row.sentUid]);
      if (present.length > 0) return present[0] ?? null;
    }
    const found = await searchUids(client, { header: { 'message-id': row.messageId } });
    return found[0] ?? null;
  }
}

/**
 * Сколько адресатов проверяется запасной проверкой.
 *
 * Письмо на двадцать человек — это рассылка, а не разговор, и ждать
 * ответа «хоть от кого-нибудь из двадцати» смысла не имеет. Пять адресов
 * покрывают обычную переписку и ограничивают число поисков по IMAP.
 */
const MAX_FALLBACK_RECIPIENTS = 5;

/**
 * Сколько найденных писем осматривается в одной папке.
 *
 * Берутся ПОСЛЕДНИЕ: ответ, если он есть, — среди свежих. Предел нужен
 * на случай собеседника, который пишет по сто писем в день: проверка
 * не должна превращаться в вычитывание папки.
 */
const MAX_CANDIDATES = 50;

/** UIDVALIDITY открытой папки. */
function currentUidValidity(client: ImapFlow): number {
  const mailbox = client.mailbox;
  return typeof mailbox === 'object' && mailbox ? Number(mailbox.uidValidity ?? 0) : 0;
}

/** `f-<base64url(путь)>` — та же форма, что у идентификаторов папок. */
function encodeFolderId(path: string): string {
  return 'f-' + Buffer.from(path, 'utf8').toString('base64url');
}

/** Разбирает список адресов «Кому» из базы. */
export function splitAddresses(raw: string): string[] {
  return raw
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '');
}

interface SentLetter {
  uid: number;
  messageId: string | null;
  subject: string;
  to: string[];
  date: Date | null;
}

/** Читает у отправленных писем то, что нужно для ожидания ответа. */
async function readSentLetters(client: ImapFlow, uids: number[]): Promise<SentLetter[]> {
  const fetched = (await client.fetchAll(uids, { uid: true, envelope: true }, { uid: true })) as
    | Array<{
        uid: number;
        envelope?: {
          subject?: string;
          messageId?: string;
          date?: Date;
          to?: Array<{ address?: string }>;
        };
      }>
    | undefined;
  return (fetched ?? []).map((msg) => ({
    uid: msg.uid,
    messageId: bareMessageId(msg.envelope?.messageId),
    subject: msg.envelope?.subject ?? '',
    to: (msg.envelope?.to ?? []).map((a) => a.address ?? '').filter((a) => a !== ''),
    date: msg.envelope?.date ?? null,
  }));
}

/** Читает письма-кандидаты в ответы. Папка уже открыта. */
async function readCandidates(client: ImapFlow, uids: number[]): Promise<ReplyCandidate[]> {
  const fetched = (await client.fetchAll(
    uids,
    { uid: true, envelope: true, headers: ['references', 'in-reply-to', 'auto-submitted'] },
    { uid: true },
  )) as
    | Array<{
        uid: number;
        envelope?: {
          subject?: string;
          inReplyTo?: string;
          date?: Date;
          from?: Array<{ address?: string }>;
        };
        headers?: Buffer;
      }>
    | undefined;

  return (fetched ?? []).map((msg) => {
    const block = msg.headers;
    return {
      fromAddress: msg.envelope?.from?.[0]?.address ?? '',
      subject: msg.envelope?.subject ?? '',
      date: msg.envelope?.date ?? null,
      references: parseMessageIdList(headerText(block, 'references')),
      inReplyTo: parseMessageIdList(msg.envelope?.inReplyTo ?? headerText(block, 'in-reply-to')),
      autoSubmitted: headerText(block, 'auto-submitted'),
    };
  });
}

function headerText(block: Buffer | undefined, name: string): string {
  if (!block) return '';
  const raw = rawHeaderValue(block, name);
  return raw ? raw.toString('utf8') : '';
}
