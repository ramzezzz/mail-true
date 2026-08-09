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
import { UnauthorizedError, UpstreamUnavailableError } from '../errors.js';
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
   * вынули из карты. Раньше такая задача открывала НОВОЕ соединение и
   * клала его в осиротевшую дорожку, а `scheduleIdleClose` потом выходил
   * первой же строкой (`lanes.get(email) !== lane`) — соединение не
   * закрывалось ни по простою, ни повторным `closeUser`, ни `closeAll`
   * при остановке сервера. Заодно ломался главный смысл дорожек: у ящика
   * оказывалось два живых соединения вместо одного, и очередь команд
   * переставала быть общей.
   */
  closed: boolean;
}

function noop(): void {
  /* результат предыдущей задачи очереди не важен */
}

export class ImapPool {
  private readonly lanes = new Map<string, Lane>();

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
     * Дорожку закрыли, пока эта задача стояла в очереди. Открывать ради
     * неё новое соединение нельзя: закрытие означает, что сессии больше
     * нет — человек вышел, или ему сменили пароль, или ящик заблокировали.
     */
    if (lane.closed) {
      throw new UnauthorizedError('Сессия закрыта. Войдите заново.');
    }
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

  private scheduleIdleClose(email: string, lane: Lane): void {
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    lane.idleTimer = null;
    // Пока в очереди есть задачи, дорожка нужна: закрывать нечего и незачем.
    if (lane.pending > 0) return;
    lane.idleTimer = setTimeout(() => {
      if (lane.pending > 0) return;
      // Дорожка могла осиротеть (её вынул closeUser, пока задачи ещё шли).
      // Из карты убираем только свою — но соединение закрываем в любом
      // случае, иначе оно останется висеть до таймаута самого Dovecot.
      if (this.lanes.get(email) === lane) this.lanes.delete(email);
      const client = lane.client;
      lane.client = null;
      if (client) client.logout().catch(() => client.close());
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
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    const client = lane.client;
    lane.client = null;
    if (client) await client.logout().catch(() => client.close());
  }

  /** Закрывает все соединения (останов сервера). */
  async closeAll(): Promise<void> {
    const all = [...this.lanes.keys()];
    await Promise.all(all.map((email) => this.closeUser(email)));
  }

  /** Число открытых соединений — для тестов и диагностики. */
  get openConnections(): number {
    let count = 0;
    for (const lane of this.lanes.values()) if (lane.client) count += 1;
    return count;
  }
}
