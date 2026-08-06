/**
 * Сборщик указателя переписки: читает конверты писем и складывает адреса
 * в базу.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ СБОРЩИК, А НЕ ЗАПРОС К IMAP НА КАЖДУЮ БУКВУ
 * ------------------------------------------------------------------
 * Тот же довод, что и у сборщика истории доставки (admin/flow-collector.ts):
 * источник дорогой, а спрашивают его часто. Выборка конвертов ящика — это
 * секунды; подсказка обязана появляться за миллисекунды, пока человек
 * набирает следующую букву. Между этими двумя числами нет ничего, кроме
 * заранее собранного указателя.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПРОХОД ИДЁТ ОТ НОВЫХ ПИСЕМ К СТАРЫМ
 * ------------------------------------------------------------------
 * Ящик, заведённый вчера, и ящик с десятью тысячами писем — это две
 * разные задачи, и решать их одинаково нельзя.
 *
 *   * Вчерашний ящик разбирается целиком за один заход, и говорить тут
 *     не о чем.
 *   * В ящике на десять тысяч писем разбор «с самого начала» означает
 *     минуты работы, в течение которых подсказка не знает НИЧЕГО. А самые
 *     нужные адреса лежат в последних письмах: с кем переписывались на
 *     этой неделе, тому и напишут завтра.
 *
 * Поэтому первый заход берёт хвост — свежие письма, — и подсказка начинает
 * работать сразу. Остальное добирается порциями в фоне, пока не кончится.
 * Ровно так же поступает сборщик истории доставки с журналом Postfix,
 * и по той же причине: полезное «сейчас и приблизительно» лучше
 * бесполезного «через минуту и точно».
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПОРЦИИ МАЛЕНЬКИЕ
 * ------------------------------------------------------------------
 * Соединение с Dovecot у пользователя одно и общее (imap/pool.ts): все
 * его запросы идут по нему строго по очереди. Значит, длинная выборка
 * сборщика встала бы поперёк списка писем и открытия письма — человек
 * увидел бы, что почта «задумалась», и был бы прав. Каждая порция —
 * отдельная задача в очереди, между ними вклиниваются запросы интерфейса.
 */
