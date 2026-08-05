/**
 * Чтение писем для помощника.
 *
 * Помощник получает письмо ровно тем же путём, что и интерфейс:
 * IMAP-соединение от имени самого пользователя. Служебного доступа
 * к чужим ящикам здесь нет и быть не должно — сервер читает письмо
 * только потому, что пользователь сейчас на него смотрит.
 *
 * Наружу из прочитанного уходит не всё: подготовкой занимается
 * @mail-true/ai (см. sanitize.ts там), а опись отправленного
 * возвращается пользователю вместе с ответом.
 */
import type { FastifyInstance } from 'fastify';
import type { AiSourceMessage } from '@mail-true/ai';
import { NotFoundError } from '../errors.js';
import { requireFolder, splitMessageId } from '../imap/service.js';
import { parseFullMessage } from '../mail/parse.js';
import type { MailSession } from '../types.js';

/**
 * Загружает письма по идентификаторам и приводит к форме, понятной
 * помощнику. Письма из одной папки читаются под одной блокировкой.
 */
export async function loadMessagesForAi(
  app: FastifyInstance,
  session: MailSession,
  ids: readonly string[],
): Promise<AiSourceMessage[]> {
  if (ids.length === 0) return [];
  const { pool } = app.deps;

  // Группируем по папке: одна блокировка на папку вместо одной на письмо.
  const byFolder = new Map<string, string[]>();
  for (const id of ids) {
    const { folderId, uid } = splitMessageId(id);
    const list = byFolder.get(folderId);
    if (list) list.push(String(uid));
    else byFolder.set(folderId, [String(uid)]);
  }

  const found = new Map<string, AiSourceMessage>();

  await pool.withClient(session.email, session.password, async (client) => {
    for (const [folderId, uids] of byFolder) {
      const folder = await requireFolder(client, folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        for (const uid of uids) {
          const msg = await client.fetchOne(
            uid,
            {
              uid: true,
              envelope: true,
              flags: true,
              bodyStructure: true,
              size: true,
              internalDate: true,
              source: true,
            },
            { uid: true },
          );
          if (!msg || !msg.source) continue;
          const { message } = await parseFullMessage({
            folderId: folder.id,
            msg,
            source: msg.source,
            // Внешние картинки помощнику не нужны: он работает с текстом.
            allowRemote: false,
          });
          found.set(message.id, toAiSource(message));
        }
      } finally {
        lock.release();
      }
    }
  });

  // Возвращаем в том порядке, в каком просили: для цепочки порядок важен.
  const result: AiSourceMessage[] = [];
  for (const id of ids) {
    const message = found.get(id);
    if (message) result.push(message);
  }
  if (result.length === 0) throw new NotFoundError('Письмо не найдено');
  return result;
}

/** Одно письмо. Отдельная обёртка ради читаемости маршрутов. */
export async function loadMessageForAi(
  app: FastifyInstance,
  session: MailSession,
  id: string,
): Promise<AiSourceMessage> {
  const [message] = await loadMessagesForAi(app, session, [id]);
  if (!message) throw new NotFoundError('Письмо не найдено');
  return message;
}

/**
 * Приводит письмо интерфейса к входу помощника.
 *
 * Форма AiSourceMessage намеренно совпадает с Message из @mail-true/shared,
 * но перечислить поля ЯВНО важно: так видно, что именно попадает
 * в область досягаемости помощника, и случайное новое поле в Message
 * не утечёт наружу само собой.
 */
function toAiSource(message: {
  id: string;
  threadId?: string | undefined;
  subject: string;
  date: string;
  from: { name: string | null; address: string };
  to: { name: string | null; address: string }[];
  cc: { name: string | null; address: string }[];
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: { filename: string; mimeType: string; size: number }[];
  headers: Record<string, string>;
}): AiSourceMessage {
  return {
    id: message.id,
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    subject: message.subject,
    date: message.date,
    from: message.from,
    to: message.to,
    cc: message.cc,
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml,
    attachments: message.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
    headers: message.headers,
  };
}
