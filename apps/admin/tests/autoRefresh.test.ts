/**
 * @vitest-environment jsdom
 */
/**
 * Автообновление живого списка: прилипание к концу, окно записей, память
 * о выборе.
 *
 * Это чистая логика, и проверяется она без DOM — ровно поэтому её и вынесли
 * из страницы: правило «когда список считается стоящим внизу» слишком
 * важное, чтобы жить внутри обработчика прокрутки без проверок.
 *
 * На старом коде падают все проверки: автообновления не существовало.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  STICK_SLACK_PX,
  autoRefreshKey,
  isPinnedToBottom,
  keepWindow,
  loadAutoRefresh,
  saveAutoRefresh,
  shouldPoll,
  unreadCount,
  unreadLabel,
} from '../src/lib/autoRefresh';

describe('прилипание к концу списка', () => {
  it('список, стоящий ровно в конце, считается прилипшим', () => {
    expect(isPinnedToBottom({ scrollTop: 900, scrollHeight: 1500, clientHeight: 600 })).toBe(true);
  });

  it('отмотанный вверх — не прилипший', () => {
    // Ради этого всё и затевалось: человек, разбирающийся в старой записи,
    // не должен выдёргиваться вниз каждым новым событием.
    expect(isPinnedToBottom({ scrollTop: 100, scrollHeight: 1500, clientHeight: 600 })).toBe(false);
  });

  it('вернулся вниз сам — снова прилипший', () => {
    // Признак — положение прокрутки, а не флаг «пользователь трогал»:
    // иначе однажды тронувший список больше никогда бы не следил за живым.
    const position = { scrollTop: 100, scrollHeight: 1500, clientHeight: 600 };
    expect(isPinnedToBottom(position)).toBe(false);
    expect(isPinnedToBottom({ ...position, scrollTop: 900 })).toBe(true);
  });

  it('есть запас на дрожание прокрутки', () => {
    // Инерционная прокрутка на телефоне останавливается в паре точек от
    // края, дробные высоты строк дают остаток в доли точки. Без запаса
    // прилипание слетало бы само, и это выглядело бы как поломка.
    const almost = { scrollTop: 900 - (STICK_SLACK_PX - 1), scrollHeight: 1500, clientHeight: 600 };
    expect(isPinnedToBottom(almost)).toBe(true);

    const tooFar = { scrollTop: 900 - (STICK_SLACK_PX + 10), scrollHeight: 1500, clientHeight: 600 };
    expect(isPinnedToBottom(tooFar)).toBe(false);
  });

  it('список короче окна всегда прилипший: прокручивать нечего', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 600 })).toBe(true);
  });
});

describe('окно записей в памяти', () => {
  it('лишнее срезается сверху — вниз приходит новое, оно важнее', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    expect(keepWindow(items, 4)).toEqual([6, 7, 8, 9]);
  });

  it('пока предел не достигнут, массив не пересоздаётся', () => {
    // Лишняя копия на каждом обновлении — это лишняя перерисовка всего
    // списка, а он живой и обновляется постоянно.
    const items = [1, 2, 3];
    expect(keepWindow(items, 10)).toBe(items);
    expect(keepWindow(items, 3)).toBe(items);
  });

  it('нулевой предел означает «не резать»', () => {
    const items = [1, 2, 3];
    expect(keepWindow(items, 0)).toBe(items);
  });
});

describe('счётчик непрочитанного', () => {
  it('считается от момента отрыва от конца, а не от начала списка', () => {
    expect(unreadCount(120, 100)).toBe(20);
    expect(unreadCount(100, 120)).toBe(0);
  });

  it('подпись склоняется по-русски', () => {
    expect(unreadLabel(1)).toBe('1 новая запись');
    expect(unreadLabel(2)).toBe('2 новые записи');
    expect(unreadLabel(5)).toBe('5 новых записей');
    expect(unreadLabel(11)).toBe('11 новых записей');
    expect(unreadLabel(21)).toBe('21 новая запись');
    expect(unreadLabel(112)).toBe('112 новых записей');
  });
});

describe('когда вообще опрашивать сервер', () => {
  it('выключенное автообновление не опрашивает', () => {
    expect(shouldPoll(false, 'visible')).toBe(false);
  });

  it('невидимая вкладка не опрашивает', () => {
    // Забытая на сутки панель иначе молотила бы запросами тот же сервер,
    // что возит почту.
    expect(shouldPoll(true, 'hidden')).toBe(false);
  });

  it('включённое на видимой вкладке — опрашивает', () => {
    expect(shouldPoll(true, 'visible')).toBe(true);
    expect(shouldPoll(true, undefined)).toBe(true);
  });
});

describe('память о выборе', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it('по умолчанию автообновление выключено', () => {
    // Список, который шевелится сам, — это решение человека, а не наше
    // за него.
    expect(loadAutoRefresh('logs:postfix')).toBe(false);
  });

  it('выбор переживает перезаход', () => {
    saveAutoRefresh('logs:postfix', true);
    expect(loadAutoRefresh('logs:postfix')).toBe(true);
    saveAutoRefresh('logs:postfix', false);
    expect(loadAutoRefresh('logs:postfix')).toBe(false);
  });

  it('у каждого журнала своя память', () => {
    // За очередью следят постоянно, а в журнал сервера приложения заходят
    // разбираться: общий выключатель дёргал бы один список из-за другого.
    saveAutoRefresh('logs:postfix', true);
    expect(loadAutoRefresh('logs:postfix')).toBe(true);
    expect(loadAutoRefresh('logs:dovecot')).toBe(false);
    expect(loadAutoRefresh('queue')).toBe(false);
    expect(autoRefreshKey('logs:postfix')).not.toBe(autoRefreshKey('logs:dovecot'));
  });

  it('недоступное хранилище не роняет страницу', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('частный режим');
      },
    });
    expect(() => loadAutoRefresh('logs:postfix')).not.toThrow();
    expect(loadAutoRefresh('logs:postfix')).toBe(false);
    expect(() => saveAutoRefresh('logs:postfix', true)).not.toThrow();
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
  });
});