import type { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type { ImapPool } from '../imap/pool.js';
import { detectRole, isServiceFolder, type RawFolderInfo } from '../mail/folders.js';
import type { MailSession } from '../types.js';
import type { ContactCursor, ContactsDb, HarvestRole } from './db.js';
import { foldObservations, observationsFromEnvelope, type ContactObservation } from './observations.js';
import { normalizeAddress } from './tokens.js';

export interface ContactHarvesterOptions {
  db: ContactsDb;
  pool: ImapPool;
  logger: Logger;
  /** Сколько писем разбирать одной порцией. */
  chunkSize?: number;
  /** Сколько порций добора старой почты за один заход. */
  chunksPerRun?: number;
  /** Пауза между заходами дальнейшего добора, мс. */
  backfillPauseMs?: number;
  /** Не повторять заход по новой почте чаще, чем раз в столько мс. */
  freshnessMs?: number;
  /**
   * Сообщает наружу, разобран ли ящик целиком.
   *
   * Нужно ровно для одного: интерфейс не должен говорить «ничего не
   * найдено», пока сборщик ещё идёт по старым письмам. Правда в этот
   * момент другая — «пока не всё просмотрено», и сказать её можно только
   * зная состояние сборщика.
   */
  onProgress?: (email: string, complete: boolean) => void;
}

export interface HarvestOutcome {
  /** Сколько писем разобрано за этот заход. */
  scanned: number;
  /** Сколько строк указателя затронуто. */
  contacts: number;
  /** Осталась ли неразобранная старая почта. */
  more: boolean;
}

const EMPTY: HarvestOutcome = { scanned: 0, contacts: 0, more: false };

/** Роли папок, из которых берутся адреса, и в каком порядке. */
const ROLES: readonly HarvestRole[] = ['sent', 'inbox'];

export interface HarvestRequest {
  session: MailSession;
  /**
   * Пополнять ли указатель из ПОЛУЧЕННЫХ писем.
   *
   * Это настройка «автоматически пополнять контакты» из общих настроек
   * ящика. Отправленные письма собираются всегда и от неё не зависят:
   * человек сам выбрал этот адрес и сам его набрал — запоминать то, что
   * он только что сделал своими руками, разрешения не требует. А вот
   * адреса из входящих — это уже сведения о том, кто ему пишет, и здесь
   * решает он.
   */
  collectReceived: boolean;
}

type HarvesterSettings = Required<Omit<ContactHarvesterOptions, 'onProgress'>> &
  Pick<ContactHarvesterOptions, 'onProgress'>;

export class ContactHarvester {
  readonly #opts: HarvesterSettings;
  /** Заходы одного ящика не должны накладываться друг на друга. */
  readonly #inflight = new Map<string, Promise<HarvestOutcome>>();
  /** Когда по этому ящику последний раз смотрели новую почту. */
  readonly #lastFresh = new Map<string, number>();
  #closed = false;

  constructor(opts: ContactHarvesterOptions) {
    this.#opts = {
      chunkSize: 500,
      chunksPerRun: 4,
      backfillPauseMs: 300,
      freshnessMs: 30_000,
      ...opts,
    };
  }

  /** Останавливает дальнейшие фоновые заходы (закрытие сервера). */
  close(): void {
    this.#closed = true;
  }

  /**
   * Просит пополнить указатель и НЕ ждёт результата.
   *
   * Подсказка не должна зависеть от сборщика: человек уже начал печатать,
   * и заставлять его ждать выборки писем — значит вернуть ровно ту
   * задержку, ради устранения которой указатель и заведён. Поэтому заход
   * идёт в фоне, а нынешний запрос отвечает по тому, что уже собрано.
   *
   * Ошибки сюда не поднимаются: неудача сборщика — это «подсказка знает
   * меньше», а не «почта сломалась».
   */
  kick(request: HarvestRequest): void {
    if (this.#closed) return;
    void this.#loop(request).catch((err: unknown) => {
      this.#opts.logger.debug(errorInfo(err), 'Сборщик адресов: заход не удался');
    });
  }

  /** Заход за заходом, пока не разобран весь ящик. */
  async #loop(request: HarvestRequest): Promise<void> {
    for (;;) {
      const outcome = await this.run(request);
      this.#opts.onProgress?.(request.session.email, !outcome.more);
      if (!outcome.more || this.#closed) return;
      // Пауза между порциями — не «чтобы не нагрузить сервер», а чтобы
      // очередь соединения досталась запросам человека: он в это время
      // читает почту, и его список писем важнее нашего указателя.
      await new Promise((resolve) => setTimeout(resolve, this.#opts.backfillPauseMs));
    }
  }

  /**
   * Один заход. Повторный вызов, пока предыдущий не закончился,
   * присоединяется к нему, а не запускает второй: два сборщика по одному
   * ящику разобрали бы одни и те же письма дважды и вдвое завысили счётчики.
   */
  async run(request: HarvestRequest): Promise<HarvestOutcome> {
    const key = request.session.email.toLowerCase();
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const started = this.#runOnce(request).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, started);
    return started;
  }

  async #runOnce(request: HarvestRequest): Promise<HarvestOutcome> {
    const { session } = request;
    const account = session.email.toLowerCase();
    const own = new Set<string>();
    const self = normalizeAddress(session.email);
    if (self) own.add(self);

    let cursors: ContactCursor[];
    try {
      cursors = await this.#opts.db.cursors(account);
    } catch (err) {
      this.#opts.logger.debug(errorInfo(err), 'Сборщик адресов: отметки не прочитаны');
      return EMPTY;
    }

    const total: HarvestOutcome = { scanned: 0, contacts: 0, more: false };
    for (const role of ROLES) {
      if (role === 'inbox' && !request.collectReceived) continue;
      const before = cursors.find((c) => c.role === role) ?? null;
      const outcome = await this.#harvestRole(session, account, role, before, own);
      total.scanned += outcome.scanned;
      total.contacts += outcome.contacts;
      total.more ||= outcome.more;
    }
    return total;
  }

  async #harvestRole(
    session: MailSession,
    account: string,
    role: HarvestRole,
    before: ContactCursor | null,
    own: ReadonlySet<string>,
  ): Promise<HarvestOutcome> {
    const { db, pool, logger, chunkSize, chunksPerRun, freshnessMs } = this.#opts;
    const freshKey = `${account}:${role}`;
    const now = Date.now();
    // Новая почта проверяется не чаще, чем раз в freshnessMs. Без этого
    // каждая нажатая буква в поле «Кому» отправляла бы команду в Dovecot —
    // ровно то, от чего указатель и должен избавить.
    const checkFresh = (this.#lastFresh.get(freshKey) ?? 0) + freshnessMs <= now;
    const needBackfill = !before || !before.backfillDone;
    if (!checkFresh && !needBackfill) return EMPTY;

    let scanned = 0;
    let contacts = 0;
    let more = false;

    try {
      /*
       * Первое обращение — только осмотреться: где лежит папка, сменился ли
       * UIDVALIDITY и что осталось разобрать. Ничего тяжёлого здесь нет.
       */
      const plan = await pool.withClient(session.email, session.password, async (client) => {
        const path = await folderPathForRole(client, role);
        if (!path) return null;
        const lock = await client.getMailboxLock(path);
        try {
          const mailbox = client.mailbox;
          if (!mailbox || typeof mailbox === 'boolean') return null;
          const uidValidity = Number(mailbox.uidValidity ?? 0);
          const uidNext = Number(mailbox.uidNext ?? 0);
          const exists = Number(mailbox.exists ?? 0);

          /*
           * Смена UIDVALIDITY по RFC 3501 значит: прежние номера писем
           * больше ничего не значат. Продолжать с них — верный способ
           * пропустить всю папку целиком, приняв чужие номера за свои,
           * и никогда об этом не узнать.
           */
          const cursor: ContactCursor =
            before && before.uidValidity === uidValidity
              ? { ...before }
              : { role, uidValidity, topUid: 0, bottomUid: 0, backfillDone: false, scanned: 0 };

          if (exists === 0) {
            // Пустая папка — разбирать нечего, и добирать тоже.
            cursor.backfillDone = true;
            cursor.topUid = Math.max(cursor.topUid, uidNext - 1);
            await db.saveCursor(account, cursor);
            return null;
          }
          return {
            path,
            cursor,
            ranges: planRanges(cursor, uidNext, chunkSize, chunksPerRun, checkFresh),
          };
        } finally {
          lock.release();
        }
      });

      if (!plan) {
        if (checkFresh) this.#lastFresh.set(freshKey, now);
        return EMPTY;
      }

      /*
       * Каждая порция — ОТДЕЛЬНОЕ обращение к пулу, а не общий заход на все
       * сразу. Это принципиально: соединение с Dovecot у пользователя одно
       * и общее (imap/pool.ts), и все его запросы идут по нему строго по
       * очереди. Заход, удерживающий соединение на две с половиной тысячи
       * писем, встал бы поперёк списка писем и открытия письма — человек
       * увидел бы, что почта «задумалась», и был бы прав. Отдельные задачи
       * дают запросам интерфейса вклиниться между порциями; лишний SELECT
       * папки на порцию рядом с этим ничего не стоит.
       */
      let cursor = plan.cursor;
      for (const range of plan.ranges) {
        const batch = await pool.withClient(session.email, session.password, async (client) => {
          const lock = await client.getMailboxLock(plan.path);
          try {
            return await this.#scanRange(client, range, role, own);
          } finally {
            lock.release();
          }
        });
        scanned += batch.scanned;
        if (batch.folded.length > 0) contacts += await db.upsert(account, batch.folded);
        cursor = applyRange(cursor, range, batch.scanned);
        // Отметка сохраняется после КАЖДОЙ порции, а не в конце захода:
        // оборванное соединение посреди разбора не должно заставлять
        // начинать папку сначала — и тем более разбирать её дважды.
        await db.saveCursor(account, cursor);
      }
      more = !cursor.backfillDone;
      if (checkFresh) this.#lastFresh.set(freshKey, now);
    } catch (err) {
      // Сборщик — вспомогательная работа. Его отказ не должен ни ронять
      // запрос человека, ни попадать в журнал уровнем «ошибка»: чаще
      // всего это просто оборванное соединение.
      logger.debug(errorInfo(err, { role }), 'Сборщик адресов: папка не разобрана');
      return EMPTY;
    }

    return { scanned, contacts, more };
  }

  /** Разбирает один диапазон UID: конверты -> наблюдения -> свёртка. */
  async #scanRange(
    client: ImapFlow,
    range: UidRange,
    role: HarvestRole,
    own: ReadonlySet<string>,
  ): Promise<{ scanned: number; folded: ReturnType<typeof foldObservations> }> {
    const now = new Date();
    /*
     * Берётся ТОЛЬКО конверт. Ни тела, ни структуры, ни флагов: адреса
     * лежат в конверте, а всё остальное — это мегабайты по сети и работа
     * Dovecot ради сведений, которые тут же будут выброшены.
     */
    const fetched = await client.fetchAll(
      `${range.from}:${range.to}`,
      { uid: true, envelope: true },
      { uid: true },
    );
    const observations: ContactObservation[] = [];
    for (const msg of fetched) {
      if (!msg.envelope) continue;
      observations.push(...observationsFromEnvelope(msg.envelope, role, own, now));
    }
    return { scanned: fetched.length, folded: foldObservations(observations) };
  }
}

