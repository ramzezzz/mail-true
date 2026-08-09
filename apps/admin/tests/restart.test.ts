/**
 * Проверки перезапуска служб на стороне панели.
 *
 * Главное, что здесь закрыто, — обещание «панель вернётся сама».
 * Сервер приложения, перезапуская себя, ответить о результате не может:
 * его в этот момент нет. Значит панель обязана понять это сама, и понять
 * НАДЁЖНО. Ошибки, которые тут возможны, все неприятные:
 *
 *   1. Объявить успех рано. Первый же ответ приняли за «сервер вернулся»,
 *      а это был тот же процесс, который ещё не начал останавливаться.
 *      Панель отчиталась об успехе за секунду до обрыва связи.
 *   2. Объявить поломку там, где всё идёт по плану. Во время перезапуска
 *      сервер не отвечает — это норма, а не ошибка, и показывать её как
 *      ошибку значит пугать человека тем, что он сам и запустил.
 *   3. Ждать вечно. «Перезапускаю…» без конца — худший из возможных
 *      исходов: непонятно, ждать дальше или идти в консоль.
 *   4. Одинаковый текст для разных служб.
 */
import { describe, expect, it } from 'vitest';
import {
  applyButtonLabel,
  appliesSummary,
  applyHint,
  applyWarning,
  DEFAULT_WATCH_LIMITS,
  runRestarts,
  startWatch,
  watching,
  watchStep,
  type RestartRunIo,
  type WatchState,
} from '../src/lib/restart';
import type { RestartJobState, RestartTarget, SettingApply } from '../src/api/types';

function target(patch: Partial<RestartTarget> = {}): RestartTarget {
  return {
    id: 'api',
    title: 'Сервер приложения',
    actions: ['restart', 'recreate'],
    self: true,
    impact: 'Панель и веб-почта не отвечают несколько секунд.',
    downtime: 'от 3 до 15 секунд',
    safe: 'Почтовые программы не заметят ничего.',
    available: true,
    unavailableReason: null,
    commands: {
      restart: 'docker compose -f infra/docker-compose.yml restart api',
      recreate: 'docker compose -f infra/docker-compose.yml up -d --no-deps api',
    },
    ...patch,
  };
}

function job(patch: Partial<RestartJobState> = {}): RestartJobState {
  return {
    id: '7',
    service: 'api',
    action: 'restart',
    requestedBy: 'snimki',
    requestedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'pending',
    detail: null,
    bootId: 'старый',
    ...patch,
  };
}

/* ------------------------------------------------------------------ */
/* Тексты: перезапуск и пересоздание — разные слова                     */
/* ------------------------------------------------------------------ */

describe('подписи кнопок', () => {
  it('пересоздание контейнера называется своим именем, а не перезапуском', () => {
    const t = target({ title: 'Автонастройка почтовых программ' });
    expect(applyButtonLabel(t, 'restart')).toBe('Перезапустить: автонастройка почтовых программ');
    expect(applyButtonLabel(t, 'recreate')).toBe(
      'Пересоздать контейнер: автонастройка почтовых программ',
    );
    expect(applyButtonLabel(t, 'restart')).not.toBe(applyButtonLabel(t, 'recreate'));
  });

  it('два шага применения перечисляются по порядку, а не сливаются в «перезапустить всё»', () => {
    const targets = [
      target({ id: 'autoconfig', title: 'Автонастройка почтовых программ', self: false }),
      target({ id: 'api', title: 'Сервер приложения' }),
    ];
    const summary = appliesSummary(
      {
        applies: [
          { target: 'autoconfig', action: 'recreate' },
          { target: 'api', action: 'restart' },
        ],
      },
      targets,
    );
    expect(summary).toBe(
      'пересоздать контейнер: автонастройка почтовых программ, затем перезапустить: сервер приложения',
    );
  });

  it('живая настройка честно говорит, что применять нечего', () => {
    expect(appliesSummary({ applies: [] }, [])).toBe('действует сразу');
  });

  it('неизвестная служба не обрушивает подпись, а называется как есть', () => {
    expect(applyHint({ target: 'что-то', action: 'restart' }, [])).toBe('перезапустить: что-то');
  });
});

describe('предупреждение перед нажатием', () => {
  it('несёт последствия, срок и то, что уцелеет', () => {
    const w = applyWarning(target(), 'restart');
    expect(w.impact).toContain('не отвечают');
    expect(w.downtime).toBe('от 3 до 15 секунд');
    expect(w.safe).toContain('Почтовые программы');
    expect(w.blocked).toBeNull();
  });

  it('недоступная кнопка объясняет причину и даёт команду для консоли', () => {
    const w = applyWarning(
      target({
        id: 'rspamd',
        self: false,
        available: false,
        unavailableReason: 'Посредник перезапуска не настроен.',
      }),
      'restart',
    );
    expect(w.blocked).toBe('Посредник перезапуска не настроен.');
    expect(w.command).toContain('docker compose');
  });
});

