/**
 * Маршруты разбора ящика: рассылки пачкой и массовая уборка.
 *
 *   GET  /api/mailings            — кто вам пишет: группы, числа, место
 *   POST /api/mailings/unsubscribe — отписаться от группы (RFC 8058)
 *   GET  /api/cleanup             — куда делось место: квота и тяжёлое
 *   POST /api/cleanup/sweep       — посчитать и убрать пачкой
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ УБОРКА — ОДИН МАРШРУТ, А НЕ ТРИ
 * ------------------------------------------------------------------
 * «Удалить всё от отправителя», «убрать всё старше года», «отправить
 * рассылку в папку» и «оставить только последнее письмо» — это ОДНО
 * действие с разными условиями: посчитать отбор и перенести его в другую
 * папку. Разложить их по трём маршрутам значило бы три места, где можно
 * ошибиться в отборе, и три места, которые надо одинаково защитить от
 * «удалили не то». Условия поэтому лежат в теле запроса, а отбор считает
 * одна функция (`selectForSweep` в mailings.ts) — та же самая, что
 * отвечает на предпросмотр.
 *
 * ------------------------------------------------------------------
 * ЧЕМ ЗАЩИЩЕНО МАССОВОЕ УДАЛЕНИЕ
 * ------------------------------------------------------------------
 * 1. Никакого необратимого удаления. Письма ПЕРЕНОСЯТСЯ — в корзину или
 *    в названную папку. `EXPUNGE` отсюда не вызывается никогда.
 * 2. Число называется ДО. `dryRun: true` возвращает ровно тот отбор,
 *    который уедет при `dryRun: false`.
 * 3. Отбор не может «подрасти» между показом и нажатием. Клиент присылает
 *    отметку осмотра (`scanAt`), которую он видел; если разбор с тех пор
 *    пересобран, запрос отвергается, а не выполняется по новым данным.
 * 4. Корзина, черновики и «Отложенные» не убираются никогда — правило
 *    живёт в selectForSweep и проверено юнит-тестом.
 */
import type { FastifyInstance } from 'fastify';
import type { ImapFlow } from 'imapflow';
import { z } from 'zod';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors.js';
import {
  existingUids,
  requireFolder,
  requireOrCreateFolder,
  splitMessageId,
} from '../imap/service.js';
import { parseMessageHeaders } from './parse.js';
import { MAX_ENTITY_ID_LENGTH } from './folders.js';
import {
  groupMailings,
  heaviestMessages,
  selectForSweep,
  summarizeSelection,
  type MailingGroup,
  type ScannedMessage,
  type SweepCriteria,
} from './mailings.js';
import { scanMailbox, SCAN_LIMIT, type ScanResult } from './mailings-scan.js';
import { performUnsubscribe, type UnsubscribeSmtp } from './unsubscribe-request.js';
import type { MailSession } from '../types.js';

/**
 * Сколько живёт осмотр ящика.
 *
 * Разбор — это несколько запросов подряд: открыли список, посмотрели
 * предпросмотр, нажали «убрать». Осматривать ящик заново на каждом шаге
 * значило бы платить за это трижды и — что хуже — показывать человеку
 * три разных числа. Пять минут достаточно, чтобы разобраться, и мало,
 * чтобы разбор устарел незаметно; кнопка «Обновить» есть всегда.
 */
export const SCAN_TTL_MS = 5 * 60_000;

/** Сколько самых тяжёлых писем показываем в уборке. */
const HEAVIEST_LIMIT = 30;

/** Предел на разовый перенос — тот же, что у обычных массовых действий. */
const MOVE_CHUNK = 500;

interface CacheEntry {
  result: ScanResult;
  storedAt: number;
}

const sweepCriteriaSchema = z.object({
  folderId: z.string().min(1).max(MAX_ENTITY_ID_LENGTH).optional(),
  olderThanDays: z.coerce.number().int().min(0).max(36_500).optional(),
  keepUnread: z.boolean().default(false),
  keepFlagged: z.boolean().default(false),
  groupKey: z.string().min(1).max(512).optional(),
  largerThanBytes: z.coerce.number().int().min(0).optional(),
  keepLatest: z.coerce.number().int().min(0).max(100).optional(),
});