/* ------------------------------------------------------------------ */
/* Планирование порций — чистые функции, их и проверяют тесты           */
/* ------------------------------------------------------------------ */

/** Диапазон UID и что он означает для отметки сборщика. */
export interface UidRange {
  from: number;
  to: number;
  /** 'forward' — новая почта наверху, 'backfill' — старая внизу. */
  kind: 'forward' | 'backfill';
}

/**
 * Какие диапазоны разобрать в этот заход.
 *
 * Сначала новая почта (её мало, а нужна она больше всего), затем порции
 * добора старой — от последней разобранной вниз.
 *
 * Диапазоны считаются по НОМЕРАМ, а не по количеству писем: номера
 * не сплошные (удалённое письмо оставляет дыру), поэтому порция на 500
 * номеров может дать и 500 писем, и три. Это не беда — важно, что каждый
 * заход двигает границу вниз на фиксированную величину и потому
 * заканчивается за предсказуемое число заходов, а не «когда-нибудь».
 */
export function planRanges(
  cursor: ContactCursor,
  uidNext: number,
  chunkSize: number,
  chunksPerRun: number,
  checkFresh: boolean,
): UidRange[] {
  const ranges: UidRange[] = [];
  const highest = Math.max(0, uidNext - 1);
  // В папке не было ни одного письма за всю её жизнь: разбирать нечего, и
  // диапазон «1:0» отправлять серверу тоже незачем.
  if (highest < 1) return ranges;

  if (cursor.topUid === 0 && cursor.bottomUid === 0) {
    // Первый заход по этой папке: берём хвост — самые свежие письма.
    const from = Math.max(1, highest - chunkSize + 1);
    ranges.push({ from, to: highest, kind: 'forward' });
  } else if (checkFresh && highest > cursor.topUid) {
    ranges.push({ from: cursor.topUid + 1, to: highest, kind: 'forward' });
  }

  // Добор старой почты. Считаем от той границы, какой она станет ПОСЛЕ
  // первого диапазона: иначе первый заход разобрал бы хвост дважды.
  let bottom = ranges.length > 0 && ranges[0]?.kind === 'forward' && cursor.bottomUid === 0
    ? (ranges[0]?.from ?? 1)
    : cursor.bottomUid;
  if (bottom === 0) bottom = 1;

  for (let i = 0; i < chunksPerRun && bottom > 1; i += 1) {
    const to = bottom - 1;
    const from = Math.max(1, to - chunkSize + 1);
    ranges.push({ from, to, kind: 'backfill' });
    bottom = from;
  }
  return ranges;
}

