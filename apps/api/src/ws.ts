/**
 * WebSocket /ws — уведомления о новых письмах.
 * На пользователя открывается отдельное IMAP-соединение с IDLE на INBOX;
 * при появлении новых писем всем сокетам пользователя рассылается событие.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ НАБЛЮДЕНИЕ ПЕРЕЖИВАЕТ ЗАКРЫТУЮ ВКЛАДКУ
 * ------------------------------------------------------------------
 * Раньше наблюдение закрывалось вместе с последним сокетом — и это было
 * ровно то, что нужно, пока уведомления показывала сама страница.
 *
 * С уведомлениями при ЗАКРЫТОЙ вкладке так нельзя: закрылась вкладка —
 * закрылось наблюдение, и о новом письме просто НЕКОМУ узнать. Никакой
 * push не уйдёт, потому что событие не случится. Возможность выглядела бы
 * работающей (подписка есть, ключи есть, проверочное уведомление
 * приходит) и молчала бы на настоящих письмах — худший из возможных
 * дефектов: проверить его можно только терпением.
 *
 * Поэтому: пока у ящика есть подписка на доставку, наблюдение живёт и без
 * вкладок — но не дольше `PUSH_WATCH_MAX_MS` (по умолчанию сутки).
 *
 * Чего здесь СОЗНАТЕЛЬНО нет: сохранения пароля. Наблюдение держится на
 * пароле из живого сеанса и после перезапуска сервера не возобновляется
 * само — до первого открытия почты. Хранить пароли ящиков ради того,
 * чтобы наблюдение переживало перезапуск, — цена, несоразмерная выгоде:
 * это почтовый сервер, который ставят как раз затем, чтобы лишнего о
 * переписке нигде не оставалось.
 */
import type { FastifyInstance } from 'fastify';
import { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import { mapAddress } from './mail/summary.js';
import type { AppConfig } from './config.js';
import { errorInfo } from './log.js';
import type { PushService } from './push/service.js';

/** Минимальный структурный тип сокета (в проекте нет @types/ws). */
interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'close' | 'error' | 'message', cb: (...args: unknown[]) => void): void;
}

const WS_OPEN = 1;

interface Watcher {
  client: ImapFlow;
  sockets: Set<WsLike>;
  closed: boolean;
  /** Адрес и пароль ящика: нужны, чтобы собрать содержимое уведомления. */
  email: string;
  password: string;
  /**
   * Отпечатки браузеров, в которых сейчас открыта вкладка почты.
   *
   * По ним решается, кому НЕ слать push: браузер с открытой вкладкой
   * покажет окно сам, и второе такое же от Service Worker было бы
   * дублем. Отпечаток на браузер, а не на вкладку: вкладок в одном
   * браузере бывает несколько, а окно нужно одно.
   */
  clients: Map<WsLike, string>;
  /**
   * До какого момента наблюдение живёт без единой открытой вкладки.
   * 0 — не живёт вовсе (подписок на доставку у ящика нет).
   */
  keepAliveUntil: number;
}

/**
 * Сколько наблюдение живёт после закрытия последней вкладки.
 *
 * Сутки — не «побольше на всякий случай», а сознательный предел.
 * Соединение IDLE занимает место в Dovecot и в памяти сервера приложения,
 * а пароль ящика всё это время лежит в памяти процесса. Держать это
 * неделями ради человека, который закрыл почту и ушёл в отпуск, — плохая
 * сделка; сутки покрывают обычную ночь и обычные выходные не покрывают
 * намеренно.
 */
export const WATCH_KEEP_ALIVE_MS = 24 * 3600 * 1000;

/** Как часто проверяем, не пора ли закрыть осиротевшее наблюдение. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Пора ли закрыть наблюдение: вкладок нет и срок вышел. */
export function watchExpired(
  watcher: { sockets: { size: number }; keepAliveUntil: number },
  now: number,
): boolean {
  return watcher.sockets.size === 0 && watcher.keepAliveUntil <= now;
}

export class MailNotifier {
  private readonly watchers = new Map<string, Watcher>();
  private sweeper: NodeJS.Timeout | null = null;
  /**
   * Рассылка уведомлений. Подключается извне (см. app.ts), а не создаётся
   * здесь: наблюдатель за ящиками не должен знать ни про базу подписок,
   * ни про службы доставки, ни про помощника ИИ.
   */
  private push: PushService | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /** Подключает рассылку уведомлений при закрытой вкладке. */
  attachPush(push: PushService): void {
    this.push = push;
  }

