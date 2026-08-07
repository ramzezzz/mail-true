/**
 * Проверки перезапуска служб.
 *
 * Здесь закрыты те дефекты, которые в этой затее возможны и стоят дорого:
 *
 *   1. Имя службы из запроса доезжает до посредника. Это самое опасное,
 *      что тут может случиться: у посредника сокет Docker, то есть права
 *      root на машине, и единственное, что отделяет «перезапустить
 *      rspamd» от «сделать что угодно», — закрытый список.
 *   2. Действие, которого у службы нет. Тот же список, другая колонка.
 *   3. Петля перезапусков. Настройка, из-за которой сервер падает на
 *      старте, превращала бы кнопку в бесконечный круг.
 *   4. Остановка там, где поднять некому. Запуск из исходников: нажатие
 *      кнопки означало бы, что сервер просто исчез.
 *   5. Молчаливая кнопка. Нет посредника — обязан быть внятный отказ с
 *      командой для консоли, а не тишина.
 *   6. Одинаковое предупреждение для разных служб. Остановка Postfix и
 *      остановка nginx — разные события для людей, и текст обязан
 *      различаться.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pino } from 'pino';
import {
  actionTitle,
  consoleCommand,
  findTarget,
  RESTART_TARGETS,
  resolveTarget,
} from './restart-targets.js';
import { SelfRestart } from './self-restart.js';
import { describeState, ServiceAgent, ServiceAgentUnavailableError } from './service-agent.js';

const silent = pino({ level: 'silent' });

/* ------------------------------------------------------------------ */
/* 1-2. Закрытый список: имя и действие                                 */
/* ------------------------------------------------------------------ */

void test('имя службы, которого нет в перечне, отвергается', () => {
  for (const evil of [
    'postgres',
    'redis',
    'service-agent',
    'installer',
    '../../etc/passwd',
    'rspamd; rm -rf /',
    'RSPAMD',
    '',
    'rspamd ',
  ]) {
    assert.throws(
      () => resolveTarget(evil, 'restart'),
      /не перезапускается из панели/u,
      `имя «${evil}» не должно приниматься`,
    );
  }
});

void test('имя службы не строкой отвергается до всякой обработки', () => {
  for (const evil of [null, undefined, 42, {}, ['rspamd']]) {
    assert.throws(() => resolveTarget(evil, 'restart'), /Не указаны служба и действие/u);
  }
});

void test('известная служба принимается, и возвращается ОПИСАНИЕ, а не строка запроса', () => {
  const resolved = resolveTarget('rspamd', 'restart');
  assert.equal(resolved.id, 'rspamd');
  assert.equal(resolved.action, 'restart');
  // Именно объект перечня: дальше по коду работают с ним, а не с вводом.
  assert.equal(resolved.title, findTarget('rspamd')?.title);
  assert.ok(resolved.impact.length > 40);
});

void test('действие, которого у службы нет, отвергается', () => {
  assert.throws(() => resolveTarget('rspamd', 'exec'), /не предусмотрено/u);
  assert.throws(() => resolveTarget('rspamd', 'stop'), /не предусмотрено/u);
  assert.throws(() => resolveTarget('rspamd', 'RESTART'), /не предусмотрено/u);
});

void test('в перечне нет служб, чей перезапуск роняет продукт целиком', () => {
  const ids = RESTART_TARGETS.map((t) => t.id);
  for (const forbidden of ['postgres', 'redis', 'service-agent', 'installer', 'clamav']) {
    assert.ok(!ids.includes(forbidden), `${forbidden} не должен перезапускаться из панели`);
  }
});

/* ------------------------------------------------------------------ */
/* 6. Предупреждения у разных служб — разные                            */
/* ------------------------------------------------------------------ */

void test('у каждой службы своё предупреждение о последствиях', () => {
  const impacts = new Set(RESTART_TARGETS.map((t) => t.impact));
  assert.equal(
    impacts.size,
    RESTART_TARGETS.length,
    'Два одинаковых предупреждения — значит одно из них неправда',
  );
  const safe = new Set(RESTART_TARGETS.map((t) => t.safe));
  assert.equal(safe.size, RESTART_TARGETS.length);
});

