/**
 * WebSocket /ws — уведомления о новых письмах.
 * На пользователя открывается отдельное IMAP-соединение с IDLE на INBOX;
 * при появлении новых писем всем сокетам пользователя рассылается событие.
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
}

export class MailNotifier {
  private readonly watchers = new Map<string, Watcher>();
  /**
   * Рассылка уведомлений. Подключается извне (см. app.ts), а не создаётся
   * здесь: наблюдатель за ящиками не должен знать ни про базу подписок,
   * ни про службы доставки, ни про помощника ИИ.
   */
  private push: PushService | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  /** Подключает рассылку уведомлений при закрытой вкладке. */
  attachPush(push: PushService): void {
    this.push = push;
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
        this.logger.warn(errorInfo(err, { email }), 'Не удалось прочитать новые письма для уведомления');
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
    event: { count: number; prevCount: number }
  ): Promise<void> {
    if (event.count <= event.prevCount) return;
    const range = `${event.prevCount + 1}:${event.count}`;
    const fetched = await watcher.client.fetchAll(range, { uid: true, envelope: true, flags: true });
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
      if (watcher.sockets.size === 0) {
        // Последний подписчик ушёл — закрываем IDLE-соединение
        watcher.closed = true;
        this.watchers.delete(email);
        watcher.client.logout().catch(() => watcher.client.close());
      }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  async closeAll(): Promise<void> {
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
