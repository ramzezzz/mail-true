/**
 * «Применить к письмам, которые уже находятся в папках» — и что бывает,
 * когда этот прогон обрывается.
 *
 * ------------------------------------------------------------------
 * ЧТО ЛОМАЛОСЬ
 * ------------------------------------------------------------------
 * Правило сохранялось, файл Sieve переписывался, и только ПОСЛЕ этого
 * начинался обход ящика по нескольку тысяч писем. Любой сбой на этом
 * обходе (оборванное соединение, занятая папка, отказ сервера) уходил
 * наружу как 500. Окно правила не закрывалось, человек читал «Не удалось
 * сохранить правило» и нажимал «Сохранить» ещё раз — и получал ВТОРОЕ
 * такое же правило. В том числе второе правило «удалить безвозвратно».
 *
 * Поэтому здесь проверяется не текст сообщения, а именно это: запрос
 * отвечает успехом, правило заведено ОДНО, а о неудавшемся прогоне
 * сказано словами в ответе.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import type { ImapFlow } from 'imapflow';
import { registerErrorHandling } from '../http-errors.js';
import { settingsUserRoutes } from './routes.js';
import type { SettingsService } from './service.js';
import { DEFAULT_ACTIONS, type FilterRule, type FilterRuleInput } from './types.js';

const logger = pino({ level: 'silent' });

/** Ящик подделки: одних «Входящих» хватает — прогон до них не доходит. */
class FakeClient {
  list(): Promise<unknown[]> {
    return Promise.resolve([
      {
        path: 'INBOX',
        name: 'INBOX',
        delimiter: '/',
        parentPath: '',
        specialUse: '\\Inbox',
        flags: new Set<string>(),
        status: { messages: 0, unseen: 0, uidValidity: 1n },
      },
    ]);
  }
}

class FakeDb {
  created = 0;
  rules: FilterRule[] = [];

  listFilters(): Promise<FilterRule[]> {
    return Promise.resolve(this.rules);
  }

  createFilter(_email: string, input: FilterRuleInput): Promise<FilterRule> {
    this.created += 1;
    const rule: FilterRule = {
      id: 5,
      position: 0,
      ...input,
      actions: { ...DEFAULT_ACTIONS, ...input.actions },
    };
    this.rules = [rule];
    return Promise.resolve(rule);
  }

  getFilter(): Promise<FilterRule | null> {
    return Promise.resolve(this.rules[0] ?? null);
  }

  getSettings(): Promise<null> {
    return Promise.resolve(null);
  }
}

async function harness(): Promise<{ app: FastifyInstance; db: FakeDb }> {
  const db = new FakeDb();
  const client = new FakeClient();
  let entered = 0;

  const app = Fastify({ logger: false }) as unknown as FastifyInstance;
  registerErrorHandling(app);
  app.decorate('deps', {
    logger,
    pool: {
      /*
       * Первый вход в ящик — чтение списка папок, он удаётся. Второй —
       * это и есть прогон правила по уже полученным письмам, и он
       * обрывается: ровно так ведёт себя ящик, у которого отвалилось
       * соединение посреди обхода тысяч писем.
       */
      withClient: <T>(_email: string, _password: string, fn: (c: ImapFlow) => Promise<T>) => {
        entered += 1;
        if (entered === 1) return fn(client as unknown as ImapFlow);
        return Promise.reject(new Error('соединение с ящиком оборвалось'));
      },
    },
  } as unknown as FastifyInstance['deps']);
  app.decorateRequest('mailSession', null);
  app.decorate('requireSession', (request: { mailSession: unknown }) => {
    request.mailSession = { id: 's', email: 'ivan@mail.true', password: 'secret' };
    return Promise.resolve();
  });

  const service = {
    available: true,
    config: { FILTER_APPLY_MAX_MESSAGES: 5000 },
    requireDb: () => db,
    syncSieve: () => Promise.resolve({ ok: true, written: true, error: '' }),
  } as unknown as SettingsService;

  await app.register((scope) => settingsUserRoutes(scope, service));
  await app.ready();
  return { app, db };
}

test('оборванный прогон по старым письмам не отменяет сохранение правила', async () => {
  const { app, db } = await harness();

  const response = await app.inject({
    method: 'POST',
    url: '/filters',
    payload: {
      id: '',
      enabled: true,
      auto: false,
      conditions: [{ field: 'from', operator: 'contains', value: 'вася@почта' }],
      actions: {
        moveToFolderId: null,
        markRead: false,
        markFlagged: false,
        labelKeys: [],
        deleteMode: 'purge',
        applyToExistingFolderIds: ['inbox'],
        forwardTo: null,
        autoReply: null,
        continueOtherFilters: true,
        applyToSpam: false,
      },
    },
  });

  assert.equal(
    response.statusCode,
    200,
    `правило уже создано — отвечать отказом нельзя: ${response.body}`,
  );
  const body = JSON.parse(response.body) as { id: string; applyWarning?: string };
  assert.equal(body.id, '5');
  assert.match(
    body.applyWarning ?? '',
    /не удалось/iu,
    'о неудавшемся прогоне человеку сказано словами',
  );
  assert.equal(db.created, 1, 'правило заведено ровно одно');

  await app.close();
});

test('правило «удалять всё подряд» сервер не принимает', async () => {
  /*
   * ЧТО БЫЛО. Окно фильтра открывается со строкой условия без значения.
   * Человек выбирает «Удалить безвозвратно, минуя корзину» и нажимает
   * «Сохранить», не заполнив значение: браузер выбрасывает пустое условие,
   * проверка полноты смотрит только на действия, и на сервер приходит
   * правило с пустым списком условий. В личный файл Sieve уезжает discard
   * на всю не-спамную почту — безвозвратно, начиная со следующего письма.
   *
   * Пустой список условий сам по себе законен (правило «на всю почту» —
   * это и пересылка, и метка). Незаконно ровно одно сочетание: ни одного
   * условия и удаление.
   */
  const { app } = await harness();

  const response = await app.inject({
    method: 'POST',
    url: '/filters',
    payload: {
      id: '',
      enabled: true,
      auto: false,
      conditions: [],
      actions: {
        moveToFolderId: null,
        markRead: false,
        markFlagged: false,
        labelKeys: [],
        deleteMode: 'purge',
        applyToExistingFolderIds: [],
        forwardTo: null,
        autoReply: null,
        continueOtherFilters: true,
        applyToSpam: false,
      },
      name: 'всё в утиль',
    },
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.match((response.json() as { message: string }).message, /ВСЕЙ почте|удаление/u);
});
