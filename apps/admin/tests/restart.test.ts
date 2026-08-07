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
  startWatch,
  watching,
  watchStep,
  type WatchState,
} from '../src/lib/restart';
import type { RestartJobState, RestartTarget } from '../src/api/types';

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
