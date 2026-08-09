/**
 * Стрелки ходят по тому порядку, который человек ВИДИТ на экране.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Курсор двигался по сырому списку писем, а рисуется он переставленным:
 * вернувшиеся из «Отложенных» и оставшиеся без ответа поднимаются
 * отдельными группами наверх, остальные раскладываются по периодам.
 *
 * Во «Входящих» с одним вернувшимся письмом человек жал стрелку вниз — и
 * курсор вставал не на первую строку экрана, а на вторую: поднятая
 * группа пропускалась целиком. Долистав до места, где это письмо лежит
 * по дате прихода, он получал рывок списка обратно наверх без всякой
 * причины. А Enter открывал не то письмо, на котором видна подсветка.
 *
 * Те же грабли были у стрелок «предыдущее/следующее» на странице письма:
 * соседи искались в сыром ответе сервера.
 */
import { describe, expect, it } from 'vitest';
import type { MessageSummary } from '@mail-true/shared';
import { flattenRows, orderedMessages } from '../src/mail/MessageList';

const NOW = new Date('2026-08-09T12:00:00Z');

/** Письмо списка: нужны только поля, влияющие на порядок. */
function letter(id: string, date: string, extra: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id,
    folderId: 'inbox',
    uid: Number(id.split(':')[1] ?? 0),
    subject: `письмо ${id}`,
    from: { address: 'kto@mail.local', name: 'Кто-то' },
    to: [{ address: 'ivan@mail.local', name: 'Иван' }],
    date,
    snippet: '',
    flags: { seen: false, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    ...extra,
  } as unknown as MessageSummary;
}

describe('порядок писем для клавиатуры', () => {
  it('совпадает с нарисованным: те же письма и в том же порядке', () => {
    const messages = [
      letter('inbox:1', '2026-08-09T10:00:00Z'),
      letter('inbox:2', '2026-08-08T10:00:00Z'),
      letter('inbox:3', '2026-08-01T10:00:00Z'),
    ];
    const drawn = flattenRows(messages, NOW)
      .filter((row) => row.type === 'message')
      .map((row) => (row.type === 'message' ? row.message.id : ''));
    expect(orderedMessages(messages, NOW).map((m) => m.id)).toEqual(drawn);
  });

  it('вернувшееся из «Отложенных» письмо идёт первым, как и на экране', () => {
    // Раньше стрелка вниз пропускала эту строку: в сыром списке она
    // лежит по дате прихода, то есть в середине.
    const messages = [
      letter('inbox:1', '2026-08-09T10:00:00Z'),
      letter('inbox:2', '2026-08-09T09:00:00Z', { returnedFromSnooze: true }),
      letter('inbox:3', '2026-08-09T08:00:00Z'),
    ];
    expect(orderedMessages(messages, NOW).map((m) => m.id)).toEqual([
      'inbox:2',
      'inbox:1',
      'inbox:3',
    ]);
  });

  it('письмо без ответа поднимается следом за вернувшимися', () => {
    const messages = [
      letter('inbox:1', '2026-08-09T10:00:00Z'),
      letter('inbox:2', '2026-08-09T09:00:00Z', { awaitReply: 'overdue' }),
      letter('inbox:3', '2026-08-09T08:00:00Z', { returnedFromSnooze: true }),
    ];
    expect(orderedMessages(messages, NOW).map((m) => m.id)).toEqual([
      'inbox:3',
      'inbox:2',
      'inbox:1',
    ]);
  });

  it('ни одно письмо не теряется и не задваивается при перестановке', () => {
    const messages = [
      letter('inbox:1', '2026-08-09T10:00:00Z', { returnedFromSnooze: true }),
      letter('inbox:2', '2026-08-08T10:00:00Z'),
      letter('inbox:3', '2026-08-01T10:00:00Z', { awaitReply: 'overdue' }),
      letter('inbox:4', '2026-07-01T10:00:00Z'),
    ];
    const order = orderedMessages(messages, NOW).map((m) => m.id);
    expect(order).toHaveLength(messages.length);
    expect(new Set(order).size).toBe(messages.length);
  });

  it('заголовки групп в порядок не попадают: на них курсор не встаёт', () => {
    const messages = [
      letter('inbox:1', '2026-08-09T10:00:00Z', { returnedFromSnooze: true }),
      letter('inbox:2', '2026-08-08T10:00:00Z'),
    ];
    const rows = flattenRows(messages, NOW);
    expect(rows.some((row) => row.type === 'header')).toBe(true);
    expect(orderedMessages(messages, NOW)).toHaveLength(2);
  });

  it('пустой список даёт пустой порядок, а не падение', () => {
    expect(orderedMessages([], NOW)).toEqual([]);
  });
});
