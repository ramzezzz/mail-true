/**
 * Маршруты своих меток.
 *
 * Живут отдельным файлом, а подключаются одной строкой из routes/messages.ts:
 * метки — часть работы с письмами (они и хранятся в письмах), но собственного
 * подключения к базе, собственной пробы схемы и собственного разбора запросов
 * у них столько, что внутри чужого файла это читалось бы как вставка.
 *
 *   GET    /api/labels              — справочник и доступность возможности
 *   POST   /api/labels              — завести метку
 *   PATCH  /api/labels/:key         — переименовать, сменить цвет
 *   DELETE /api/labels/:key?purge=1 — удалить (и, по просьбе, снять с писем)
 *   POST   /api/messages/labels     — поставить и снять метки на письмах
 *
 * ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА. Ни один маршрут отсюда не имеет права
 * тронуть служебное ключевое слово: `$Snoozed`, `$Pinned`, `$MDNSent`, чипы
 * категорий и признак надёжного отправителя. Поэтому список слов на
 * простановку и снятие проверяется ДВАЖДЫ — по виду ключа (`mt-…`,
 * см. isUserLabelKey) и по справочнику ящика. Слова, которого нет в
 * справочнике, до `STORE` не доедет ни при какой ошибке в интерфейсе.
 */
import type { FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import { z } from 'zod';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors.js';
import {
  existingUids,
  groupIdsByFolder,
  listFolders,
  requireFolder,
} from '../imap/service.js';
import { errorInfo } from '../log.js';
import { MAX_ENTITY_ID_LENGTH } from './folders.js';
import {
  isServiceKeyword,
  isUserLabelKey,
  LABEL_COLORS,
  MAX_LABEL_NAME_LENGTH,
  normalizeLabelName,
  type UserLabel,
} from './labels.js';
import { isUndefinedTable, type LabelStore } from './labels-db.js';
import type { MailSession } from '../types.js';

/** Подсказка, если миграцию 0018 ещё не применили. */
export const LABELS_MIGRATION_HINT =
  'Таблицы меток нет. Примените infra/postgres/migrations/0018_mail_labels.sql ' +
  'к работающей базе.';

const messageIdSchema = z.string().min(3).max(MAX_ENTITY_ID_LENGTH);

const labelDraftSchema = z.object({
  name: z.string().min(1).max(MAX_LABEL_NAME_LENGTH),
  color: z.enum(LABEL_COLORS).default('blue'),
});

const labelPatchSchema = z.object({
  name: z.string().min(1).max(MAX_LABEL_NAME_LENGTH).optional(),
  color: z.enum(LABEL_COLORS).optional(),
});

const labelKeyParamSchema = z.object({ key: z.string().min(1).max(64) });

const purgeQuerySchema = z.object({ purge: z.enum(['0', '1']).default('0') });

const applyBodySchema = z.object({
  ids: z.array(messageIdSchema).min(1).max(500),
  add: z.array(z.string().min(1).max(64)).max(32).default([]),
  remove: z.array(z.string().min(1).max(64)).max(32).default([]),
});

const labelsOfBodySchema = z.object({
  ids: z.array(messageIdSchema).min(1).max(500),
});

/**
 * Сколько номеров писем кладём в одну команду FETCH.
 *
 * Не «на всякий случай»: команда IMAP — это строка, и пятьсот номеров
 * подряд её заметно удлиняют. Двести — то же число, которым режет запросы
 * сам продукт в других местах, и оно заведомо влезает в предел строки
 * у любого сервера.
 */
const FETCH_CHUNK = 200;

export interface LabelsDeps {
  store: LabelStore | null;
  /** Почему возможности нет. Пусто — возможность есть. */
  unavailableReason: string;
}

function requireMailSession(session: MailSession | null): MailSession {
  if (!session) throw new UnauthorizedError();
  return session;
}

/**
 * Состояние возможности: справочник либо есть целиком, либо честно нет.
 *
 * Отдельного «частично работает» не бывает намеренно. Пока `available`
 * ложно, интерфейс не показывает ни раздела настроек, ни пункта в меню —
 * то же правило, что у отложенных писем и помощника ИИ: кнопка, которая
 * молча ничего не делает, хуже отсутствующей кнопки.
 */
export interface LabelsState {
  available: boolean;
  reason: string | null;
  items: UserLabel[];
}

/**
 * Проверяет присланные ключевые слова по справочнику.
 *
 * Возвращает ТОЛЬКО те, что и похожи на пользовательскую метку, и заведены
 * в этом ящике. Всё прочее — служебные слова, чужие ключевые слова и
 * опечатки — отбрасывается с ошибкой, а не молча: молчаливое отбрасывание
 * выглядело бы как «метка поставилась», и человек ушёл бы с этим.
 */
export function resolveLabelKeys(
  keys: readonly string[],
  dictionary: readonly UserLabel[],
): string[] {
  const known = new Map(dictionary.map((l) => [l.key.toLowerCase(), l.key]));
  const out: string[] = [];
  for (const raw of keys) {
    const key = raw.trim();
    if (isServiceKeyword(key) || !isUserLabelKey(key)) {
      throw new BadRequestError(`Это не пользовательская метка: ${raw}`);
    }
    const resolved = known.get(key.toLowerCase());
    if (!resolved) throw new NotFoundError(`Метка не найдена: ${raw}`);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/**
 * Снимает ключевое слово со ВСЕХ писем ящика.
 *
 * Нужно ровно в одном месте — при удалении метки с ответом «снять с писем».
 * Идём по всем папкам и ищем письма поиском по ключевому слову, а не
 * перебором: папка на двадцать тысяч писем перебором обходилась бы минутами,
 * а поиск по ключевому слову Dovecot делает по индексу.
 *
 * Папка, которую не удалось открыть (её удалили между списком и заходом,
 * или это `\Noselect`), пропускается: терять снятие с остальных писем
 * из-за одной папки нельзя.
 */
export async function purgeKeyword(
  client: ImapFlow,
  keyword: string,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<number> {
  if (!isUserLabelKey(keyword)) {
    // Двойной замок: сюда нельзя попасть со служебным словом даже по ошибке
    // вызывающего. Стереть `$MDNSent` со всего ящика — это необратимо.
    throw new BadRequestError(`Снимать можно только пользовательские метки: ${keyword}`);
  }
  const folders = await listFolders(client);
  let removed = 0;
  for (const folder of folders) {
    let lock: { release(): void } | null = null;
    try {
      lock = await client.getMailboxLock(folder.path);
      const uids = await client.search({ keyword }, { uid: true });
      if (uids && uids.length > 0) {
        await client.messageFlagsRemove(uids, [keyword], { uid: true });
        removed += uids.length;
      }
    } catch (err) {
      log?.warn(errorInfo(err, { folder: folder.path, keyword }), 'Не удалось снять метку в папке');
    } finally {
      lock?.release();
    }
  }
  return removed;
}

export async function labelRoutes(app: FastifyInstance, deps: LabelsDeps): Promise<void> {
  const { pool } = app.deps;

  /**
   * Справочник ящика. Единственная точка, где маршруты его получают:
   * без справочника ни поставить, ни снять метку нельзя (см. шапку).
   */
  const dictionaryOf = async (session: MailSession): Promise<UserLabel[]> => {
    if (!deps.store) return [];
    try {
      return await deps.store.list(session.email);
    } catch (err) {
      if (isUndefinedTable(err)) throw new BadRequestError(LABELS_MIGRATION_HINT);
      throw err;
    }
  };

  const requireStore = (): LabelStore => {
    if (!deps.store) throw new BadRequestError(deps.unavailableReason);
    return deps.store;
  };

  app.get('/labels', { preHandler: app.requireSession }, async (request): Promise<LabelsState> => {
    const session = requireMailSession(request.mailSession);
    if (!deps.store) {
      return { available: false, reason: deps.unavailableReason, items: [] };
    }
    return { available: true, reason: null, items: await dictionaryOf(session) };
  });

  app.post('/labels', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = labelDraftSchema.parse(request.body);
    const name = normalizeLabelName(body.name);
    if (name === '') throw new BadRequestError('У метки должно быть название');
    /*
     * Имя, совпадающее со служебным словом, отклоняется ЗДЕСЬ, хотя ключ
     * всё равно получил бы приставку `mt-` и столкнуться не мог. Причина
     * не в столкновении, а в честности показа: метка с именем «reliable»
     * или «$Snoozed» рисовалась бы рядом с настоящим служебным признаком
     * и означала бы совсем другое.
     */
    if (isServiceKeyword(name)) {
      throw new BadRequestError(`Это служебное слово продукта, меткой его назвать нельзя: ${name}`);
    }
    const existing = await dictionaryOf(session);
    if (existing.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      throw new BadRequestError(`Метка «${name}» уже есть`);
    }
    return requireStore().create(session.email, { name, color: body.color });
  });

  app.patch('/labels/:key', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const { key } = labelKeyParamSchema.parse(request.params);
    const patch = labelPatchSchema.parse(request.body ?? {});
    if (!isUserLabelKey(key)) throw new NotFoundError(`Метка не найдена: ${key}`);

    const name = patch.name === undefined ? undefined : normalizeLabelName(patch.name);
    if (name !== undefined) {
      if (name === '') throw new BadRequestError('У метки должно быть название');
      if (isServiceKeyword(name)) {
        throw new BadRequestError(
          `Это служебное слово продукта, меткой его назвать нельзя: ${name}`,
        );
      }
      const existing = await dictionaryOf(session);
      if (existing.some((l) => l.key !== key && l.name.toLowerCase() === name.toLowerCase())) {
        throw new BadRequestError(`Метка «${name}» уже есть`);
      }
    }

    /*
     * Ключ не меняется НИКОГДА, даже если имя изменилось до неузнаваемости.
     * Ключ лежит в письмах: менять его значило бы переставлять ключевые
     * слова на тысячах писем ради переименования в справочнике — и терять
     * пометку на тех письмах, до которых переделка не доехала.
     */
    const updated = await requireStore().update(session.email, key, {
      ...(name !== undefined ? { name } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
    });
    if (!updated) throw new NotFoundError(`Метка не найдена: ${key}`);
    return updated;
  });

  /**
   * Удаление метки. Два разных действия за одним словом, и человека
   * спрашивают, какое из них он имеет в виду:
   *
   *   purge=0 — метка уходит из справочника, а ключевые слова остаются
   *             в письмах. Пометка станет невидимой, но не пропадёт:
   *             заведя метку с тем же именем, человек её не вернёт (ключ
   *             выдаётся новый), зато ничего и не потеряно безвозвратно.
   *   purge=1 — ключевое слово снимается со всех писем ящика. Это
   *             необратимо, и ответ честно говорит, скольких писем
   *             коснулись.
   *
   * Порядок важен: сперва письма, потом справочник. Упади мы посередине —
   * метка останется в справочнике и снятие можно повторить. В обратном
   * порядке ключ бы потерялся, а слова в письмах остались бы навсегда
   * безымянными.
   */
  app.delete('/labels/:key', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const { key } = labelKeyParamSchema.parse(request.params);
    const { purge } = purgeQuerySchema.parse(request.query ?? {});
    if (!isUserLabelKey(key)) throw new NotFoundError(`Метка не найдена: ${key}`);

    const dictionary = await dictionaryOf(session);
    const label = dictionary.find((l) => l.key === key);
    if (!label) throw new NotFoundError(`Метка не найдена: ${key}`);

    let removedFromMessages = 0;
    if (purge === '1') {
      removedFromMessages = await pool.withClient(session.email, session.password, (client) =>
        purgeKeyword(client, label.key, request.log),
      );
    }
    await requireStore().remove(session.email, label.key);
    return { ok: true, key: label.key, purged: purge === '1', removedFromMessages };
  });

  /**
   * Какие метки стоят на перечисленных письмах.
   *
   * Нужно ровно для одного места — строки списка, сгруппированного по
   * перепискам. Строка представляет разговор, но сервер отдаёт в списке
   * только ПОСЛЕДНЕЕ его письмо (`GET /messages?threaded=true`), а метки
   * лежат в каждом письме отдельно. Без этого маршрута строка показывала бы
   * метки последнего письма — и пометка «оплатить», поставленная на весь
   * разговор, исчезала бы из списка от первого же ответа собеседника:
   * новое письмо ключевого слова не несёт.
   *
   * Отдельным запросом, а не полем в списке писем, по двум причинам:
   * сводку переписки собирает imap/service.ts (общий горячий путь всего
   * списка, куда эта возможность лезть не должна), и запрос этот
   * необязательный — если он не удался, список рисуется как прежде.
   *
   * POST, а не GET, из-за длины: пятьсот составных идентификаторов писем
   * в строке запроса — это несколько килобайт, и такой адрес обрежет
   * первый же посредник.
   *
   * Достаётся ТОЛЬКО список ключевых слов (FETCH FLAGS) — ни темы, ни тела,
   * ни заголовков. И в ответ попадают только слова из справочника: чужое
   * ключевое слово и служебная пометка сюда не проходят, показывать их
   * пилюлей всё равно нечем.
   */
  app.post('/messages/labels/of', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = labelsOfBodySchema.parse(request.body);
    const dictionary = await dictionaryOf(session);
    if (dictionary.length === 0) return { labels: {} };

    const known = new Map(dictionary.map((l) => [l.key.toLowerCase(), l.key]));
    const byFolder = groupIdsByFolder(body.ids);
    const labels: Record<string, string[]> = {};

    await pool.withClient(session.email, session.password, async (client) => {
      for (const [folderId, uids] of byFolder) {
        let folder;
        try {
          folder = await requireFolder(client, folderId);
        } catch {
          // Папки нет — читать нечего. Это ЧТЕНИЕ, и падать из-за одной
          // пропавшей папки нельзя: строки остальных папок остались бы
          // без меток из-за чужой беды.
          continue;
        }
        const lock = await client.getMailboxLock(folder.path);
        try {
          for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
            const chunk = uids.slice(i, i + FETCH_CHUNK);
            const fetched = await client.fetchAll(chunk.join(','), { uid: true, flags: true }, {
              uid: true,
            });
            for (const msg of fetched) {
              const own: string[] = [];
              for (const flag of msg.flags ?? []) {
                const resolved = known.get(flag.toLowerCase());
                if (resolved && !own.includes(resolved)) own.push(resolved);
              }
              // Письма без меток в ответ не кладём: пустой список — это
              // умолчание на стороне интерфейса, и гонять его по сети
              // на каждую строку незачем.
              if (own.length > 0) labels[`${folder.id}:${String(msg.uid)}`] = own;
            }
          }
        } finally {
          lock.release();
        }
      }
    });

    return { labels };
  });

  /**
   * Поставить и снять метки на письмах.
   *
   * Отдельный маршрут, а не расширение `POST /api/messages/flags`, ровно
   * по причине из шапки: у флагов список слов задан схемой намертво
   * (`seen`, `flagged`, `deleted`), а здесь слова приходят строками и
   * обязаны пройти сверку со справочником. Смешивать эти два разбора
   * в одном обработчике значило бы, что однажды строка проедет мимо сверки.
   */
  app.post('/messages/labels', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = applyBodySchema.parse(request.body);
    if (body.add.length === 0 && body.remove.length === 0) {
      throw new BadRequestError('Не указано ни одной метки');
    }
    const dictionary = await dictionaryOf(session);
    const toAdd = resolveLabelKeys(body.add, dictionary);
    const toRemove = resolveLabelKeys(body.remove, dictionary);
    // Одно и то же слово и поставить, и снять — это ошибка в интерфейсе,
    // а не «сначала поставим, потом снимем»: порядок был бы случайным.
    const clash = toAdd.find((k) => toRemove.includes(k));
    if (clash) throw new BadRequestError(`Метку нельзя поставить и снять разом: ${clash}`);

    const byFolder = groupIdsByFolder(body.ids);
    let updated = 0;

    await pool.withClient(session.email, session.password, async (client) => {
      // Сначала проверяем ВСЕ папки и только потом меняем хоть что-то —
      // то же правило, что у флагов (routes/messages.ts): 404 на середине
      // списка оставлял бы ящик в состоянии, которого не видел человек.
      const targets: Array<{ path: string; uids: number[] }> = [];
      for (const [folderId, uids] of byFolder) {
        const folder = await requireFolder(client, folderId);
        targets.push({ path: folder.path, uids });
      }

      for (const { path, uids } of targets) {
        const lock = await client.getMailboxLock(path);
        try {
          // Считаем результат по ящику, а не по длине присланного списка
          const present = await existingUids(client, uids);
          if (present.length === 0) continue;
          if (toAdd.length > 0) await client.messageFlagsAdd(present, toAdd, { uid: true });
          if (toRemove.length > 0) {
            await client.messageFlagsRemove(present, toRemove, { uid: true });
          }
          updated += present.length;
        } finally {
          lock.release();
        }
      }
    });

    return { updated, added: toAdd, removed: toRemove };
  });
}
