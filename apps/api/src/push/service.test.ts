/**
 * Рассылка уведомлений: что уходит наружу, кому и когда не уходит вовсе.
 *
 * Самая важная проверка здесь — первая: в теле push-сообщения при
 * настройке по умолчанию НЕТ ни темы, ни отправителя, ни адреса ящика.
 * Она сформулирована через «чего в теле нет», а не «что в нём есть»,
 * нарочно: поле, добавленное когда-нибудь потом «просто чтобы было
 * удобнее», обязано на ней споткнуться.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createECDH, randomBytes } from 'node:crypto';
import pino from 'pino';
import { loadPushConfig } from './config.js';
import { toBase64Url, generateVapidKeys } from './crypto.js';
import { accountKey, browserName, PushService, type PushEnvironment } from './service.js';
import type { ArrivedMessage } from './policy.js';
import {
  defaultNotificationPrefs,
  type NotificationPrefs,
  type PushSubscriptionRecord,
} from './types.js';
import type { MailSession } from '../types.js';

const logger = pino({ level: 'silent' });
const SESSION: MailSession = { id: 'сессия', email: 'test@mail.local', password: 'test12345' };

/* ------------------------------------------------------------------ */
/* Заглушки                                                             */
/* ------------------------------------------------------------------ */

function browserSubscription(clientId: string): PushSubscriptionRecord {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    id: 1,
    accountEmail: SESSION.email,
    endpoint: `https://fcm.googleapis.com/fcm/send/${clientId}`,
    p256dh: toBase64Url(ecdh.getPublicKey()),
    auth: toBase64Url(randomBytes(16)),
    clientId,
    userAgent: 'Mozilla/5.0 Chrome/131.0',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    lastErrorAt: null,
    lastError: null,
  };
}

