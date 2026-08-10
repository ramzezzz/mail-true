/**
 * Вход администратора в чужой ящик — служебным доступом Dovecot.
 *
 * Механизм: master user. В dovecot.conf включён passdb с `master = yes`
 * и `auth_master_user_separator = *`, поэтому вход под именем
 * `user@домен*служебный_пользователь` с ПАРОЛЕМ СЛУЖЕБНОГО ПОЛЬЗОВАТЕЛЯ
 * открывает ящик user@домен. Пароль владельца ящика при этом не нужен
 * и, что важнее, не меняется: подмена пароля оставила бы владельца без
 * доступа и была бы заметна ему как «взлом».
 *
 * Ограничения этого режима заданы конструкцией, а не проверкой в интерфейсе:
 *  - здесь есть только чтение (открыть папку, прочитать письмо);
 *  - функции отправки в модуле нет вообще, поэтому отправить письмо
 *    от имени пользователя нельзя;
 *  - каждый сеанс требует причину и попадает в admin_mailbox_access.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Logger } from 'pino';
import type { Folder } from '@mail-true/shared';
import { AuthFailedError, UpstreamUnavailableError } from '../errors.js';
import { AdminUnavailableError } from './errors.js';
import { listFolders as listMailFoldersOf } from '../imap/service.js';
import { errorInfo } from '../log.js';
import { htmlToText } from '../mail/text.js';

export interface MasterAccessOptions {
  host: string;
  port: number;
  secure: boolean;
  rejectUnauthorized: boolean;
  masterUser: string;
  masterPassword: string;
  separator: string;
  logger: Logger;
}

/** Имя для IMAP-входа: `ящик*служебный_пользователь`. */
export function masterLoginName(email: string, masterUser: string, separator: string): string {
  return `${email}${separator}${masterUser}`;
}

export interface AdminFolder {
  path: string;
  name: string;
  specialUse: string | null;
  messages: number;
  unseen: number;
}

export interface AdminMessageSummary {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  size: number;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface AdminMessageBody {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  /** Только текст: HTML администратору в этом режиме не рендерим. */
  text: string;
  headers: string;
}

/** Размер и число писем в ящике — для карточки пользователя. */
export interface MailboxUsage {
  messages: number;
  bytes: number;
}

export class MailboxMasterAccess {
  constructor(private readonly opts: MasterAccessOptions) {}

  get configured(): boolean {
    return this.opts.masterUser !== '' && this.opts.masterPassword !== '';
  }

  private client(email: string): ImapFlow {
    if (!this.configured) {
      throw new AdminUnavailableError(
        'Служебный доступ Dovecot не настроен: задайте DOVECOT_MASTER_USER и DOVECOT_MASTER_PASSWORD',
      );
    }
    return new ImapFlow({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure,
      auth: {
        user: masterLoginName(email, this.opts.masterUser, this.opts.separator),
        pass: this.opts.masterPassword,
      },
      tls: { rejectUnauthorized: this.opts.rejectUnauthorized },
      logger: false,
      disableAutoIdle: true,
      clientInfo: { name: 'Mail.True Admin', version: '0.1.0' },
    });
  }

