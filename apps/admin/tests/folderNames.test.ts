/**
 * Названия папок в админке. Перевод сделали в почте и посчитали закрытым,
 * а админка осталась со служебными `INBOX`, `Sent`, `Drafts` — администратор
 * и владелец ящика видели разные названия одних и тех же папок.
 */
import { describe, expect, it } from 'vitest';
import { folderTitle, isServiceFolder } from '../src/lib/folderNames';

// Служебный признак IMAP начинается с обратной косой черты: \Sent, \Drafts…
// Выносим в константы, чтобы экранирование не потерялось при правках.
const INBOX = String.raw`\Inbox`;
const SENT = String.raw`\Sent`;
const DRAFTS = String.raw`\Drafts`;
const JUNK = String.raw`\Junk`;
const TRASH = String.raw`\Trash`;
const ARCHIVE = String.raw`\Archive`;

describe('названия папок в админке', () => {
  it('системные папки переводятся по служебному признаку', () => {
    expect(folderTitle({ name: 'Sent', path: 'Sent', specialUse: SENT })).toBe('Отправленные');
    expect(folderTitle({ name: 'Drafts', path: 'Drafts', specialUse: DRAFTS })).toBe('Черновики');
    expect(folderTitle({ name: 'Spam', path: 'Spam', specialUse: JUNK })).toBe('Спам');
    expect(folderTitle({ name: 'Trash', path: 'Trash', specialUse: TRASH })).toBe('Корзина');
    expect(folderTitle({ name: 'Archive', path: 'Archive', specialUse: ARCHIVE })).toBe('Архив');
  });

  it('«Входящие» опознаются и без служебного признака', () => {
    // Главный случай: у INBOX сервер может не отдать признак вовсе.
    expect(folderTitle({ name: 'INBOX', path: 'INBOX', specialUse: null })).toBe('Входящие');
    expect(folderTitle({ name: 'INBOX', path: 'INBOX', specialUse: INBOX })).toBe('Входящие');
  });

  it('пользовательская папка сохраняет своё имя', () => {
    expect(folderTitle({ name: 'Счета', path: 'Счета', specialUse: null })).toBe('Счета');
  });

  it('служебные каталоги почтового сервера опознаются', () => {
    // Они приходят в списке наравне с обычными папками, и человек,
    // приняв такой каталог за папку, может его переименовать или удалить.
    expect(isServiceFolder({ name: 'locks', path: 'dovecot/lda-dupes/locks' })).toBe(true);
    expect(isServiceFolder({ name: 'Счета', path: 'Счета' })).toBe(false);
    expect(isServiceFolder({ name: 'INBOX', path: 'INBOX' })).toBe(false);
  });
});