/** Хранилище в памяти вместо Postgres: правила рассылки от базы не зависят. */
function fakeDb(subscriptions: PushSubscriptionRecord[], prefs: NotificationPrefs) {
  const forgotten: string[] = [];
  const failures: Array<{ endpoint: string; error: string }> = [];
  return {
    forgotten,
    failures,
    db: {
      listSubscriptions: async () => subscriptions,
      getPrefs: async () => prefs,
      savePrefs: async () => prefs,
      touchSubscription: async () => undefined,
      forgetEndpoint: async (endpoint: string) => {
        forgotten.push(endpoint);
        subscriptions.splice(
          subscriptions.findIndex((s) => s.endpoint === endpoint),
          1,
        );
      },
      recordFailure: async (endpoint: string, error: string) => {
        failures.push({ endpoint, error });
      },
      ensureVapidKeys: async () => generateVapidKeys(),
      schemaReady: async () => true,
      deleteSubscription: async () => true,
      close: async () => undefined,
    },
  };
}

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Служба доставки: запоминает запросы и отвечает заданным кодом. */
function fakePushService(status = 201) {
  const sent: SentRequest[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const request = init as { headers: Record<string, string>; body: Uint8Array };
    sent.push({ url: String(url), headers: request.headers, body: request.body });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => 'ответ службы доставки',
    };
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

/**
 * Ящик вместо настоящего IMAP.
 *
 * Не «лишь бы что-то вернуть»: письмо проходит через тот же самый
 * buildSummary, что и список писем, поэтому проверяется заодно и чтение
 * (src/push/messages.ts) — без него уведомлению нечего показывать.
 */
function fakeMailbox(subject = 'Договор поставки') {
  /**
   * Сколько раз соединение просили пересмотреть папку.
   *
   * Не любопытства ради: без NOOP соединение из пула не видит письма,
   * пришедшего секунду назад, — а уведомление спрашивается ровно в эту
   * секунду. На живом стенде это давало безымянное «Новое письмо»
   * вместо темы и отправителя.
   */
  let noops = 0;
  const client = {
    list: async () => [
      {
        path: 'INBOX',
        name: 'INBOX',
        delimiter: '/',
        parentPath: '',
        specialUse: '\\Inbox',
        flags: new Set<string>(),
        status: { messages: 1, unseen: 1, uidValidity: 1 },
      },
    ],
    status: async () => ({ messages: 1, unseen: 1, uidValidity: 1 }),
    getMailboxLock: async () => ({ release: () => undefined }),
    noop: async () => {
      noops += 1;
    },
    fetchOne: async (uid: string) => ({
      uid: Number(uid),
      envelope: {
        subject,
        from: [{ name: 'Пётр', address: 'petr@example.com' }],
        to: [],
        cc: [],
        date: new Date('2026-08-06T11:20:00.000Z'),
      },
      flags: new Set<string>(),
      size: 2048,
      internalDate: new Date('2026-08-06T11:20:00.000Z'),
    }),
  };
  const pool = {
    withClient: async (_email: string, _password: string, fn: (c: unknown) => Promise<unknown>) =>
      fn(client),
  } as unknown as PushEnvironment['pool'];
  return { pool, noops: () => noops };
}

function environment(overrides: Partial<PushEnvironment> = {}): PushEnvironment {
  return {
    pool: {} as PushEnvironment['pool'],
    masterSwitch: async () => true,
    logoUrl: async () => null,
    aiSummary: async () => ({ text: null, degraded: null }),
    aiAvailability: async () => ({ available: true, reason: null }),
    ...overrides,
  };
}

function buildService(options: {
  prefs?: Partial<NotificationPrefs>;
  subscriptions?: PushSubscriptionRecord[];
  status?: number;
  env?: Partial<PushEnvironment>;
}) {
  const prefs: NotificationPrefs = {
    ...defaultNotificationPrefs(),
    enabled: true,
    push: true,
    ...options.prefs,
  };
  const subscriptions = options.subscriptions ?? [browserSubscription('телефон')];
  const store = fakeDb(subscriptions, prefs);
  const delivery = fakePushService(options.status ?? 201);
  const service = new PushService({
    config: loadPushConfig({ PUSH_ENABLED: 'true', DATABASE_URL: 'postgres://x' }),
    db: store.db as never,
    logger,
    env: environment({ fetchImpl: delivery.fetchImpl, ...options.env }),
  });
  // Ключи сервер берёт у себя же: init() создаёт пару через хранилище.
  // Подменять их незачем — проверяется рассылка целиком, вместе с подписью.
  return { service, store, delivery, prefs };
}

function arrived(patch: Partial<ArrivedMessage> = {}): ArrivedMessage {
  return {
    id: 'inbox:296',
    folderId: 'inbox',
    from: { name: 'Пётр', address: 'petr@example.com' },
    subject: 'Договор поставки',
    date: '2026-08-06T11:20:00.000Z',
    seen: false,
    ...patch,
  };
}

/* ------------------------------------------------------------------ */
/* Что уходит наружу                                                    */
/* ------------------------------------------------------------------ */

test('в теле push по умолчанию нет ни темы, ни отправителя, ни адреса ящика', () => {
  const { service } = buildService({});
  const payload = service.minimalPayload(SESSION.email);
  const parsed = JSON.parse(payload) as Record<string, unknown>;

  // Всё содержимое тела — версия формата и отпечаток ящика. И только.
  assert.deepEqual(Object.keys(parsed).sort(), ['k', 'v']);
  assert.equal(parsed['k'], accountKey(SESSION.email));

  // Ничего из письма и ничего, по чему можно узнать человека
  for (const secret of ['Пётр', 'petr@example.com', 'Договор', 'test@mail.local', 'mail.local']) {
    assert.ok(!payload.includes(secret), `в теле push нашлось «${secret}»: ${payload}`);
  }
});

test('отпечаток ящика необратим и у разных ящиков разный', () => {
  const a = accountKey('test@mail.local');
  const b = accountKey('demo@mail.local');
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{16}$/u);
  // Регистр адреса на отпечаток не влияет: один ящик — один ярлык окна
  assert.equal(accountKey('TEST@Mail.Local'), a);
});

