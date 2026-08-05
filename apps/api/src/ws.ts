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
}

export class MailNotifier {
  private readonly watchers = new Map<string, Watcher>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

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
    const watcher: Watcher = { client, sockets: new Set(), closed: false };

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
      this.broadcast(watcher, {
        type: 'new-message',
        folderId: 'inbox',
        id: `inbox:${msg.uid}`,
        uid: msg.uid,
        from: mapAddress(msg.envelope?.from?.[0]),
        subject: msg.envelope?.subject ?? '',
        date: (msg.envelope?.date ?? new Date()).toISOString(),
      });
    }
  }

  /** Подписывает сокет на уведомления пользователя. */
  async subscribe(email: string, password: string, socket: WsLike): Promise<void> {
    const watcher = await this.ensureWatcher(email, password);
    watcher.sockets.add(socket);
    socket.send(JSON.stringify({ type: 'ready' }));

    const cleanup = (): void => {
      watcher.sockets.delete(socket);
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
      .subscribe(session.email, session.password, ws)
      .catch((err) => {
        request.log.warn(errorInfo(err), 'Не удалось запустить IDLE-подписку');
        ws.send(JSON.stringify({ type: 'error', error: 'IDLE_FAILED' }));
        ws.close();
      });
  });
}
