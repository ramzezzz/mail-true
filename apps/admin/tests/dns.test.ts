/**
 * Диалог проверки DNS: что именно показывается администратору.
 *
 * Раньше страница доменов отвечала одним словом на плашке. Из-за этого
 * терялись три различия, каждое из которых меняет действия человека:
 *
 *   1. «записи нет» и «запись есть, но не та» — в первом случае идут
 *      заводить запись, во втором правят значение;
 *   2. «не настроено» и «не удалось спросить» — второе лечится не у
 *      регистратора, а в сети сервера, и выдавать его за первое нельзя;
 *   3. обязательные записи и удобные — из-за отсутствия SRV почта ходит,
 *      из-за отсутствия MX не ходит вовсе.
 */
import { describe, expect, it } from 'vitest';
import {
  GROUP_ORDER,
  PROPAGATION_NOTE,
  VERDICT_LABEL,
  answerStamp,
  answerTime,
  buildZoneText,
  copyHint,
  formatActual,
  groupChecks,
  needsAttention,
  needsPropagationNote,
  resolverNote,
  summarize,
  verdictTone,
} from '../src/lib/dns';
import type { DnsCheck, DnsReport, DnsVerdict } from '../src/api/types';

function check(patch: Partial<DnsCheck> & { id: string }): DnsCheck {
  return {
    group: 'core',
    title: 'Запись',
    purpose: 'Зачем она нужна',
    impact: 'Что сломается без неё',
    recordName: 'example.ru',
    recordType: 'TXT',
    expected: 'v=spf1 mx ~all',
    copyable: true,
    actual: [],
    status: 'ok',
    verdict: 'ok',
    diff: null,
    hint: 'Что сделать',
    required: true,
    askedVia: '8.8.8.8',
    checkedAt: '2026-08-05T19:05:41.000Z',
    ...patch,
  };
}

function report(checks: DnsCheck[], reachable = true): DnsReport {
  return {
    domain: 'example.ru',
    checkedAt: new Date().toISOString(),
    overall: 'ok',
    resolver: {
      servers: ['8.8.8.8', '9.9.9.9'],
      answeredBy: reachable ? ['8.8.8.8'] : [],
      reachable,
    },
    checks,
  };
}

describe('вывод по записи', () => {
  it('«не настроено» и «настроено с ошибкой» — разные слова', () => {
    // Именно это различие просил заказчик: одинаковая красная плашка
    // не подсказывала, идти заводить запись или править значение.
    expect(VERDICT_LABEL.missing).toBe('не настроено');
    expect(VERDICT_LABEL.mismatch).toBe('настроено с ошибкой');
    expect(VERDICT_LABEL.ok).toBe('настроено верно');
    expect(VERDICT_LABEL.missing).not.toBe(VERDICT_LABEL.mismatch);
  });

  it('«не удалось проверить» не выглядит как «не настроено»', () => {
    expect(VERDICT_LABEL.unreachable).toBe('не удалось проверить');
    expect(verdictTone('unreachable')).toBe('muted');
    expect(verdictTone('mismatch')).toBe('fail');
    expect(verdictTone('ok')).toBe('ok');
  });

  it('у каждого вывода есть подпись и оттенок', () => {
    const all: DnsVerdict[] = ['ok', 'missing', 'mismatch', 'warn', 'unreachable'];
    for (const verdict of all) {
      expect(VERDICT_LABEL[verdict]).toBeTruthy();
      expect(['ok', 'warn', 'fail', 'muted']).toContain(verdictTone(verdict));
    }
  });
});

describe('что раскрыто сразу', () => {
  it('раскрыто то, с чем надо что-то делать; верное — свёрнуто', () => {
    // Записей полтора десятка: раскрытые «в порядке» превращают диалог
    // в простыню, в которой не видно проблемы.
    expect(needsAttention(check({ id: 'mx', verdict: 'ok' }))).toBe(false);
    expect(needsAttention(check({ id: 'mx', verdict: 'missing' }))).toBe(true);
    expect(needsAttention(check({ id: 'mx', verdict: 'mismatch' }))).toBe(true);
    expect(needsAttention(check({ id: 'mx', verdict: 'warn' }))).toBe(true);
    expect(needsAttention(check({ id: 'mx', verdict: 'unreachable' }))).toBe(true);
  });
});

describe('разделы', () => {
  it('порядок разделов — от обязательного к удобному', () => {
    expect(GROUP_ORDER).toEqual(['core', 'web', 'client']);
  });

  it('пустые разделы не показываются, а проблемы в разделе сосчитаны', () => {
    const groups = groupChecks([
      check({ id: 'mx', group: 'core', verdict: 'missing' }),
      check({ id: 'spf', group: 'core', verdict: 'ok' }),
      check({ id: 'autoconfig', group: 'client', verdict: 'mismatch' }),
    ]);
    expect(groups.map((g) => g.group)).toEqual(['core', 'client']);
    expect(groups[0]?.problems).toBe(1);
    expect(groups[1]?.problems).toBe(1);
    expect(groups[0]?.title).toBe('Обязательный минимум');
    expect(groups[0]?.note.length).toBeGreaterThan(10);
  });
});