/* ------------------------------------------------------------------ */
/* Ожидание: панель возвращается сама                                   */
/* ------------------------------------------------------------------ */

describe('ожидание возвращения сервера', () => {
  const t = target();

  it('пока отвечает ТОТ ЖЕ процесс, успех не объявляется', () => {
    let state = startWatch(t, 'restart');
    // Старый процесс ещё жив и закрывает запросы: метка та же.
    state = watchStep(state, { type: 'job', job: job({ bootId: 'старый' }) }, 'старый');
    expect(state.status).toBe('polling');
    expect(state.attempts).toBe(1);
  });

  it('обрыв связи во время перезапуска — это норма, а не ошибка', () => {
    let state = startWatch(t, 'restart');
    state = watchStep(state, { type: 'offline' }, 'старый');
    expect(state.status).toBe('polling');
    expect(state.offline).toBe(1);
    expect(state.message).toContain('так и должно быть');
  });

  it('сменившаяся метка процесса — и есть доказательство, что сервер вернулся', () => {
    let state = startWatch(t, 'restart');
    state = watchStep(state, { type: 'offline' }, 'старый');
    state = watchStep(state, { type: 'offline' }, 'старый');
    state = watchStep(state, { type: 'job', job: job({ bootId: 'новый' }) }, 'старый');
    expect(state.status).toBe('ok');
    expect(state.message).toBe('Сервер приложения вернулся');
    expect(watching(state)).toBe(false);
  });

  it('заявка, закрытая с успехом, тоже завершает ожидание', () => {
    let state = startWatch(t, 'restart');
    state = watchStep(
      state,
      { type: 'job', job: job({ status: 'ok', detail: 'Служба поднялась.' }) },
      null,
    );
    expect(state.status).toBe('ok');
    expect(state.detail).toBe('Служба поднялась.');
  });

  it('неудача показывает причину, а не «что-то пошло не так»', () => {
    let state = startWatch(t, 'recreate');
    state = watchStep(
      state,
      {
        type: 'job',
        job: job({ status: 'failed', detail: 'контейнер завершился (код 1). cannot parse config' }),
      },
      null,
    );
    expect(state.status).toBe('failed');
    expect(state.detail).toContain('cannot parse config');
  });

  it('ожидание не бесконечно: молчание сервера когда-то признаётся отказом', () => {
    let state: WatchState = startWatch(t, 'restart');
    for (let i = 0; i < DEFAULT_WATCH_LIMITS.maxAttempts; i += 1) {
      state = watchStep(state, { type: 'offline' }, 'старый');
    }
    expect(state.status).toBe('timeout');
    // И говорит, куда смотреть дальше: «попробуйте позже» тут не ответ.
    expect(state.detail).toContain('docker compose');
  });

  it('вечного «перезапускаю» не бывает и при живом сервере', () => {
    let state: WatchState = startWatch(t, 'restart');
    for (let i = 0; i < DEFAULT_WATCH_LIMITS.maxAttempts; i += 1) {
      state = watchStep(state, { type: 'job', job: job({ bootId: 'старый' }) }, 'старый');
    }
    expect(state.status).toBe('timeout');
  });

  it('завершённое ожидание больше не меняется', () => {
    let state = startWatch(t, 'restart');
    state = watchStep(state, { type: 'job', job: job({ bootId: 'новый' }) }, 'старый');
    const after = watchStep(state, { type: 'offline' }, 'старый');
    expect(after).toBe(state);
  });

  it('у чужой службы метка процесса не проверяется: перезапускают не нас', () => {
    let state = startWatch(target({ id: 'rspamd', self: false }), 'restart');
    // bootId сервера тот же — он и не менялся, перезапускали rspamd.
    state = watchStep(
      state,
      { type: 'job', job: job({ service: 'rspamd', bootId: 'старый' }) },
      null,
    );
    expect(state.status).toBe('polling');
    state = watchStep(
      state,
      { type: 'job', job: job({ service: 'rspamd', status: 'ok', detail: 'Служба поднялась.' }) },
      null,
    );
    expect(state.status).toBe('ok');
  });
});

/* ------------------------------------------------------------------ */
/* Перезапуск списка служб после сохранения настроек                    */
/* ------------------------------------------------------------------ */

