/**
 * Пул IMAP-соединений: одно живое соединение на пользователя,
 * переиспользуется между HTTP-запросами, закрывается по таймауту простоя.
 * Обращения одного пользователя сериализуются, чтобы не смешивать
 * состояние выбранного ящика между параллельными запросами.
 *
 * Устройство. На пользователя заводится «дорожка» (Lane): очередь задач плюс
 * соединение. Соединение берётся УЖЕ ВНУТРИ очереди — это принципиально:
 *
 *  1. Раньше проверка «есть ли соединение» и его открытие стояли до очереди и
 *     не были защищены от гонки: 60 параллельных запросов видели пустой пул
 *     одновременно и открывали 60 соединений. Стек упирался в
 *     `mail_max_userip_connections` Dovecot, часть запросов падала, а вход
 *     блокировался на пять минут — до истечения таймаутов.
 *  2. Задача, уже поставленная в очередь, получала ссылку на клиента, взятую
 *     до её запуска. Если соединение к этому моменту умирало, задача падала с
 *     `Connection not available` и отдавала 500 вместо 503, а очередь так и
 *     работала с мёртвым соединением до конца.
 *
 * Теперь соединение открывается ровно одно на пользователя (гонки нет по
 * построению: acquire выполняется только в хвосте очереди), а каждая задача
 * получает живого клиента — при необходимости переоткрытого.
 */
import { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import { UpstreamUnavailableError } from '../errors.js';
import { isConnectionLost, toApiError } from './errors.js';
import { errorInfo } from '../log.js';

export interface ImapPoolOptions {
  host: string;
  port: number;
  secure: boolean;
  /** Проверять TLS-сертификат сервера (false для self-signed в dev). */
  rejectUnauthorized: boolean;
  /** Мс простоя, после которых соединение закрывается. */
  idleMs: number;
  logger: Logger;
  /** Фабрика клиента. Настоящая по умолчанию, подменяется в тестах. */
  createClient?: (email: string, password: string) => ImapFlow;
}

interface Lane {
  /** Живое соединение пользователя; null — ещё не открыто или уже сломано. */
  client: ImapFlow | null;
  /** Цепочка задач: обращения одного пользователя идут строго по очереди. */
  queue: Promise<unknown>;
  /** Сколько задач в работе и в очереди — дорожку с задачами закрывать нельзя. */
  pending: number;
  idleTimer: NodeJS.Timeout | null;
  /**
   * Дорожку закрыли (выход, смена пароля, блокировка ящика).
   *
   * Признак нужен потому, что закрытие не отменяет очередь: задачи, уже
   * стоявшие в ней, доходят до `acquire` уже после того, как дорожку
   * вынули из карты. Такая задача открывает НОВОЕ соединение и кладёт его
   * в осиротевшую дорожку — а закрыть его потом было нечем: сторож простоя
   * выходил первой же строкой (`lanes.get(email) !== lane`), повторный
   * `closeUser` этой дорожки не находил, `closeAll` при остановке сервера
   * — тоже. Соединение висело до собственного таймаута Dovecot, и у ящика
   * всё это время было два живых соединения вместо одного: очередь команд
   * переставала быть общей.
   *
   * По этому признаку осиротевшая дорожка закрывает своё соединение сразу,
   * как только доделает задачи (см. scheduleIdleClose): ждать простоя ей
   * незачем — переиспользовать её уже некому, в карте её нет.
   */
  closed: boolean;
}

function noop(): void {
  /* результат предыдущей задачи очереди не важен */
}

export class ImapPool {
  private readonly lanes = new Map<string, Lane>();
  /**
   * Дорожки, вынутые из карты, но ещё доделывающие свои задачи.
   *
   * Соединение такая дорожка открывает уже ПОСЛЕ закрытия, и по карте
   * пользователей её не найти — а закрывать надо: остановка сервера обязана
   * закрыть все соединения до единого. Их и держим здесь, отдельным списком.
   */
  private readonly orphans = new Set<Lane>();

  constructor(private readonly opts: ImapPoolOptions) {}

  /** Создаёт нового IMAP-клиента (без подключения). */
  private makeClient(email: string, password: string): ImapFlow {
    if (this.opts.createClient) return this.opts.createClient(email, password);
    return new ImapFlow({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure,
      auth: { user: email, pass: password },
      tls: { rejectUnauthorized: this.opts.rejectUnauthorized },
      logger: false,
      // IDLE в пуле не нужен: соединение живёт только ради команд
      disableAutoIdle: true,
      clientInfo: { name: 'Mail.True', version: '0.1.0' },
    });
  }

  /** Проверка логина и пароля отдельным короткоживущим соединением. */
  async verify(email: string, password: string): Promise<void> {
    const client = this.makeClient(email, password);
    // Слушатель ошибок вешается ДО подключения: необработанное событие 'error'
    // на источнике событий убивает процесс Node целиком.
    client.on('error', (err: unknown) => {
      this.opts.logger.warn(
        errorInfo(err, { email }),
        'Ошибка IMAP-соединения при проверке логина',
      );
    });
    try {
      await client.connect();
      await client.logout().catch(() => client.close());
    } catch (err) {
      client.close();
      const apiErr = toApiError(err);
      if (apiErr.code !== 'AUTH_FAILED') {
        this.opts.logger.warn(errorInfo(err), 'IMAP недоступен при проверке логина');
      }
      throw apiErr;
    }
  }

  private laneFor(email: string): Lane {
    const existing = this.lanes.get(email);
    if (existing) return existing;
    const lane: Lane = {
      client: null,
      queue: Promise.resolve(),
      pending: 0,
      idleTimer: null,
      closed: false,
    };
    this.lanes.set(email, lane);
    return lane;
  }

  /** Забывает сломанное соединение, чтобы следующая задача открыла новое. */
  private dropClient(lane: Lane, client: ImapFlow): void {
    if (lane.client === client) lane.client = null;
    try {
      client.close();
    } catch {
      /* соединение уже закрыто */
    }
  }

  /**
   * Возвращает живого клиента дорожки, при необходимости открывая соединение.
   * Вызывается только из хвоста очереди — второй одновременный вызов невозможен.
   */
  private async acquire(email: string, password: string, lane: Lane): Promise<ImapFlow> {
    /*
     * Дорожку могли закрыть, пока эта задача стояла в очереди, — и это НЕ
     * повод ей отказывать.
     *
     * Здесь стоял отказ 401 «Сессия закрыта», и он бил не по тому: дорожка
     * одна на АДРЕС, а не на сессию. Человек, вышедший в одном браузере,
     * ронял задачи своих же живых сессий — второй вкладки, телефона, —
     * если они в этот момент стояли в очереди. Браузер такой 401 считает
     * концом сессии и уводит на экран входа, не повторяя запрос. Окно
     * невелико, но приходится ровно на длинные операции (поиск по всему
     * ящику, разбор, массовый перенос) — то есть тогда, когда очередь и
     * не пуста. Тем же способом обычный перезапуск сервера разлогинивал
     * тех, у кого шла долгая работа: closeAll помечает все дорожки до
     * того, как Fastify перестанет принимать запросы.
     *
     * Закрытую сессию отсеивает проверка сессии, а не пул: до сюда
     * доходит только тот, чья сессия жива. Задача просто открывает своё
     * соединение — а закрывает его осиротевшая дорожка сама, доделав
     * задачи (см. scheduleIdleClose и closeAll).
     */
    const existing = lane.client;
    if (existing && existing.usable) return existing;
    if (existing) this.dropClient(lane, existing);

    const client = this.makeClient(email, password);
    client.on('error', (err: unknown) => {
      this.opts.logger.warn(errorInfo(err, { email }), 'Ошибка IMAP-соединения в пуле');
      this.dropClient(lane, client);
    });
    client.on('close', () => {
      if (lane.client === client) lane.client = null;
    });

    try {
      await client.connect();
    } catch (err) {
      client.close();
      const apiErr = toApiError(err);
      if (apiErr.code !== 'AUTH_FAILED') {
        this.opts.logger.warn(errorInfo(err), 'Не удалось открыть IMAP-соединение');
      }
      throw apiErr;
    }
    lane.client = client;
    return client;
  }

  /** Закрывает соединение дорожки, не трогая ни карту, ни список сирот. */
  private closeLane(lane: Lane): Promise<void> {
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    lane.idleTimer = null;
    const client = lane.client;
    lane.client = null;
    if (!client) return Promise.resolve();
    return client.logout().catch(() => {
      client.close();
    });
  }

  private scheduleIdleClose(email: string, lane: Lane): void {
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    lane.idleTimer = null;
    // Пока в очереди есть задачи, дорожка нужна: закрывать нечего и незачем.
    if (lane.pending > 0) return;
    /*
     * Осиротевшая дорожка закрывается СРАЗУ, а не через время простоя.
     *
     * Ждать простоя ей незачем: в карте её нет, переиспользовать соединение
     * некому — оно только занимало бы место в пределе Dovecot на число
     * соединений ящика. Раньше её не закрывал никто: сторож простоя выходил
     * первой же строкой (дорожка в карте уже другая), а таймер вдобавок
     * unref-нут — при остановке процесса он не срабатывает вовсе.
     */
    if (lane.closed) {
      this.orphans.delete(lane);
      void this.closeLane(lane);
      return;
    }
    lane.idleTimer = setTimeout(() => {
      if (lane.pending > 0) return;
      if (this.lanes.get(email) === lane) this.lanes.delete(email);
      void this.closeLane(lane);
    }, this.opts.idleMs);
    // Не держим процесс живым ради таймера
    lane.idleTimer.unref?.();
  }

  /**
   * Выполняет fn с IMAP-клиентом пользователя.
   * Соединение берётся из пула или открывается заново — уже внутри очереди.
   */
  async withClient<T>(
    email: string,
    password: string,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const lane = this.laneFor(email);
    lane.pending += 1;
    if (lane.idleTimer) {
      clearTimeout(lane.idleTimer);
      lane.idleTimer = null;
    }

    const run = async (): Promise<T> => {
      const client = await this.acquire(email, password, lane);
      try {
        return await fn(client);
      } catch (err) {
        if (!isConnectionLost(err)) throw err;
        // Соединение умерло посреди работы. Клиенту — 503 по контракту
        // (раньше сюда прилетал голый `Error: Connection not available`,
        // и обработчик ошибок отдавал 500). Сломанного клиента забываем,
        // чтобы следующая задача очереди открыла новое соединение, а не
        // билась в то же мёртвое.
        //
        // Повтора здесь намеренно нет: fn может быть неидемпотентной
        // (APPEND в «Отправленные», перемещение), и повтор после обрыва
        // посреди команды способен создать дубль письма.
        this.dropClient(lane, client);
        throw new UpstreamUnavailableError();
      }
    };

    const task = lane.queue.then(run, run);
    lane.queue = task.then(noop, noop);
    try {
      return await task;
    } finally {
      lane.pending -= 1;
      this.scheduleIdleClose(email, lane);
    }
  }

  /** Закрывает соединение пользователя (например, при выходе). */
  async closeUser(email: string): Promise<void> {
    const lane = this.lanes.get(email);
    if (!lane) return;
    this.lanes.delete(email);
    lane.closed = true;
    await this.closeLane(lane);
    // Задачи, уже стоящие в очереди, доделаются и откроют СВОЁ соединение —
    // значит, дорожку нельзя терять из виду, пока они не кончатся.
    if (lane.pending > 0) this.orphans.add(lane);
  }

  /** Закрывает все соединения (останов сервера). */
  async closeAll(): Promise<void> {
    const all = [...this.lanes.keys()];
    // Осиротевшие дорожки — тоже соединения, и до Dovecot им дела нет:
    // без этого они висели бы до его собственного таймаута уже после того,
    // как наш процесс погас.
    const orphans = [...this.orphans];
    this.orphans.clear();
    await Promise.all([
      ...all.map((email) => this.closeUser(email)),
      ...orphans.map((lane) => this.closeLane(lane)),
    ]);
  }

  /** Число открытых соединений — для тестов и диагностики. */
  get openConnections(): number {
    let count = 0;
    for (const lane of this.lanes.values()) if (lane.client) count += 1;
    // Соединение осиротевшей дорожки — такое же соединение к Dovecot.
    // Пока их здесь не считали, любая проверка «после закрытия соединений
    // не осталось» была истинна сама по себе: closeUser первым делом
    // вынимает дорожку из карты, а считалось только по карте.
    for (const lane of this.orphans) if (lane.client) count += 1;
    return count;
  }
}