const sweepBodySchema = sweepCriteriaSchema.extend({
  /** Только посчитать. По умолчанию — да: случайный запрос ничего не унесёт. */
  dryRun: z.boolean().default(true),
  /** Куда переносим. По умолчанию — корзина. */
  targetFolderId: z.string().min(1).max(MAX_ENTITY_ID_LENGTH).default('trash'),
  /**
   * Отметка осмотра, который человек видел. Без неё выполнение
   * запрещено — см. пункт 3 в шапке.
   */
  scanAt: z.string().min(1).max(64).optional(),
});

const unsubscribeBodySchema = z.object({
  key: z.string().min(1).max(512),
});

const refreshQuerySchema = z.object({ refresh: z.enum(['0', '1']).default('0') });

function requireMailSession(session: MailSession | null): MailSession {
  if (!session) throw new UnauthorizedError();
  return session;
}

export interface MailingsDeps {
  /**
   * Настройки исходящей почты — для письма отписки на `mailto:`.
   *
   * Функция, а не готовый объект: маршруты собираются раньше, чем кому бы
   * то ни было понадобится SMTP, и трогать настройки на сборке они не
   * должны (см. routes/messages.ts, там же причина).
   */
  smtp: () => UnsubscribeSmtp;
}

/**
 * Строка разбора для интерфейса.
 *
 * Отличается от `MailingGroup` одним полем — долей от занятого места.
 * Считать её на клиенте было бы можно, но тогда «12 % ящика» и «сколько
 * освободится» считались бы в двух разных местах из двух разных чисел.
 */
export interface MailingGroupView extends MailingGroup {
  /** Доля от занятого места ящика, 0..1. Null — квота неизвестна. */
  quotaShare: number | null;
}

function withQuotaShare(
  groups: readonly MailingGroup[],
  quota: ScanResult['quota'],
): MailingGroupView[] {
  const used = quota?.usedBytes ?? 0;
  return groups.map((group) => ({
    ...group,
    quotaShare: used > 0 ? Math.min(1, group.bytes / used) : null,
  }));
}