/* ------------------------------------------------------------------ */
/* Кому уходит, а кому нет                                              */
/* ------------------------------------------------------------------ */

test('в браузер с открытой вкладкой push не уходит', async () => {
  const phone = browserSubscription('телефон');
  const desktop = browserSubscription('рабочий-стол');
  const { service, delivery } = buildService({ subscriptions: [phone, desktop] });
  await service.init();

  const result = await service.onNewMessage(SESSION, arrived(), {
    // Вкладка открыта на рабочем столе — там окно покажет сама страница
    liveClientIds: new Set(['рабочий-стол']),
  });

  assert.equal(result.notified, true);
  assert.equal(result.pushed, 1, 'ушло ровно одно сообщение');
  assert.equal(delivery.sent.length, 1);
  assert.equal(delivery.sent[0]!.url, phone.endpoint);

  // Обратный ход: закрыли вкладку — уходит в оба браузера
  delivery.sent.length = 0;
  const second = await service.onNewMessage(SESSION, arrived({ id: 'inbox:297' }), {
    liveClientIds: new Set(),
  });
  assert.equal(second.pushed, 2);
});

test('с выключенным push наружу не уходит ничего, но уведомление остаётся', async () => {
  const { service, delivery } = buildService({ prefs: { push: false } });
  await service.init();
  const result = await service.onNewMessage(SESSION, arrived(), { liveClientIds: new Set() });

  assert.equal(result.notified, true, 'открытая вкладка окно всё равно покажет');
  assert.equal(result.pushed, 0);
  assert.equal(delivery.sent.length, 0, 'к службе доставки не обращались вовсе');
});

test('выключенные уведомления не порождают ни push, ни очереди', async () => {
  const { service, delivery } = buildService({ env: { masterSwitch: async () => false } });
  await service.init();
  const result = await service.onNewMessage(SESSION, arrived(), { liveClientIds: new Set() });

  assert.deepEqual(
    { notified: result.notified, reason: result.reason, pushed: result.pushed },
    { notified: false, reason: 'notifications-off', pushed: 0 },
  );
  assert.equal(delivery.sent.length, 0);
  assert.deepEqual(service.pending(SESSION.email), []);
});

test('спам в очередь уведомлений не попадает', async () => {
  const { service } = buildService({});
  await service.init();
  const result = await service.onNewMessage(SESSION, arrived({ folderId: 'spam' }), {
    liveClientIds: new Set(),
  });
  assert.equal(result.reason, 'not-inbox');
  assert.deepEqual(service.pending(SESSION.email), []);
});

/* ------------------------------------------------------------------ */
/* Заголовки обращения к службе доставки                                */
/* ------------------------------------------------------------------ */

test('обращение к службе доставки подписано и помечено сроком жизни', async () => {
  const { service, delivery } = buildService({});
  await service.init();
  await service.onNewMessage(SESSION, arrived(), { liveClientIds: new Set() });

  const request = delivery.sent[0]!;
  assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
  assert.match(request.headers['Authorization']!, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/u);
  assert.equal(request.headers['TTL'], '86400');
  assert.equal(request.headers['Urgency'], 'normal');
  // Тело зашифровано: открытым текстом в нём не должно быть ничего
  assert.ok(!Buffer.from(request.body).toString('utf8').includes('"v"'));
});

/* ------------------------------------------------------------------ */
/* Отказы службы доставки                                               */
/* ------------------------------------------------------------------ */