describe('итог наверху диалога', () => {
  it('считает сломанные, замечания и непроверенное отдельно', () => {
    const summary = summarize(
      report([
        check({ id: 'a', verdict: 'ok' }),
        check({ id: 'mx', verdict: 'missing' }),
        check({ id: 'spf', verdict: 'mismatch' }),
        check({ id: 'dmarc', verdict: 'warn' }),
        check({ id: 'ptr', verdict: 'unreachable' }),
      ]),
    );
    expect(summary.ok).toBe(1);
    expect(summary.broken).toBe(2);
    expect(summary.warnings).toBe(1);
    expect(summary.unknown).toBe(1);
    expect(summary.tone).toBe('fail');
    expect(summary.headline).toContain('2');
  });

  it('всё верно — так и говорит', () => {
    const summary = summarize(report([check({ id: 'mx' }), check({ id: 'spf' })]));
    expect(summary.tone).toBe('ok');
    expect(summary.headline).toBe('Все записи настроены верно');
  });

  it('склоняет число записей по-русски', () => {
    const broken = (n: number): string =>
      summarize(
        report(
          Array.from({ length: n }, (_, i) => check({ id: `x${String(i)}`, verdict: 'missing' })),
        ),
      ).headline;
    expect(broken(1)).toContain('1 запись требует');
    expect(broken(3)).toContain('3 записи требуют');
    expect(broken(5)).toContain('5 записей требуют');
    expect(broken(11)).toContain('11 записей требуют');
  });

  it('молчащий резольвер — отдельный итог, а не «всё сломано»', () => {
    const summary = summarize(report([check({ id: 'mx', verdict: 'unreachable' })], false));
    expect(summary.tone).toBe('muted');
    expect(summary.headline).toContain('не удалось');
    expect(summary.broken).toBe(0);
  });
});

describe('у кого спрашивали', () => {
  it('называет ответивший резольвер и объясняет, почему не свой', () => {
    const note = resolverNote({
      servers: ['8.8.8.8', '9.9.9.9'],
      answeredBy: ['9.9.9.9'],
      reachable: true,
    });
    expect(note.tone).toBe('ok');
    expect(note.text).toContain('9.9.9.9');
    // Иначе проверка показывала бы то, что мы сами себе прописали.
    expect(note.text).toMatch(/сво[йё]|сами/i);
  });

  it('никто не ответил — прямо говорит, что записей это не касается', () => {
    const note = resolverNote({ servers: ['8.8.8.8'], answeredBy: [], reachable: false });
    expect(note.tone).toBe('muted');
    expect(note.text).toContain('не значит, что записей нет');
    expect(note.text).toContain('53/udp');
  });
});

describe('строка «что опубликовано»', () => {
  it('отличает «записи нет» от «спросить не удалось»', () => {
    expect(formatActual(check({ id: 'mx', verdict: 'missing', actual: [] }))).toBe('записи нет');
    expect(formatActual(check({ id: 'mx', verdict: 'unreachable', actual: [] }))).toBe(
      'спросить не удалось',
    );
  });

  it('несколько записей показываются по одной на строку', () => {
    const value = formatActual(
      check({ id: 'spf', verdict: 'mismatch', actual: ['v=spf1 mx ~all', 'v=spf1 -all'] }),
    );
    expect(value.split('\n')).toHaveLength(2);
  });
});

describe('перепроверка одной записи', () => {
  it('время ответа берётся у самой записи, а не у отчёта', () => {
    // После точечной перепроверки общее время отчёта врёт про остальные
    // строки: у каждой строки своя отметка.
    const свежая = check({ id: 'mx', checkedAt: '2026-08-05T19:30:00.000Z' });
    const старая = check({ id: 'spf', checkedAt: '2026-08-05T19:05:41.000Z' });
    expect(answerTime(свежая.checkedAt)).not.toBe(answerTime(старая.checkedAt));
    expect(answerStamp(свежая)).toContain(answerTime(свежая.checkedAt));
  });

  it('в отметке видно, у кого спросили', () => {
    expect(answerStamp(check({ id: 'mx', askedVia: '9.9.9.9' }))).toContain('9.9.9.9');
  });

  it('отказ проверки не выдаётся за полученный ответ', () => {
    const stamp = answerStamp(check({ id: 'mx', verdict: 'unreachable', askedVia: null }));
    expect(stamp).toContain('не удалось');
    expect(stamp).not.toContain('ответ получен');
  });

  it('без отметки времени ничего не выдумывается', () => {
    expect(answerTime(null)).toBe('');
    expect(answerTime('не дата')).toBe('');
  });
});

describe('время жизни записи', () => {
  it('про TTL напоминается там, где человек полезет править — у сломанных записей', () => {
    // Иначе «перепроверить» сразу после правки покажет старый ответ,
    // и человек начнёт чинить верную настройку.
    expect(needsPropagationNote(check({ id: 'mx', verdict: 'missing' }))).toBe(true);
    expect(needsPropagationNote(check({ id: 'mx', verdict: 'mismatch' }))).toBe(true);
    expect(needsPropagationNote(check({ id: 'mx', verdict: 'ok' }))).toBe(false);
  });

  it('предупреждение говорит и про минуты, и про сутки', () => {
    expect(PROPAGATION_NOTE).toMatch(/минут/);
    expect(PROPAGATION_NOTE).toMatch(/суток/);
  });
});

describe('копирование', () => {
  it('у PTR копировать к регистратору нечего — и это объяснено', () => {
    const ptr = check({ id: 'ptr', recordType: 'PTR', copyable: false });
    expect(copyHint(ptr)).toContain('хостер');
    expect(copyHint(check({ id: 'mx' }))).toBeNull();
  });

  it('в общий кусок для панели не попадают PTR и незаполненные значения', () => {
    const text = buildZoneText(
      report([
        check({ id: 'mx', recordType: 'MX', expected: '10 mail.example.ru.' }),
        check({ id: 'ptr', recordType: 'PTR', copyable: false, expected: 'mail.example.ru.' }),
        check({ id: 'a', recordType: 'A', expected: '<публичный адрес сервера>' }),
      ]),
    );
    expect(text).toContain('10 mail.example.ru.');
    expect(text).not.toContain('PTR');
    expect(text).not.toContain('<публичный');
  });
});