void test('предупреждения называют последствия, а не службы', () => {
  const byId = new Map(RESTART_TARGETS.map((t) => [t.id, t]));
  // Postfix — про приём почты и временный отказ отправителю.
  assert.match(byId.get('postfix')!.impact, /принимается/u);
  assert.match(byId.get('postfix')!.safe, /не тер/u);
  // Dovecot — про обрыв почтовых программ.
  assert.match(byId.get('dovecot')!.impact, /почтовых программ/u);
  // Nginx — про веб-вход, включая саму панель.
  assert.match(byId.get('nginx')!.impact, /панель/u);
  assert.match(byId.get('nginx')!.safe, /IMAP/u);
  // Rspamd — про письма без проверки и без подписи.
  assert.match(byId.get('rspamd')!.impact, /DKIM/u);
});

void test('команда для консоли отличается у перезапуска и пересоздания', () => {
  const rspamd = findTarget('rspamd')!;
  assert.match(consoleCommand(rspamd, 'restart'), /compose .*restart rspamd$/u);
  assert.match(consoleCommand(rspamd, 'recreate'), /up -d --no-deps rspamd$/u);
  assert.notEqual(consoleCommand(rspamd, 'restart'), consoleCommand(rspamd, 'recreate'));
  assert.equal(actionTitle('recreate'), 'пересоздание контейнера');
});

/* ------------------------------------------------------------------ */
/* 3-4. Перезапуск себя: петля и «поднять некому»                       */
/* ------------------------------------------------------------------ */

/** Журнал-подделка: считает старты и помнит закрытые заявки. */
class FakeStore {
  boots = 0;
  begun: Array<{ service: string; action: string; by: string | null }> = [];
  finished: Array<{ id: string; status: string }> = [];
  trimmed = 0;
  failNext: Error | null = null;

  async bootsSince(): Promise<number> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    return this.boots;
  }
  async begin(service: string, action: string, by: string | null): Promise<{ id: string }> {
    this.begun.push({ service, action, by });
    return { id: String(this.begun.length) };
  }
  async finish(id: string, status: string): Promise<void> {
    this.finished.push({ id, status });
  }
  async markBoot(): Promise<null> {
    this.boots += 1;
    return null;
  }
  async trim(): Promise<void> {
    this.trimmed += 1;
  }
}

function selfRestart(patch: Record<string, unknown> = {}): {
  self: SelfRestart;
  store: FakeStore;
  stops: number[];
} {
  const store = new FakeStore();
  const stops: number[] = [];
  const self = new SelfRestart({
    logger: silent,
    store: store as unknown as never,
    supervised: true,
    graceMs: 1,
    stop: () => stops.push(Date.now()),
    ...patch,
  });
  return { self, store, stops };
}

void test('перезапуск себя разрешён, когда стартов немного', async () => {
  const { self, store } = selfRestart();
  store.boots = 1;
  assert.deepEqual(await self.decide(), { allowed: true });
});

void test('петля: слишком много стартов подряд — отказ с объяснением', async () => {
  const { self, store } = selfRestart({ loopMaxBoots: 3, loopWindowMinutes: 7 });
  store.boots = 4;
  const decision = await self.decide();
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  // Отказ обязан называть числа и объяснять, что делать: «попробуйте
  // позже» здесь было бы вредным советом.
  assert.match(decision.reason, /за последние 7 минут/u);
  assert.match(decision.reason, /стартовал 4 раз/u);
  assert.match(decision.reason, /падает сразу после/u);
  assert.match(decision.reason, /docker compose logs/u);
});

void test('петля: ровно на границе перезапуск ещё разрешён', async () => {
  const { self, store } = selfRestart({ loopMaxBoots: 3 });
  store.boots = 3;
  assert.equal((await self.decide()).allowed, true);
});

void test('отказ журнала не запрещает перезапуск: это защита, а не разрешение', async () => {
  const { self, store } = selfRestart();
  store.failNext = new Error('база молчит');
  assert.equal((await self.decide()).allowed, true);
});

void test('без контейнера перезапуск запрещён: поднять будет некому', async () => {
  const { self } = selfRestart({ supervised: false });
  const decision = await self.decide();
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.match(decision.reason, /не в контейнере/u);
  assert.match(decision.reason, /некому/u);
});

