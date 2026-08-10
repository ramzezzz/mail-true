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
 * Читать метки отсюда нечем и незачем: они приезжают вместе со списком
 * писем (`MessageSummary.labels`, а у строки-переписки — `thread.labels`).
 * Отдельный маршрут «какие метки на этих письмах» здесь был и удалён:
 * он стоил лишнего оборота к серверу на каждый показ списка, а отвечал
 * ровно тем, что список и так знает из FETCH FLAGS.
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
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
  UpstreamUnavailableError,
} from '../errors.js';
import {
  existingUids,
  groupIdsByFolder,
  listFolders,
  requireFolder,
  searchUids,
  storeFlags,
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
  'Таблицы меток нет. Примените infra/postgres/migrations/0001_baseline.sql ' +
  'к работающей базе.';

const messageIdSchema = z.string().min(3).max(MAX_ENTITY_ID_LENGTH);

/** Сколько меток может завести один ящик. Разбор — у проверки в POST /labels. */
const MAX_LABELS = 100;

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
export interface PurgeResult {
  /** Сколько писем лишились ключевого слова. */
  removed: number;
  /**
   * Папки, где снять не удалось. Пустой список — снято везде.
   *
   * Возвращается, а не только пишется в журнал, ради удаления метки:
   * стереть её из справочника, не сняв слово с писем, значит оставить на
   * письмах пометку, у которой больше нет ни имени, ни способа её убрать.
   */
  failedFolders: string[];
}

export async function purgeKeyword(
  client: ImapFlow,
  keyword: string,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<PurgeResult> {
  if (!isUserLabelKey(keyword)) {
    // Двойной замок: сюда нельзя попасть со служебным словом даже по ошибке
    // вызывающего. Стереть `$MDNSent` со всего ящика — это необратимо.
    throw new BadRequestError(`Снимать можно только пользовательские метки: ${keyword}`);
  }
  const folders = await listFolders(client);
  let removed = 0;
  const failedFolders: string[] = [];
  for (const folder of folders) {
    let lock: { release(): void } | null = null;
    try {
      lock = await client.getMailboxLock(folder.path);
      /*
       * Через searchUids: `client.search` при отказе команды ошибку не
       * бросает, а возвращает `false`. Здесь это значило, что папка, в
       * которой поиск не выполнился, молча пропускалась: метку из
       * справочника убрали, а на письмах этой папки ключевое слово
       * осталось — и число «снято N» было занижено, ничем этого не
       * показывая. Теперь отказ поиска попадает в catch ниже и виден в
       * журнале с именем папки.
       */
      const uids = await searchUids(client, { keyword });
      if (uids.length > 0) {
        /*
         * Через storeFlags, и по двум причинам сразу. Первая: отказ STORE
         * imapflow отдаёт возвратом `false`, а не исключением — папка
         * молча оставалась с ключевым словом на письмах, тогда как метку
         * из справочника уже удаляли, и снять его становилось нечем.
         * Вторая: здесь `uids` — это ВСЕ письма папки с этой меткой, и
         * одной строкой такой список Dovecot отвергает как «Too long
         * argument» примерно с двенадцати тысяч писем.
         */
        await storeFlags(client, uids, [keyword], 'remove');
        removed += uids.length;
      }
    } catch (err) {
      failedFolders.push(folder.path);
      log?.warn(errorInfo(err, { folder: folder.path, keyword }), 'Не удалось снять метку в папке');
    } finally {
      lock?.release();
    }
  }
  return { removed, failedFolders };
}

export async function labelRoutes(app: FastifyInstance, deps: LabelsDeps): Promise<void> {
  const { pool } = app.deps;

  /**
   * Убирает метку из действий всех правил этого ящика.
   *
   * Возвращает, сколько правил тронули. Правило, у которого метка была
   * единственным действием, не удаляется и не выключается: у него могут
   * быть условия, которые человек настраивал, — пусть он сам решит, что
   * с ним делать. Зато оно перестаёт клеить то, чего больше нет.
   */
  const dropLabelFromFilters = async (
    email: string,
    key: string,
    log: { warn(obj: unknown, msg: string): void },
  ): Promise<number> => {
    try {
      const db = app.settingsService.requireDb();
      const rules = await db.listFilters(email);
      let cleaned = 0;
      for (const rule of rules) {
        const labels = rule.actions.labels ?? [];
        if (!labels.includes(key)) continue;
        await db.updateFilter(email, rule.id, {
          actions: { ...rule.actions, labels: labels.filter((l) => l !== key) },
        });
        cleaned += 1;
      }
      if (cleaned > 0) await app.settingsService.syncSieve(email);
      return cleaned;
    } catch (err) {
      log.warn(errorInfo(err), 'Метка удалена, но правила её ещё ставят');
      return 0;
    }
  };

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
    /*
     * Потолок числа меток.
     *
     * Метка — это ключевое слово IMAP на письме, и стоит она недёшево:
     * список меток целиком уходит в каждый ответ со списком писем, а
     * снять ключевое слово с прежних писем после удаления метки нечем
     * (ключ занимается навсегда — mail/labels-db.ts). Сотня — заведомо
     * больше, чем человек способен различать глазами в списке, и заведомо
     * меньше, чем начнёт мешать почте.
     */
    if (existing.length >= MAX_LABELS) {
      throw new BadRequestError(
        `Меток уже ${String(existing.length)} — это предел. Удалите ненужные.`,
      );
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
   *             в письмах. Пометка станет невидимой, но не пропадёт, и
   *             ничего не потеряно безвозвратно. Ключ при этом остаётся
   *             занятым навсегда: раньше он освобождался, и метка с тем
   *             же (или созвучным — «Счета» и «Счёта») именем получала
   *             его снова, мгновенно оказываясь на всех письмах, которые
   *             человек ею не помечал.
   *   purge=1 — ключевое слово снимается со всех писем ящика. Это
   *             необратимо, и ответ честно говорит, скольких писем
   *             коснулись.
   *
   * Порядок важен: сперва письма, потом справочник. Упади мы посередине —
   * метка останется в справочнике и снятие можно повторить. В обратном
   * порядке ключ бы потерялся, а слова в письмах остались бы навсегда
   * безымянными.
   *
   * По той же причине НЕЧИСТОЕ снятие приравнивается к падению. Отказ в
   * отдельной папке раньше только записывался в журнал: снятие «удалось»,
   * метка уходила из справочника, а в той папке ключевое слово оставалось
   * на письмах — без имени и без способа его убрать. Повторить было
   * нечего: метки уже нет, а завести её заново нельзя (ключ выдаётся
   * новый). Теперь при неудаче хотя бы в одной папке справочник не
   * трогается и ответ говорит, где повторить.
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
      const result = await pool.withClient(session.email, session.password, (client) =>
        purgeKeyword(client, label.key, request.log),
      );
      removedFromMessages = result.removed;
      if (result.failedFolders.length > 0) {
        throw new UpstreamUnavailableError(
          `Метку не удалось снять в папках: ${result.failedFolders.join(', ')}. Метка оставлена — повторите позже.`,
          { removedFromMessages, failedFolders: result.failedFolders },
        );
      }
    }
    /*
     * Сообщаем, СНЯЛИ ли слово с писем: от этого зависит судьба ключа.
     * При purge=0 слово остаётся на письмах, и ключ обязан остаться
     * занятым — иначе следующая метка с тем же (или созвучным) именем
     * получит его снова и мгновенно окажется на всех письмах, которые
     * человек ею не помечал. «Счета» и «Счёта» дают один ключ.
     */
    await requireStore().remove(session.email, label.key, purge === '1');

    /*
     * Правила, которые эту метку ставили, тоже перестают её ставить.
     *
     * ------------------------------------------------------------------
     * ЧТО БЫЛО
     * ------------------------------------------------------------------
     * Удаление трогало только справочник меток, а `mail_filters` не
     * чистил никто. Человек удалял метку вместе со снятием её со всех
     * писем — а правило продолжало клеить её на КАЖДОЕ новое подходящее
     * письмо. В списке правил при этом виден сырой ключ вместо имени, и
     * убрать его нечем: форма правила рисует галочки только по
     * существующим меткам. Оставалось удалить само правило.
     *
     * Для папок ровно это давно сделано (retargetFilterFolders в
     * settings/folders.ts) — у меток такого не было.
     *
     * Отказ здесь не отменяет удаления метки: справочник уже изменён, а
     * повторить чистку человек может, открыв правило. Поэтому пишем в
     * журнал и идём дальше.
     */
    const cleanedRules = await dropLabelFromFilters(session.email, label.key, request.log);

    return {
      ok: true,
      key: label.key,
      purged: purge === '1',
      removedFromMessages,
      /** Сколько правил перестало ставить эту метку. */
      cleanedRules,
    };
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
          // Через storeFlags: сам STORE тоже может отказать, и тогда
          // imapflow вернёт `false` вместо исключения. Раньше число
          // «поставлено меток: N» считалось сразу после вызова, то есть
          // отвечало о письмах, на которых метка не появилась.
          if (toAdd.length > 0) await storeFlags(client, present, toAdd, 'add');
          if (toRemove.length > 0) await storeFlags(client, present, toRemove, 'remove');
          updated += present.length;
        } finally {
          lock.release();
        }
      }
    });

    return { updated, added: toAdd, removed: toRemove };
  });
}
