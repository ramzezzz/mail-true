/**
 * Автопродление сертификата: разбор отчёта и оценка.
 *
 * Проверяется главное свойство этой части: она обязана КРАСНЕТЬ ровно в
 * тех случаях, из-за которых сертификаты и истекают, и молчать там, где
 * продление выключено намеренно. Оба перекоса одинаково вредны: тревога
 * на исправном сервере со своим сертификатом повторялась бы дважды в
 * сутки, и на неё перестали бы смотреть — то есть пропустили бы
 * настоящую.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeRenewal,
  parseRenewalReport,
  RENEW_STALE_FAIL_HOURS,
  RENEW_STALE_WARN_HOURS,
  renewalHealthCheck,
  type RenewalState,
} from './cert-renewal.js';

const NOW = Date.parse('2026-08-07T12:00:00Z');

/** Отчёт того самого вида, который пишет install/lib/common.sh. */
function report(options: {
  kind?: string;
  enabled?: boolean;
  attempts?: Array<{ at: string; outcome: string; message?: string; trigger?: string }>;
  nextRunAt?: string;
}): RenewalState {
  const text = JSON.stringify({
    version: 1,
    updatedAt: '2026-08-07T03:17:00Z',
    certSource: 'letsencrypt',
    timer: {
      kind: options.kind ?? 'systemd',
      unit: 'mailtrue-certs.timer',
      enabled: options.enabled ?? true,
      nextRunAt: options.nextRunAt ?? '2026-08-07T15:17:00Z',
      detail: 'Таймер systemd: проверка дважды в сутки',
    },
    attempts: (options.attempts ?? []).map((a) => ({
      at: a.at,
      trigger: a.trigger ?? 'timer',
      mode: 'renew',
      outcome: a.outcome,
      validTo: '2026-11-05T00:00:00Z',
      seconds: 4,
      message: a.message ?? 'ничего особенного',
    })),
  });
  return parseRenewalReport(text);
}

const FRESH_OK = { at: '2026-08-07T03:17:00Z', outcome: 'not-due' };

test('разбор: отчёт скрипта читается целиком', () => {
  const state = report({ attempts: [FRESH_OK] });
  assert.equal(state.problem, '');
  assert.equal(state.report?.timer.kind, 'systemd');
  assert.equal(state.report?.attempts.length, 1);
  assert.equal(state.report?.attempts[0]?.outcome, 'not-due');
});

test('разбор: испорченный файл — это «не знаю», а не падение', () => {
  const state = parseRenewalReport('{ это не JSON');
  assert.equal(state.report, null);
  assert.match(state.problem, /JSON/u);
});

test('разбор: незнакомый итог доезжает как есть', () => {
  // Хост и контейнер обновляются порознь. Новое значение от свежего
  // скрипта не должно делать отчёт нечитаемым для старой панели — иначе
  // обновление продукта гасило бы тревогу.
  const state = report({ attempts: [{ at: '2026-08-07T03:17:00Z', outcome: 'что-то-новое' }] });
  assert.equal(state.problem, '');
  assert.equal(state.report?.attempts[0]?.outcome, 'что-то-новое');
});

test('всё хорошо: таймер ходит, последняя попытка свежая', () => {
  const verdict = gradeRenewal(report({ attempts: [FRESH_OK] }), 'letsencrypt', NOW);
  assert.equal(verdict.state, 'ok');
  assert.match(verdict.detail, /Включено/u);
});

test('таймера нет вовсе — это отказ, а не замечание', () => {
  // Ровно случай «установка без systemd»: сертификат истечёт в известный
  // день, и вопрос только когда.
  const verdict = gradeRenewal(
    report({ kind: 'none', enabled: false, attempts: [FRESH_OK] }),
    'letsencrypt',
    NOW,
  );
  assert.equal(verdict.state, 'fail');
  assert.match(verdict.detail, /не включено/u);
  assert.match(verdict.hint ?? '', /--install-timer/u);
});

test('юнит на месте, но выключен — тоже отказ', () => {
  // Глазами это выглядит как «всё настроено»: файл юнита есть.
  const verdict = gradeRenewal(
    report({ enabled: false, attempts: [FRESH_OK] }),
    'letsencrypt',
    NOW,
  );
  assert.equal(verdict.state, 'fail');
});

test('неудачная последняя попытка — отказ, и причина сохраняется словами', () => {
  const verdict = gradeRenewal(
    report({
      attempts: [
        {
          at: '2026-08-07T03:17:00Z',
          outcome: 'failed',
          message: 'certbot вернул код 1. Подробности: /var/log/letsencrypt/letsencrypt.log',
        },
      ],
    }),
    'letsencrypt',
    NOW,
  );
  assert.equal(verdict.state, 'fail');
  assert.match(verdict.detail, /certbot вернул код 1/u);
});

