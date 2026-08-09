/**
 * Служба заглушённых цепочек: заглушить переписку, снять заглушку,
 * показать подборку «Заглушённые».
 *
 * ==================================================================
 * ГЛАВНОЕ: ЗАГЛУШКА РАБОТАЕТ ПРИ ДОСТАВКЕ, А НЕ В СПИСКЕ
 * ==================================================================
 * Возможность имеет смысл ровно в одном случае: человек закрыл почту и
 * ушёл, а переписка продолжается без него. Заглушка, которая только прячет
 * строки в списке, в этом случае не делает НИЧЕГО: письмо всё равно ляжет
 * во «Входящие», поднимет счётчик непрочитанных и приедет уведомлением на
 * телефон. Поэтому решение принимает Dovecot в момент доставки — по файлу
 * правил Sieve, который эта служба и пишет (settings/sieve-muted.ts).
 *
 * Отсюда порядок действий, и он не переставляем:
 *
 *   1. ЗАПИСЬ в базу. Источник истины — она.
 *   2. ФАЙЛ ПРАВИЛ из базы целиком + пересборка личного скрипта (в нём
 *      стоит строка `include`). Не удалось — запись СНИМАЕТСЯ обратно и
 *      человек получает отказ. Молча оставить запись нельзя: подборка
 *      «Заглушённые» показывала бы переписку заглушённой, а письма
 *      продолжали бы приходить во «Входящие».
 *   3. ПЕРЕНОС уже пришедших писем в «Заглушённые». Последним, потому что
 *      он не обязателен для обещания («дальше не будет приходить») и
 *      потому что его отказ не должен отменять заглушку.
 *
 * ==================================================================
 * ЧЕГО ЗДЕСЬ НЕТ: РАБОТНИКА
 * ==================================================================
 * В отличие от отложенных писем, ждать здесь нечего: всё, что происходит
 * после нажатия кнопки, делает Dovecot сам. Поэтому ни таймера, ни
 * служебного входа в ящик этой возможности не нужно — и не заводится.
 */