void test('остановка назначается один раз, второе нажатие ничего не ускоряет', async () => {
  const { self, stops } = selfRestart({ graceMs: 5 });
  self.schedule('первая');
  self.schedule('вторая');
  assert.equal(self.pending, true);
  // Пока пауза не вышла, останова быть не должно: ответ ещё уходит.
  assert.equal(stops.length, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(stops.length, 1, 'останов должен случиться ровно один раз');
  // И повторная заявка отклоняется словами, а не молча.
  const decision = await self.decide();
  assert.equal(decision.allowed, false);
});

void test('метка процесса своя у каждого запуска — по ней панель и узнаёт новый сервер', () => {
  const a = selfRestart().self;
  const b = selfRestart().self;
  assert.notEqual(a.bootId, b.bootId);
  assert.match(a.bootId, /^[0-9a-f-]{36}$/u);
});

void test('отметка о старте закрывает заявку и подчищает журнал', async () => {
  const { self, store } = selfRestart();
  await self.announceBoot();
  assert.equal(store.boots, 1);
  assert.equal(store.trimmed, 1);
});

/* ------------------------------------------------------------------ */
/* 5. Нет посредника — отказ словами, а не тишина                       */
/* ------------------------------------------------------------------ */

void test('ненастроенный посредник честно называет себя ненастроенным', async () => {
  const agent = new ServiceAgent({ baseUrl: '', token: '', logger: silent });
  assert.equal(agent.configured, false);
  await assert.rejects(
    () => agent.status(findTarget('rspamd')!),
    (err: unknown) => {
      assert.ok(err instanceof ServiceAgentUnavailableError);
      assert.equal(err.statusCode, 503);
      // Отказ обязан говорить, ЧТО сделать: имя переменной и файл.
      assert.match(err.message, /SERVICE_AGENT_TOKEN/u);
      assert.match(err.message, /infra\/\.env/u);
      return true;
    },
  );
});

void test('секрет без адреса (и наоборот) — это «не настроен», а не «попробуем»', () => {
  assert.equal(
    new ServiceAgent({ baseUrl: 'http://service-agent:11346', token: '', logger: silent })
      .configured,
    false,
  );
  assert.equal(
    new ServiceAgent({ baseUrl: '', token: 'секрет', logger: silent }).configured,
    false,
  );
});

void test('посредник не отвечает — отказ называет команду подъёма службы', async () => {
  // Порт, на котором заведомо никто не слушает.
  const agent = new ServiceAgent({
    baseUrl: 'http://127.0.0.1:1',
    token: 'секрет',
    logger: silent,
    timeoutMs: 500,
  });
  await assert.rejects(
    () => agent.health(),
    (err: unknown) => {
      assert.ok(err instanceof ServiceAgentUnavailableError);
      assert.match(err.message, /service-agent/u);
      return true;
    },
  );
});

void test('клиент отказывается делать со службой то, чего у неё нет в перечне', async () => {
  const agent = new ServiceAgent({
    baseUrl: 'http://127.0.0.1:1',
    token: 'секрет',
    logger: silent,
    timeoutMs: 200,
  });
  const fake = { ...findTarget('rspamd')!, actions: ['restart'] as const };
  await assert.rejects(() => agent.apply(fake, 'recreate'), /не предусмотрено/u);
});

/* ------------------------------------------------------------------ */
/* Состояние после: «поднялась» и «не поднялась, вот почему»            */
/* ------------------------------------------------------------------ */

void test('состояние поднявшейся службы описывается коротко и по делу', () => {
  const text = describeState({
    service: 'rspamd',
    state: 'running',
    health: 'healthy',
    up: true,
    detail: null,
    startedAt: null,
    exitCode: null,
    restarts: null,
  });
  assert.match(text, /поднялась/u);
  assert.match(text, /проба контейнера зелёная/u);
});

void test('не поднявшаяся служба объясняет причину, а не отделывается кодом', () => {
  const text = describeState({
    service: 'rspamd',
    state: 'exited',
    health: 'none',
    up: false,
    detail: 'контейнер завершился (код 1). Последние строки журнала:\ncannot parse config',
    startedAt: null,
    exitCode: '1',
    restarts: null,
  });
  assert.match(text, /не поднялась/u);
  assert.match(text, /cannot parse config/u);
});

void test('отсутствующий контейнер — это отдельный внятный случай', () => {
  const text = describeState({
    service: 'clamav',
    state: 'absent',
    health: 'none',
    up: false,
    detail: null,
    startedAt: null,
    exitCode: null,
    restarts: null,
  });
  assert.match(text, /нет вовсе/u);
});
