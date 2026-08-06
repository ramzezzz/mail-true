/**
 * Прямое подключение к чужому ящику.
 *
 * Второй режим из docs/plan.md (этап 9): чужой ящик показывается
 * отдельным деревом папок, письма читаются с чужого сервера на лету,
 * ничего не дублируется. Место не занимается, состояние всегда
 * актуальное; расплата — скорость зависит от чужого сервера, и общий
 * поиск по такому ящику не работает.
 *
 * Соединения держатся в собственном пуле, а не открываются на каждый
 * запрос: чужой сервер обычно медленнее нашего, и логин к нему стоит
 * дороже всего остального вместе взятого. Пул устроен так же, как
 * основной (src/imap/pool.ts): одно соединение на подключение, обращения
 * сериализуются, простаивающее соединение закрывается.
 */
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { Logger } from 'pino';
import type { Folder } from '@mail-true/shared';
import { AuthFailedError, BadRequestError, UpstreamUnavailableError } from '../errors.js';
import { listFolders, listMessages } from '../imap/service.js';
import { findFolderById } from '../mail/folders.js';
import type { ExternalAccount } from './types.js';
import { errorInfo } from '../log.js';

function isAuthError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'authenticationFailed' in err);
}

interface PoolEntry {
  client: ImapFlow;
  queue: Promise<unknown>;
  idleTimer: NodeJS.Timeout | null;
  broken: boolean;
}

export interface ExternalPoolOptions {
  idleMs: number;
  /**
   * Проверять сертификат чужого сервера. Общая настройка сервера
   * (TLS_REJECT_UNAUTHORIZED): в dev-стеке сертификаты самоподписанные,
   * в production проверка включена. Отдельное подключение может ослабить
   * её флагом allowInsecureTls — но не наоборот.
   */
  rejectUnauthorized: boolean;
  logger: Logger;
}

/** Пул соединений с чужими серверами, по одному на подключение. */
export class ExternalImapPool {
  readonly #entries = new Map<string, PoolEntry>();
  readonly #opts: ExternalPoolOptions;

  constructor(opts: ExternalPoolOptions) {
    this.#opts = opts;
  }

  #makeClient(account: ExternalAccount, password: string): ImapFlow {
    return new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      auth: { user: account.imap.user, pass: password },
      logger: false,
      disableAutoIdle: true,
      clientInfo: { name: 'Mail.True', version: '0.1.0' },
      tls: {
        rejectUnauthorized: account.allowInsecureTls ? false : this.#opts.rejectUnauthorized,
      },
    });
  }

  /** Проверка настроек подключением: мастер должен сказать «работает» до сохранения. */
  async verify(account: ExternalAccount, password: string): Promise<void> {
    const client = this.#makeClient(account, password);
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.logout().catch(() => client.close());
    } catch (err) {
      client.close();
      if (isAuthError(err)) throw new AuthFailedError('Чужой сервер отверг логин или пароль');
      this.#opts.logger.warn(errorInfo(err, { host: account.imap.host }), 'Чужой IMAP недоступен');
      throw new UpstreamUnavailableError(
        `Не удалось подключиться к ${account.imap.host}:${String(account.imap.port)}`,
      );
    }
  }

  async #open(key: string, account: ExternalAccount, password: string): Promise<PoolEntry> {
    const client = this.#makeClient(account, password);
    const entry: PoolEntry = { client, queue: Promise.resolve(), idleTimer: null, broken: true };
    try {
      await client.connect();
    } catch (err) {
      client.close();
      if (isAuthError(err)) throw new AuthFailedError('Чужой сервер отверг логин или пароль');
      throw new UpstreamUnavailableError(`Чужой сервер недоступен: ${account.imap.host}`);
    }
    entry.broken = false;
    client.on('close', () => {
      entry.broken = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    client.on('error', (err: unknown) => {
      entry.broken = true;
      this.#opts.logger.warn(errorInfo(err, { key }), 'Ошибка соединения с чужим сервером');
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      try {
        client.close();
      } catch {
        /* уже закрыто */
      }
    });
    return entry;
  }

  #scheduleIdleClose(key: string, entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      entry.client.logout().catch(() => entry.client.close());
    }, this.#opts.idleMs);
    entry.idleTimer.unref?.();
  }

  /** Выполняет fn с соединением к чужому серверу. */
  async withClient<T>(
    ownerEmail: string,
    account: ExternalAccount,
    password: string,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const key = `${ownerEmail.toLowerCase()}#${String(account.id)}`;
    let entry = this.#entries.get(key);
    if (!entry || entry.broken || !entry.client.usable) {
      entry = await this.#open(key, account, password);
      this.#entries.set(key, entry);
    }
    const current = entry;
    if (current.idleTimer) clearTimeout(current.idleTimer);
    const task = current.queue.then(
      () => fn(current.client),
      () => fn(current.client),
    );
    current.queue = task.catch(() => undefined);
    try {
      return await task;
    } finally {
      this.#scheduleIdleClose(key, current);
    }
  }

  /** Закрывает соединение конкретного подключения (удаление, смена пароля). */
  async close(ownerEmail: string, accountId: number): Promise<void> {
    const key = `${ownerEmail.toLowerCase()}#${String(accountId)}`;
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await entry.client.logout().catch(() => entry.client.close());
  }

  async closeAll(): Promise<void> {
    const keys = [...this.#entries.keys()];
    await Promise.all(
      keys.map(async (key) => {
        const entry = this.#entries.get(key);
        if (!entry) return;
        this.#entries.delete(key);
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        await entry.client.logout().catch(() => entry.client.close());
      }),
    );
  }
}