test('отозванная подписка удаляется, а временный отказ — нет', async () => {
  const gone = buildService({ status: 410 });
  await gone.service.init();
  await gone.service.onNewMessage(SESSION, arrived(), { liveClientIds: new Set() });
  assert.equal(gone.store.forgotten.length, 1, 'подписку 410 забыли навсегда');
  assert.equal(gone.store.failures.length, 0);

  const temporary = buildService({ status: 503 });
  await temporary.service.init();
  await temporary.service.onNewMessage(SESSION, arrived(), { liveClientIds: new Set() });
  assert.equal(temporary.store.forgotten.length, 0, 'временный отказ подписку не убивает');
  assert.equal(temporary.store.failures.length, 1);
});

/* ------------------------------------------------------------------ */
/* Очередь и группировка                                                */
/* ------------------------------------------------------------------ */

test('десять писем подряд копятся в одну очередь без повторов', async () => {
  const { service } = buildService({ prefs: { push: false } });
  await service.init();
  for (let i = 0; i < 10; i += 1) {
    await service.onNewMessage(SESSION, arrived({ id: `inbox:${String(300 + i)}` }), {
      liveClientIds: new Set(),
    });
  }
  // Повтор того же письма (переподключение наблюдателя) очередь не растит
  await service.onNewMessage(SESSION, arrived({ id: 'inbox:300' }), { liveClientIds: new Set() });

  const pending = service.pending(SESSION.email);
  assert.equal(pending.length, 10);
  assert.equal(pending[0], 'inbox:309', 'свежее письмо первое');
  assert.equal(new Set(pending).size, 10, 'повторов нет');
});

test('увиденное уведомление забывается — выборочно или целиком', async () => {
  const { service } = buildService({ prefs: { push: false } });
  await service.init();
  for (const id of ['inbox:300', 'inbox:301', 'inbox:302']) {
    await service.onNewMessage(SESSION, arrived({ id }), { liveClientIds: new Set() });
  }

  assert.equal(service.markSeen(SESSION.email, ['inbox:301']), 1);
  assert.deepEqual(service.pending(SESSION.email), ['inbox:302', 'inbox:300']);

  assert.equal(service.markSeen(SESSION.email), 2, 'открыли почту — новостей больше нет');
  assert.deepEqual(service.pending(SESSION.email), []);
});

test('очередь одного ящика не смешивается с очередью другого', async () => {
  const { service } = buildService({ prefs: { push: false } });
  await service.init();
  const other: MailSession = { id: 'с2', email: 'demo@mail.local', password: 'demo12345' };
  await service.onNewMessage(SESSION, arrived({ id: 'inbox:300' }), { liveClientIds: new Set() });
  await service.onNewMessage(other, arrived({ id: 'inbox:400' }), { liveClientIds: new Set() });

  assert.deepEqual(service.pending(SESSION.email), ['inbox:300']);
  assert.deepEqual(service.pending(other.email), ['inbox:400']);
  service.markSeen(SESSION.email);
  assert.deepEqual(service.pending(other.email), ['inbox:400'], 'чужую очередь не тронули');
});

/* ------------------------------------------------------------------ */
/* Уровень «сводка от ИИ»                                               */
/* ------------------------------------------------------------------ */

test('без согласия на ИИ уровень честно опускается до первых фраз', async () => {
  const { service } = buildService({
    prefs: { push: false, level: 'ai-summary' },
    env: {
      aiAvailability: async () => ({
        available: false,
        reason: 'Нужно ваше согласие на отправку писем сервису ИИ',
      }),
      // Помощника звать не должны вовсе — если позвали, тест упадёт
      aiSummary: async () => {
        throw new Error('помощника звать было нельзя');
      },
    },
  });
  await service.init();
  await service.onNewMessage(SESSION, arrived(), { liveClientIds: new Set() });

  const view = await service.buildView(SESSION);
  assert.equal(view.degraded, 'Нужно ваше согласие на отправку писем сервису ИИ');
});