export async function mailingsRoutes(app: FastifyInstance, deps: MailingsDeps): Promise<void> {
  const { pool } = app.deps;

  /*
   * Осмотры лежат в памяти процесса, а не в базе, и это осознанно: разбор
   * — это снимок ящика на минуту вперёд, а не данные, которые надо
   * пережить перезапуск. Поэтому у возможности нет ни таблицы, ни
   * миграции, ни состояния `available: false`: она работает везде, где
   * работает сама почта.
   */
  const cache = new Map<string, CacheEntry>();

  const scanFor = async (session: MailSession, force: boolean): Promise<ScanResult> => {
    const key = session.email.toLowerCase();
    const cached = cache.get(key);
    if (!force && cached && Date.now() - cached.storedAt < SCAN_TTL_MS) return cached.result;
    const result = await pool.withClient(session.email, session.password, (client) =>
      scanMailbox(client, { log: app.log }),
    );
    cache.set(key, { result, storedAt: Date.now() });
    return result;
  };

  /** Осмотр, который человек уже видел. Разошлись отметки — отказ. */
  const scanAsSeen = async (
    session: MailSession,
    scanAt: string | undefined,
  ): Promise<ScanResult> => {
    const result = await scanFor(session, false);
    if (scanAt && scanAt !== result.at) {
      throw new BadRequestError(
        'Разбор ящика пересобран, и числа могли измениться. Обновите список и повторите.',
      );
    }
    return result;
  };

  const dropCache = (session: MailSession): void => {
    cache.delete(session.email.toLowerCase());
  };

  /**
   * Кто вам пишет.
   *
   * Ответ несёт и сам разбор, и то, чего он стоил: сколько писем
   * осмотрено из скольких и дошёл ли осмотр до конца. Без этого числа
   * групп читались бы как «всё, что есть в ящике», а это неправда на
   * ящике крупнее предела осмотра.
   */
  app.get('/mailings', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const { refresh } = refreshQuerySchema.parse(request.query ?? {});
    const scan = await scanFor(session, refresh === '1');
    const groups = groupMailings(scan.messages);
    return {
      at: scan.at,
      scanned: scan.scanned,
      total: scan.total,
      truncated: scan.truncated,
      limit: SCAN_LIMIT,
      quota: scan.quota,
      folders: scan.folders,
      groups: withQuotaShare(groups, scan.quota),
    };
  });

  /**
   * Отписка от группы целиком.
   *
   * Отписка и удаление — ДВА РАЗНЫХ действия, и здесь делается только
   * первое. Так требует и здравый смысл: отписка меняет будущее (писем
   * больше не будет), удаление меняет прошлое (накопившееся уедет в
   * корзину). Человек имеет право сделать одно без другого, и уж точно
   * не должен получать второе как побочный итог первого.
   */
  app.post('/mailings/unsubscribe', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = unsubscribeBodySchema.parse(request.body);
    const scan = await scanFor(session, false);
    const group = groupMailings(scan.messages).find((g) => g.key === body.key);
    if (!group) throw new NotFoundError('Такой рассылки в разборе нет');
    if (!group.unsubscribeMessageId) {
      throw new NotFoundError(`В письмах «${group.title}» нет адреса отписки — отписаться нечем`);
    }

    const { folderId, uid } = splitMessageId(group.unsubscribeMessageId);
    const headers = await pool.withClient(session.email, session.password, async (client) => {
      const folder = await requireFolder(client, folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const msg = await client.fetchOne(String(uid), { uid: true, headers: true }, { uid: true });
        if (!msg || !msg.headers) return null;
        return parseMessageHeaders(msg.headers);
      } finally {
        lock.release();
      }
    });
    if (!headers) throw new NotFoundError('Письмо для отписки уже не найти — обновите разбор');

    const outcome = await performUnsubscribe({
      headers,
      session,
      smtp: deps.smtp(),
      log: request.log,
    });
    if (!outcome) throw new NotFoundError('В письме нет адреса отписки');
    return { ...outcome, key: group.key, title: group.title };
  });

  /**
   * Куда делось место.
   *
   * Квота берётся у почтового сервера, а не считается сложением размеров
   * писем: «сколько освободится» должно быть выражено в тех же единицах,
   * в которых человек видит заполненность ящика в профиле. Наша сумма
   * от неё отличается — Dovecot считает и служебные данные тоже.
   */
  app.get('/cleanup', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const { refresh } = refreshQuerySchema.parse(request.query ?? {});
    const scan = await scanFor(session, refresh === '1');
    const groups = groupMailings(scan.messages);

    return {
      at: scan.at,
      scanned: scan.scanned,
      total: scan.total,
      truncated: scan.truncated,
      limit: SCAN_LIMIT,
      quota: scan.quota,
      folders: scan.folders,
      /*
       * Самые тяжёлые письма — первый и самый честный ответ на вопрос
       * «куда делось место»: десяток писем с вложениями обычно весит
       * больше, чем тысяча писем без них.
       *
       * Корзина сюда не идёт: убрать оттуда уборка ничего не может (это
       * её собственное правило), и строка, по которой нельзя нажать, в
       * списке «что убрать» только мешает. Сколько занимает корзина,
       * видно в разбивке по папкам — вместе с кнопкой её очистить.
       */
      heaviest: heaviestMessages(
        scan.messages.filter((m) => m.folderRole !== 'trash'),
        HEAVIEST_LIMIT,
      ).map((m) => ({
        id: m.id,
        folderId: m.folderId,
        subject: m.subject,
        from: m.from,
        date: m.date,
        size: m.size,
        seen: m.seen,
        flagged: m.flagged,
      })),
      /*
       * Старые рассылки — второй ответ. Здесь это те группы, что признаны
       * рассылками и не присылали ничего дольше месяца: именно они и
       * лежат мёртвым грузом, потому что человек про них уже забыл.
       */
      staleMailings: withQuotaShare(
        groups.filter(
          (g) => g.mailing && Date.now() - new Date(g.lastDate).getTime() > 30 * 86_400_000,
        ),
        scan.quota,
      ),
    };
  });

  /**
   * Посчитать и убрать.
   *
   * Один и тот же запрос с `dryRun: true` и `dryRun: false` — и это
   * главное свойство маршрута: показанное число и выполненное действие
   * приходят из одного отбора, а не из двух похожих.
   */
  app.post('/cleanup/sweep', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = sweepBodySchema.parse(request.body);
    const criteria: SweepCriteria = {
      ...(body.folderId !== undefined ? { folderId: body.folderId } : {}),
      ...(body.olderThanDays !== undefined ? { olderThanDays: body.olderThanDays } : {}),
      keepUnread: body.keepUnread,
      keepFlagged: body.keepFlagged,
      ...(body.groupKey !== undefined ? { groupKey: body.groupKey } : {}),
      ...(body.largerThanBytes !== undefined ? { largerThanBytes: body.largerThanBytes } : {}),
      ...(body.keepLatest !== undefined ? { keepLatest: body.keepLatest } : {}),
    };

    const scan = await scanAsSeen(session, body.scanAt);
    const chosen = selectForSweep(scan.messages, criteria);
    const preview = summarizeSelection(chosen);

    if (body.dryRun) {
      return { dryRun: true, at: scan.at, ...preview, moved: 0, targetFolderId: null };
    }

    /*
     * Выполнение без отметки осмотра запрещено. Отбор считается по
     * снимку ящика, и «убрать 412 писем» имеет смысл только по тому же
     * снимку, по которому эти 412 были показаны. Клиент, который отметку
     * не прислал, показать число заранее не мог по построению.
     */
    if (!body.scanAt) {
      throw new BadRequestError(
        'Выполнять уборку можно только по показанному разбору: пришлите отметку осмотра.',
      );
    }
    if (chosen.length === 0) {
      return { dryRun: false, at: scan.at, ...preview, moved: 0, targetFolderId: null };
    }

    const { moved, targetFolderId } = await pool.withClient(
      session.email,
      session.password,
      (client) => moveScanned(client, chosen, body.targetFolderId),
    );
    // Ящик изменился — прежний разбор больше не про него
    dropCache(session);
    return { dryRun: false, at: scan.at, ...preview, moved, targetFolderId };
  });
}

