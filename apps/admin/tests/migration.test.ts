/**
 * Раздел «Перенос почты»: что человек видит на экране.
 *
 * Проверяется главное свойство раздела — он должен отвечать на вопрос
 * «оно движется?». Перенос ящика идёт часами, и «крутилка» в этих
 * условиях не сообщает ничего: нужны числа, доля выполнения и текущая
 * папка. Ниже — ровно эти вычисления.
 *
 * На старом коде падают все проверки: модуля lib/migration не было.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MigrationItem, MigrationJob } from '../src/api/types';
import {
  currentActivity,
  isJobLive,
  jobProgress,
  readinessProblems,
  retryableItems,
  ITEM_STATE_TONES,
  JOB_STATE_TONES,
} from '../src/lib/migration';

function job(patch: Partial<MigrationJob> = {}): MigrationJob {
  return {
    id: 1,
    adminLogin: 'rukovodstvo',
    state: 'running',
    stopRequested: false,
    sourceHost: 'kerio.staraya.ru',
    sourcePort: 993,
    sourceSecure: true,
    masterUser: 'admin',
    total: 4,
    done: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    error: null,
    createdAt: '2026-08-05T00:00:00.000Z',
    startedAt: '2026-08-05T00:00:01.000Z',
    finishedAt: null,
    live: true,
    ...patch,
  };
}

function item(patch: Partial<MigrationItem> = {}): MigrationItem {
  return {
    position: 0,
    sourceUser: 'ivan@staraya.ru',
    destUser: 'ivan@novaya.ru',
    state: 'queued',
    total: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    currentFolder: null,
    errors: [],
    startedAt: null,
    finishedAt: null,
    ...patch,
  };
}

describe('доля выполнения', () => {
  it('считает и по ящикам, и по письмам текущего ящика', () => {
    // Один большой ящик на пять тысяч писем переносится часами. Если
    // считать только по ящикам, полоса стоит на нуле всё это время
    // и человек решает, что задание зависло.
    const items = [
      item({ position: 0, state: 'ok' }),
      item({ position: 1, state: 'running', total: 1000, copied: 500 }),
      item({ position: 2 }),
      item({ position: 3 }),
    ];
    expect(jobProgress(job(), items)).toBeCloseTo(0.375, 3);
  });

  it('обратный ход: без учёта писем текущего ящика доля была бы вчетверо меньше', () => {
    const items = [
      item({ position: 0, state: 'running', total: 1000, copied: 999 }),
      item({ position: 1 }),
      item({ position: 2 }),
      item({ position: 3 }),
    ];
    const progress = jobProgress(job(), items);
    expect(progress).toBeGreaterThan(0.24);
    expect(progress).toBeLessThanOrEqual(0.25);
  });

  it('ящик с ошибками считается пройденным: возвращаться к нему задание не будет', () => {
    const items = [item({ position: 0, state: 'failed' }), item({ position: 1, state: 'partial' })];
    expect(jobProgress(job({ total: 2 }), items)).toBe(1);
  });

  it('доля не выходит за единицу, даже если сервер прислал больше писем, чем обещал', () => {
    const items = [item({ position: 0, state: 'running', total: 10, copied: 99 })];
    expect(jobProgress(job({ total: 1 }), items)).toBe(1);
  });

  it('остановленный ящик показывает сделанное, а не ноль', () => {
    // Поймано на живом стенде: остановленное задание с 225 перенесёнными
    // письмами из 917 рисовало пустую полосу. Человек, решающий,
    // продолжать ли перенос, видел бы «не сделано ничего».
    const items = [item({ state: 'stopped', total: 900, copied: 225 })];
    expect(jobProgress(job({ total: 1 }), items)).toBeCloseTo(0.25, 2);
  });

  it('пустое задание не делится на ноль', () => {
    expect(jobProgress(job({ total: 0 }), [])).toBe(0);
  });
});

describe('что происходит прямо сейчас', () => {
  it('называет ящик, папку и номер письма', () => {
    const text = currentActivity([
      item({ state: 'running', currentFolder: 'INBOX/Проекты', total: 800, copied: 120, skipped: 5 }),
    ]);
    expect(text).toContain('ivan@staraya.ru');
    expect(text).toContain('INBOX/Проекты');
    expect(text).toContain('125');
    expect(text).toContain('800');
  });

  it('до первой папки честно говорит, что идёт подготовка', () => {
    // Чтение списка папок большого ящика занимает минуты. Пустая строка
    // здесь читалась бы как «ничего не происходит».
    const text = currentActivity([item({ state: 'running' })]);
    expect(text).toContain('подготовка');
  });

  it('когда ничего не переносится — строки нет, а не «переносится null»', () => {
    expect(currentActivity([item({ state: 'ok' })])).toBeNull();
    expect(currentActivity([])).toBeNull();
  });
});

describe('состояния', () => {
  it('идущим считается задание в очереди и в работе', () => {
    expect(isJobLive(job({ state: 'queued' }))).toBe(true);
    expect(isJobLive(job({ state: 'running' }))).toBe(true);
    expect(isJobLive(job({ state: 'done' }))).toBe(false);
    expect(isJobLive(job({ state: 'stopped' }))).toBe(false);
    expect(isJobLive(job({ state: 'failed' }))).toBe(false);
  });

  it('остановка человеком не красная, а перенос с ошибками не зелёный', () => {
    // Красная плашка в ответ на собственное нажатие читается как поломка,
    // а зелёная при недоехавших письмах — как «всё хорошо, можно
    // переключать MX». Оба прочтения дорого обходятся.
    expect(JOB_STATE_TONES.stopped).toBe('warn');
    expect(JOB_STATE_TONES.failed).toBe('fail');
    expect(ITEM_STATE_TONES.partial).toBe('warn');
    expect(ITEM_STATE_TONES.ok).toBe('ok');
  });
});

describe('повтор неудавшихся', () => {
  it('берёт всё, что не доехало, включая не начатое', () => {
    const items = [
      item({ position: 0, state: 'ok' }),
      item({ position: 1, state: 'failed' }),
      item({ position: 2, state: 'partial' }),
      item({ position: 3, state: 'stopped' }),
      item({ position: 4, state: 'queued' }),
    ];
    expect(retryableItems(items).map((i) => i.position)).toEqual([1, 2, 3, 4]);
  });

  it('успешно перенесённый ящик повторять не предлагается', () => {
    // Повтор такого ящика — это часы работы и сканирование чужого
    // сервера ради нуля новых писем.
    expect(retryableItems([item({ state: 'ok' })])).toHaveLength(0);
  });
});

describe('оформление раздела', () => {
  const css = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'src',
      'pages',
      'MigratePage.module.css',
    ),
    'utf8',
  );

  it('не содержит захардкоженных цветов', () => {
    // Поймано на живом стенде: полоса выполнения была нарисована запасным
    // синим, потому что переменных --mt-color-accent и --mt-color-danger
    // в панели не существует. В изумрудной и коралловой темах она осталась
    // бы синей — то есть выглядела бы чужим элементом на странице.
    const hex = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hex).toEqual([]);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  it('пользуется только существующими переменными панели', () => {
    // Запасное значение в var(--x, синий) молча прячет опечатку в имени
    // переменной: цвет «работает», но темы на него не влияют.
    const vars = [...css.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/g)];
    expect(vars.length).toBeGreaterThan(5);
    expect(vars.filter((m) => m[2] !== undefined).map((m) => m[1])).toEqual([]);
  });
});

describe('готовность раздела', () => {
  it('называет все препятствия сразу, а не по одному', () => {
    // Иначе о каждом узнают отдельно, перезапуская контейнер, — три
    // перезапуска вместо одного.
    const problems = readinessProblems({
      masterConfigured: false,
      secretConfigured: false,
      schemaReady: false,
    });
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toContain('DOVECOT_MASTER_USER');
    expect(problems.join(' ')).toContain('SESSION_SECRET');
    expect(problems.join(' ')).toContain('0011_migration_jobs.sql');
  });

  it('когда всё настроено — препятствий нет', () => {
    expect(
      readinessProblems({ masterConfigured: true, secretConfigured: true, schemaReady: true }),
    ).toEqual([]);
  });
});
