/**
 * Управление папками ящика: создание, переименование, удаление, очистка.
 *
 * Раздел «Папки» настроек (docs/features-reference.md). Живёт здесь, а не
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
import { deleteUids, listFolders } from '../imap/service.js';
import { errorInfo } from '../log.js';
import {
  findFolderById,
  folderPathBytes,
  MAX_FOLDER_PATH_BYTES,
  roleByName,
} from '../mail/folders.js';
import type { MailSession } from '../types.js';
import { originOf } from './access-record.js';
import type { FilterActions, FilterRule } from './types.js';

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

/* ------------------------------------------------------------------ */
/* Правила фильтрации, которые смотрят на эту папку                     */
/* ------------------------------------------------------------------ */

/** Что поправить в правиле после переименования или удаления папки. */
export interface FilterFolderPatch {
  id: number;
  /** Новый путь папки-приёмника; null — папки больше нет. */
  folder: string | null;
  /** Выключить правило: без папки от него не осталось ни одного действия. */
  disable: boolean;
}

/** Осталось ли правилу что делать, кроме раскладки в папку. */
function hasOtherActions(actions: FilterActions): boolean {
  return (
    actions.markRead ||
    actions.flag ||
    actions.labels.length > 0 ||
    actions.deleteMessage !== null ||
    actions.forwardTo.length > 0 ||
    actions.autoReply !== null
  );
}

/**
 * Правила, раскладывающие почту в эту папку, после её переименования
 * (`to` — новый путь) или удаления (`to === null`).
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО
 * ------------------------------------------------------------------
 * Правило хранит ПУТЬ папки, а не её номер, а файл Sieve собирается с
 * `fileinto :create`. Переименовали папку — путь в правиле остался
 * старым, и первое же подходящее письмо ЗАВОДИЛО папку со старым именем
 * заново: человек видел папку-призрак и не находил в новой папке ничего.
 * В списке правил действие при этом пропадало с глаз (folderIdOfPath не
 * находит путь и отдаёт null), и первое же сохранение правила записывало
 * folder: null — раскладка исчезала насовсем, без единого сообщения.
 *
 * Вложенные папки переезжают вместе с родителем: переименование «Работа»
 * меняет путь и у правила, кладущего письма в «Работа/Счета».
 *
 * У удалённой папки приёмника нет и быть не может: правило перестаёт
 * перекладывать (иначе `:create` завёл бы её обратно), а если больше оно
 * ничего не делало — выключается. Выключенное правило видно и его можно
 * починить; молча оставленное пустое правило выглядело бы работающим.
 */