/**
 * Переносит отобранные письма в папку.
 *
 * Разложены по папкам-источникам и переносятся частями не больше пятисот:
 * ровно так же, как это делают обычные массовые действия
 * (routes/messages.ts). Число в ответе считается по ящику
 * (`existingUids` + карта UIDPLUS), а не по длине списка: письмо, которое
 * успели удалить с телефона, не должно попадать в «перенесено».
 *
 * Папка-получатель проверяется ДО первого переноса — 404 на середине
 * оставил бы ящик в состоянии, которого человек не видел.
 */
async function moveScanned(
  client: ImapFlow,
  chosen: readonly ScannedMessage[],
  targetFolderId: string,
): Promise<{ moved: number; targetFolderId: string }> {
  const target = await requireOrCreateFolder(client, targetFolderId);

  const byFolder = new Map<string, number[]>();
  for (const message of chosen) {
    if (message.folderId === target.id) continue;
    const bucket = byFolder.get(message.folderId);
    if (bucket) bucket.push(message.uid);
    else byFolder.set(message.folderId, [message.uid]);
  }

  const sources: Array<{ path: string; uids: number[] }> = [];
  for (const [folderId, uids] of byFolder) {
    const folder = await requireFolder(client, folderId);
    sources.push({ path: folder.path, uids });
  }

  let moved = 0;
  for (const source of sources) {
    const lock = await client.getMailboxLock(source.path);
    try {
      for (let i = 0; i < source.uids.length; i += MOVE_CHUNK) {
        const slice = source.uids.slice(i, i + MOVE_CHUNK);
        const present = await existingUids(client, slice);
        if (present.length === 0) continue;
        const result = await client.messageMove(present, target.path, { uid: true });
        const mapped = result && typeof result === 'object' ? result.uidMap?.size : undefined;
        moved += mapped ?? present.length;
      }
    } finally {
      lock.release();
    }
  }
  return { moved, targetFolderId: target.id };
}