/** Двигает отметку сборщика после разобранного диапазона. */
export function applyRange(cursor: ContactCursor, range: UidRange, scanned: number): ContactCursor {
  const topUid = Math.max(cursor.topUid, range.to);
  const bottomUid = cursor.bottomUid === 0 ? range.from : Math.min(cursor.bottomUid, range.from);
  return {
    ...cursor,
    topUid,
    bottomUid,
    // Дошли до первого номера — старой почты больше нет. Признак нужен,
    // чтобы сборщик перестал ходить в IMAP на каждое обращение к подсказке
    // у ящика, который уже разобран целиком.
    backfillDone: bottomUid <= 1,
    scanned: cursor.scanned + scanned,
  };
}

/**
 * Путь папки по её роли.
 *
 * Не по имени: «Отправленные» называются по-разному в зависимости от
 * клиента, которым ящик заводили, и от языка. Роль вычисляется по флагу
 * \Sent и по перечню известных имён — тем же кодом, каким её вычисляет
 * весь остальной продукт (mail/folders.ts), чтобы сборщик и список папок
 * не расходились в том, какая папка «Отправленные».
 */
export async function folderPathForRole(
  client: ImapFlow,
  role: HarvestRole,
): Promise<string | null> {
  // LIST без статусов: счётчики писем здесь не нужны, а запрос STATUS по
  // каждой папке — это лишний оборот к серверу на каждую папку ящика.
  const listed = await client.list();
  for (const item of listed) {
    if (item.flags?.has('\\Noselect')) continue;
    // Служебные каталоги Dovecot (`dovecot/lda-dupes`, `sieve`) писем не
    // содержат, но в LIST приходят наравне с остальными.
    if (isServiceFolder({ path: item.path, delimiter: item.delimiter })) continue;
    const info: RawFolderInfo = {
      path: item.path,
      name: item.name,
      delimiter: item.delimiter,
      parentPath: item.parentPath,
      specialUse: item.specialUse,
      flags: item.flags,
    };
    if (detectRole(info) === role) return item.path;
  }
  return null;
}