test('молчание таймера ловится по возрасту попытки, а не по полю «включено»', () => {
  // Самое коварное состояние: таймер выключили, скрипт больше не
  // запускается, а в файле навсегда осталось «включено». Единственный
  // признак — что записи перестали появляться.
  const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();

  const fresh = gradeRenewal(
    report({ attempts: [{ at: hoursAgo(RENEW_STALE_WARN_HOURS - 1), outcome: 'not-due' }] }),
    'letsencrypt',
    NOW,
  );
  assert.equal(fresh.state, 'ok');

  const stale = gradeRenewal(
    report({ attempts: [{ at: hoursAgo(RENEW_STALE_WARN_HOURS), outcome: 'not-due' }] }),
    'letsencrypt',
    NOW,
  );
  assert.equal(stale.state, 'warn');

  const dead = gradeRenewal(
    report({ attempts: [{ at: hoursAgo(RENEW_STALE_FAIL_HOURS), outcome: 'not-due' }] }),
    'letsencrypt',
    NOW,
  );
  assert.equal(dead.state, 'fail');
});

test('таймер включён, а попыток ещё не было — предупреждение', () => {
  const verdict = gradeRenewal(report({ attempts: [] }), 'letsencrypt', NOW);
  assert.equal(verdict.state, 'warn');
});

test('отчёта нет — предупреждение, а не зелёный экран', () => {
  // Зелёный на непрочитанном — худший ответ: он означает «я не смотрел»,
  // а читается как «всё хорошо».
  const verdict = gradeRenewal({ report: null, problem: 'Отчёта нет' }, 'letsencrypt', NOW);
  assert.equal(verdict.state, 'warn');
  assert.equal(verdict.detail, 'Отчёта нет');
});

test('свой сертификат: молчим, даже если таймера нет и отчёта нет', () => {
  // Это не поломка, а решение: продление затёрло бы принесённый
  // сертификат, и install/renew-certs.sh отказывается это делать.
  // Тревога здесь повторялась бы вечно на исправном сервере.
  assert.equal(gradeRenewal({ report: null, problem: 'нет' }, 'custom', NOW).state, 'ok');
  assert.equal(gradeRenewal(report({ kind: 'none', enabled: false }), 'custom', NOW).state, 'ok');
});

test('самоподписанный: продлевать нечего, Let’s Encrypt тут ни при чём', () => {
  const verdict = gradeRenewal(report({ kind: 'none', enabled: false }), 'selfsigned', NOW);
  assert.equal(verdict.state, 'ok');
  assert.match(verdict.hint ?? '', /--force/u);
});

test('читается ровно то, что на самом деле пишет install/lib/common.sh', () => {
  /*
   * Байт в байт вывод renew_report_write, снятый живым прогоном в WSL
   * (Ubuntu 22.04, bash 5.1). Это единственное место, где формат файла
   * проверяется с ОБЕИХ сторон: пишет его bash на хосте, читает
   * TypeScript в контейнере, и общего типа у них нет и быть не может.
   * Разойдись они молча — панель показала бы «отчёта нет» на сервере,
   * где продление работает, то есть соврала бы ровно наоборот.
   */
  const real = [
    '{',
    '  "version": 1,',
    '  "updatedAt": "2026-08-07T09:22:14Z",',
    '  "certSource": "letsencrypt",',
    '  "timer": {"kind": "none", "unit": "mailtrue-certs.timer", "enabled": false, "nextRunAt": "", "detail": "Автопродления нет: ни юнита systemd, ни записи в cron"},',
    '  "attempts": [',
    '    {"at": "2026-08-07T09:22:14Z", "trigger": "manual", "mode": "force", "outcome": "failed", "validTo": "", "seconds": 12, "message": "certbot вернул код 1. Подробности: /var/log/letsencrypt/letsencrypt.log"},',
    '    {"at": "2026-08-07T09:22:14Z", "trigger": "timer", "mode": "renew", "outcome": "not-due", "validTo": "2026-11-05T00:00:00Z", "seconds": 4, "message": "Продление не требовалось: срок ещё не подошёл"}',
    '  ]',
    '}',
    '',
  ].join('\n');

  const state = parseRenewalReport(real);
  assert.equal(state.problem, '');
  assert.equal(state.report?.attempts.length, 2);
  assert.equal(state.report?.timer.kind, 'none');
  assert.equal(state.report?.certSource, 'letsencrypt');

  // И оценка по нему — отказ дважды: и таймера нет, и попытка неудачна.
  const verdict = gradeRenewal(state, 'letsencrypt', Date.parse('2026-08-07T10:00:00Z'));
  assert.equal(verdict.state, 'fail');
});

test('в «Наблюдение» уезжает готовая проверка группы «Сертификаты»', () => {
  // Без этого раздел пришлось бы открывать нарочно, а его не открывают.
  const check = renewalHealthCheck(
    report({ kind: 'none', enabled: false, attempts: [FRESH_OK] }),
    'letsencrypt',
    NOW,
  );
  assert.equal(check.group, 'Сертификаты');
  assert.equal(check.id, 'cert:renewal');
  assert.equal(check.state, 'fail');
});
