/**
 * Тесты прав на действия с папками и счётчика писем в настройках.
 * Эталон — таблица из docs/features-reference.md и скриншот 12-folders.png.
 */

import { describe, expect, it } from 'vitest';
import type { Folder } from '@mail-true/shared';
import { formatCount, formatFolderCount, folderRights } from '../src/lib/folderRights';

function rights(role: Folder['role'], system = true) {
  return folderRights({ role, system });
}

describe('folderRights', () => {
  // Сервер (`PATCH /api/folders/:id`) отвечает «Системную папку переименовать
  // нельзя» на любую папку с system: true. Интерфейс обязан молчать о том,
  // чего сервер не позволит: раньше «Переименовать» у Входящих предлагалось
  // и всегда заканчивалось ошибкой.
  it('Входящие чистятся, но не переименовываются и не удаляются', () => {
    expect(rights('inbox')).toEqual({ canClear: true, canRename: false, canDelete: false });
  });

  it('Отправленные, Черновики и Архив — как Входящие', () => {
    expect(rights('sent')).toEqual({ canClear: true, canRename: false, canDelete: false });
    expect(rights('drafts')).toEqual({ canClear: true, canRename: false, canDelete: false });
    expect(rights('archive')).toEqual({ canClear: true, canRename: false, canDelete: false });
  });

  it('Спам чистится, но переименовать и удалить нельзя', () => {
    expect(rights('spam')).toEqual({ canClear: true, canRename: false, canDelete: false });
  });

  it('Корзина не даёт ни одного действия', () => {
    expect(rights('trash')).toEqual({ canClear: false, canRename: false, canDelete: false });
  });

  it('пользовательская папка — единственная, которую можно удалить', () => {
    expect(rights('custom', false)).toEqual({
      canClear: true,
      canRename: true,
      canDelete: true,
    });
  });

  it('вложенная автокатегория не переименовывается и не удаляется', () => {
    // «Рассылки», «Чеки» — представления внутри Входящих, приходят system: true,
    // а системную папку сервер не даёт ни переименовать, ни удалить
    expect(rights('custom', true)).toEqual({ canClear: true, canRename: false, canDelete: false });
  });

  it('право переименовать совпадает с правилом сервера: !system', () => {
    const roles: Array<Folder['role']> = ['inbox', 'sent', 'drafts', 'archive', 'custom'];
    for (const role of roles) {
      expect(folderRights({ role, system: true }).canRename).toBe(false);
    }
    expect(folderRights({ role: 'custom', system: false }).canRename).toBe(true);
  });
});

describe('formatCount', () => {
  it('точное число до 999', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
  });

  it('свыше 999 показывается «999+» — точный подсчёт больших папок дорог', () => {
    expect(formatCount(1000)).toBe('999+');
    expect(formatCount(48213)).toBe('999+');
  });
});

describe('formatFolderCount', () => {
  it('без непрочитанных показывается только общее число', () => {
    expect(formatFolderCount({ unreadCount: 0, totalCount: 11 })).toBe('11');
  });

  it('с непрочитанными — «10/999+», как у папки «Входящие» в привычных почтовых интерфейсах', () => {
    expect(formatFolderCount({ unreadCount: 10, totalCount: 5000 })).toBe('10/999+');
  });

  it('обе части ограничиваются порогом независимо', () => {
    expect(formatFolderCount({ unreadCount: 1200, totalCount: 3000 })).toBe('999+/999+');
  });
});