  /**
   * Событие в открытые вкладки одного ящика. `false` — вкладок нет.
   *
   * Единственный способ сказать человеку что-то СРАЗУ, пока он смотрит
   * на почту. Пользуется этим отправка писем: когда письмо из очереди
   * окончательно не уходит, об этом нельзя молчать до следующего захода
   * в «Черновики» (см. routes/compose.ts, onGiveUp).
   *
   * Ответ важен: `false` значит, что сказать было некому, и полагаться
   * на это событие как на единственный способ известить нельзя — рядом
   * с ним обязана лежать запись, которая дождётся человека.
   */
  notify(email: string, payload: unknown): boolean {
    const watcher = this.watchers.get(email);
    if (!watcher || watcher.closed || watcher.sockets.size === 0) return false;
    this.broadcast(watcher, payload);
    return true;
  }

  private broadcast(watcher: Watcher, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const socket of watcher.sockets) {
      if (socket.readyState === WS_OPEN) {
        try {
          socket.send(data);
        } catch {
          /* сокет закрывается */
        }
      }
    }
  }

  /** Открывает (или переиспользует) IDLE-наблюдателя для пользователя. */
  private async ensureWatcher(email: string, password: string): Promise<Watcher> {
    const existing = this.watchers.get(email);
    if (existing && !existing.closed && existing.client.usable) return existing;

    const client = new ImapFlow({
      host: this.config.IMAP_HOST,
      port: this.config.IMAP_PORT,
      secure: this.config.IMAP_SECURE,
      auth: { user: email, pass: password },
      tls: { rejectUnauthorized: this.config.TLS_REJECT_UNAUTHORIZED },
      logger: false,
      clientInfo: { name: 'Mail.True-IDLE', version: '0.1.0' },
    });
    const watcher: Watcher = {
      client,
      sockets: new Set(),
      closed: false,
      email,
      password,
      clients: new Map(),
      keepAliveUntil: 0,
    };

    // Слушатели вешаются ДО подключения: необработанное событие 'error'
    // на источнике событий убивает процесс Node целиком, а рвётся
    // соединение чаще всего именно на подключении
    client.on('error', (err: unknown) => {
      this.logger.warn(errorInfo(err, { email }), 'Ошибка IDLE-соединения');
      watcher.closed = true;
      if (this.watchers.get(email) === watcher) this.watchers.delete(email);
      try {
        client.close();
      } catch {
        /* уже закрыто */
      }
    });
    client.on('close', () => {
      watcher.closed = true;
      if (this.watchers.get(email) === watcher) this.watchers.delete(email);
      this.broadcast(watcher, { type: 'idle-lost' });
    });
    client.on('exists', (event: { path: string; count: number; prevCount: number }) => {
      void this.onNewMessages(watcher, event).catch((err) => {
        this.logger.warn(
          errorInfo(err, { email }),
          'Не удалось прочитать новые письма для уведомления',
        );
      });
    });

    try {
      await client.connect();
      await client.mailboxOpen('INBOX');
    } catch (err) {
      watcher.closed = true;
      try {
        client.close();
      } catch {
        /* уже закрыто */
      }
      throw err;
    }

    this.watchers.set(email, watcher);
    return watcher;
  }

  private async onNewMessages(
    watcher: Watcher,
    event: { count: number; prevCount: number },
  ): Promise<void> {
    if (event.count <= event.prevCount) return;
    const range = `${event.prevCount + 1}:${event.count}`;
    const fetched = await watcher.client.fetchAll(range, {
      uid: true,
      envelope: true,
      flags: true,
    });
    for (const msg of fetched) {
      const id = `inbox:${msg.uid}`;
      const from = mapAddress(msg.envelope?.from?.[0]);
      const subject = msg.envelope?.subject ?? '';
      const date = (msg.envelope?.date ?? new Date()).toISOString();

      this.broadcast(watcher, {
        type: 'new-message',
        folderId: 'inbox',
        id,
        uid: msg.uid,
        from,
        subject,
        date,
      });

      /*
       * Уведомление при ЗАКРЫТОЙ вкладке.
       *
       * Событие выше увидят только открытые вкладки. Всё остальное —
       * решение «уведомлять ли вообще» (спам, свои письма, тихие часы) и
       * рассылка через службу доставки — живёт в src/push и вызывается
       * отсюда, потому что здесь сервер узнаёт о письме первым.
       *
       * Отказ рассылки не должен ломать живые обновления: письмо в списке
       * появиться обязано, даже если уведомление не ушло.
       */
      if (this.push) {
        void this.push
          .onNewMessage(
            { id: '', email: watcher.email, password: watcher.password },
            {
              id,
              folderId: 'inbox',
              from,
              subject,
              date,
              // Письмо пришло уже прочитанным — так делает фильтр
              // с действием «пометить прочитанным».
              seen: msg.flags?.has('\\Seen') ?? false,
            },
            { liveClientIds: new Set(watcher.clients.values()) },
          )
          .catch((err) => {
            this.logger.warn(
              errorInfo(err, { email: watcher.email }),
              'Не удалось разослать уведомление о новом письме',
            );
          });
      }
    }
  }

  /**
   * Подписывает сокет на уведомления пользователя.
   *
   * `clientId` — отпечаток БРАУЗЕРА (не вкладки), который тот придумал
   * себе сам и хранит у себя. Нужен ровно для одного: пока вкладка
   * открыта, push в этот же браузер не уходит — иначе на одно письмо
   * человек получал бы два одинаковых окна.
   */
  async subscribe(
    email: string,
    password: string,
    socket: WsLike,
    clientId: string | null = null,
  ): Promise<void> {
    const watcher = await this.ensureWatcher(email, password);
    watcher.sockets.add(socket);
    if (clientId) watcher.clients.set(socket, clientId);
    socket.send(JSON.stringify({ type: 'ready' }));

    const cleanup = (): void => {
      watcher.sockets.delete(socket);
      watcher.clients.delete(socket);
      if (watcher.sockets.size > 0) return;
      /*
       * Ушёл последний подписчик. Раньше здесь безусловно закрывалось
       * IDLE-соединение — и с уведомлениями при закрытой вкладке это
       * означало бы, что о новом письме некому узнать (см. шапку файла).
       * Спрашиваем рассылку, есть ли у ящика подписки, и если есть —
       * продолжаем наблюдать ещё сутки.
       */
      void this.keepOrClose(email, watcher);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  private async keepOrClose(email: string, watcher: Watcher): Promise<void> {
    const keep = this.push ? await this.push.hasSubscriptions(email).catch(() => false) : false;
    // За время запроса в базу вкладку могли открыть снова — тогда
    // закрывать нечего и решение отменяется само.
    if (watcher.sockets.size > 0) return;
    if (keep) {
      watcher.keepAliveUntil = Date.now() + WATCH_KEEP_ALIVE_MS;
      this.startSweeper();
      this.logger.debug({ email }, 'Вкладок нет, наблюдение оставлено ради уведомлений');
      return;
    }
    this.closeWatcher(email, watcher);
  }

  private closeWatcher(email: string, watcher: Watcher): void {
    watcher.closed = true;
    if (this.watchers.get(email) === watcher) this.watchers.delete(email);
    watcher.client.logout().catch(() => watcher.client.close());
    if (this.watchers.size === 0) this.stopSweeper();
  }

  /**
   * Уборщик осиротевших наблюдений.
   *
   * Без него соединение, оставленное ради уведомлений, жило бы до
   * перезапуска сервера: сокетов у него нет, и закрыть его больше некому.
   */
  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [email, watcher] of this.watchers) {
        if (watchExpired(watcher, now)) {
          this.logger.debug({ email }, 'Срок наблюдения без вкладок вышел, закрываем');
          this.closeWatcher(email, watcher);
        }
      }
    }, SWEEP_INTERVAL_MS);
    // Таймер не должен держать процесс, когда всё остальное завершилось
    this.sweeper.unref?.();
  }

  private stopSweeper(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = null;
  }

  async closeAll(): Promise<void> {
    this.stopSweeper();
    for (const [email, watcher] of this.watchers) {
      this.watchers.delete(email);
      watcher.closed = true;
      await watcher.client.logout().catch(() => watcher.client.close());
    }
  }
}

/**
 * Отпечаток браузера из строки запроса.
 *
 * Он не секрет и ничего не открывает: сравнивается только с отпечатками
 * подписок ЭТОГО же ящика. Но пришёл он снаружи, поэтому длина ограничена
 * и всё лишнее отбрасывается.
 */
export function clientIdOf(query: unknown): string | null {
  const raw = (query as { client?: unknown } | null)?.client;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 64);
  return trimmed === '' ? null : trimmed;
}

/** Регистрирует маршрут GET /ws (websocket). */
export async function wsRoutes(app: FastifyInstance, notifier: MailNotifier): Promise<void> {
  app.get('/ws', { websocket: true, preHandler: app.requireSession }, (socket, request) => {
    const ws = socket as unknown as WsLike;
    const session = request.mailSession;
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', error: 'UNAUTHORIZED' }));
      ws.close();
      return;
    }
    void notifier
      .subscribe(session.email, session.password, ws, clientIdOf(request.query))
      .catch((err) => {
        request.log.warn(errorInfo(err), 'Не удалось запустить IDLE-подписку');
        ws.send(JSON.stringify({ type: 'error', error: 'IDLE_FAILED' }));
        ws.close();
      });
  });
}
