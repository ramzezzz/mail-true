/**
 * Что показывать, пока грузится новый список.
 *
 * `placeholderData: (previous) => previous` отдавал данные ЛЮБОГО прошлого
 * ключа: при переходе из «Входящих» в «Отправленные» под новым заголовком
 * оставались письма предыдущей папки — скелетон не показывался, и понять,
 * что список ещё не тот, было нельзя.
 */

import { describe, expect, it } from 'vitest';
import type { MessageListQuery } from '@mail-true/shared';
import { queryKeys, sameMessage, sameMessageList } from '../src/api/queries';

const query = (patch: Partial<MessageListQuery> = {}): MessageListQuery => ({
  folderId: 'inbox',
  offset: 0,
  limit: 100,
  threaded: false,
  filter: 'all',
  ...patch,
});

describe('sameMessageList', () => {
  it('смена папки — не тот же список: нужен скелетон', () => {
    const inbox = queryKeys.messages(query());
    const sent = queryKeys.messages(query({ folderId: 'sent' }));
    expect(sameMessageList(inbox, sent)).toBe(false);
  });

  it('смена фильтра — тоже другой список', () => {
    expect(
      sameMessageList(queryKeys.messages(query()), queryKeys.messages(query({ filter: 'unread' }))),
    ).toBe(false);
  });

  it('другой поисковый запрос — другой список', () => {
    expect(
      sameMessageList(
        queryKeys.messages(query({ search: 'договор' })),
        queryKeys.messages(query({ search: 'счёт' })),
      ),
    ).toBe(false);
  });

  it('следующая страница той же папки — список тот же, мигать незачем', () => {
    expect(
      sameMessageList(queryKeys.messages(query()), queryKeys.messages(query({ offset: 100 }))),
    ).toBe(true);
  });

  it('прошлых данных не было — показывать нечего', () => {
    expect(sameMessageList(undefined, queryKeys.messages(query()))).toBe(false);
  });
});

describe('sameMessage', () => {
  it('то же письмо с картинками и без — можно показывать прежнее тело', () => {
    expect(sameMessage(queryKeys.message('inbox:209', false), queryKeys.message('inbox:209', true))).toBe(
      true,
    );
  });

  it('другое письмо — прежнее тело показывать нельзя', () => {
    expect(sameMessage(queryKeys.message('inbox:209'), queryKeys.message('inbox:210'))).toBe(false);
  });
});
