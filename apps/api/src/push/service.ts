/**
 * Уведомления о новой почте: что показать, кому доставить и что при этом
 * уходит наружу.
 *
 * ------------------------------------------------------------------
 * ДВА ПУТИ, И ОНИ РАЗНЫЕ ПО ПРИРОДЕ
 * ------------------------------------------------------------------
 * 1. ВКЛАДКА ОТКРЫТА. Событие приходит по нашему же WebSocket, окно
 *    рисует сама страница через Notification API. Ни один байт не покидает
 *    машину — ни к нам, ни тем более к посторонним. Показывать здесь можно
 *    что угодно, вплоть до сводки от ИИ.
 *
 * 2. ВКЛАДКА ЗАКРЫТА. Разбудить браузер может только служба доставки:
 *    Google для Chrome, Mozilla для Firefox, Apple для Safari. Наш сервер
 *    обращается к ней, она будит браузер, Service Worker показывает окно.
 *
 * Во втором случае по умолчанию наружу уходит МИНИМУМ: «есть новости» и
 * отпечаток ящика. Ни темы, ни отправителя, ни текста. Содержимое Service
 * Worker забирает с нашего сервера (GET /api/push/notifications) в момент
 * показа. Полное обоснование — в types.ts, в шапке файла; здесь важно
 * следствие: `minimalPayload` ниже — это ВСЁ, что видит посторонний.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ PUSH НЕ УХОДИТ ТУДА, ГДЕ ОТКРЫТА ВКЛАДКА
 * ------------------------------------------------------------------
 * Иначе на одно письмо человек получал бы два окна: одно от вкладки,
 * второе от Service Worker. Отличать «вкладку» от «браузера» приходится
 * по отпечатку (clientId): вкладка на рабочем компьютере не должна
 * отменять уведомление на телефоне, где никакой вкладки нет.
 */
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { ImapPool } from '../imap/pool.js';
import type { MailSession } from '../types.js';
import { errorInfo } from '../log.js';
import type { PushConfig } from './config.js';
import type { NotificationPrefsPatch, PushDb } from './db.js';
import { MAX_PUSH_PAYLOAD_BYTES, type VapidKeys } from './crypto.js';
import { readNotificationItemsSafely, type RawNotificationItem } from './messages.js';
import {
  buildNotificationView,
  shouldNotify,
  type ArrivedMessage,
  type NotificationItem,
  type SkipReason,
} from './policy.js';
import { sendPush, type PushSendResult } from './sender.js';
import {
  defaultNotificationPrefs,
  levelAtMost,
  type NotificationLevel,
  type NotificationPrefs,
  type NotificationView,
  type PushSubscriptionRecord,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Окружение                                                            */
/* ------------------------------------------------------------------ */

/** Сводка от ИИ либо честная причина, почему её не будет. */
export interface AiSummaryResult {
  text: string | null;
  /** Что показать в настройках, если сводки не вышло. null — всё в порядке. */
  degraded: string | null;
}

/**
 * Всё, что сервис берёт извне. Через узкий интерфейс, а не через
 * FastifyInstance: правила уведомлений должны проверяться без поднятого
 * почтового ящика, помощника ИИ и базы логотипов.
 */
export interface PushEnvironment {
  pool: ImapPool;
  /**
   * Главный выключатель уведомлений — общая настройка ящика
   * (`notifyBrowser`). Второго такого же выключателя здесь нет намеренно:
   * два выключателя одного и того же — прямая дорога к «включил, а не
   * работает».
   */
  masterSwitch(email: string): Promise<boolean>;
  /**
   * Адрес растрового логотипа отправителя или null. Векторный логотип
   * сюда попадать не должен: Chrome не рисует SVG в уведомлениях вовсе.
   */
  logoUrl(email: string, domain: string): Promise<string | null>;
  /** Сводка от ИИ по письму. */
  aiSummary(session: MailSession, messageId: string): Promise<AiSummaryResult>;
  /** Доступен ли уровень «сводка от ИИ» этому человеку, и если нет — почему. */
  aiAvailability(email: string): Promise<{ available: boolean; reason: string | null }>;
  fetchImpl?: typeof fetch;
}

/* ------------------------------------------------------------------ */
/* Очередь ожидающих показа                                             */
/* ------------------------------------------------------------------ */

interface PendingEntry {
  id: string;
  at: number;
}

/**
 * Отпечаток ящика для ярлыка окна и для тела push.
 *
 * Хэш, а не адрес: ярлык окна виден в отладчике браузера, а тело push
 * проходит через посторонний сервер. Класть туда адрес ящика — значит
 * сообщить посреднику, кому именно пришло письмо, чего он иначе не знает.
 */
export function accountKey(email: string): string {
  return createHash('sha256').update(email.toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* Состояние для интерфейса                                             */
/* ------------------------------------------------------------------ */

export interface PushDeviceDto {
  id: number;
  /** Название браузера, разобранное из User-Agent. Адреса подписки нет. */
  browser: string;
  createdAt: string;
  lastSeenAt: string;
  /** Это устройство — то, с которого пришёл запрос. */
  current: boolean;
  lastError: string | null;
}

export interface PushStateDto {
  /** Уведомления при закрытой вкладке работают на этом сервере. */
  pushAvailable: boolean;
  /** Почему не работают. null — работают. */
  pushUnavailableReason: string | null;
  /** Открытый ключ VAPID для подписки в браузере. */
  vapidPublicKey: string | null;
  prefs: NotificationPrefs;
  devices: PushDeviceDto[];
  /** Доступен ли уровень «сводка от ИИ» и почему нет. */
  ai: { available: boolean; reason: string | null };
}

/** Название браузера из User-Agent — для списка устройств в настройках. */
export function browserName(userAgent: string | null): string {
  const ua = userAgent ?? '';
  if (/\bEdg\//u.test(ua)) return 'Microsoft Edge';
  if (/\bYaBrowser\//u.test(ua)) return 'Яндекс.Браузер';
  if (/\bOPR\//u.test(ua)) return 'Opera';
  if (/\bFirefox\//u.test(ua)) return 'Firefox';
  if (/\bChrome\//u.test(ua)) return 'Chrome';
  if (/\bSafari\//u.test(ua)) return 'Safari';
  return 'Неизвестный браузер';
}

/* ------------------------------------------------------------------ */
/* Сервис                                                               */
/* ------------------------------------------------------------------ */

export class PushService {
  readonly #config: PushConfig;
  readonly #db: PushDb | null;
  readonly #logger: Logger;
  readonly #env: PushEnvironment;
  /**
   * Очередь неувиденных уведомлений — В ПАМЯТИ, и это осознанно.
   *
   * Она живёт ровно столько же, сколько наблюдение за ящиком по IMAP IDLE:
   * оба принадлежат одному процессу сервера приложения. Класть её в Redis
   * значило бы завести второй источник истины и второй способ сломаться,
   * не получив ничего: после перезапуска сервера наблюдение всё равно
   * начинается заново, и «неувиденные» уведомления теряют смысл вместе с ним.
   *
   * Хранятся ТОЛЬКО идентификаторы писем («inbox:296») и время. Ни темы,
   * ни отправителя, ни текста здесь нет — они читаются из ящика в момент
   * показа.
   */
  readonly #pending = new Map<string, PendingEntry[]>();
  #keys: VapidKeys | null = null;
  #keysReason: string | null = null;

  constructor(init: {
    config: PushConfig;
    db: PushDb | null;
    logger: Logger;
    env: PushEnvironment;
  }) {
    this.#config = init.config;
    this.#db = init.db;
    this.#logger = init.logger;
    this.#env = init.env;
  }

  get config(): PushConfig {
    return this.#config;
  }

  get db(): PushDb | null {
    return this.#db;
  }

  /** Ключи сервера. null — уведомления при закрытой вкладке невозможны. */
  get keys(): VapidKeys | null {
    return this.#keys;
  }

  /** Готов ли раздел к работе с подписками. */
  get pushAvailable(): boolean {
    return this.#config.PUSH_ENABLED && this.#db !== null && this.#keys !== null;
  }

  get pushUnavailableReason(): string | null {
    if (!this.#config.PUSH_ENABLED) {
      return 'Уведомления при закрытой вкладке выключены на сервере (PUSH_ENABLED=false)';
    }
    if (!this.#db) {
      return 'Нет подключения к базе: подписки хранить негде';
    }
    if (!this.#keys) {
      return this.#keysReason ?? 'Не удалось получить ключи сервера для уведомлений';
    }
    return null;
  }

  /**
   * Готовит ключи сервера. Вызывается один раз при старте.
   *
   * Ключи из окружения важнее сохранённых: их задают ровно тогда, когда
   * переносят установку вместе с уже выданными подписками, и молча
   * подменить их своими значило бы обесценить все подписки разом.
   */
  async init(): Promise<void> {
    if (!this.#config.PUSH_ENABLED) return;
    const fromEnv = this.#config.PUSH_VAPID_PUBLIC_KEY;
    const privateFromEnv = this.#config.PUSH_VAPID_PRIVATE_KEY;
    if (fromEnv && privateFromEnv) {
      this.#keys = { publicKey: fromEnv, privateKey: privateFromEnv };
      return;
    }
    if (fromEnv || privateFromEnv) {
      this.#keysReason =
        'Задана только половина пары PUSH_VAPID_PUBLIC_KEY/PUSH_VAPID_PRIVATE_KEY. ' +
        'Нужны обе или ни одной.';
      this.#logger.error(this.#keysReason);
      return;
    }
    if (!this.#db) return;
    try {
      this.#keys = await this.#db.ensureVapidKeys();
    } catch (err) {
      this.#keysReason = 'Не удалось прочитать ключи уведомлений из базы (миграция 0012?)';
      this.#logger.warn(errorInfo(err), this.#keysReason);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Настройки                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Действующие настройки: подробности из своей таблицы плюс главный
   * выключатель из общих настроек ящика.
   */
  async prefs(email: string): Promise<NotificationPrefs> {
    const stored = this.#db ? await this.#db.getPrefs(email).catch(() => null) : null;
    const base = stored ?? defaultNotificationPrefs();
    let enabled = false;
    try {
      enabled = await this.#env.masterSwitch(email);
    } catch (err) {
      // Недоступные настройки означают «не разрешал»: уведомления,
      // которых не просили, хуже отсутствующих.
      this.#logger.warn(errorInfo(err), 'Не удалось прочитать главный выключатель уведомлений');
    }
    return { ...base, enabled };
  }

  async savePrefs(email: string, patch: NotificationPrefsPatch): Promise<NotificationPrefs> {
    if (!this.#db) throw new Error('Настройки уведомлений недоступны: нет базы');
    const saved = await this.#db.savePrefs(email, patch);
    return { ...saved, enabled: await this.#env.masterSwitch(email).catch(() => false) };
  }

  async state(email: string, currentClientId: string | null): Promise<PushStateDto> {
    const prefs = await this.prefs(email);
    const subscriptions = this.#db ? await this.#db.listSubscriptions(email).catch(() => []) : [];
    return {
      pushAvailable: this.pushAvailable,
      pushUnavailableReason: this.pushUnavailableReason,
      vapidPublicKey: this.#keys?.publicKey ?? null,
      prefs,
      devices: subscriptions.map((sub) => ({
        id: sub.id,
        browser: browserName(sub.userAgent),
        createdAt: sub.createdAt,
        lastSeenAt: sub.lastSeenAt,
        current: currentClientId !== null && sub.clientId === currentClientId,
        lastError: sub.lastError,
      })),
      ai: await this.#env.aiAvailability(email).catch(() => ({
        available: false,
        reason: 'Помощник на основе ИИ недоступен',
      })),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Очередь                                                            */
  /* ---------------------------------------------------------------- */

  /** Идентификаторы неувиденных писем, свежие первыми. */
  pending(email: string): string[] {
    const key = accountKey(email);
    const now = Date.now();
    const list = (this.#pending.get(key) ?? []).filter(
      (entry) => now - entry.at < this.#config.PUSH_PENDING_TTL_MS,
    );
    if (list.length === 0) this.#pending.delete(key);
    else this.#pending.set(key, list);
    return list.map((entry) => entry.id);
  }

  #enqueue(email: string, id: string): void {
    const key = accountKey(email);
    const list = this.#pending.get(key) ?? [];
    // Повторное событие об одном письме (переподключение наблюдателя)
    // не должно превращаться во второе «новое письмо» в счётчике группы.
    if (list.some((entry) => entry.id === id)) return;
    list.unshift({ id, at: Date.now() });
    this.#pending.set(key, list.slice(0, this.#config.PUSH_PENDING_MAX));
  }

  /**
   * Забыть уведомления: их увидели, по ним щёлкнули или их закрыли.
   * Без списка — забыть все: человек открыл почту, новостей больше нет.
   */
  markSeen(email: string, ids?: readonly string[]): number {
    const key = accountKey(email);
    const list = this.#pending.get(key) ?? [];
    if (!ids || ids.length === 0) {
      this.#pending.delete(key);
      return list.length;
    }
    const drop = new Set(ids);
    const left = list.filter((entry) => !drop.has(entry.id));
    if (left.length === 0) this.#pending.delete(key);
    else this.#pending.set(key, left);
    return list.length - left.length;
  }

  /* ---------------------------------------------------------------- */
  /* Новое письмо                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Пришло новое письмо.
   *
   * Возвращает решение и число отправленных push-сообщений — не ради
   * красоты, а чтобы это можно было проверить тестом и увидеть в журнале:
   * «уведомления нет» обязано иметь причину.
   */
  async onNewMessage(
    session: MailSession,
    message: ArrivedMessage,
    options: { liveClientIds: ReadonlySet<string>; ownAddresses?: readonly string[] } ,
  ): Promise<{ notified: boolean; reason: SkipReason | null; pushed: number }> {
    const prefs = await this.prefs(session.email);
    const decision = shouldNotify(message, {
      prefs,
      ownAddresses: options.ownAddresses ?? [session.email],
      now: new Date(),
    });
    if (!decision.notify) {
      this.#logger.debug(
        { reason: decision.reason, id: message.id },
        'Уведомление о письме не показываем',
      );
      return { notified: false, reason: decision.reason, pushed: 0 };
    }

    this.#enqueue(session.email, message.id);

    // Открытая вкладка покажет окно сама — по событию WebSocket. Push
    // уходит только туда, где вкладки нет.
    const pushed = prefs.push
      ? await this.#deliver(session, prefs, options.liveClientIds).catch((err) => {
          this.#logger.warn(errorInfo(err), 'Не удалось разослать push-уведомления');
          return 0;
        })
      : 0;

    return { notified: true, reason: null, pushed };
  }

  /** Рассылает push всем подпискам ящика, кроме тех, где открыта вкладка. */
  async #deliver(
    session: MailSession,
    prefs: NotificationPrefs,
    liveClientIds: ReadonlySet<string>,
  ): Promise<number> {
    if (!this.pushAvailable || !this.#db || !this.#keys) return 0;
    const subscriptions = await this.#db.listSubscriptions(session.email);
    const targets = subscriptions.filter((sub) => !liveClientIds.has(sub.clientId));
    if (targets.length === 0) return 0;

    const payload = prefs.pushPayload
      ? await this.#payloadWithContent(session, prefs)
      : this.minimalPayload(session.email);

    let sent = 0;
    for (const sub of targets) {
      const result = await this.#sendTo(sub, payload);
      if (result.ok) sent += 1;
    }
    return sent;
  }

  /**
   * ВСЁ, что видит посторонний при настройке по умолчанию.
   *
   * Отпечаток ящика нужен Service Worker, чтобы не перепутать ярлыки окон
   * двух ящиков в одном браузере. По нему нельзя узнать ни адрес, ни
   * отправителя, ни тему — ничего.
   */
  minimalPayload(email: string): string {
    return JSON.stringify({ v: 1, k: accountKey(email) });
  }

  /**
   * Тело с содержимым — только по явному выбору человека.
   *
   * Оно зашифровано (RFC 8291), и прочитать его посредник не может. Но
   * шифротекст у него остаётся, а мы за это платим ещё и свежестью:
   * содержимое в теле — снимок момента отправки, а письмо могли уже
   * прочитать с другого устройства. Поэтому не по умолчанию.
   */
  async #payloadWithContent(session: MailSession, prefs: NotificationPrefs): Promise<string> {
    try {
      const view = await this.buildView(session, prefs);
      const body = JSON.stringify({ v: 1, k: accountKey(session.email), view });
      if (Buffer.byteLength(body, 'utf8') <= MAX_PUSH_PAYLOAD_BYTES) return body;
      // Не влезло — уходит минимум, содержимое Service Worker заберёт сам.
      this.#logger.debug('Уведомление с содержимым не помещается в push, уходит минимальное');
    } catch (err) {
      this.#logger.warn(errorInfo(err), 'Не удалось собрать содержимое для push');
    }
    return this.minimalPayload(session.email);
  }

  async #sendTo(sub: PushSubscriptionRecord, payload: string): Promise<PushSendResult> {
    const result = await sendPush({
      target: { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      payload,
      keys: this.#keys!,
      subject: this.#config.contact,
      ttlSeconds: this.#config.PUSH_TTL_SECONDS,
      timeoutMs: this.#config.PUSH_TIMEOUT_MS,
      logger: this.#logger,
      ...(this.#env.fetchImpl ? { fetchImpl: this.#env.fetchImpl } : {}),
    });

    if (!this.#db) return result;
    if (result.ok) {
      await this.#db.touchSubscription(sub.endpoint).catch(() => undefined);
    } else if (result.gone) {
      // Подписки больше нет — повторять по ней бессмысленно навсегда.
      this.#logger.info({ browser: browserName(sub.userAgent) }, 'Подписка отозвана, удаляем');
      await this.#db.forgetEndpoint(sub.endpoint).catch(() => undefined);
    } else {
      await this.#db.recordFailure(sub.endpoint, result.error ?? 'отказ').catch(() => undefined);
    }
    return result;
  }

  /**
   * Есть ли у ящика хоть одна подписка на доставку при закрытой вкладке.
   *
   * Спрашивает наблюдатель за почтой (ws.ts), когда закрывается последняя
   * вкладка: если подписки есть, наблюдение за ящиком надо продолжать —
   * иначе уведомления «при закрытой вкладке» не случатся никогда, потому
   * что о новом письме просто некому будет узнать.
   */
  async hasSubscriptions(email: string): Promise<boolean> {
    if (!this.pushAvailable || !this.#db) return false;
    try {
      const prefs = await this.prefs(email);
      if (!prefs.enabled || !prefs.push) return false;
      return (await this.#db.listSubscriptions(email)).length > 0;
    } catch (err) {
      this.#logger.debug(errorInfo(err), 'Не удалось проверить подписки ящика');
      return false;
    }
  }

  /** Разовая проверка: отправляет push в подписки этого браузера. */
  async sendTestPush(email: string, clientId: string): Promise<{ sent: number; error: string | null }> {
    if (!this.pushAvailable || !this.#db || !this.#keys) {
      return { sent: 0, error: this.pushUnavailableReason };
    }
    const subscriptions = (await this.#db.listSubscriptions(email)).filter(
      (sub) => sub.clientId === clientId,
    );
    if (subscriptions.length === 0) {
      return { sent: 0, error: 'В этом браузере подписки нет' };
    }
    let sent = 0;
    let error: string | null = null;
    for (const sub of subscriptions) {
      // Проверочное уведомление уходит тем же путём и с тем же телом, что
      // и настоящее: проверка, которая идёт другим путём, ничего не
      // доказывает. Признак `test` заставляет Service Worker показать
      // окно даже при пустой очереди.
      const result = await this.#sendTo(
        sub,
        JSON.stringify({ v: 1, k: accountKey(email), test: true }),
      );
      if (result.ok) sent += 1;
      else error = result.error;
    }
    return { sent, error };
  }

  /* ---------------------------------------------------------------- */
  /* Сборка окна                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Собирает описание всплывающего окна по неувиденным письмам.
   *
   * Одна и та же сборка и для Service Worker, и для открытой вкладки.
   * Соблазн собрать текст на клиенте (у вкладки уже есть тема и
   * отправитель из события WebSocket) был отвергнут: две реализации одних
   * и тех же правил расходятся всегда, и расходиться они начали бы именно
   * там, где это труднее всего заметить, — в уровнях подробности.
   */
  async buildView(
    session: MailSession,
    prefs?: NotificationPrefs,
    options: { ids?: readonly string[] } = {},
  ): Promise<NotificationView> {
    const effective = prefs ?? (await this.prefs(session.email));
    const ids = options.ids ?? this.pending(session.email);
    const key = accountKey(session.email);

    let level: NotificationLevel = effective.level;
    let degraded: string | null = null;

    // Уровень «сводка от ИИ» доступен, только пока помощник разрешён
    // администратором и человек дал согласие. Иначе честно опускаемся
    // до первых фраз — и говорим об этом в настройках.
    if (level === 'ai-summary') {
      const availability = await this.#env
        .aiAvailability(session.email)
        .catch(() => ({ available: false, reason: 'Помощник на основе ИИ недоступен' }));
      if (!availability.available) {
        level = levelAtMost(level, 'preview');
        degraded = availability.reason;
      }
    }

    const items = await this.#collectItems(session, ids, level);

    // Сводка считается ТОЛЬКО для одного письма. Считать её для каждого
    // из десяти — значит потратить десять обращений к платному сервису
    // ради текста, который в окне всё равно не поместится.
    if (level === 'ai-summary' && items.length === 1) {
      const first = items[0]!;
      const summary = await this.#env
        .aiSummary(session, first.id)
        .catch(() => ({ text: null, degraded: 'Сервис ИИ не ответил' }));
      first.summary = summary.text;
      if (summary.degraded) degraded = summary.degraded;
    }

    return buildNotificationView({ items, level, accountKey: key, degraded });
  }

  async #collectItems(
    session: MailSession,
    ids: readonly string[],
    level: NotificationLevel,
  ): Promise<NotificationItem[]> {
    if (ids.length === 0) return [];
    // «Только факт» не требует ни темы, ни отправителя — читать письма
    // ради текста, который не будет показан, незачем. Заодно это самый
    // честный вид уровня: содержимое даже не покидает почтовый ящик.
    if (level === 'minimal') {
      return ids.map((id) => ({
        id,
        folderId: id.split(':')[0] ?? 'inbox',
        from: null,
        subject: '',
        date: new Date().toISOString(),
        preview: null,
        summary: null,
        logoUrl: null,
      }));
    }

    const raw: RawNotificationItem[] = await readNotificationItemsSafely({
      pool: this.#env.pool,
      session,
      ids,
      logger: this.#logger,
      // Первые фразы загружаются отдельным обращением к письму — делаем
      // это только на тех уровнях, где они действительно показываются.
      withPreview: level === 'preview' || level === 'ai-summary',
    });

    // Логотип берём только для ОДНОГО письма: в групповом окне он всё
    // равно не используется, а лишний поход в базу логотипов — лишний.
    if (raw.length === 1) {
      const only = raw[0]!;
      if (only.logoDomain) {
        only.logoUrl = await this.#env
          .logoUrl(session.email, only.logoDomain)
          .catch(() => null);
      }
    }
    return raw;
  }
}