test('исчерпанный предел ИИ не отменяет уведомление, а понижает подробность', async () => {
  const { service } = buildService({
    prefs: { push: false, level: 'ai-summary' },
    env: {
      pool: fakeMailbox().pool,
      aiAvailability: async () => ({ available: true, reason: null }),
      aiSummary: async () => ({
        text: null,
        degraded: 'Предел расходов на ИИ исчерпан — в уведомлении первые фразы письма',
      }),
    },
  });
  await service.init();
  await service.onNewMessage(SESSION, arrived(), { liveClientIds: new Set() });

  const view = await service.buildView(SESSION);
  // Главное: окно всё равно есть, и в нём видно письмо. Человек включал
  // уведомления ради письма, а не ради сводки.
  assert.equal(view.title, 'Пётр');
  assert.ok(view.body.includes('Договор поставки'), view.body);
  assert.match(view.degraded ?? '', /Предел расходов/u);
});

test('сводка от ИИ доходит до окна уведомления', async () => {
  // Обратный ход к предыдущей проверке: когда сводка есть, она и
  // показывается — иначе «понижение подробности» было бы единственным
  // поведением уровня.
  const { service } = buildService({
    prefs: { push: false, level: 'ai-summary' },
    env: {
      pool: fakeMailbox().pool,
      aiSummary: async () => ({
        text: 'Пётр прислал подписанный договор и ждёт согласования до пятницы.',
        degraded: null,
      }),
    },
  });
  await service.init();
  await service.onNewMessage(SESSION, arrived(), { liveClientIds: new Set() });

  const view = await service.buildView(SESSION);
  assert.ok(view.body.includes('ждёт согласования до пятницы'), view.body);
  assert.equal(view.degraded, null);
});

test('письмо читается из ящика тем же путём, что и список писем', async () => {
  const mailbox = fakeMailbox('Счёт на оплату');
  const { service } = buildService({
    prefs: { push: false, level: 'sender-subject' },
    env: { pool: mailbox.pool },
  });
  await service.init();
  await service.onNewMessage(SESSION, arrived(), { liveClientIds: new Set() });

  const view = await service.buildView(SESSION);
  assert.equal(view.title, 'Пётр');
  assert.equal(view.body, 'Счёт на оплату');
  assert.equal(view.url, '/inbox/inbox%3A296');
  assert.deepEqual(view.ids, ['inbox:296']);
});

test('перед чтением письма соединение просят пересмотреть папку', async () => {
  /*
   * Дефект, найденный на живом стенде, и он же — причина этой проверки.
   *
   * Соединение берётся из пула и живёт с уже ВЫБРАННОЙ папкой. Service
   * Worker просыпается от push почти мгновенно и спрашивает содержимое
   * в ту же секунду, когда письмо доставлено, — а такое соединение его
   * ещё не видит. `fetchOne` возвращал пустоту, и вместо темы и
   * отправителя всплывало безымянное «Новое письмо». Через десяток
   * секунд тот же запрос отрабатывал правильно, отчего дефект и
   * выглядел мистикой.
   */
  const mailbox = fakeMailbox('Акт сверки');
  const { service } = buildService({
    prefs: { push: false, level: 'sender-subject' },
    env: { pool: mailbox.pool },
  });
  await service.init();
  await service.onNewMessage(SESSION, arrived(), { liveClientIds: new Set() });
  await service.buildView(SESSION);

  assert.equal(mailbox.noops(), 1, 'без NOOP уведомление выйдет безымянным');
});

test('сводка не считается для группы писем: десять обращений к платному сервису — не плата за одно окно', async () => {
  let calls = 0;
  const { service } = buildService({
    prefs: { push: false, level: 'ai-summary' },
    env: {
      aiSummary: async () => {
        calls += 1;
        return { text: 'сводка', degraded: null };
      },
    },
  });
  await service.init();
  for (const id of ['inbox:300', 'inbox:301', 'inbox:302']) {
    await service.onNewMessage(SESSION, arrived({ id }), { liveClientIds: new Set() });
  }
  await service.buildView(SESSION);
  assert.equal(calls, 0, 'для группы сводка не запрашивается');
});