/**
 * Папки чужого ящика.
 *
 * Идентификаторы папок получают приставку `ext<id>:`, чтобы веб-интерфейс
 * не перепутал «Входящие» чужого ящика со своими: дерево показывается
 * отдельным, но живёт в том же списке.
 */
export async function listExternalFolders(client: ImapFlow, accountId: number): Promise<Folder[]> {
  const folders = await listFolders(client);
  const prefix = `ext${String(accountId)}:`;
  return folders.map((folder) => ({
    ...folder,
    id: `${prefix}${folder.id}`,
    parentId: folder.parentId === null ? null : `${prefix}${folder.parentId}`,
  }));
}

/** Убирает приставку `ext<id>:` с идентификатора папки. */
export function stripExternalPrefix(folderId: string, accountId: number): string {
  const prefix = `ext${String(accountId)}:`;
  return folderId.startsWith(prefix) ? folderId.slice(prefix.length) : folderId;
}

export interface ExternalListArgs {
  folderId: string;
  offset: number;
  limit: number;
  withSnippets: boolean;
}

/** Список писем в папке чужого ящика. */
export async function listExternalMessages(
  client: ImapFlow,
  accountId: number,
  args: ExternalListArgs,
): Promise<{ items: unknown[]; total: number; offset: number; limit: number }> {
  const folders = await listFolders(client);
  const folderId = stripExternalPrefix(args.folderId, accountId);
  const folder = findFolderById(folders, folderId);
  if (!folder) throw new BadRequestError(`Папка не найдена: ${args.folderId}`);
  const page = await listMessages(client, {
    folder,
    offset: args.offset,
    limit: args.limit,
    filter: 'all',
    withSnippets: args.withSnippets,
  });
  const prefix = `ext${String(accountId)}:`;
  return {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      id: `${prefix}${item.id}`,
      folderId: `${prefix}${item.folderId}`,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Отправка «от имени» внешнего адреса                                  */
/* ------------------------------------------------------------------ */

export interface SendAsOptions {
  account: ExternalAccount;
  password: string;
  raw: Buffer;
  recipients: string[];
  rejectUnauthorized: boolean;
  logger: Logger;
}

/**
 * Отправляет письмо через SMTP чужого сервиса.
 *
 * Отправлять письмо с чужим адресом в поле From через НАШ сервер нельзя:
 * подписи DKIM у нас для чужого домена нет, SPF укажет на наш сервер,
 * и письмо уедет в спам — или будет отвергнуто. Поэтому «от имени»
 * означает буквально: через тот же сервис, которому принадлежит адрес.
 */
export async function sendAsExternal(options: SendAsOptions): Promise<void> {
  const { account, password, raw, recipients, rejectUnauthorized, logger } = options;
  const smtp = account.smtp;
  if (!smtp) {
    throw new BadRequestError(
      'Для этого подключения не задан SMTP-сервер — отправлять «от имени» некуда',
    );
  }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: password },
    tls: { rejectUnauthorized: account.allowInsecureTls ? false : rejectUnauthorized },
  });
  try {
    await transport.sendMail({
      envelope: { from: account.address, to: recipients },
      raw,
    });
  } catch (err) {
    logger.warn(errorInfo(err, { host: smtp.host }), 'Отправка через чужой SMTP не удалась');
    throw new UpstreamUnavailableError(
      `Не удалось отправить письмо через ${smtp.host}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    transport.close();
  }
}
