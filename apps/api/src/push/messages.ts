/**
 * Чтение писем для уведомления.
 *
 * Отдельно от правил показа (policy.ts) намеренно: там чистая логика без
 * сети, здесь — IMAP, помощник ИИ и логотипы отправителей. Смешав их,
 * пришлось бы поднимать почтовый ящик, чтобы проверить склонение слова
 * «письмо».
 *
 * Тема, отправитель и первые фразы берутся ровно тем же путём, что и для
 * списка писем (buildSummary + fetchSnippet), а логотип — той же
 * проверкой подлинности отправителя (senderLogoDomain). Иначе уведомление
 * показывало бы одно, а список — другое, и это выглядело бы поломкой.
 */
import type { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import { fetchSnippet, requireFolder, splitMessageId } from '../imap/service.js';
import { buildSummary } from '../mail/summary.js';
import type { ImapPool } from '../imap/pool.js';
import type { MailSession } from '../types.js';
import { errorInfo } from '../log.js';
import type { NotificationItem } from './policy.js';

/** Прочитанное письмо без содержимого, зависящего от уровня подробности. */
export interface RawNotificationItem extends NotificationItem {
  /**
   * Домен, которому в ЭТОМ письме разрешено показать логотип. null —
   * подлинность отправителя не подтверждена. Право на логотип решается
   * там же, где и для списка писем: логотип читается как знак подлинности.
   */
  logoDomain: string | null;
}

export interface ReadItemsOptions {
  pool: ImapPool;
  session: MailSession;
  /** Идентификаторы писем вида «inbox:296». */
  ids: readonly string[];
  logger: Logger;
  /**
   * Нужны ли первые фразы. За ними идёт отдельная загрузка части письма —
   * на уровнях «только факт» и «отправитель и тема» она не нужна, и
   * делать её значило бы читать содержимое письма, которого человек
   * показывать не просил.
   */
  withPreview: boolean;
}

/**
 * Читает письма для уведомления.
 *
 * Пропавшие письма (успели удалить, переложили) молча выпадают из списка:
 * уведомление о письме, которого уже нет, — худшее, что можно показать.
 */
export async function readNotificationItems(
  options: ReadItemsOptions,
): Promise<RawNotificationItem[]> {
  const { ids } = options;
  if (ids.length === 0) return [];

  const byFolder = new Map<string, number[]>();
  for (const id of ids) {
    try {
      const { folderId, uid } = splitMessageId(id);
      const list = byFolder.get(folderId);
      if (list) list.push(uid);
      else byFolder.set(folderId, [uid]);
    } catch {
      /* битый идентификатор из очереди — просто пропускаем */
    }
  }

  const found = new Map<string, RawNotificationItem>();
  await options.pool.withClient(
    options.session.email,
    options.session.password,
    async (client: ImapFlow) => {
      for (const [folderId, uids] of byFolder) {
        const folder = await requireFolder(client, folderId);
        const lock = await client.getMailboxLock(folder.path);
        try {
          /*
           * NOOP заставляет почтовый сервер пересмотреть папку — и здесь
           * это не перестраховка, а исправление найденного на живом стенде
           * дефекта.
           *
           * Соединение берётся из пула и живёт между запросами с уже
           * ВЫБРАННОЙ папкой. Уведомление же спрашивается в ту же секунду,
           * когда письмо доставлено: Service Worker просыпается от push
           * почти мгновенно. Письма, пришедшего секунду назад, такое
           * соединение ещё не видит — `fetchOne` возвращает пустоту, и
           * уведомление выходило безымянным «Новое письмо» вместо темы и
           * отправителя. Через десяток секунд тот же запрос отрабатывал
           * правильно, отчего дефект и выглядел мистикой.
           *
           * Ровно то же и по той же причине делает список писем
           * (см. listMessages в imap/service.ts). Стоит один оборот
           * к серверу.
           */
          await client.noop();
          for (const uid of uids) {
            const msg = await client.fetchOne(
              String(uid),
              {
                uid: true,
                envelope: true,
                flags: true,
                bodyStructure: true,
                size: true,
                internalDate: true,
                // Те же заголовки, что берёт список писем: сырая тема
                // (восьмибитная кодировка без RFC 2047) и результат
                // проверки подлинности — от него зависит право на логотип.
                headers: ['subject', 'authentication-results'],
              },
              { uid: true },
            );
            if (!msg) continue;
            const snippet = options.withPreview ? await fetchSnippet(client, msg) : '';
            const summary = buildSummary({
              folderId: folder.id,
              msg,
              snippet,
              rawHeaders: msg.headers,
            });
            found.set(summary.id, {
              id: summary.id,
              folderId: summary.folderId,
              from: summary.from,
              subject: summary.subject,
              date: summary.date,
              preview: snippet === '' ? null : snippet,
              summary: null,
              logoUrl: null,
              // Поле необязательное в контракте письма: «нет домена» и
              // «поле не заполнено» для значка означают одно и то же —
              // логотипа не будет, в кружке останется буква.
              logoDomain: summary.senderLogoDomain ?? null,
            });
          }
        } finally {
          lock.release();
        }
      }
    },
  );

  // Порядок — как просили: первым идёт самое свежее письмо, и именно оно
  // определяет заголовок окна.
  const result: RawNotificationItem[] = [];
  for (const id of ids) {
    const item = found.get(id);
    if (item) result.push(item);
  }
  if (result.length !== ids.length) {
    options.logger.debug(
      { asked: ids.length, found: result.length },
      'Часть писем для уведомления уже недоступна',
    );
  }
  return result;
}

/** Ошибка чтения писем не должна ломать уведомление целиком. */
export async function readNotificationItemsSafely(
  options: ReadItemsOptions,
): Promise<RawNotificationItem[]> {
  try {
    return await readNotificationItems(options);
  } catch (err) {
    options.logger.warn(errorInfo(err), 'Не удалось прочитать письма для уведомления');
    return [];
  }
}