test('на уровне «только факт» письма из ящика не читаются вовсе', async () => {
  let read = 0;
  const { service } = buildService({
    prefs: { push: false, level: 'minimal' },
    env: {
      pool: {
        withClient: async () => {
          read += 1;
        },
      } as unknown as PushEnvironment['pool'],
    },
  });
  await service.init();
  await service.onNewMessage(SESSION, arrived(), { liveClientIds: new Set() });

  const view = await service.buildView(SESSION);
  assert.equal(read, 0, 'содержимое письма даже не покидало ящик');
  assert.equal(view.title, 'Новое письмо');
});

/* ------------------------------------------------------------------ */
/* Состояние для интерфейса                                             */
/* ------------------------------------------------------------------ */

test('без базы раздел честно объявляет себя неработающим', () => {
  const service = new PushService({
    config: loadPushConfig({ PUSH_ENABLED: 'true' }),
    db: null,
    logger,
    env: environment(),
  });
  assert.equal(service.pushAvailable, false);
  assert.match(service.pushUnavailableReason ?? '', /базе/u);
});

test('выключенный на сервере push называет себя своим именем', () => {
  const service = new PushService({
    config: loadPushConfig({ PUSH_ENABLED: 'false', DATABASE_URL: 'postgres://x' }),
    db: null,
    logger,
    env: environment(),
  });
  assert.match(service.pushUnavailableReason ?? '', /PUSH_ENABLED/u);
});

test('список устройств называет браузер, но не выдаёт адрес подписки', async () => {
  const subscription = browserSubscription('телефон');
  const { service } = buildService({ subscriptions: [subscription] });
  await service.init();
  const state = await service.state(SESSION.email, 'телефон');

  assert.equal(state.devices.length, 1);
  assert.equal(state.devices[0]!.browser, 'Chrome');
  assert.equal(state.devices[0]!.current, true);
  // Адрес подписки — это секрет: кто его знает, тот может слать
  // уведомления в этот браузер. Наружу он не отдаётся никогда.
  assert.ok(!JSON.stringify(state).includes(subscription.endpoint));
  assert.ok(!JSON.stringify(state).includes(subscription.auth));
});

test('название браузера разбирается по User-Agent, а неизвестное не выдумывается', () => {
  assert.equal(browserName('Mozilla/5.0 … Chrome/131.0.0.0 Safari/537.36'), 'Chrome');
  assert.equal(browserName('Mozilla/5.0 … Chrome/131 Safari/537.36 Edg/131.0'), 'Microsoft Edge');
  assert.equal(browserName('Mozilla/5.0 … YaBrowser/24.12 Safari/537.36'), 'Яндекс.Браузер');
  assert.equal(browserName('Mozilla/5.0 … Firefox/133.0'), 'Firefox');
  assert.equal(browserName('Mozilla/5.0 … Version/17.6 Safari/605.1.15'), 'Safari');
  assert.equal(browserName(null), 'Неизвестный браузер');
});

/* ------------------------------------------------------------------ */
/* Проверочное уведомление                                              */
/* ------------------------------------------------------------------ */

test('проверочное уведомление уходит только в тот браузер, откуда его просили', async () => {
  const phone = browserSubscription('телефон');
  const desktop = browserSubscription('рабочий-стол');
  const { service, delivery } = buildService({ subscriptions: [phone, desktop] });
  await service.init();

  const result = await service.sendTestPush(SESSION.email, 'телефон');
  assert.equal(result.sent, 1);
  assert.equal(delivery.sent.length, 1);
  assert.equal(delivery.sent[0]!.url, phone.endpoint);

  // В браузере без подписки — честный отказ, а не молчаливый успех
  const missing = await service.sendTestPush(SESSION.email, 'ноутбук');
  assert.equal(missing.sent, 0);
  assert.match(missing.error ?? '', /подписки нет/u);
});