export function retargetFilterFolders(
  rules: readonly FilterRule[],
  from: string,
  to: string | null,
  delimiter: string,
): FilterFolderPatch[] {
  const prefix = `${from}${delimiter}`;
  const patches: FilterFolderPatch[] = [];
  for (const rule of rules) {
    const current = rule.actions.folder;
    if (current === null) continue;
    let next: string | null;
    if (current === from) {
      next = to;
    } else if (current.startsWith(prefix)) {
      next = to === null ? null : `${to}${current.slice(from.length)}`;
    } else {
      continue;
    }
    patches.push({
      id: rule.id,
      folder: next,
      disable: next === null && !hasOtherActions(rule.actions),
    });
  }
  return patches;
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
      /*
       * Имя, которое делает папку СЛУЖЕБНОЙ, руками не даём.
       *
       * Роль папки узнаётся в том числе по имени («Архив», «Спам»,
       * «Корзина», «Отложенные», «Заглушённые» и их английские
       * написания) — так ящик, приехавший с чужого сервера, получает
       * правильные папки. Обратная сторона: заведённая руками папка с
       * таким именем тоже становится служебной, а служебную нельзя ни
       * переименовать, ни удалить. Человек создавал её сам — и больше не
       * мог убрать из продукта ничем.
       *
       * Отдельно про «Заглушённые»: правило доставки пишет туда жёстко
       * заданный путь, и своя папка с таким именем расщепляла бы
       * заглушённую переписку на две.
       */
      const wouldBeSystem = roleByName(draft.name);
      if (wouldBeSystem !== 'custom') {
        throw new BadRequestError(
          `Имя «${draft.name}» занято под служебную папку: такие папки почта заводит сама, ` +
            'и удалить или переименовать их потом нельзя. Выберите другое имя.',
        );
      }

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

      /*
       * Служебное имя нельзя получить и переименованием.
       *
       * ------------------------------------------------------------------
       * ЧТО БЫЛО
       * ------------------------------------------------------------------
       * При СОЗДАНИИ папки такая проверка есть и объяснена, а здесь её не
       * было вовсе. Переименовал «Счета» в «Корзина» — и разбор ролей
       * (`detectRole`) начинает считать эту папку корзиной. Хуже: при
       * двух папках одной роли роль достаётся первой по алфавиту, а
       * «Корзина» стоит раньше «Trash» — значит настоящая корзина
       * становится обычной папкой и теряет защиту «системная», после чего
       * её можно удалить со всем содержимым.
       *
       * Роль корзины читают пять разных мест: куда правило кладёт
       * удаляемое, что чистит «Очистить корзину» (на не-корзине это
       * немедленное удаление БЕЗ возможности вернуть), куда возвращается
       * восстановленное, что пропускать в выгрузке и где искать.
       */
      const wouldBeSystem = roleByName(name);
      if (wouldBeSystem !== 'custom') {
        throw new BadRequestError(
          `Имя «${name}» занято под служебную папку: такие папки почта заводит сама, ` +
            'и своя папка с этим именем перехватила бы их работу — например, письма ' +
            'из корзины стали бы удаляться без возможности вернуть. Выберите другое имя.',
        );
      }

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
      // Правила фильтрации переезжают следом за папкой — иначе Sieve
      // заведёт папку со старым именем заново. См. retargetFilterFolders.
      await moveFilters(session.email, folder.path, target, delimiter);
      const refreshed = await listFolders(client);
      const renamed = refreshed.find((f) => f.path === target);
      if (!renamed) throw new BadRequestError('Папка переименована, но не найдена в списке');
      return renamed;
    });
  });

  /*
   * Удаление вместе с содержимым И СО ВЛОЖЕННЫМИ ПАПКАМИ. Системные
   * папки не удаляются.
   *
   * Вложенные удаляются здесь же, потому что ровно это обещано человеку
   * в вопросе перед удалением («папка и все её вложенные папки будут
   * удалены вместе с письмами»). Раньше удалялась одна папка: по IMAP
   * родитель с детьми превращается в пустой узел дерева, дети остаются
   * на месте вместе с письмами — то есть человек видел на экране прямо
   * противоположное тому, на что согласился.
   *
   * Порядок — от самых глубоких к родителю: удалить родителя первым
   * означало бы оставить детей без пути, по которому их можно назвать.
   */
  app.delete('/folders/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    await pool.withClient(session.email, session.password, async (client) => {
      const folders = await listFolders(client);
      const folder = findFolderById(folders, id);
      if (!folder) throw new NotFoundError(`Папка не найдена: ${id}`);
      if (folder.system) throw new BadRequestError('Системную папку удалить нельзя');

      const delimiter = await delimiterOf(client, folders);
      const prefix = `${folder.path}${delimiter}`;
      const children = folders.filter((f) => f.path.startsWith(prefix));
      /*
       * Служебная папка внутри своей — редкость, но она возможна у ящика,
       * приехавшего с чужого сервера. Молча снести её вместе с родителем
       * нельзя: это «Корзина» или «Спам» со всем их содержимым.
       */
      const system = children.find((f) => f.system);
      if (system) {
        throw new BadRequestError(
          `Внутри папки «${folder.name}» лежит системная папка «${system.name}», а её удалить нельзя. ` +
            'Перенесите её выше по дереву и повторите удаление.',
        );
      }

      for (const child of [...children].sort((a, b) => b.path.length - a.path.length)) {
        await client.mailboxDelete(child.path);
      }
      await client.mailboxDelete(folder.path);
      // Правила, раскладывавшие почту сюда, теряют приёмник — иначе Sieve
      // с `fileinto :create` заведёт удалённую папку заново.
      await moveFilters(session.email, folder.path, null, delimiter);
    });
    return { ok: true };
  });

  /**
   * Переносит правила фильтрации следом за папкой и переписывает Sieve.
   *
   * Отказ базы настроек НЕ отменяет операцию над папкой: папка уже
   * переименована (или удалена) в почтовом хранилище, и ответить
   * человеку ошибкой значило бы соврать о том, что произошло. Поэтому
   * причина уходит в журнал сервера, а не в ответ.
   *
   * ЧЕГО ЭТО НЕ ЛОВИТ. Переименование той же папки МИМО нас — из почтовой
   * программы на телефоне или ноутбуке: по IMAP это разрешено, и узнать о
   * нём отсюда неоткуда. Правило сохранит старый путь, а `fileinto :create`
   * при первом же письме заведёт папку со старым именем заново — рядом с
   * переименованной. Закрыть это можно только сверкой правил со списком
   * папок при подключении к ящику; пока не сделано.
   */
  async function moveFilters(
    email: string,
    from: string,
    to: string | null,
    delimiter: string,
  ): Promise<void> {
    const service = app.settingsService as FastifyInstance['settingsService'] | undefined;
    if (!service?.available) return;
    try {
      const db = service.requireDb();
      const rules = await db.listFilters(email);
      const patches = retargetFilterFolders(rules, from, to, delimiter);
      if (patches.length === 0) return;
      for (const patch of patches) {
        const rule = rules.find((r) => r.id === patch.id);
        if (!rule) continue;
        await db.updateFilter(email, patch.id, {
          actions: { ...rule.actions, folder: patch.folder },
          ...(patch.disable ? { enabled: false } : {}),
        });
      }
      // Файл правил в ящике собирается из базы целиком — без этого
      // переписанные правила остались бы только в базе, а почту
      // продолжал бы раскладывать старый файл со старым путём.
      await service.syncSieve(email);
    } catch (err) {
      app.deps.logger.warn(
        errorInfo(err, { email, from, to }),
        'Папка переименована или удалена, но правила фильтрации остались со старым путём',
      );
    }
  }

  /*
   * Очистка: письма удаляются, папка остаётся. Отдельная операция,
   * потому что «Очистить» в интерфейсе — это именно очистка, а не
   * удаление папки с последующим созданием заново.
   *
   * У КОРЗИНЫ поведение другое, и это главное изменение возможности
   * «восстановление после очистки». Раньше очистка звала EXPUNGE, и
   * письма исчезали с диска в ту же секунду — восстановить их было нельзя
   * ничем. Теперь они уезжают в служебную папку и живут там столько дней,
   * сколько человек указал в настройках (по умолчанию семь, как у
   * Fastmail). Ноль дней означает прежнее поведение — удалять сразу.
   *
   * Остальных папок это НЕ касается: «Очистить» на своей папке — это
   * осознанное действие над тем, что человек хранил, а не над тем, что
   * он уже выбросил. Заводить на него отсрочку значило бы удваивать
   * место, занятое любой уборкой в ящике.
   */
  app.post('/folders/:id/clear', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const recovery = app.recoveryService;

    const result = await pool.withClient(session.email, session.password, async (client) => {
      const folders = await listFolders(client);
      const folder = findFolderById(folders, id);
      if (!folder) throw new NotFoundError(`Папка не найдена: ${id}`);

      const uids = await withFolder(client, folder.path, async () => {
        const found = await client.search({ all: true }, { uid: true });
        return Array.isArray(found) ? found : [];
      });
      if (uids.length === 0) return { removed: 0, kept: 0, restoreUntil: null };

      const days = folder.role === 'trash' ? await recoveryDaysOf(session.email) : 0;
      if (days > 0) {
        const swept = await recovery.sweep(client, session.email, folder, uids, days);
        // Письма, которые перенести не удалось (сервер не подтвердил
        // номера), уже не в корзине — они в служебной папке, но без
        // записи. Считаем их удалёнными: обещать возврат того, чего мы
        // не записали, нельзя.
        return { removed: swept.removed, kept: swept.kept, restoreUntil: swept.restoreUntil };
      }

      await withFolder(client, folder.path, async () => {
        // Через deleteUids: отказ EXPUNGE imapflow отдаёт возвратом
        // `false`, а число «удалено N» считалось строкой ниже по длине
        // присланного списка. Эта ветка работает и при выключенном сроке
        // хранения, и на любой НЕ-корзинной папке — то есть «Очистить» на
        // своей папке в тысячи писем отчитывалось об успехе, не удалив
        // ничего.
        await deleteUids(client, uids);
      });
      return { removed: uids.length, kept: 0, restoreUntil: null };
    });

    app.deps.accessLog?.record({
      accountEmail: session.email,
      kind: 'folders',
      /*
       * Число вынесено в конец строки нарочно: по-русски «3 письма» и
       * «5 писем» склоняются по-разному, а склонять в журнале действий
       * незачем — форма «писем: 3» верна при любом числе.
       */
      detail:
        result.kept > 0
          ? `Очищена корзина, можно вернуть писем: ${result.kept}`
          : `Очищена папка, удалено писем: ${result.removed}`,
      ...originOf(request),
    });

    // `removed` остаётся первым полем ответа: его читает уже написанный
    // интерфейс (apps/web/src/api/settingsApi.ts). Остальное — добавка,
    // и старый клиент её просто не заметит.
    return result;
  });

  /** Срок хранения очищенного у этого ящика; 0 — не хранить. */
  async function recoveryDaysOf(email: string): Promise<number> {
    const recovery = app.recoveryService;
    if (!recovery.available) return 0;
    try {
      return await recovery.daysFor(email);
    } catch {
      // Не смогли прочитать настройку — ведём себя как раньше и удаляем.
      // Молча сохранить письма было бы хуже: человек просил их выбросить.
      return 0;
    }
  }
}

/** Выполняет действие под блокировкой папки и всегда её отпускает. */
async function withFolder<T>(client: ImapFlow, path: string, action: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(path);
  try {
    return await action();
  } finally {
    lock.release();
  }
}
