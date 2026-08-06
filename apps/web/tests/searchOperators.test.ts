/**
 * Операторы поиска в браузере: разбор области поиска и снятие условий чипом.
 *
 * Грамматика проверяется на стороне API (apps/api/src/mail/search-query.test.ts);
 * здесь — только то, что делает браузер и чего сервер сделать не может:
 * находит папку, названную словами, и убирает условие из строки запроса.
 */

import { describe, expect, it } from 'vitest';
import type { Folder } from '@mail-true/shared';
import { findFolderByName, planSearch } from '../src/search/searchOperators';
import { dropSearchChip } from '../src/pages/SearchPage';

function folder(id: string, name: string, role: Folder['role'], path = name): Folder {
  return {
    id,
    path,
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
  folder('inbox', 'INBOX', 'inbox', 'INBOX'),
  folder('spam', 'Spam', 'spam', 'Spam'),
  folder('rassylki', 'Рассылки', 'custom', 'Рассылки'),
  folder('rabota-otchety', 'Отчёты', 'custom', 'Работа/Отчёты'),
];

describe('findFolderByName', () => {
  it('находит по русскому названию из интерфейса', () => {
    // Человек пишет то, что видит, а ящик знает совсем другое слово
    expect(findFolderByName(FOLDERS, 'Входящие')?.id).toBe('inbox');
    expect(findFolderByName(FOLDERS, 'входящие')?.id).toBe('inbox');
  });

  it('находит по собственному имени, идентификатору и пути', () => {
    expect(findFolderByName(FOLDERS, 'Рассылки')?.id).toBe('rassylki');
    expect(findFolderByName(FOLDERS, 'inbox')?.id).toBe('inbox');
    expect(findFolderByName(FOLDERS, 'Работа/Отчёты')?.id).toBe('rabota-otchety');
  });

  it('находит вложенную папку по хвосту пути', () => {
    // Целиком путь человек не пишет почти никогда
    expect(findFolderByName(FOLDERS, 'Отчеты')?.id).toBe('rabota-otchety');
  });

  it('несуществующая папка — это null, а не первая попавшаяся', () => {
    expect(findFolderByName(FOLDERS, 'Архив 2019')).toBeNull();
  });
});

describe('planSearch', () => {
  it('оператор «папка:» превращается в папку и в чип', () => {
    const plan = planSearch('папка:Рассылки скидки', FOLDERS);
    expect(plan.folder?.id).toBe('rassylki');
    expect(plan.unknownFolder).toBeNull();
    expect(plan.chips.map((c) => `${c.title}: ${c.value}`)).toEqual([
      'Папка: Рассылки',
      'Слова: скидки',
    ]);
  });

  it('несуществующая папка названа, а не проглочена', () => {
    // Молчание здесь — худший вариант: человек искал бы ошибку в словах
    const plan = planSearch('папка:Архив2019 счета', FOLDERS);
    expect(plan.folder).toBeNull();
    expect(plan.unknownFolder).toBe('Архив2019');
  });

  it('пока папки не загрузились, о ненайденной говорить рано', () => {
    const plan = planSearch('папка:Рассылки', []);
    expect(plan.unknownFolder).toBeNull();
  });

  it('обычный запрос никаких условий не заводит', () => {
    // Ровно тот пример, которым описан риск в docs/gaps.md, п. 7
    const plan = planSearch('Договор № 452/26: правки', FOLDERS);
    expect(plan.folder).toBeNull();
    expect(plan.chips).toEqual([
      { field: 'text', title: 'Слова', value: 'Договор № 452/26: правки' },
    ]);
  });
});

describe('dropSearchChip', () => {
  it('снимает именно то условие, которого коснулись', () => {
    expect(dropSearchChip('от:волкова есть:вложение договор', 'from')).toBe(
      'есть:вложение договор',
    );
    expect(dropSearchChip('от:волкова есть:вложение договор', 'hasAttachment')).toBe(
      'от:волкова договор',
    );
  });

  it('снимает свободные слова, не трогая условия', () => {
    expect(dropSearchChip('от:волкова договор аренды', 'text')).toBe('от:волкова');
  });

  it('снимает слово-признак', () => {
    expect(dropSearchChip('непрочитанные счета', 'seen')).toBe('счета');
  });

  it('условия, которого нет, снятие не портит', () => {
    expect(dropSearchChip('договор', 'from')).toBe('договор');
  });
});