/*
 * «ПЕРЕЗАПУЩЕНЫ СЛУЖБЫ: POSTFIX, DOVECOT» — ЗЕЛЁНЫМ, ПРИ ЛЕЖАЩЕМ СЕРВЕРЕ.
 *
 * Заявка на перезапуск возвращается 202 СРАЗУ: маршрут отвечает и уходит
 * работать в фоне. Раздел настроек считал возврат запроса успехом, и из
 * этого следовало сразу три беды:
 *
 *   1. не поднявшийся контейнер (самый частый исход после правки
 *      настроек) показывался зелёным;
 *   2. службы перезапускались ОДНОВРЕМЕННО, хотя комментарий рядом
 *      обещал «по одной» — Postfix спрашивает пароли у Dovecot, и
 *      одновременная остановка обоих даёт отказ аутентификации;
 *   3. список настроек перечитывался через доли секунды, и над зелёной
 *      плашкой оставалась красная «перезапуск нужен прямо сейчас».
 */

/** Стенд: помнит порядок событий и отвечает заранее заданными итогами. */
function runner(outcomes: Record<string, RestartJobState[]>): {
  io: RestartRunIo;
  log: string[];
} {
  const log: string[] = [];
  const queues = new Map(Object.entries(outcomes).map(([k, v]) => [k, [...v]]));
  let current = '';
  return {
    log,
    io: {
      request: async (targetId) => {
        log.push(`заявка:${targetId}`);
        current = targetId;
        return { id: targetId, self: false, bootId: null };
      },
      fetchJob: async (id) => {
        log.push(`опрос:${id}`);
        const queue = queues.get(id) ?? [];
        return queue.length > 1
          ? (queue.shift() as RestartJobState)
          : (queue[0] as RestartJobState);
      },
      // Время не идёт: проверка не должна занимать секунды.
      wait: async () => {
        void current;
      },
    },
  };
}

const STEPS: SettingApply[] = [
  { target: 'postfix', action: 'restart' },
  { target: 'dovecot', action: 'restart' },
];

describe('перезапуск списка служб', () => {
  it('вторую службу не трогает, пока не поднялась первая', async () => {
    const { io, log } = runner({
      postfix: [job({ status: 'pending' }), job({ status: 'ok', detail: 'Служба поднялась' })],
      dovecot: [job({ status: 'ok', detail: 'Служба поднялась' })],
    });
    const result = await runRestarts(STEPS, io, () => target({ id: 'postfix' }));

    expect(result.failed).toBeNull();
    expect(result.done).toEqual(['postfix', 'dovecot']);
    // Заявка на dovecot — только после того, как postfix отчитался.
    expect(log).toEqual([
      'заявка:postfix',
      'опрос:postfix',
      'опрос:postfix',
      'заявка:dovecot',
      'опрос:dovecot',
    ]);
  });

  it('не поднявшуюся службу не записывает в перезапущенные', async () => {
    const { io, log } = runner({
      postfix: [job({ status: 'failed', detail: 'Контейнер не стартовал: bad config' })],
      dovecot: [job({ status: 'ok' })],
    });
    const result = await runRestarts(STEPS, io, () => target({ id: 'postfix' }));

    expect(result.done, 'лежащая служба посчитана перезапущенной').toEqual([]);
    expect(result.failed?.target).toBe('postfix');
    expect(result.failed?.detail).toContain('bad config');
    // И вторую службу не трогаем: первая лежит, чинить надо её.
    expect(log).not.toContain('заявка:dovecot');
  });

  it('обрыв связи во время перезапуска не считается поломкой', async () => {
    let asked = 0;
    const io: RestartRunIo = {
      request: async () => ({ id: '1', self: true, bootId: 'старый' }),
      fetchJob: async () => {
        asked += 1;
        // Первые два опроса — сервер молчит (он перезапускается),
        // третий — отвечает уже новый процесс.
        if (asked < 3) throw new Error('fetch failed');
        return job({ bootId: 'новый' });
      },
      wait: async () => undefined,
      isServerRefusal: () => false,
    };
    const result = await runRestarts([STEPS[0] as SettingApply], io, () => target());
    expect(result.failed).toBeNull();
    expect(result.done).toEqual(['postfix']);
  });

  it('осмысленный отказ сервера — это отказ, а не молчание', async () => {
    const io: RestartRunIo = {
      request: async () => ({ id: '1', self: false, bootId: null }),
      fetchJob: () => Promise.reject(new Error('Заявка не найдена')),
      wait: async () => undefined,
      isServerRefusal: () => true,
    };
    const result = await runRestarts([STEPS[0] as SettingApply], io, () => target());
    expect(result.done).toEqual([]);
    expect(result.failed?.message).toBe('Не удалось узнать результат');
  });

  it('служба, которая молчит слишком долго, не висит вечно', async () => {
    const io: RestartRunIo = {
      request: async () => ({ id: '1', self: false, bootId: null }),
      fetchJob: async () => job({ status: 'pending' }),
      wait: async () => undefined,
    };
    const result = await runRestarts([STEPS[0] as SettingApply], io, () => target(), {
      maxAttempts: 5,
    });
    expect(result.done).toEqual([]);
    expect(result.failed?.target).toBe('postfix');
  });
});
