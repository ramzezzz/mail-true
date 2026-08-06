/**
 * Тесты фасетных фильтров поиска: счётчики по признакам, папкам и периодам,
 * а также отбор результатов по выбранным фасетам.
 */

import { describe, expect, it } from 'vitest';
import type { Folder, MessageSummary } from '@mail-true/shared';
import {
  applyFacets,
  computeAggregates,
  matchesFlagFacet,
  periodBucket,
} from '../src/lib/searchFacets';

// Фиксированное «сейчас»: среда 5 августа 2026
const NOW = new Date(2026, 7, 5, 14, 0, 0);

function folder(id: string, name: string, role: Folder['role']): Folder {
  return {
    id,
    path: name,
    name,
    role,
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 0,
    system: true,
    uidValidity: 1,
  };
}

const FOLDERS: Folder[] = [
  folder('inbox', 'INBOX', 'inbox'),
  folder('newsletters', 'Рассылки', 'custom'),
  folder('spam', 'Spam', 'spam'),
];

interface Options {
  seen?: boolean;
  flagged?: boolean;
  attach?: boolean;
}

function message(id: string, folderId: string, date: Date, o: Options = {}): MessageSummary {
  return {
    id,
    folderId,
    uid: Number(id.replace(/\D/gu, '')) || 1,
    threadId: `t-${id}`,
    from: { name: null, address: 'a@b.c' },
    to: [],
    cc: [],
    subject: `Тема ${id}`,
    snippet: '',
    date: date.toISOString(),
    flags: {
      seen: o.seen ?? true,
      flagged: o.flagged ?? false,
      answered: false,
      forwarded: false,
      draft: false,
      deleted: false,
    },
    hasAttachments: o.attach ?? false,
    attachmentNames: [],
    labels: [],
    pinned: false,
    sizeBytes: 1000,
  };
}

describe('periodBucket', () => {
  it('текущий месяц называется «За этот месяц»', () => {
    expect(periodBucket(new Date(2026, 7, 2).toISOString(), NOW)).toEqual({
      id: 'month:2026-08',
      label: 'За этот месяц',
    });
  });

  it('месяц текущего года подписан названием месяца', () => {
    expect(periodBucket(new Date(2026, 6, 20).toISOString(), NOW)).toEqual({
      id: 'month:2026-07',
      label: 'Июль',
    });
  });

  it('прошлые годы сворачиваются в один период «За год»', () => {
    expect(periodBucket(new Date(2020, 2, 1).toISOString(), NOW)).toEqual({
      id: 'year:2020',
      label: 'За 2020',
    });
    // декабрь прошлого года попадает в год, а не в месяц
    expect(periodBucket(new Date(2025, 11, 31).toISOString(), NOW).id).toBe('year:2025');
  });
});

describe('matchesFlagFacet', () => {
  it('различает непрочитанные, с флагом и с вложениями', () => {
    const m = message('1', 'inbox', NOW, { seen: false, flagged: true, attach: false });
    expect(matchesFlagFacet(m, 'unread')).toBe(true);
    expect(matchesFlagFacet(m, 'flagged')).toBe(true);
    expect(matchesFlagFacet(m, 'attachments')).toBe(false);
  });
});

describe('computeAggregates', () => {
  const messages = [
    message('1', 'inbox', new Date(2026, 7, 2), { seen: false, attach: true }),
    message('2', 'inbox', new Date(2026, 6, 20), { flagged: true }),
    message('3', 'newsletters', new Date(2026, 6, 3)),
    message('4', 'inbox', new Date(2020, 1, 10), { seen: false }),
  ];

  it('считает признаки письма', () => {
    const agg = computeAggregates(messages, FOLDERS, NOW);
    expect(agg.total).toBe(4);
    expect(agg.flags).toEqual({ unread: 2, flagged: 1, attachments: 1 });
  });

  it('счётчики по папкам идут в порядке левого меню и с русскими названиями', () => {
    const agg = computeAggregates(messages, FOLDERS, NOW);
    expect(agg.folders).toEqual([
      { id: 'inbox', label: 'Входящие', count: 3 },
      { id: 'newsletters', label: 'Рассылки', count: 1 },
    ]);
  });

  it('папки без совпадений в списке не показываются', () => {
    const agg = computeAggregates(messages, FOLDERS, NOW);
    expect(agg.folders.some((f) => f.id === 'spam')).toBe(false);
  });

  it('письма из неизвестной папки не теряются', () => {
    const agg = computeAggregates([message('9', 'archive-2', NOW)], FOLDERS, NOW);
    expect(agg.folders).toEqual([{ id: 'archive-2', label: 'archive-2', count: 1 }]);
  });

  it('периоды: сначала текущий месяц, затем месяцы года, затем годы', () => {
    const agg = computeAggregates(messages, FOLDERS, NOW);
    expect(agg.periods.map((p) => p.label)).toEqual(['За этот месяц', 'Июль', 'За 2020']);
    expect(agg.periods.map((p) => p.count)).toEqual([1, 2, 1]);
  });

  it('пустой результат даёт нулевые счётчики, а не падение', () => {
    const agg = computeAggregates([], FOLDERS, NOW);
    expect(agg).toEqual({
      total: 0,
      flags: { unread: 0, flagged: 0, attachments: 0 },
      folders: [],
      periods: [],
      labels: [],
    });
  });
});

describe('applyFacets', () => {
  const messages = [
    message('1', 'inbox', new Date(2026, 7, 2), { seen: false, attach: true }),
    message('2', 'inbox', new Date(2026, 6, 20), { flagged: true }),
    message('3', 'newsletters', new Date(2026, 6, 3), { seen: false }),
  ];

  it('без выбранных фасетов возвращает всё', () => {
    expect(
      applyFacets(messages, { flags: [], folderId: null, period: null, label: null }, NOW),
    ).toHaveLength(3);
  });

  it('несколько признаков объединяются по И', () => {
    const result = applyFacets(
      messages,
      { flags: ['unread', 'attachments'], folderId: null, period: null, label: null },
      NOW,
    );
    expect(result.map((m) => m.id)).toEqual(['1']);
  });

  it('папка и период сужают выборку вместе', () => {
    const result = applyFacets(
      messages,
      { flags: [], folderId: 'inbox', period: 'month:2026-07', label: null },
      NOW,
    );
    expect(result.map((m) => m.id)).toEqual(['2']);
  });
});
