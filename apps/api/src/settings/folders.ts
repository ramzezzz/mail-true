/**
 * Управление папками ящика: создание, переименование, удаление, очистка.
 *
 * Раздел «Папки» настроек (docs/features-mailru.md). Живёт здесь, а не
 * в src/routes/folders.ts: тот отдаёт список папок и меняться не должен,
 * а изменяющие операции — часть настроек. Маршруты регистрируются под
 * тем же префиксом /api/folders, но другими методами, поэтому пересечения
 * с существующим GET нет.
 *
 * Все операции идут прямо в IMAP: собственного каталога папок мы не
 * держим. Вторая точка правды здесь означала бы расхождение с тем, что
 * видит почтовый клиент на телефоне.
 */
import type { FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import { z } from 'zod';
import type { Folder } from '@mail-true/shared';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors.js';
import { listFolders } from '../imap/service.js';
import { findFolderById, folderPathBytes, MAX_FOLDER_PATH_BYTES } from '../mail/folders.js';
import type { MailSession } from '../types.js';

const draftSchema = z.object({
  name: z.string().trim().min(1).max(255),
  parentId: z.string().min(1).max(512).nullable().default(null),
});

const renameSchema = z.object({ name: z.string().trim().min(1).max(255) });

const idParam = z.object({ id: z.string().min(1).max(512) });

/** Разделитель иерархии ящика: у Dovecot настроен '/', но спрашиваем сервер. */
async function delimiterOf(client: ImapFlow, folders: Folder[]): Promise<string> {
  const inbox = folders.find((f) => f.role === 'inbox');
  if (inbox) {
    const listed = await client.list();
    const found = listed.find((item) => item.path === inbox.path);
    if (found?.delimiter) return found.delimiter;
  }
  return '/';
}

/** Имя папки не должно содержать разделитель: иерархию задаёт parentId. */
function checkName(name: string, delimiter: string): void {
  if (name.includes(delimiter) || name.includes('/') || name.includes('\\')) {
    throw new BadRequestError(
      `Имя папки не может содержать «${delimiter}» — вложенность задаётся выбором родителя`,
    );
  }
}

/**
 * Путь папки целиком не должен выходить за предел: он попадает в адрес
 * запроса, и слишком длинный путь делает папку и письма в ней недостижимыми
 * (см. MAX_FOLDER_PATH_BYTES). Считается ВЕСЬ путь, а не одно имя: вложенная
 * папка упирается в предел заметно раньше, чем папка в корне.
 *
 * Сообщение говорит и о вложенности, и о кириллице: буква занимает два байта,
 * и «умещается 255 символов» ввело бы человека в заблуждение ровно вдвое.
 */
function checkPathLength(path: string, name: string): void {
  const bytes = folderPathBytes(path);
  if (bytes <= MAX_FOLDER_PATH_BYTES) return;
  const nested = path !== name;
  throw new BadRequestError(
    nested
      ? `Слишком длинный путь до папки «${name}»: вместе с родительскими папками получается ${bytes} байт, а допустимо ${MAX_FOLDER_PATH_BYTES}. Сократите название или выберите родителя выше по дереву.`
      : `Слишком длинное название папки: ${bytes} байт при допустимых ${MAX_FOLDER_PATH_BYTES}. Русская буква занимает два байта, поэтому предел — около ${Math.floor(MAX_FOLDER_PATH_BYTES / 2)} русских букв.`,
  );
}

export async function folderManagementRoutes(app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;

  const sessionOf = (request: { mailSession: MailSession | null }): MailSession => {
    if (!request.mailSession) throw new UnauthorizedError();
    return request.mailSession;
  };

  // Создание папки. Возвращается сама папка — интерфейс сразу подставляет
  // её в дерево, не перезапрашивая список.
  app.post('/folders', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const draft = draftSchema.parse(request.body);
    return pool.withClient(session.email, session.password, async (client) => {
      const folders = await listFolders(client);
      const delimiter = await delimiterOf(client, folders);
      checkName(draft.name, delimiter);

      let path = draft.name;
      if (draft.parentId) {
        const parent = findFolderById(folders, draft.parentId);
        if (!parent) throw new NotFoundError(`Родительская папка не найдена: ${draft.parentId}`);
        path = `${parent.path}${delimiter}${draft.name}`;
      }
      checkPathLength(path, draft.name);
      if (folders.some((f) => f.path === path)) {
        throw new BadRequestError(`Папка «${draft.name}» уже существует`);
      }
      await client.mailboxCreate(path);
      await client.mailboxSubscribe(path).catch(() => undefined);

      const refreshed = await listFolders(client);
      const created = refreshed.find((f) => f.path === path);
      if (!created) throw new BadRequestError('Папка создана, но не найдена в списке');
      return created;
    });
  });

  // Переименование. Системные папки не трогаем: их имена — часть
  // соглашения с почтовыми клиентами (SPECIAL-USE).
  app.patch('/folders/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const { name } = renameSchema.parse(request.body);
    return pool.withClient(session.email, session.password, async (client) => {
      const folders = await listFolders(client);
      const folder = findFolderById(folders, id);
      if (!folder) throw new NotFoundError(`Папка не найдена: ${id}`);
      if (folder.system) throw new BadRequestError('Системную папку переименовать нельзя');

      const delimiter = await delimiterOf(client, folders);
      checkName(name, delimiter);
      const parts = folder.path.split(delimiter);
      parts[parts.length - 1] = name;
      const target = parts.join(delimiter);
      if (target === folder.path) return folder;
      checkPathLength(target, name);
      // Переименование родителя удлиняет пути ВСЕХ вложенных папок. Проверить
      // только сам переименовываемый путь мало: длиннее предела могла бы стать
      // вложенная папка, о которой человек в этот момент даже не думает, — и
      // ловушку получила бы именно она.
      const prefix = `${folder.path}${delimiter}`;
      const longestChild = folders
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => target + f.path.slice(folder.path.length))
        .sort((a, b) => folderPathBytes(b) - folderPathBytes(a))[0];
      if (longestChild) checkPathLength(longestChild, name);
      if (folders.some((f) => f.path === target)) {
        throw new BadRequestError(`Папка «${name}» уже существует`);
      }

      await client.mailboxRename(folder.path, target);
      const refreshed = await listFolders(client);
      const renamed = refreshed.find((f) => f.path === target);
      if (!renamed) throw new BadRequestError('Папка переименована, но не найдена в списке');
      return renamed;
    });
  });

  // Удаление вместе с содержимым. Системные папки не удаляются.
  app.delete('/folders/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    await pool.withClient(session.email, session.password, async (client) => {
      const folders = await listFolders(client);
      const folder = findFolderById(folders, id);
      if (!folder) throw new NotFoundError(`Папка не найдена: ${id}`);
      if (folder.system) throw new BadRequestError('Системную папку удалить нельзя');
      await client.mailboxDelete(folder.path);
    });
    return { ok: true };
  });

  // Очистка: письма удаляются, папка остаётся. Отдельная операция,
  // потому что «Очистить» в интерфейсе — это именно очистка, а не
  // удаление папки с последующим созданием заново.
  app.post('/folders/:id/clear', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const removed = await pool.withClient(session.email, session.password, async (client) => {
      const folders = await listFolders(client);
      const folder = findFolderById(folders, id);
      if (!folder) throw new NotFoundError(`Папка не найдена: ${id}`);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const found = await client.search({ all: true }, { uid: true });
        const uids = Array.isArray(found) ? found : [];
        if (uids.length === 0) return 0;
        await client.messageDelete(uids, { uid: true });
        return uids.length;
      } finally {
        lock.release();
      }
    });
    return { removed };
  });
}