  /** Открывает короткоживущее соединение, выполняет fn, закрывает. */
  private async withClient<T>(email: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.client(email);
    try {
      await client.connect();
    } catch (err) {
      client.close();
      if (err && typeof err === 'object' && 'authenticationFailed' in err) {
        throw new AuthFailedError(
          'Dovecot отклонил служебный доступ. Проверьте master-пароль и настройку passdb (master = yes).',
        );
      }
      this.opts.logger.warn(
        errorInfo(err, { email }),
        'Не удалось открыть служебное IMAP-соединение',
      );
      throw new UpstreamUnavailableError();
    }
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  /** Проверяет, что служебный вход в этот ящик действительно работает. */
  async verify(email: string): Promise<void> {
    await this.withClient(email, async () => undefined);
  }

  async listFolders(email: string): Promise<AdminFolder[]> {
    return this.withClient(email, async (client) => {
      const listed = await client.list({ statusQuery: { messages: true, unseen: true } });
      const out: AdminFolder[] = [];
      for (const item of listed) {
        if (item.flags.has('\\Noselect')) continue;
        let status = item.status;
        if (!status) {
          try {
            status = await client.status(item.path, { messages: true, unseen: true });
          } catch {
            /* папка недоступна — покажем нули */
          }
        }
        out.push({
          path: item.path,
          name: item.name,
          specialUse: item.specialUse ?? null,
          messages: status?.messages ?? 0,
          unseen: status?.unseen ?? 0,
        });
      }
      return out;
    });
  }

  /**
   * Папки в той же модели, что видит сам пользователь (роль папки,
   * вложенность, публичный идентификатор `f-<base64url(путь)>`).
   *
   * Отдельно от listFolders(): та отдаёт плоский список для чтения писем
   * администратором, а здесь нужен ровно тот справочник, по которому
   * настройки переводят идентификатор папки в путь IMAP и обратно
   * (см. settings/webdto.ts). Собирать второй такой перевод для админки
   * нельзя: правило «письма от директора — в папку Х», заведённое
   * администратором, обязано указывать на ту же папку, что и правило,
   * заведённое владельцем ящика.
   */
  async listMailFolders(email: string): Promise<Folder[]> {
    return this.withClient(email, (client) => listMailFoldersOf(client));
  }

  async listMessages(
    email: string,
    path: string,
    limit: number,
    offset: number,
  ): Promise<{ items: AdminMessageSummary[]; total: number }> {
    return this.withClient(email, async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        const mailbox = client.mailbox;
        const total = typeof mailbox === 'object' && mailbox ? mailbox.exists : 0;
        if (total === 0) return { items: [], total: 0 };
        // Новые сверху: берём окно с конца последовательности
        const end = Math.max(1, total - offset);
        const start = Math.max(1, end - limit + 1);
        if (offset >= total) return { items: [], total };

        const items: AdminMessageSummary[] = [];
        for await (const msg of client.fetch(
          `${start}:${end}`,
          { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
          { uid: false },
        )) {
          const env = msg.envelope;
          const structure = msg.bodyStructure as
            { childNodes?: unknown[]; type?: string } | undefined;
          items.push({
            uid: msg.uid,
            subject: env?.subject ?? '(без темы)',
            from: (env?.from ?? [])
              .map((a) => a.address ?? '')
              .filter(Boolean)
              .join(', '),
            to: (env?.to ?? [])
              .map((a) => a.address ?? '')
              .filter(Boolean)
              .join(', '),
            date: env?.date ? new Date(env.date).toISOString() : null,
            size: msg.size ?? 0,
            seen: msg.flags?.has('\\Seen') ?? false,
            flagged: msg.flags?.has('\\Flagged') ?? false,
            hasAttachments: (structure?.type ?? '').toLowerCase() === 'multipart/mixed',
          });
        }
        items.reverse();
        return { items, total };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Читает письмо. Флаг \Seen НЕ ставится: администратор не должен
   * оставлять следов в ящике владельца.
   */
  async readMessage(email: string, path: string, uid: number): Promise<AdminMessageBody | null> {
    return this.withClient(email, async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, envelope: true, headers: true, source: true },
          { uid: true },
        );
        if (!msg || typeof msg === 'boolean') return null;
        const env = msg.envelope;
        const source = msg.source ?? Buffer.alloc(0);
        /*
         * ПИСЬМО РАЗБИРАЕТСЯ, А НЕ РЕЖЕТСЯ ПО ПУСТОЙ СТРОКЕ.
         *
         * Раньше исходник делился по первой пустой строке, и всё
         * остальное отдавалось как «текст». Для русскоязычной почты это
         * отказ почти в каждом письме: простое письмо на кириллице едет в
         * base64, типовое — multipart/alternative с границами и двумя
         * закодированными частями. То есть главный сценарий раздела
         * («обращение №1234: письмо не пришло, смотрим») давал
         * нечитаемую простыню, а поле называлось `text` и подавалось
         * интерфейсом как текст письма.
         *
         * HTML администратору по-прежнему не показывается (см. шапку
         * файла): берётся текстовая часть, а если её нет — текст,
         * вытопленный из HTML. Разборщик тот же, что и в самой почте.
         */
        const parsed = await simpleParser(source, { skipImageLinks: true });
        const body =
          parsed.text && parsed.text.trim() !== ''
            ? parsed.text
            : parsed.html
              ? htmlToText(parsed.html)
              : '';
        return {
          uid: msg.uid,
          subject: env?.subject ?? '(без темы)',
          from: (env?.from ?? [])
            .map((a) => a.address ?? '')
            .filter(Boolean)
            .join(', '),
          to: (env?.to ?? [])
            .map((a) => a.address ?? '')
            .filter(Boolean)
            .join(', '),
          date: env?.date ? new Date(env.date).toISOString() : null,
          text: body.slice(0, 200_000),
          headers: msg.headers ? msg.headers.toString('utf8').slice(0, 20_000) : '',
        };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Очищает ящик перед удалением: удаляет все папки, кроме INBOX,
   * и очищает сам INBOX.
   *
   * Зачем через IMAP, если каталог всё равно будет удалён с диска:
   * индексы Dovecot и данные полнотекстового поиска Xapian лежат
   * в ОТДЕЛЬНОМ томе (mail_location = …:INDEX=/var/mail/index/%d/%n),
   * которого у API нет и быть не должно. Убрать их может только сам
   * Dovecot — и убирает, когда папку удаляют его же средствами.
   *
   * Вызывается ДО удаления строки virtual_users: после удаления Dovecot
   * перестанет пускать даже служебного пользователя, и очистить будет уже
   * нечем. Отказ не критичен — каталог всё равно уйдёт в карантин,
   * — поэтому результат возвращается, а не бросается исключением.
   *
   * ------------------------------------------------------------------
   * ЭТО НЕ «ОЧИСТКА ИНДЕКСОВ». ЭТО УНИЧТОЖЕНИЕ ПИСЕМ
   * ------------------------------------------------------------------
   * Название обманчиво, и на этом уже обожглись: здесь удаляются ВСЕ
   * папки и всё содержимое INBOX, то есть переписка человека целиком и
   * безвозвратно. Индексы убираются заодно, как следствие.
   *
   * Поэтому звать это можно только там, где почта и так подлежит
   * немедленному уничтожению. Удаление ящика с ненулевой отсрочкой
   * (ADMIN_MAILBOX_PURGE_DELAY_MINUTES) — не тот случай: отсрочка прямо
   * обещает человеку время передумать, а вызов отсюда делал это обещание
   * пустым (в карантин уезжал уже пустой каталог). Подробности и
   * нынешний порядок — в routes/users.ts, обработчик DELETE /users/:id.
   */
  async purgeMail(
    email: string,
  ): Promise<{ ok: boolean; foldersDeleted: number; error: string | null }> {
    try {
      return await this.withClient(email, async (client) => {
        let foldersDeleted = 0;
        const listed = await client.list();
        // Сначала вложенные: удалять родителя раньше ребёнка нельзя.
        const paths = listed
          .filter((item) => item.path.toUpperCase() !== 'INBOX')
          .map((item) => item.path)
          .sort((a, b) => b.length - a.length);
        for (const target of paths) {
          try {
            await client.mailboxDelete(target);
            foldersDeleted += 1;
          } catch {
            /* папка уже исчезла или не удаляется — не повод останавливаться */
          }
        }
        // INBOX удалить нельзя по стандарту — очищаем содержимое.
        const lock = await client.getMailboxLock('INBOX').catch(() => null);
        if (lock) {
          try {
            const mailbox = client.mailbox;
            const exists = typeof mailbox === 'object' && mailbox ? mailbox.exists : 0;
            if (exists > 0) await client.messageDelete({ all: true }, { uid: false });
          } catch {
            /* см. выше */
          } finally {
            lock.release();
          }
        }
        return { ok: true, foldersDeleted, error: null };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger.warn(errorInfo(err, { email }), 'Не удалось очистить ящик перед удалением');
      return { ok: false, foldersDeleted: 0, error: message };
    }
  }

  /** Сколько писем и байт в ящике (обход всех папок). */
  async usage(email: string): Promise<MailboxUsage> {
    return this.withClient(email, async (client) => {
      let messages = 0;
      let bytes = 0;
      const listed = await client.list();
      for (const item of listed) {
        if (item.flags.has('\\Noselect')) continue;
        const lock = await client.getMailboxLock(item.path).catch(() => null);
        if (!lock) continue;
        try {
          const mailbox = client.mailbox;
          const exists = typeof mailbox === 'object' && mailbox ? mailbox.exists : 0;
          if (exists === 0) continue;
          messages += exists;
          for await (const msg of client.fetch(`1:*`, { size: true }, { uid: false })) {
            bytes += msg.size ?? 0;
          }
        } finally {
          lock.release();
        }
      }
      return { messages, bytes };
    });
  }
}