import type { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import type { Folder } from '@mail-true/shared';
import { ApiError, BadRequestError, UpstreamUnavailableError } from '../errors.js';
import {
  existingUids,
  groupIdsByFolder,
  moveUids,
  requireFolder,
  requireOrCreateFolder,
  storeFlags,
} from '../imap/service.js';
import { errorInfo } from '../log.js';
import { rawHeaderValue } from './header-charset.js';
import type { MuteStore, MutedRow } from './mute-db.js';
import { groupThreads, threadIdentity, type ThreadHeaderSource } from './mute-thread.js';
import type { SieveIncludeStore } from '../settings/sieve-include.js';
import { MUTED_INCLUDE_NAME } from '../settings/sieve.js';
import { buildMutedSieveScript, MUTED_FOLDER_ID, MUTED_MAX_IDS } from '../settings/sieve-muted.js';

/** Письмо из ящика в том виде, в каком его читает разбор переписок. */
interface MuteSource extends ThreadHeaderSource {
  subject: string;
  fromAddress: string;
  /**
   * Составной идентификатор письма `${folderId}:${uid}`.
   *
   * Нужен затем, чтобы переносить в «Заглушённые» ТОЛЬКО письма тех
   * переписок, которые в самом деле заглушены. Раньше в перенос уходил
   * исходный список выделенного, и письмо, которое заглушить нельзя (нет
   * Message-ID — обычное дело у кривых рассыльщиков) и которое служба
   * честно пропустила, всё равно уезжало из «Входящих» и помечалось
   * прочитанным. Вернуть его было нечем: в подборке «Заглушённые» его
   * нет — она строится по базе, — а ключа переписки не существует.
   */
  id: string;
}

/** Модуль выключен: нет базы или не применена миграция. */
export class MuteUnavailableError extends ApiError {
  constructor(message: string) {
    super(503, 'MUTE_UNAVAILABLE', message);
  }
}

export const MUTE_MIGRATION_HINT =
  'Заглушить переписку нельзя: не применена миграция ' +
  'infra/postgres/migrations/0001_baseline.sql. Почта работает как обычно.';

/** Заглушённая переписка в форме, которую читает интерфейс. */
export interface MutedThreadItem {
  /** Ключ переписки — им же она и расглушается. */
  key: string;
  subject: string;
  from: string;
  /** Когда заглушили (ISO). */
  mutedAt: string;
  /** Сколько идентификаторов писем узнаёт эта запись. */
  knownMessages: number;
}

export interface MuteServiceOptions {
  logger: Logger;
  /**
   * Куда класть включаемый файл Sieve.
   *
   * Функцией, а не значением: раздел настроек, которому принадлежит
   * хранилище, подключается к приложению ПОЗЖЕ работы с письмами
   * (см. app.ts), и взятое при сборке значение оказалось бы пустым.
   * Спрашиваем в момент использования — тогда оно уже есть.
   */
  includes: () => SieveIncludeStore;
  /**
   * Пересборка личного файла правил ящика.
   *
   * Нужна ровно по одной причине: строка `include` живёт в личном скрипте,
   * а личного скрипта у человека без правил и автоответчика может не быть
   * вовсе. Возвращает то, что случилось, — интерфейс обязан узнать, что
   * заглушка не доехала до почты, а не радоваться зря.
   */
  syncSieve: (email: string) => Promise<{ written: boolean; error: string }>;
}

export class MuteService {
  readonly #opts: MuteServiceOptions;
  /**
   * Хранилище появляется ПОСЛЕ проверки схемы, а не в конструкторе:
   * сборка маршрутов не должна ждать Postgres — почта обязана подняться
   * и с лежащей базой (тот же приём, что у отложенных писем).
   */
  #store: MuteStore | null = null;
  #reason: string | null = null;

  constructor(opts: MuteServiceOptions) {
    this.#opts = opts;
  }

  attachStore(store: MuteStore): void {
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
   * Заглушка доедет до доставки: вдобавок к базе есть доступ к хранилищу
   * скриптов Dovecot.
   *
   * Отдельно от `available` намеренно. Без базы заглушить нельзя вовсе.
   * Без доступа к хранилищу — можно записать и показать подборку, но новые
   * письма всё равно пойдут во «Входящие»; об этом надо предупреждать ДО
   * того, как человек на заглушку понадеется, а не после.
   */
  get deliveryAvailable(): boolean {
    return this.available && this.#opts.includes().enabled;
  }

  get unavailableReason(): string | null {
    return this.#reason;
  }

  #requireStore(): MuteStore {
    const store = this.#store;
    if (!store) {
      throw new MuteUnavailableError(
        this.#reason ?? 'Заглушить переписку нельзя: не настроена база данных (DATABASE_URL)',
      );
    }
    return store;
  }

  /* ---------------------------------------------------------------- */
  /* Подборка «Заглушённые»                                            */
  /* ---------------------------------------------------------------- */

  async list(accountEmail: string): Promise<MutedThreadItem[]> {
    const store = this.#requireStore();
    const rows = await store.listMuted(accountEmail);
    return rows.map((row) => ({
      key: row.threadKey,
      subject: row.subject,
      from: row.fromAddress,
      mutedAt: row.createdAt,
      knownMessages: row.messageIds.length,
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Заглушить                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Заглушает переписки, которым принадлежат указанные письма.
   *
   * Письма приходят строками списка, уже развёрнутыми в переписку
   * (интерфейс делает это через expandThreadIds): человек заглушает
   * РАЗГОВОР, а не письмо, и решать, что в разговор входит, должен тот,
   * кто видит список, а не тот, кто читает заголовки.
   */
  async mute(
    client: ImapFlow,
    accountEmail: string,
    ids: string[],
  ): Promise<{ muted: number; moved: number; deliveryError: string }> {
    const store = this.#requireStore();
    const sources = await this.#readHeaders(client, ids);
    if (sources.length === 0) {
      throw new BadRequestError('Этих писем в ящике уже нет — заглушать нечего');
    }

    /*
     * Выделить пять строк из разных разговоров и нажать «Заглушить» —
     * законное действие, поэтому письма сперва разбираются по перепискам.
     * Записей будет столько, сколько разговоров: подборка «Заглушённые»
     * покажет каждый своей строкой, и снять их можно будет поодиночке.
     */
    const groups = groupThreads(sources);
    const written: string[] = [];
    /** Письма заглушённых переписок — только их и уносим из «Входящих». */
    const mutedIds: string[] = [];
    for (const group of groups) {
      const identity = threadIdentity(group);
      if (identity.threadKey === '' || identity.messageIds.length === 0) {
        /*
         * Письмо без Message-ID и без ссылок. Такое шлют кривые рассыльщики,
         * и узнать его продолжение при доставке нечем: заголовков, по которым
         * оно связано со следующим письмом, попросту нет. Пропускаем — молча
         * заглушить его всё равно невозможно, а отказывать из-за одного
         * такого письма во всей пачке значит не сделать ничего.
         */
        continue;
      }
      const newest = group[group.length - 1];
      const row = await store.mute({
        accountEmail,
        threadKey: identity.threadKey,
        messageIds: identity.messageIds,
        subject: newest?.subject ?? '',
        fromAddress: newest?.fromAddress ?? '',
      });
      written.push(row.threadKey);
      // Переносим потом ровно эти письма — и только их (см. MuteSource.id).
      for (const item of group) mutedIds.push(item.id);
    }

    if (written.length === 0) {
      throw new BadRequestError(
        'Эту переписку нельзя заглушить: у писем нет заголовка Message-ID, ' +
          'по которому узнаётся их продолжение',
      );
    }

    let deliveryError = '';
    try {
      deliveryError = await this.refreshScript(accountEmail);
    } catch (err) {
      // Файл правил не записался — обещание не выполнено. Записи снимаем,
      // иначе подборка врала бы человеку: «заглушено», а письма идут.
      for (const key of written) await store.lift(accountEmail, key).catch(() => false);
      throw new UpstreamUnavailableError(
        'Не удалось записать правило доставки — переписка НЕ заглушена: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    const moved = await this.#moveToMuted(client, mutedIds).catch((err: unknown) => {
      // Перенос уже пришедших писем — не часть обещания: обещано, что
      // дальше письма не будут приходить во «Входящие», и это уже сделано.
      this.#opts.logger.warn(
        errorInfo(err, { account: accountEmail }),
        'Заглушённая переписка записана, но перенести её письма не удалось',
      );
      return 0;
    });

    return { muted: written.length, moved, deliveryError };
  }

  /** Снимает заглушку. Уже пришедшее остаётся в «Заглушённых». */
  /**
   * Снять заглушку с переписок ВЫДЕЛЕННЫХ ПИСЕМ.
   *
   * Ровно то, что обещает кнопка «Вернуть переписку». Раньше её нажатие
   * снимало заглушку со ВСЕХ записей ящика: браузер брал ключи из всей
   * подборки, независимо от выделения. Человек выделял одну переписку,
   * нажимал кнопку в единственном числе — и разом возвращал во «Входящие»
   * всё, от чего прятался неделями. Подтверждения при этом не было.
   *
   * Вторая половина той же беды: список ключей уходил одним запросом, а
   * схема тела ограничивает его сотней. Как только заглушённых переписок
   * становилось больше ста, снять заглушку было НЕЧЕМ — единственный путь
   * в продукте всегда отвечал 400.
   *
   * Ключ переписки в самом письме не лежит, поэтому он вычисляется здесь
   * из заголовков — тем же разбором, что и при заглушении.
   */
  async unmuteByMessages(
    client: ImapFlow,
    accountEmail: string,
    ids: string[],
  ): Promise<{ lifted: number }> {
    const sources = await this.#readHeaders(client, ids);
    const keys = new Set<string>();
    for (const group of groupThreads(sources)) {
      const identity = threadIdentity(group);
      if (identity.threadKey !== '') keys.add(identity.threadKey);
    }
    if (keys.size === 0) return { lifted: 0 };
    return this.unmute(accountEmail, [...keys]);
  }

  async unmute(accountEmail: string, keys: string[]): Promise<{ lifted: number }> {
    const store = this.#requireStore();
    const lifted: string[] = [];
    for (const key of keys) {
      if (await store.lift(accountEmail, key)) lifted.push(key);
    }
    if (lifted.length === 0) return { lifted: 0 };

    try {
      await this.refreshScript(accountEmail);
    } catch (err) {
      /*
       * ОТКАТ — такой же, как у заглушения выше, и здесь он важнее.
       *
       * Порядок действий один: сперва база, потом файл правил. Если файл
       * не записался (sievec не собрал, docker exec вернул не ноль,
       * транспорт Sieve выключен), у заглушения записи снимались обратно —
       * а у снятия не возвращались, и получалось состояние, из которого
       * нет выхода:
       *
       *   * в базе переписка расглушена, значит ПРОПАЛА из подборки
       *     «Заглушённые» — там только state = 'muted';
       *   * на диске у Dovecot лежит прежний файл со всеми правилами,
       *     включая только что снятое.
       *
       * Дальше каждое новое письмо этой переписки Sieve кладёт в
       * «Заглушённые», помечает прочитанным и обрывает остальные правила.
       * Человек об этом не узнаёт ничем: во «Входящие» не приходит,
       * счётчик не растёт.
       *
       * Починить было нельзя даже намеренно. Повтор снятия возвращал 200
       * и «lifted: 0» — запись уже 'lifted', второй раз lift() отвечает
       * false, а пересборка файла при нуле не запускается. Ключ переписки
       * при этом взять неоткуда: из подборки она исчезла.
       *
       * Вранье здесь дороже, чем у заглушения: там письма шли во
       * «Входящие» вопреки обещанию — это видно; здесь они перестают
       * приходить вопреки обещанию — а этого не видно.
       */
      for (const key of lifted) await store.restore(accountEmail, key).catch(() => false);
      throw new UpstreamUnavailableError(
        'Не удалось переписать правило доставки — заглушка НЕ снята: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    return { lifted: lifted.length };
  }

  /* ---------------------------------------------------------------- */
  /* Файл правил                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Пересобирает включаемый файл ящика по базе и обновляет личный скрипт.
   *
   * Возвращает причину, по которой заглушка НЕ доедет до доставки
   * (пустая строка — всё хорошо). Бросает только тогда, когда файл не
   * записался вовсе.
   */
  async refreshScript(accountEmail: string): Promise<string> {
    const store = this.#requireStore();
    const rows = await store.listMuted(accountEmail);
    const ids = collectIds(rows);
    const script = buildMutedSieveScript(ids, { accountEmail });

    if (script === '') {
      await this.#opts.includes().remove(accountEmail, MUTED_INCLUDE_NAME);
    } else {
      const result = await this.#opts.includes().write(accountEmail, MUTED_INCLUDE_NAME, script);
      if (!result.written) throw new Error(result.error || 'файл правил не записан');
    }

    // Личный скрипт нужен даже без единого правила пользователя: строка
    // include живёт именно в нём (см. settings/service.ts, needsScript).
    const sync = await this.#opts.syncSieve(accountEmail);
    /*
     * И последним действием — убрать СОБРАННЫЙ личный скрипт. Именно
     * последним: пересборка выше кладёт в ящик свежий `.dovecot.svbin`,
     * а собран он отдельно запущенным `sievec`, который включаемые файлы
     * не разрешает вовсе (см. шапку settings/sieve-include.ts). Без этого
     * шага в ящике остался бы собранный скрипт, ничего не знающий о
     * заглушённых цепочках.
     */
    await this.#opts.includes().invalidateCompiled(accountEmail);
    return sync.written ? '' : sync.error;
  }

  /* ---------------------------------------------------------------- */
  /* Ящик                                                              */
  /* ---------------------------------------------------------------- */

  /** Читает у выделенных писем заголовки, по которым узнаётся переписка. */
  async #readHeaders(client: ImapFlow, ids: string[]): Promise<MuteSource[]> {
    const out: MuteSource[] = [];
    for (const [folderId, uids] of groupIdsByFolder(ids)) {
      const folder = await requireFolder(client, folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const present = await existingUids(client, uids);
        if (present.length === 0) continue;
        const fetched = (await client.fetchAll(
          present,
          { uid: true, envelope: true, headers: ['references', 'in-reply-to'] },
          { uid: true },
        )) as
          | Array<{
              uid: number;
              envelope?: {
                subject?: string;
                messageId?: string;
                inReplyTo?: string;
                date?: Date;
                from?: Array<{ address?: string }>;
              };
              headers?: Buffer;
            }>
          | undefined;
        for (const msg of fetched ?? []) {
          const block = msg.headers;
          out.push({
            id: `${folderId}:${String(msg.uid)}`,
            messageId: msg.envelope?.messageId ?? null,
            references: headerText(block, 'references'),
            // In-Reply-To берётся и из конверта, и из заголовков: конверт
            // отдаёт его не всякий сервер, а заголовок есть всегда.
            inReplyTo: msg.envelope?.inReplyTo ?? headerText(block, 'in-reply-to'),
            date: msg.envelope?.date ?? null,
            subject: msg.envelope?.subject ?? '',
            fromAddress: msg.envelope?.from?.[0]?.address ?? '',
          });
        }
      } finally {
        lock.release();
      }
    }
    // По дате: самое новое письмо даёт тему и отправителя для строки подборки.
    out.sort((a, b) => {
      const at = a.date ? a.date.getTime() : 0;
      const bt = b.date ? b.date.getTime() : 0;
      return at - bt;
    });
    return out;
  }

  /** Переносит уже пришедшие письма переписки в «Заглушённые». */
  async #moveToMuted(client: ImapFlow, ids: string[]): Promise<number> {
    const target: Folder = await requireOrCreateFolder(client, MUTED_FOLDER_ID);
    let moved = 0;
    for (const [folderId, uids] of groupIdsByFolder(ids)) {
      const folder = await requireFolder(client, folderId);
      if (folder.path === target.path) continue;
      const lock = await client.getMailboxLock(folder.path);
      try {
        const present = await existingUids(client, uids);
        if (present.length === 0) continue;
        /*
         * Прочитанным помечаем ДО переноса, пока письмо ещё здесь: после
         * MOVE его номера в исходной папке уже нет, а новый номер сервер
         * сообщает не всегда. Непрочитанное письмо в «Заглушённых» портило
         * бы весь смысл — общий счётчик непрочитанных считает все папки.
         */
        await storeFlags(client, present, ['\\Seen'], 'add');
        /*
         * Отказ MOVE обязан быть виден. imapflow отдаёт его возвратом
         * `false`, и раньше число «заглушено и перенесено N» считалось
         * строкой ниже независимо от ответа сервера. Это хуже, чем просто
         * неверное число: письма оставались во «Входящих», но уже
         * прочитанными — то есть пропадали из счётчика непрочитанных и из
         * внимания человека, никуда при этом не уехав.
         */
        moved += await moveUids(client, present, target.path);
      } finally {
        lock.release();
      }
    }
    return moved;
  }
}

/** Значение заголовка из блока сырых заголовков. */
function headerText(block: Buffer | undefined, name: string): string {
  if (!block) return '';
  const raw = rawHeaderValue(block, name);
  return raw ? raw.toString('utf8') : '';
}

/**
 * Собирает идентификаторы всех заглушённых переписок ящика в один список.
 *
 * Порядок — от свежих записей к старым (так их отдаёт база), и предел
 * отрезает именно ХВОСТ: если заглушённых переписок стало больше, чем
 * помещается в файл правил, перестают работать самые давние, а не самые
 * свежие. Обратный порядок означал бы, что человек заглушает переписку
 * и ничего не происходит.
 */
export function collectIds(rows: readonly MutedRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const id of row.messageIds) {
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
      if (out.length >= MUTED_MAX_IDS) return out;
    }
  }
  return out;
}
